#!/usr/bin/env python3
"""Create a dissolved California boundary from the county polygons."""

from __future__ import annotations

import argparse
import json
import math
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from osgeo import gdal, ogr, osr


ROOT = Path(__file__).resolve().parents[2]
COUNTY_ARCHIVE = ROOT / "data_sources" / "CA_Counties_simple.zip"
OUTPUT = ROOT / "public" / "data" / "boundaries" / "california.geojson"
WEB_MERCATOR_EPSG = 3857
DEFAULT_MAX_GAP_WIDTH_METERS = 30.0


def extract_county_shapefile(archive: Path, folder: Path) -> Path:
    if not archive.is_file():
        raise FileNotFoundError(f"County boundary archive not found: {archive}")
    destination = folder / archive.stem
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"Unsafe path in county archive: {item.filename}")
            if path.suffix.lower() in {".shp", ".shx", ".dbf", ".prj", ".cpg"}:
                source.extract(item, destination)
    shapefiles = list(destination.glob("*.shp"))
    if len(shapefiles) != 1:
        raise ValueError(
            f"Expected one shapefile in {archive}, found {len(shapefiles)}"
        )
    return shapefiles[0]


def build_california_geometry(
    shapefile: Path,
    max_gap_width_meters: float = DEFAULT_MAX_GAP_WIDTH_METERS,
) -> ogr.Geometry:
    if not math.isfinite(max_gap_width_meters) or max_gap_width_meters < 0:
        raise ValueError("The maximum gap width must be a finite, non-negative number.")

    source = ogr.Open(str(shapefile))
    if source is None:
        raise RuntimeError(f"Could not open county boundaries: {shapefile}")
    layer = source.GetLayer(0)
    if layer is None:
        raise RuntimeError(f"No county boundary layer found in {shapefile}")

    # This source's .prj incorrectly labels its Web Mercator coordinates as Albers.
    county_srs = osr.SpatialReference()
    county_srs.ImportFromEPSG(WEB_MERCATOR_EPSG)
    county_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    dissolved: ogr.Geometry | None = None
    feature_count = 0
    for feature in layer:
        county = feature.GetGeometryRef()
        if county is None:
            raise RuntimeError("A county feature is missing its geometry.")
        county = county.Clone()
        county.AssignSpatialReference(county_srs)
        if not county.IsValid():
            county = county.MakeValid()
        if county is None or county.IsEmpty():
            raise RuntimeError("A county geometry could not be made valid.")
        dissolved = county if dissolved is None else dissolved.Union(county)
        if dissolved is None:
            raise RuntimeError("Could not dissolve the county boundaries.")
        feature_count += 1

    if feature_count == 0 or dissolved is None:
        raise RuntimeError("No county polygons were found.")

    if max_gap_width_meters:
        closing_radius = max_gap_width_meters / 2
        expanded = dissolved.Buffer(closing_radius)
        if expanded is None or expanded.IsEmpty():
            raise RuntimeError("Could not expand the dissolved county geometry.")
        dissolved = expanded.Buffer(-closing_radius)
        if dissolved is None or dissolved.IsEmpty():
            raise RuntimeError("Could not close gaps in the dissolved county geometry.")
        if not dissolved.IsValid():
            dissolved = dissolved.MakeValid()
        if dissolved is None or dissolved.IsEmpty():
            raise RuntimeError("The gap-closed California geometry is invalid.")

    dissolved.AssignSpatialReference(county_srs)
    return dissolved


def round_coordinate_values(value: object) -> object:
    if not isinstance(value, list):
        return value
    if all(isinstance(coordinate, (int, float)) for coordinate in value):
        return [round(coordinate, 6) for coordinate in value]
    return [round_coordinate_values(item) for item in value]


def round_geojson_geometry(geometry: dict[str, object]) -> None:
    coordinates = geometry.get("coordinates")
    if coordinates is not None:
        geometry["coordinates"] = round_coordinate_values(coordinates)
    nested_geometries = geometry.get("geometries")
    if isinstance(nested_geometries, list):
        for nested_geometry in nested_geometries:
            if isinstance(nested_geometry, dict):
                round_geojson_geometry(nested_geometry)


def write_california_geojson(geometry: ogr.Geometry, destination: Path) -> None:
    source_srs = osr.SpatialReference()
    source_srs.ImportFromEPSG(WEB_MERCATOR_EPSG)
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(4326)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_srs, target_srs)

    geographic = geometry.Clone()
    geographic.AssignSpatialReference(source_srs)
    if geographic.Transform(transform) != ogr.OGRERR_NONE:
        raise RuntimeError("Could not transform the county boundary to WGS 84.")
    geojson_geometry = json.loads(geographic.ExportToJson())
    round_geojson_geometry(geojson_geometry)
    feature_collection = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "California"},
                "geometry": geojson_geometry,
            }
        ],
    }
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(feature_collection, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

def create_california_boundary(
    shapefile: Path,
    destination: Path,
    max_gap_width_meters: float = DEFAULT_MAX_GAP_WIDTH_METERS,
) -> ogr.Geometry:
    geometry = build_california_geometry(shapefile, max_gap_width_meters)
    write_california_geojson(geometry, destination)
    return geometry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-gap-width-meters",
        type=float,
        default=DEFAULT_MAX_GAP_WIDTH_METERS,
        help="Close county gaps no wider than this (default: 30 meters).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT,
        help=f"Output GeoJSON path (default: {OUTPUT}).",
    )
    args = parser.parse_args()

    gdal.UseExceptions()
    ogr.UseExceptions()
    with tempfile.TemporaryDirectory(prefix="california-boundary-") as workdir:
        shapefile = extract_county_shapefile(COUNTY_ARCHIVE, Path(workdir))
        create_california_boundary(
            shapefile,
            args.output,
            args.max_gap_width_meters,
        )
    print(f"Wrote dissolved California boundary to {args.output}")


if __name__ == "__main__":
    main()
