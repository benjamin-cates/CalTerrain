# CalTerrain Agent Guide

## Architecture

- `src/App.tsx` owns application state, region actions, and camera focus.
  `src/app/` contains feature-data coordination, terrain export workflows, and
  the terrain image preview.
- `src/Sidebar.tsx` composes feature controls, region editing, analysis menus,
  and export options. Focused UI components live in `src/sidebar/`.
- `src/terrain/` contains tile selection/rendering, terrain sampling, clipping,
  and PNG/GLB export logic. Reuse shared terrain and geometry helpers rather
  than duplicating their calculations.
- `src/scripts/` generates the county-derived California boundary, terrain
  tiles, latitude/longitude grid, BART service-route GeoJSON, unified
  California passenger rail routes, and EPA ecoregion maps. Generated browser
  data lives in `public/data`; source datasets live in `data_sources`.
- See [docs/data-generation.md](./docs/data-generation.md) for the public-data
  inventory, source relationships, regeneration commands, and known gaps.
- The browser loads EPA Level 4 boundaries from
  `public/data/features/CA_Eco_L4.zip`. Regenerate the 120 m Level 3/Level 4
  lossless WebP maps with `bun run generate:ecoregions`. This requires GDAL's
  `ogr2ogr`, `gdal_create`, `gdal_rasterize`, and `gdal_translate` commands;
  map colors come from `public/data/features/ca_ecoregion_colors.json`.
- Regenerate the unified passenger rail routes with
  `python3 src/scripts/generate_california_rail_routes.py`; it updates both
  `public/data/features/california_rail_routes.geojson` and its shapefile ZIP.
  The checked-in MTS and SMART sources are
  `data_sources/mts_trolley_routes.geojson` and `data_sources/SMART.geojson`.
  SACRT input and shapefile ZIP generation require GDAL's `ogr2ogr` command.
- Normalize the checked-in NHD major river archive in place with
  `python3 src/scripts/unify_river_lines.py`. It updates
  `public/data/features/nhd_major_rivers.zip`, joins uniquely nearest river
  path endpoints within 30 meters and then 1 kilometer, splits the distinct
  Tule and Roaring rivers into named features, and orders each line downhill
  using the generated terrain elevations. This requires GDAL's `ogr2ogr` and
  `gdal_translate` commands.

## Project vocabulary

- A **region** is an app-managed spatial object (`Region` in `src/types.ts`)
  used for drawing, editing, analysis, or clipping. It can be an area, line,
  point, or reference to a selected county.
- A **feature** is a source or derived geographic data item, such as a park,
  ecoregion, route, river, or mountain peak. Feature options describe what can
  be shown or selected; converting a feature creates an app-managed region.
- **Terrain** is the streamed elevation-tile data and the 3D surface rendered
  from it. Feature and region geometries are separate from that surface.
- An **overlay** is a visual line or marker rendered over terrain, including
  region outlines, feature boundaries, route shields, and peak markers.

## Coordinate and terrain conventions

- Geographic `Position` tuples are `[longitude, latitude]` in WGS 84.
- `TerrainMetadata.center` is in projected Web Mercator meters. Use `toLocal`
  and `fromLocal` from `src/geo.ts` when converting between geographic
  coordinates and local map coordinates.
- Elevations and terrain sampling values are meters. Reuse the shared terrain
  height decoding and mesh-sampling helpers.
- Keep polygon holes and disconnected line pieces intact in analysis,
  clipping, preview, and export paths.

## Build and test

- Run focused tests with `bun test path/to/file.test.ts`; run `bun test` for
  the full suite.
- Run `bunx tsc --noEmit` for the strict TypeScript check.
- Run `bun run build` to validate the production bundle.
- Terrain generation (`bun run process:terrain`) requires the local GDAL
  toolchain and source data. Do not regenerate large terrain data as part of
  routine code validation.

## Change conventions

- Follow existing React, TypeScript, and Bun patterns; preserve type safety.
- Surface loading, clipboard, analysis, and export failures in the UI rather
  than silently substituting data or reporting success.
- Keep browser-facing data paths under `/data/...` aligned with files served
  from `public/data`.
- Add focused tests for geometry, sampling, parsing, and export behavior when
  changing those areas.

## Product and data decisions

- Use the county-derived California boundary as the canonical clipping mask so
  feature edges and terrain edges agree. Repair invalid source geometry before
  clipping, and preserve polygon holes and disconnected components.
- Prefer compressed shapefile ZIPs for large browser feature datasets when they
  reduce transfer size and the existing loader supports them. Keep source data,
  generated data, and browser URLs distinct.
- Treat the checked-in ecoregion color JSON as the source of truth for map
  generation. Do not substitute `.lyr` colors or an approximate CMYK formula.
- Ecoregions are logical features, not man-made features. Keep Level III and
  Level IV controls with the feature list rather than lighting controls; picking
  an ecoregion map clears the lighting selection.
- Keep feature details and actions in the feature-list panel. Preserve scroll
  stability while details are open or a search is active; show View/Cut actions
  for map-click details too, with Back only for inline list details. Promote a
  feature to quick access only when fewer than 10 are visible or cut.
