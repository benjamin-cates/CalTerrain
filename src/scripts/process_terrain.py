#!/usr/bin/env python3
"""Build buffered Web Mercator Terrain-RGB tiles for California."""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image

from create_california_boundary import (
    COUNTY_ARCHIVE,
    DEFAULT_MAX_GAP_WIDTH_METERS,
    create_california_boundary,
    extract_county_shapefile,
)


ROOT = Path(__file__).resolve().parents[2]
SOURCE_RASTERS = ROOT / "data_sources" / "USGS"
OUTPUT = ROOT / "public" / "data"
WORLD_METERS = 40_075_016.68557849
NODATA = -99_999
TILE_SIZE = 256
TILE_BORDER = 1
TILE_RASTER_SIZE = TILE_SIZE + 1 + 2 * TILE_BORDER
STATE_EDGE_BUFFER_PIXELS = 5
WEB_MERCATOR = "EPSG:3857"
WARP_TRANSFORMER_OPTIONS = ["ONLY_BEST=YES", "ALLOW_BALLPARK=NO"]


class ProgressBar:
    def __init__(self, label: str, total: int) -> None:
        self.label = label
        self.total = total
        self.completed = 0
        self.stream = sys.stderr
        self.is_tty = self.stream.isatty()
        self.last_percent = 0
        self.last_reported_at = 0.0
        if self.is_tty:
            self._render(0 if total else 100)
        elif total == 0:
            self._render(100)

    def advance(self) -> None:
        if self.completed >= self.total:
            raise RuntimeError(f"Progress exceeded its total for {self.label}.")
        self.completed += 1
        percent = self.completed * 100 // self.total
        now = time.monotonic()

        if self.is_tty:
            if (
                percent == self.last_percent
                and percent < 100
                and now - self.last_reported_at < 0.1
            ):
                return
        elif percent < 100 and percent // 10 == self.last_percent // 10:
            return

        self._render(percent)

    def finish(self) -> None:
        if self.completed != self.total:
            raise RuntimeError(
                f"Progress ended at {self.completed}/{self.total} for {self.label}."
            )

    def _render(self, percent: int) -> None:
        width = 24
        filled = round(width * percent / 100)
        bar = "#" * filled + "-" * (width - filled)
        message = (
            f"{self.label} [{bar}] {percent:3d}% "
            f"({self.completed}/{self.total})"
        )
        if self.is_tty:
            line_ending = "\n" if percent == 100 else ""
            self.stream.write(f"\r{message}{line_ending}")
        else:
            self.stream.write(f"{message}\n")
        self.stream.flush()
        self.last_percent = percent
        self.last_reported_at = time.monotonic()


def export_geojson(
    shapefile: Path,
    destination: Path,
    source_srs: str | None = None,
) -> None:
    options = {"format": "GeoJSON", "dstSRS": "EPSG:4326"}
    if source_srs is not None:
        options["srcSRS"] = source_srs
    result = gdal.VectorTranslate(
        str(destination),
        str(shapefile),
        options=gdal.VectorTranslateOptions(**options),
    )
    if result is None:
        raise RuntimeError(f"Could not export boundary data: {shapefile}")
    result = None


def create_california_layer(
    geometry: ogr.Geometry,
) -> tuple[ogr.DataSource, ogr.Layer, osr.SpatialReference]:
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(3857)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    memory_source = ogr.GetDriverByName("MEM").CreateDataSource("")
    layer = memory_source.CreateLayer("california", target_srs, ogr.wkbUnknown)
    feature = ogr.Feature(layer.GetLayerDefn())
    feature.SetGeometry(geometry)
    if layer.CreateFeature(feature) != ogr.OGRERR_NONE:
        raise RuntimeError("Could not prepare the dissolved California boundary.")
    return memory_source, layer, target_srs


def buffer_state_layer(
    source_layer: ogr.Layer,
    target_srs: osr.SpatialReference,
    distance_meters: float,
) -> tuple[ogr.DataSource, ogr.Layer]:
    memory_source = ogr.GetDriverByName("MEM").CreateDataSource("")
    layer = memory_source.CreateLayer("california_buffer", target_srs, ogr.wkbUnknown)
    source_layer.ResetReading()
    for source_feature in source_layer:
        source_geometry = source_feature.GetGeometryRef()
        if source_geometry is None:
            raise RuntimeError("The projected California boundary contains a feature without geometry.")
        geometry = source_geometry.Buffer(distance_meters)
        if geometry is None:
            raise RuntimeError("Could not buffer the California boundary.")
        if geometry.IsEmpty():
            continue
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetGeometry(geometry)
        if layer.CreateFeature(feature) != ogr.OGRERR_NONE:
            raise RuntimeError("Could not prepare the buffered California boundary.")
    return memory_source, layer


