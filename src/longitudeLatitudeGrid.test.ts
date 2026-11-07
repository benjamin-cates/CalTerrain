import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createLongitudeLatitudeGrid, longitudeLatitudeCellId } from "./longitudeLatitudeGrid";
import type { BoundaryCollection } from "./types";

const californiaBoundary: BoundaryCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-124.5, 40],
        [-122.2, 40],
        [-122.2, 42.2],
        [-124.5, 42.2],
        [-124.5, 40],
      ]],
    },
  }],
};

describe("California longitude and latitude grid", () => {
  test("includes only one-degree cells intersecting the California boundary", () => {
    const grid = createLongitudeLatitudeGrid(californiaBoundary);

    expect(grid.features).toHaveLength(9);
    expect(grid.features.map(longitudeLatitudeCellId)).toEqual([
      "lonlat--125-40",
      "lonlat--125-41",
      "lonlat--125-42",
      "lonlat--124-40",
      "lonlat--124-41",
      "lonlat--124-42",
      "lonlat--123-40",
      "lonlat--123-41",
      "lonlat--123-42",
    ]);
  });

  test("uses one-degree bounds and coordinate-based names", () => {
    const [cell] = createLongitudeLatitudeGrid(californiaBoundary).features;

    expect(cell?.properties.name).toBe("-124° to -125° W; 40° to 41° N");
    expect(cell?.geometry).toEqual({
      type: "Polygon",
      coordinates: [[
        [-125, 40],
        [-124, 40],
        [-124, 41],
        [-125, 41],
        [-125, 40],
      ]],
    });
  });

  test("returns an empty collection when the California boundary is unavailable", () => {
    expect(createLongitudeLatitudeGrid(null)).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  test("includes a small boundary component contained within a single cell", () => {
    const boundary: BoundaryCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-124.8, 40.2],
            [-124.2, 40.2],
            [-124.2, 40.8],
            [-124.8, 40.8],
            [-124.8, 40.2],
          ]],
        },
      }],
    };

    expect(createLongitudeLatitudeGrid(boundary).features.map(longitudeLatitudeCellId))
      .toEqual(["lonlat--125-40"]);
  });

  test("excludes a grid cell that falls entirely inside a boundary hole", () => {
    const boundary: BoundaryCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-2, -2],
              [2, -2],
              [2, 2],
              [-2, 2],
              [-2, -2],
            ],
            [
              [-1, -1],
              [-1, 0],
              [0, 0],
              [0, -1],
              [-1, -1],
            ],
          ],
        },
      }],
    };

    expect(createLongitudeLatitudeGrid(boundary).features.map(longitudeLatitudeCellId))
      .not.toContain("lonlat--1--1");
  });

  test("keeps the checked-in grid data in sync with the California boundary", async () => {
    const california = JSON.parse(
      await readFile(new URL("../public/data/boundaries/california.geojson", import.meta.url), "utf8"),
    ) as BoundaryCollection;
    const generatedGrid = JSON.parse(
      await readFile(
        new URL("../public/data/boundaries/longitude_latitude_cells.geojson", import.meta.url),
        "utf8",
      ),
    ) as BoundaryCollection;

    expect(generatedGrid).toEqual(createLongitudeLatitudeGrid(california));
  });
});
