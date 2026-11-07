#!/usr/bin/env python3
"""Remove outside-state pixels exposed by legacy shared-tile mask reconciliation."""

from __future__ import annotations

import argparse
import os
import stat
import tempfile
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr


ROOT = Path(__file__).resolve().parents[2]
TERRAIN_DIRECTORY = ROOT / "public" / "data" / "terrain"
BOUNDARY_PATH = ROOT / "public" / "data" / "boundaries" / "california.geojson"
WORLD_METERS = 40_075_016.68557849
TILE_SIZE = 256
TILE_BORDER = 1
TILE_RASTER_SIZE = TILE_SIZE + 1 + 2 * TILE_BORDER


def load_state_layer() -> tuple[ogr.DataSource, ogr.Layer, osr.SpatialReference]:
    source = ogr.Open(str(BOUNDARY_PATH))
    if source is None:
        raise RuntimeError(f"Could not open California boundary: {BOUNDARY_PATH}")
    source_layer = source.GetLayer(0)
    source_srs = source_layer.GetSpatialRef()
    if source_srs is None:
        raise RuntimeError("The California boundary has no coordinate reference system.")
    source_srs = source_srs.Clone()
    source_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    target_srs = osr.SpatialReference()
    target_srs.ImportFromEPSG(3857)
    target_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = osr.CoordinateTransformation(source_srs, target_srs)

    memory_source = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = memory_source.CreateLayer("california", target_srs, ogr.wkbMultiPolygon)
    for source_feature in source_layer:
        source_geometry = source_feature.GetGeometryRef()
        if source_geometry is None:
            raise RuntimeError("The California boundary contains a feature without geometry.")
        geometry = ogr.CreateGeometryFromWkb(source_geometry.ExportToWkb())
        if geometry is None or geometry.Transform(transform) != ogr.OGRERR_NONE:
            raise RuntimeError("Could not project the California boundary to Web Mercator.")
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetGeometry(geometry)
        if layer.CreateFeature(feature) != ogr.OGRERR_NONE:
            raise RuntimeError("Could not prepare the projected California boundary.")
    return memory_source, layer, target_srs


def rasterize_state_mask(
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
        raise RuntimeError(f"Could not rasterize state mask for tile {zoom}/{x}/{y}.")
    return mask.GetRasterBand(1).ReadAsArray()


def replace_tile_alpha(path: Path, alpha: np.ndarray) -> None:
    source = gdal.Open(str(path), gdal.GA_ReadOnly)
    if source is None:
        raise RuntimeError(f"Could not open terrain tile: {path}")
    if (source.RasterXSize, source.RasterYSize) != (TILE_RASTER_SIZE, TILE_RASTER_SIZE):
        raise RuntimeError(f"Unexpected dimensions for terrain tile: {path}")

    image = gdal.GetDriverByName("MEM").Create(
        "", TILE_RASTER_SIZE, TILE_RASTER_SIZE, 4, gdal.GDT_Byte,
    )
    for index, color in enumerate(
        (gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand),
        start=1,
    ):
        output_band = image.GetRasterBand(index)
        output_band.WriteArray(source.GetRasterBand(index).ReadAsArray())
        output_band.SetColorInterpretation(color)
    alpha_band = image.GetRasterBand(4)
    alpha_band.WriteArray(alpha)
    alpha_band.SetColorInterpretation(gdal.GCI_AlphaBand)

    file_descriptor, temporary_name = tempfile.mkstemp(
        suffix=".webp",
        dir=path.parent,
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    temporary_path.unlink()
    try:
        written = gdal.GetDriverByName("WEBP").CreateCopy(
            str(temporary_path),
            image,
            options=["LOSSLESS=YES", "QUALITY=100", "METHOD=6", "EXACT=1"],
        )
        if written is None:
            raise RuntimeError(f"Could not write repaired terrain tile: {path}")
        written = None

        verification = gdal.Open(str(temporary_path), gdal.GA_ReadOnly)
        if verification is None or verification.RasterCount != 4:
            raise RuntimeError(f"Repaired tile did not retain an alpha band: {path}")
        repaired_alpha = verification.GetRasterBand(4).ReadAsArray()
        if not np.array_equal(repaired_alpha, alpha):
            raise RuntimeError(f"Repaired tile alpha verification failed: {path}")
        verification = None

        os.chmod(temporary_path, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def repair_tiles(apply: bool) -> tuple[int, int]:
    memory_source, layer, target_srs = load_state_layer()
    tile_paths = sorted(TERRAIN_DIRECTORY.glob("tiles/*/*/*.webp"))
    changed_tiles = 0
    removed_pixels = 0

    for index, path in enumerate(tile_paths, start=1):
        zoom, x, y = map(int, (path.parents[1].name, path.parent.name, path.stem))
        source = gdal.Open(str(path), gdal.GA_ReadOnly)
        if source is None:
            raise RuntimeError(f"Could not open terrain tile: {path}")
        original_alpha = (
            source.GetRasterBand(4).ReadAsArray()
            if source.RasterCount >= 4
            else np.full((TILE_RASTER_SIZE, TILE_RASTER_SIZE), 255, dtype=np.uint8)
        )
        state_mask = rasterize_state_mask(layer, target_srs, zoom, x, y) > 0
        repaired_alpha = np.where(state_mask, original_alpha, 0).astype(np.uint8)
        removed = int(np.count_nonzero((original_alpha > 0) & (repaired_alpha == 0)))

        if removed:
            changed_tiles += 1
            removed_pixels += removed
            if apply:
                replace_tile_alpha(path, repaired_alpha)
        if index % 100 == 0 or index == len(tile_paths):
            print(f"Checked {index}/{len(tile_paths)} terrain tiles.")

    return changed_tiles, removed_pixels


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="rewrite WebP alpha masks; without this flag, only report affected tiles",
    )
    args = parser.parse_args()

    gdal.UseExceptions()
    changed_tiles, removed_pixels = repair_tiles(args.apply)
    action = "Repaired" if args.apply else "Would repair"
    print(f"{action} {removed_pixels} outside-state pixels in {changed_tiles} terrain tiles.")


if __name__ == "__main__":
    main()
