import { describe, expect, it } from "bun:test";
import { filterBoundaryCollection, getBoundaryFeatureOptions } from "../terrain/boundaryShapefile";
import type { ShapefileFeatureCollection } from "shpjs";
import type { BoundaryCollection } from "../types";

function makeBoundaryCollection(properties: Record<string, unknown>[]): BoundaryCollection {
  return {
    type: "FeatureCollection",
    features: properties.map((featureProperties) => ({
      type: "Feature",
      properties: featureProperties,
      geometry: {
        type: "Polygon",
        coordinates: [[
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ]],
      },
    })),
  };
}

describe("boundary shapefile features", () => {
  it("filters out shapefile records without boundary geometry", () => {
    const parsed: ShapefileFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { code: "A" },
          geometry: {
            type: "Polygon",
            coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
          },
        },
        { type: "Feature", properties: { code: "B" }, geometry: null },
      ],
    };

    expect(filterBoundaryCollection(parsed)?.features.map((feature) => feature.properties.code))
      .toEqual(["A"]);
    expect(filterBoundaryCollection({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { code: "B" }, geometry: null }],
    })).toBeNull();
  });

  it("creates sorted feature options from configured ID and name fields", () => {
    const collection = makeBoundaryCollection([
      { code: "B", name: "Beta" },
      { code: "A", name: "Alpha" },
    ]);

    expect(getBoundaryFeatureOptions(collection, "Park", "code", "name")).toEqual([
      {
        id: "A",
        label: "Alpha",
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
        },
      },
      {
        id: "B",
        label: "Beta",
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
        },
      },
    ]);
  });

  it("rejects duplicate IDs and missing feature names", () => {
    const duplicateIds = makeBoundaryCollection([
      { code: "A", name: "Alpha" },
      { code: "A", name: "Another Alpha" },
    ]);
    const missingName = makeBoundaryCollection([{ code: "A" }]);

    expect(() => getBoundaryFeatureOptions(duplicateIds, "Forest", "code", "name"))
      .toThrow("duplicate feature IDs");
    expect(() => getBoundaryFeatureOptions(missingName, "Forest", "code", "name"))
      .toThrow("missing its ID or name");
  });
});
