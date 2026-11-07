# CalTerrain Agent Guide

## Architecture

- `src/App.tsx` owns application state, data coordination, region actions,
  camera focus, and export workflows.
- `src/Sidebar.tsx` contains feature controls, region editing, analysis menus,
  and export options.
- `src/terrain/` contains tile selection/rendering, terrain sampling, clipping,
  and PNG/GLB export logic. Reuse shared terrain and geometry helpers rather
  than duplicating their calculations.
- `src/scripts/` generates the county-derived California boundary, terrain
  tiles, latitude/longitude grid, BART service-route GeoJSON, and unified
  California passenger rail routes. Generated browser data lives in
  `public/data`; source datasets live in `data_sources`.
- Regenerate the unified passenger rail routes with
  `python3 src/scripts/generate_california_rail_routes.py`; it updates both
  `public/data/features/california_rail_routes.geojson` and its shapefile ZIP.
  The checked-in MTS and SMART sources are
  `data_sources/mts_trolley_routes.geojson` and `data_sources/SMART.geojson`.
  SACRT input and shapefile ZIP generation require GDAL's `ogr2ogr` command.

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
