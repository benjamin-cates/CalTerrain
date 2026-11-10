import json
import math
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[2]
RIVER_ARCHIVE = ROOT / "public/data/features/nhd_major_rivers.zip"
FIRST_PASS_GAP_METERS = 30.0
SECOND_PASS_GAP_METERS = 1_000.0
EARTH_RADIUS_METERS = 6_371_008.8
TERRAIN_TILE_SIZE = 256
TERRAIN_TILE_BORDER = 1
SHAPEFILE_SUFFIXES = {".cpg", ".dbf", ".prj", ".shp", ".shx"}

Endpoint = tuple[int, int]
Position = list[float]
Line = list[Position]


def endpoint_distance_meters(first: Position, second: Position) -> float:
    first_longitude, first_latitude = map(math.radians, first[:2])
    second_longitude, second_latitude = map(math.radians, second[:2])
    latitude_delta = second_latitude - first_latitude
    longitude_delta = second_longitude - first_longitude
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(first_latitude)
        * math.cos(second_latitude)
        * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * EARTH_RADIUS_METERS * math.asin(math.sqrt(min(1.0, haversine)))


def _merge_line_paths_once(
    lines: list[Line],
    maximum_gap_meters: float,
) -> list[Line]:
    paths = [line for line in lines if len(line) >= 2]
    endpoints: list[Endpoint] = [
        (path_index, side)
        for path_index in range(len(paths))
        for side in (0, 1)
    ]
    candidates: dict[Endpoint, list[tuple[Endpoint, float]]] = {
        endpoint: [] for endpoint in endpoints
    }

    for endpoint_index, first in enumerate(endpoints):
        first_path, first_side = first
        first_position = paths[first_path][0 if first_side == 0 else -1]
        for second in endpoints[endpoint_index + 1 :]:
            second_path, second_side = second
            if first_path == second_path:
                continue
            second_position = paths[second_path][0 if second_side == 0 else -1]
            distance = endpoint_distance_meters(first_position, second_position)
            if distance <= maximum_gap_meters:
                candidates[first].append((second, distance))
                candidates[second].append((first, distance))

    connections: dict[Endpoint, Endpoint] = {}
    for endpoint, matches in candidates.items():
        if not matches:
            continue
        closest_distance = min(distance for _, distance in matches)
        closest_matches = [
            match
            for match, distance in matches
            if math.isclose(distance, closest_distance, abs_tol=0.001)
        ]
        if len(closest_matches) == 1:
            connections[endpoint] = closest_matches[0]

    connections = {
        endpoint: match
        for endpoint, match in connections.items()
        if connections.get(match) == endpoint
    }

    merged: list[Line] = []
    consumed: set[int] = set()
    path_order = sorted(
        range(len(paths)),
        key=lambda index: int(
            (index, 0) in connections and (index, 1) in connections
        ),
    )
    for path_index in path_order:
        if path_index in consumed:
            continue
        path = paths[path_index]
        start_side = 1 if (path_index, 0) in connections else 0
        points = list(path) if start_side == 0 else list(reversed(path))
        current_path = path_index
        exit_side = 1 - start_side
        consumed.add(path_index)

        while (next_endpoint := connections.get((current_path, exit_side))) is not None:
            next_path, next_side = next_endpoint
            if next_path in consumed:
                break
            next_points = paths[next_path]
            oriented_path = next_points if next_side == 0 else reversed(next_points)
            oriented_points = list(oriented_path)
            points.extend(
                oriented_points[1:]
                if points[-1][:2] == oriented_points[0][:2]
                else oriented_points
            )
            consumed.add(next_path)
            current_path = next_path
            exit_side = 1 - next_side

        merged.append(points)

    return merged


def merge_line_paths(
    lines: list[Line],
    maximum_gap_meters: float = FIRST_PASS_GAP_METERS,
) -> list[Line]:
    paths = [line for line in lines if len(line) >= 2]
    while True:
        merged = _merge_line_paths_once(paths, maximum_gap_meters)
        if len(merged) == len(paths):
            return merged
        paths = merged


def split_named_river(name: str, lines: list[Line]) -> list[tuple[str, list[Line]]]:
    if name not in {"Tule River", "Roaring River"}:
        return [(name, lines)]

    northern_lines = [
        line for line in lines
        if sum(position[1] for position in line) / len(line) >= 39
    ]
    southern_lines = [
        line for line in lines
        if sum(position[1] for position in line) / len(line) < 39
    ]
    if not northern_lines or not southern_lines:
        raise RuntimeError(
            f"Expected northern and southern components for {name}."
        )

    if name == "Tule River":
        return [
            ("Tule River (Tulare County)", southern_lines),
            ("Tule River (Shasta County)", northern_lines),
        ]
    return [
        ("Roaring River (Kings)", southern_lines),
        ("Roaring River (Cottonwood)", northern_lines),
    ]


