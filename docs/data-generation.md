# Browser data and regeneration

The browser fetches files from `/data/...`; those files are stored under
`public/data`. Checked-in source datasets are generally under `data_sources`.
When changing a generated dataset, update its source or generator and rerun the
narrowest applicable command rather than editing a generated output by hand.

## Reproducible outputs

| Browser data | Source and generation |
| --- | --- |
| `boundaries/california.geojson` | `data_sources/CA_Counties_simple.zip`; run `python3 src/scripts/create_california_boundary.py`. This dissolves the county polygons, repairs invalid geometry, closes gaps up to 30 m in projected meters, and writes WGS 84 GeoJSON. The source `.prj` mislabels its Web Mercator coordinates, so the script explicitly assigns EPSG:3857 before processing. |
| `boundaries/counties.geojson` | Exported from the same county archive by `python3 src/scripts/process_terrain.py` (or `bun run process:terrain`). |
| `boundaries/longitude_latitude_cells.geojson` | Derived from `california.geojson`; run `bun run generate:grid`. |
| `terrain/tiles/**`, `terrain/metadata.json` | Generated from `data_sources/USGS/*.tif` and the county archive by `bun run process:terrain`. It also regenerates the California and county GeoJSON boundaries, then the latitude/longitude grid. |
| `features/ca_ecoregions_l3.webp`, `features/ca_ecoregions_l4.webp`, `features/ca_ecoregion_map.json` | Run `bun run generate:ecoregions`; details below. |
| `features/bart_routes.geojson` | Run `python3 src/scripts/convert_bart_kml.py` with `data_sources/bart.kml`. |
| `features/california_rail_routes.geojson`, `features/california_rail_routes.zip` | First generate `bart_routes.geojson`, then run `python3 src/scripts/generate_california_rail_routes.py`. Inputs also include the Amtrak, LA Metro, SacRT, MTS, SMART, and other California rail datasets in `data_sources`. ZIP creation uses GDAL's `ogr2ogr`. |
| `features/nhd_major_rivers.zip` | `python3 src/scripts/unify_river_lines.py` normalizes this existing archive in place. It needs the generated terrain metadata and tiles to order river paths downhill; it is not a converter from `data_sources/nhd_major_rivers.gpkg`. |

`bun run process:terrain` is the large, expensive operation. It requires the
USGS GeoTIFFs, Python GDAL bindings matching GDAL 3.13.3, NumPy, Pillow, and
Bun. Install the Python packages from
[`src/scripts/requirements-terrain.txt`](../src/scripts/requirements-terrain.txt).
The pipeline creates lossless WebP Terrarium elevation tiles at zoom levels
8–11, with 256 px tiles, a 1 px shared-sample border, and a 5 px state-edge
buffer. Avoid rerunning it for routine code validation.

The boundary-only command is useful when only the canonical state geometry
needs to be refreshed. Run `bun run generate:grid` afterward if the grid also
needs to match that boundary. The `.zip` shapefile copies of the California and
county boundaries are browser inputs too, but the boundary and terrain scripts
currently write GeoJSON; there is no checked-in command to rebuild those ZIPs.

## Ecoregion maps

`bun run generate:ecoregions` reads:

- `public/data/features/CA_Eco_L4.zip` for Level IV polygons and their
  `US_L3CODE`/`US_L4CODE` attributes;
- `public/data/boundaries/california.geojson` for the common state mask; and
- `public/data/features/ca_ecoregion_colors.json` for the checked-in
  identifier-to-hex palette.

The JSON contains 13 Level III and 180 Level IV identifiers. It was derived
from `data_sources/CA_eco_back_ofr20161021_sheet2.pdf`. The PDF has DeviceCMYK
colors but no output intent/profile; the values were converted with PDF.js's
SWOP-based `DeviceCmykCS` conversion, not the simple `(1-C)(1-K)` approximation.
The [PDF.js color-space implementation](https://github.com/mozilla/pdf.js/blob/master/src/core/colorspace.js)
describes that conversion. There is currently no checked-in extractor to
rebuild the JSON from the PDF; treat the JSON as the map-generation source of
truth. The generator fails if any polygon ID is missing from it; it does not
silently fall back to `.lyr` colors.

The maps use EPSG:3857 at 120 m per pixel, include 5 px of transparent padding
outside the state boundary, and are lossless RGBA WebP. The generated metadata
records their dimensions and bounds. Alpha is rasterized from the state
boundary separately from the ecoregion polygons, so pixels inside California
that are not covered by an ecoregion polygon can be opaque black; this is a
coverage gap, not a palette entry.

Generation requires `ogr2ogr`, `gdal_create`, `gdal_rasterize`, and
`gdal_translate`. To inspect an output's dimensions, bands, and lossless
encoding, use:

```sh
gdalinfo -json public/data/features/ca_ecoregions_l3.webp
gdalinfo -json public/data/features/ca_ecoregions_l4.webp
```

## Imported data and generation gaps

Some browser assets are imported or manually processed rather than produced by
a checked-in generator. Examples include `boundaries/california.zip`,
`boundaries/counties.zip`, the clipped `national_parks.zip` and
`national_forests.zip`, highway and lake archives, and `features/CA_mountains.tsv`.
The ecoregion archive and `.lyr` files are also checked-in inputs. Keep their
source/provenance when replacing them; do not assume there is a local command
that can recreate them.

`data_sources/nhd_major_rivers.gpkg` is retained as source data, but the river
normalizer only rewrites `public/data/features/nhd_major_rivers.zip`. Rebuilding
that archive from the GPKG requires a separate export/packaging step that is
not currently scripted.