def rasterize_state_buffer(
    layer: ogr.Layer,
    target_srs: osr.SpatialReference,
    zoom: int,
    x: int,
    y: int,
) -> np.ndarray:
    tile_width = WORLD_METERS / (2**zoom)
    pixel_size = tile_width / TILE_SIZE
    min_x = x * tile_width - WORLD_METERS / 2
    max_y = WORLD_METERS / 2 - y * tile_width
    border_extent = (TILE_BORDER + 0.5) * pixel_size
    mask = gdal.GetDriverByName("MEM").Create(
        "", TILE_RASTER_SIZE, TILE_RASTER_SIZE, 1, gdal.GDT_Byte,
    )
    mask.SetProjection(target_srs.ExportToWkt())
    mask.SetGeoTransform((
        min_x - border_extent,
        pixel_size,
        0,
        max_y + border_extent,
        0,
        -pixel_size,
    ))
    layer.ResetReading()
    if gdal.RasterizeLayer(mask, [1], layer, burn_values=[255]) != gdal.CE_None:
        raise RuntimeError(f"Could not rasterize buffered state mask for tile {zoom}/{x}/{y}.")
    return mask.GetRasterBand(1).ReadAsArray() > 0


def save_lossless_webp(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(
        destination,
        format="WEBP",
        lossless=True,
        quality=100,
        method=6,
        exact=True,
    )


def encode_elevation(
    dataset: gdal.Dataset,
    destination: Path,
    state_buffer_mask: np.ndarray,
) -> bool:
    band = dataset.GetRasterBand(1)
    elevation = band.ReadAsArray()
    valid = band.GetMaskBand().ReadAsArray() != 0
    nodata = band.GetNoDataValue()
    if nodata is not None:
        valid &= elevation != nodata
    valid &= np.isfinite(elevation)
    if state_buffer_mask.shape != elevation.shape:
        raise ValueError("The buffered state mask does not match the terrain tile dimensions.")
    if not np.any(state_buffer_mask):
        return False

    encoded = np.zeros((*elevation.shape, 4), dtype=np.uint8)
    encoded[..., 0] = 128
    encoded[..., 3] = 255
    valid &= state_buffer_mask
    meters = np.clip(np.floor(elevation[valid] + 0.5), -32_768, 32_767).astype(np.int32) + 32_768
    encoded[valid, 0] = (meters >> 8).astype(np.uint8)
    encoded[valid, 1] = (meters & 255).astype(np.uint8)
    save_lossless_webp(Image.fromarray(encoded, mode="RGBA"), destination)
    return True


def reconcile_regions(regions: list[np.ndarray]) -> None:
    valid = np.stack([region[..., 3] > 0 for region in regions])
    counts = valid.sum(axis=0)
    if not np.any(counts):
        for region in regions:
            region[...] = 0
        return

    elevations = np.stack(
        [
            region[..., 0].astype(np.float64) * 256
            + region[..., 1]
            + region[..., 2] / 256
            - 32_768
            for region in regions
        ]
    )
    total = np.where(valid, elevations, 0).sum(axis=0)
    rounded = np.floor(total / np.maximum(counts, 1) + 0.5)
    encoded = np.clip(rounded, -32_768, 32_767).astype(np.int32) + 32_768
    has_elevation = counts > 0

    # Keep each tile's source alpha when reconciling its shared samples.
    for region, region_valid in zip(regions, valid):
        region[..., 0] = np.where(has_elevation, encoded >> 8, 0).astype(np.uint8)
        region[..., 1] = np.where(has_elevation, encoded & 255, 0).astype(np.uint8)
        region[..., 2] = 0
        region[..., 3] = np.where(region_valid, 255, 0).astype(np.uint8)


def normalize_shared_tile_edges(tile_keys: list[str], terrain_directory: Path) -> None:
    coordinates_by_zoom: dict[int, set[tuple[int, int]]] = {}
    for key in tile_keys:
        zoom, x, y = map(int, key.split("/"))
        coordinates_by_zoom.setdefault(zoom, set()).add((x, y))

    for zoom, coordinates in sorted(coordinates_by_zoom.items()):
        ordered_coordinates = sorted(coordinates)
        corner_xs = {x + offset for x, _ in coordinates for offset in (0, 1)}
        corner_ys = {y + offset for _, y in coordinates for offset in (0, 1)}
        progress = ProgressBar(
            f"Aligning z{zoom}",
            len(ordered_coordinates) * 3 + len(corner_xs) * len(corner_ys),
        )
        tiles: dict[tuple[int, int], tuple[Path, np.ndarray]] = {}
        for x, y in ordered_coordinates:
            path = terrain_directory / "tiles" / str(zoom) / str(x) / f"{y}.webp"
            with Image.open(path) as image:
                pixels = np.asarray(image.convert("RGBA")).copy()
            if pixels.shape[:2] != (TILE_RASTER_SIZE, TILE_RASTER_SIZE):
                raise ValueError(
                    f"Expected a {TILE_RASTER_SIZE} px buffered tile at {path}, "
                    f"got {pixels.shape[:2]}"
                )
            tiles[(x, y)] = (path, pixels)
            progress.advance()

        for x, y in ordered_coordinates:
            pixels = tiles[(x, y)][1]
            east = tiles.get((x + 1, y))
            if east:
                reconcile_regions([pixels[3:256, 256:259], east[1][3:256, 0:3]])

            south = tiles.get((x, y + 1))
            if south:
                reconcile_regions([pixels[256:259, 3:256], south[1][0:3, 3:256]])
            progress.advance()

        for corner_x in sorted(corner_xs):
            for corner_y in sorted(corner_ys):
                corners = (
                    (tiles.get((corner_x - 1, corner_y - 1)), (256, 259, 256, 259)),
                    (tiles.get((corner_x, corner_y - 1)), (256, 259, 0, 3)),
                    (tiles.get((corner_x - 1, corner_y)), (0, 3, 256, 259)),
                    (tiles.get((corner_x, corner_y)), (0, 3, 0, 3)),
                )
                regions = [
                    pixels[row_start:row_end, column_start:column_end]
                    for tile, (row_start, row_end, column_start, column_end) in corners
                    if tile is not None
                    for pixels in (tile[1],)
                ]
                if len(regions) > 1:
                    reconcile_regions(regions)
                progress.advance()

        for coordinate in ordered_coordinates:
            path, pixels = tiles[coordinate]
            save_lossless_webp(Image.fromarray(pixels, mode="RGBA"), path)
            progress.advance()
        progress.finish()


def remove_legacy_terrain_images(terrain_directory: Path) -> int:
    legacy_paths = [
        terrain_directory / "overview.webp",
        terrain_directory / "overview.png",
    ]
    legacy_paths.extend((terrain_directory / "tiles").rglob("*.png"))
    removed = 0
    for path in legacy_paths:
        if path.is_file():
            path.unlink()
            removed += 1
    return removed


def tile_range(bounds: tuple[float, float, float, float], zoom: int) -> tuple[range, range]:
    min_x, min_y, max_x, max_y = bounds
    count = 2**zoom
    tile_width = WORLD_METERS / count
    min_tile_x = max(0, math.floor((min_x + WORLD_METERS / 2) / tile_width))
    max_tile_x = min(count - 1, math.floor((max_x + WORLD_METERS / 2) / tile_width))
    min_tile_y = max(0, math.floor((WORLD_METERS / 2 - max_y) / tile_width))
    max_tile_y = min(count - 1, math.floor((WORLD_METERS / 2 - min_y) / tile_width))
    return range(min_tile_x, max_tile_x + 1), range(min_tile_y, max_tile_y + 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-zoom", type=int, default=11, choices=range(8, 12))
    args = parser.parse_args()

    gdal.UseExceptions()
    ogr.UseExceptions()
    rasters = sorted(SOURCE_RASTERS.glob("*.tif"))
    if not rasters:
        raise FileNotFoundError(f"No USGS GeoTIFF files found in {SOURCE_RASTERS}")

    print(f"Found {len(rasters)} USGS elevation rasters.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    boundary_output = OUTPUT / "boundaries"
    terrain_output = OUTPUT / "terrain"

    with tempfile.TemporaryDirectory(prefix="california-terrain-") as workdir:
        work = Path(workdir)
        county_shapefile = extract_county_shapefile(COUNTY_ARCHIVE, work)
        california_geometry = create_california_boundary(
            county_shapefile,
            boundary_output / "california.geojson",
            DEFAULT_MAX_GAP_WIDTH_METERS,
        )
        export_geojson(
            county_shapefile,
            boundary_output / "counties.geojson",
            source_srs=WEB_MERCATOR,
        )
        projected_state_memory, projected_state_layer, target_srs = create_california_layer(
            california_geometry,
        )
        min_x, max_x, min_y, max_y = projected_state_layer.GetExtent()
        bounds = (min_x, min_y, max_x, max_y)

        vrt_path = work / "usgs.vrt"
        vrt = gdal.BuildVRT(str(vrt_path), [str(path) for path in rasters])
        if vrt is None:
            raise RuntimeError("GDAL could not combine the USGS GeoTIFF files.")
        vrt = None

        tile_keys: list[str] = []
        zoom_levels = list(range(8, args.max_zoom + 1))

        for zoom in zoom_levels:
            tile_width = WORLD_METERS / (2**zoom)
            pixel_size = tile_width / TILE_SIZE
            buffer_distance = STATE_EDGE_BUFFER_PIXELS * pixel_size
            buffered_state_memory, buffered_state_layer = buffer_state_layer(
                projected_state_layer,
                target_srs,
                buffer_distance,
            )
            buffered_bounds = (
                bounds[0] - buffer_distance,
                bounds[1] - buffer_distance,
                bounds[2] + buffer_distance,
                bounds[3] + buffer_distance,
            )
            xs, ys = tile_range(buffered_bounds, zoom)
            progress = ProgressBar(f"Processing z{zoom}", len(xs) * len(ys))
            for y in ys:
                for x in xs:
                    min_x = x * tile_width - WORLD_METERS / 2
                    max_x = (x + 1) * tile_width - WORLD_METERS / 2
                    max_y = WORLD_METERS / 2 - y * tile_width
                    min_y = WORLD_METERS / 2 - (y + 1) * tile_width
                    border_extent = (TILE_BORDER + 0.5) * pixel_size
                    tile = gdal.Warp(
                        "",
                        str(vrt_path),
                        format="MEM",
                        dstSRS=WEB_MERCATOR,
                        outputBounds=(
                            min_x - border_extent,
                            min_y - border_extent,
                            max_x + border_extent,
                            max_y + border_extent,
                        ),
                        width=TILE_RASTER_SIZE,
                        height=TILE_RASTER_SIZE,
                        dstNodata=NODATA,
                        outputType=gdal.GDT_Float32,
                        resampleAlg="bilinear",
                        multithread=True,
                        transformerOptions=WARP_TRANSFORMER_OPTIONS,
                    )
                    if tile is None:
                        raise RuntimeError(f"GDAL failed to render detail tile {zoom}/{x}/{y}.")
                    destination = terrain_output / "tiles" / str(zoom) / str(x) / f"{y}.webp"
                    state_buffer_mask = rasterize_state_buffer(
                        buffered_state_layer,
                        target_srs,
                        zoom,
                        x,
                        y,
                    )
                    if encode_elevation(tile, destination, state_buffer_mask):
                        tile_keys.append(f"{zoom}/{x}/{y}")
                    tile = None
                    progress.advance()
            progress.finish()

        print("Aligning shared tile edges...")
        normalize_shared_tile_edges(tile_keys, terrain_output)

        metadata = {
            "bounds": {
                "minX": bounds[0],
                "minY": bounds[1],
                "maxX": bounds[2],
                "maxY": bounds[3],
            },
            "center": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
            "crs": WEB_MERCATOR,
            "encoding": "Terrarium RGB; elevation meters = R * 256 + G + B / 256 - 32768",
            "imageFormat": "lossless WebP",
            "tiles": tile_keys,
            "tileSize": TILE_SIZE,
            "tileBorderPixels": TILE_BORDER,
            "verticalExaggeration": 3,
            "zoomLevels": zoom_levels,
        }
        metadata_path = terrain_output / "metadata.json"
        metadata_path.write_text(json.dumps(metadata, separators=(",", ":")) + "\n")
        removed_legacy_images = remove_legacy_terrain_images(terrain_output)

    print(
        f"Done. Wrote {len(tile_keys)} buffered lossless WebP terrain tiles "
        f"and California boundary GeoJSON under {OUTPUT}."
    )
    if removed_legacy_images:
        print(f"Removed {removed_legacy_images} obsolete terrain images.")


if __name__ == "__main__":
    main()