def order_lines_by_elevation(
    lines: list[Line],
    sample_elevation: Callable[[Position], float],
) -> list[Line]:
    oriented: list[tuple[float, int, Line]] = []
    for index, line in enumerate(lines):
        start_elevation = sample_elevation(line[0])
        end_elevation = sample_elevation(line[-1])
        if start_elevation < end_elevation:
            line = list(reversed(line))
            start_elevation = end_elevation
        oriented.append((start_elevation, index, line))
    oriented.sort(key=lambda item: (-item[0], item[1]))
    return [line for _, _, line in oriented]


class TerrainElevationSampler:
    def __init__(self, metadata_path: Path, cache_directory: Path) -> None:
        with metadata_path.open(encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
        zoom_levels = metadata.get("zoomLevels")
        tiles = metadata.get("tiles")
        if not isinstance(zoom_levels, list) or not isinstance(tiles, list):
            raise RuntimeError(f"Invalid terrain metadata in {metadata_path}.")
        self.zoom_levels = sorted(zoom_levels, reverse=True)
        self.available_tiles = set(tiles)
        self.cache_directory = cache_directory
        self.cache_directory.mkdir(parents=True, exist_ok=True)
        self.tile_cache: dict[str, tuple[int, int, int, bytes]] = {}

    def sample(self, position: Position) -> float:
        longitude, latitude = position[:2]
        latitude = min(85.05112878, max(-85.05112878, latitude))
        for zoom in self.zoom_levels:
            tile_count = 2 ** zoom
            tile_x_position = (longitude + 180) / 360 * tile_count
            latitude_radians = math.radians(latitude)
            tile_y_position = (
                1 - math.asinh(math.tan(latitude_radians)) / math.pi
            ) / 2 * tile_count
            tile_x = math.floor(tile_x_position)
            tile_y = math.floor(tile_y_position)
            tile_key = f"{zoom}/{tile_x}/{tile_y}"
            if tile_key not in self.available_tiles:
                continue

            width, height, bands, pixels = self._load_tile(tile_key)
            pixel_x = min(
                width - 1,
                max(
                    0,
                    math.floor(
                        (tile_x_position - tile_x) * TERRAIN_TILE_SIZE + 0.5
                    ) + TERRAIN_TILE_BORDER,
                ),
            )
            pixel_y = min(
                height - 1,
                max(
                    0,
                    math.floor(
                        (tile_y_position - tile_y) * TERRAIN_TILE_SIZE + 0.5
                    ) + TERRAIN_TILE_BORDER,
                ),
            )
            pixel_offset = pixel_y * width + pixel_x
            pixel_count = width * height
            red = pixels[pixel_offset]
            green = pixels[pixel_count + pixel_offset]
            blue = pixels[2 * pixel_count + pixel_offset]
            if bands >= 4 and pixels[3 * pixel_count + pixel_offset] == 0:
                continue
            return red * 256 + green + blue / 256 - 32_768

        raise RuntimeError(
            f"No terrain elevation is available at {position[:2]}."
        )

    def _load_tile(self, tile_key: str) -> tuple[int, int, int, bytes]:
        cached_tile = self.tile_cache.get(tile_key)
        if cached_tile is not None:
            return cached_tile

        tile_path = ROOT / "public/data/terrain/tiles" / f"{tile_key}.webp"
        tile_name = tile_key.replace("/", "_")
        raster_path = self.cache_directory / f"{tile_name}.dat"
        result = subprocess.run(
            [
                "gdal_translate",
                "-q",
                "-of",
                "ENVI",
                str(tile_path),
                str(raster_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(
                f"Could not decode terrain tile {tile_key}: {result.stderr.strip()}"
            )

        header_values: dict[str, str] = {}
        with raster_path.with_suffix(".hdr").open(encoding="utf-8") as header_file:
            for line in header_file:
                key, separator, value = line.partition("=")
                if separator:
                    header_values[key.strip().lower()] = value.strip().lower()
        try:
            width = int(header_values["samples"])
            height = int(header_values["lines"])
            bands = int(header_values["bands"])
            data_type = int(header_values["data type"])
            interleave = header_values["interleave"]
        except (KeyError, ValueError) as error:
            raise RuntimeError(
                f"Invalid ENVI header generated for terrain tile {tile_key}."
            ) from error
        if data_type != 1 or interleave != "bsq" or bands < 3:
            raise RuntimeError(
                f"Unsupported terrain raster format for tile {tile_key}."
            )

        pixels = raster_path.read_bytes()
        if len(pixels) != width * height * bands:
            raise RuntimeError(f"Incomplete terrain raster data for tile {tile_key}.")
        decoded_tile = (width, height, bands, pixels)
        self.tile_cache[tile_key] = decoded_tile
        return decoded_tile


def run_ogr2ogr(*arguments: str) -> None:
    result = subprocess.run(
        ["ogr2ogr", *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"ogr2ogr failed: {result.stderr.strip()}")


def normalize_river_archive(
    archive_path: Path = RIVER_ARCHIVE,
) -> tuple[int, int, int]:
    with tempfile.TemporaryDirectory(
        prefix="calterrain-rivers-",
        dir=archive_path.parent,
    ) as temporary_directory:
        temporary_path = Path(temporary_directory)
        source_directory = temporary_path / "source"
        source_directory.mkdir()

        with zipfile.ZipFile(archive_path) as source_archive:
            for member in source_archive.infolist():
                member_path = Path(member.filename)
                if (
                    member_path.name != member.filename
                    or member_path.suffix.lower() not in SHAPEFILE_SUFFIXES
                ):
                    continue
                source_archive.extract(member, source_directory)

        shapefile_paths = list(source_directory.glob("*.shp"))
        if len(shapefile_paths) != 1:
            raise RuntimeError(
                f"Expected one shapefile in {archive_path}, "
                f"found {len(shapefile_paths)}."
            )
        shapefile_path = shapefile_paths[0]
        geojson_path = temporary_path / "rivers.geojson"
        run_ogr2ogr(
            "-f",
            "GeoJSON",
            "-t_srs",
            "EPSG:4326",
            "-dim",
            "XY",
            str(geojson_path),
            str(shapefile_path),
        )

        with geojson_path.open(encoding="utf-8") as geojson_file:
            collection = json.load(geojson_file)

        features = collection.get("features")
        if not isinstance(features, list) or not features:
            raise RuntimeError(f"No river features found in {archive_path}.")

        terrain_sampler = TerrainElevationSampler(
            ROOT / "public/data/terrain/metadata.json",
            temporary_path / "terrain-cache",
        )
        normalized_features = []
        source_path_count = 0
        output_path_count = 0
        for feature in features:
            geometry = feature.get("geometry")
            if not isinstance(geometry, dict):
                raise RuntimeError("River feature is missing its geometry.")
            if geometry.get("type") == "LineString":
                lines = [geometry.get("coordinates", [])]
            elif geometry.get("type") == "MultiLineString":
                lines = geometry.get("coordinates", [])
            else:
                raise RuntimeError(
                    f"Unsupported river geometry type: {geometry.get('type')}."
                )
            if not isinstance(lines, list):
                raise RuntimeError("River feature has invalid line coordinates.")

            source_path_count += len(lines)
            thirty_meter_lines = merge_line_paths(lines, FIRST_PASS_GAP_METERS)
            properties = feature.get("properties")
            name = properties.get("name") if isinstance(properties, dict) else None
            if not isinstance(name, str) or not name:
                raise RuntimeError("River feature is missing its name.")

            for output_name, group_lines in split_named_river(
                name,
                thirty_meter_lines,
            ):
                merged_lines = merge_line_paths(
                    group_lines,
                    SECOND_PASS_GAP_METERS,
                )
                if not merged_lines:
                    raise RuntimeError(
                        f"River feature {output_name} has no valid line paths."
                    )
                ordered_lines = order_lines_by_elevation(
                    merged_lines,
                    terrain_sampler.sample,
                )
                output_path_count += len(ordered_lines)
                normalized_feature = {
                    **feature,
                    "properties": {**properties, "name": output_name},
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": ordered_lines,
                    },
                }
                normalized_features.append(normalized_feature)

        collection["features"] = normalized_features

        normalized_geojson = temporary_path / "normalized_rivers.geojson"
        with normalized_geojson.open("w", encoding="utf-8") as geojson_file:
            json.dump(collection, geojson_file, separators=(",", ":"), allow_nan=False)

        output_directory = temporary_path / "output"
        output_directory.mkdir()
        output_layer_name = shapefile_path.stem
        run_ogr2ogr(
            "-f",
            "ESRI Shapefile",
            "-nln",
            output_layer_name,
            "-nlt",
            "MULTILINESTRING",
            str(output_directory),
            str(normalized_geojson),
        )

        output_shapefile = output_directory / f"{output_layer_name}.shp"
        if not output_shapefile.exists():
            raise RuntimeError(f"ogr2ogr did not create {output_shapefile}.")

        temporary_archive = temporary_path / archive_path.name
        with zipfile.ZipFile(
            temporary_archive,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as output_zip:
            for sidecar in sorted(output_directory.glob(f"{output_layer_name}.*")):
                output_zip.write(sidecar, arcname=sidecar.name)

        temporary_archive.replace(archive_path)

    return len(normalized_features), source_path_count, output_path_count


if __name__ == "__main__":
    feature_count, source_path_count, output_path_count = normalize_river_archive()
    print(
        f"Normalized {feature_count} rivers: {source_path_count} line paths "
        f"became {output_path_count} downhill-ordered paths after "
        f"{FIRST_PASS_GAP_METERS:g} m and {SECOND_PASS_GAP_METERS:g} m passes."
    )
