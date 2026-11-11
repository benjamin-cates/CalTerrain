import { describe, expect, it } from "bun:test";
import type { BoundaryFeature } from "../types";
import {
  dissolveEcoregionFeatures,
  getEcoregionMapLocalBounds,
  parseEcoregionMapMetadata,
} from "../features/ecoregions";

function level4Feature(
  code: string,
  name: string,
  level3Name: string,
  coordinates: [number, number][][],
): BoundaryFeature {
  return {
    type: "Feature",
    properties: {
      US_L4CODE: code,
      US_L4NAME: name,
      US_L3NAME: level3Name,
    },
    geometry: { type: "Polygon", coordinates },
  };
}

describe("Level IV ecoregion features", () => {
  it("dissolves same-ID polygons while retaining detached pieces and parent names", () => {
    const result = dissolveEcoregionFeatures({
      type: "FeatureCollection",
      features: [
        level4Feature("8a", "Western Range", "Southern California Mountains", [
          [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
        ]),
        level4Feature("8a", "Western Range", "Southern California Mountains", [
          [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]],
        ]),
        level4Feature("8a", "Western Range", "Southern California Mountains", [
          [[4, 0], [5, 0], [5, 1], [4, 1], [4, 0]],
        ]),
      ],
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties).toEqual({
      US_L4CODE: "8a",
      US_L4NAME: "Western Range",
      US_L3NAME: "Southern California Mountains",
    });
    const geometry = result.features[0]?.geometry;
    expect(geometry?.type).toBe("MultiPolygon");
    if (geometry?.type === "MultiPolygon") {
      expect(geometry.coordinates).toHaveLength(2);
    }
  });

  it("rejects inconsistent names for a Level IV code", () => {
    expect(() => dissolveEcoregionFeatures({
      type: "FeatureCollection",
      features: [
        level4Feature("8a", "Western Range", "Southern California Mountains", [
          [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
        ]),
        level4Feature("8a", "Western Range", "Other region", [
          [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]],
        ]),
      ],
    })).toThrow("Ecoregion 8a has inconsistent region names.");
  });
});

describe("ecoregion map metadata", () => {
  it("parses projected dimensions and bounds", () => {
    expect(parseEcoregionMapMetadata({
      projection: "EPSG:3857",
      resolutionMeters: 120,
      paddingPixels: 5,
      width: 20,
      height: 30,
      bounds: { minX: 100, minY: 200, maxX: 2_500, maxY: 3_800 },
    })).toEqual({
      projection: "EPSG:3857",
      resolutionMeters: 120,
      paddingPixels: 5,
      width: 20,
      height: 30,
      bounds: { minX: 100, minY: 200, maxX: 2_500, maxY: 3_800 },
    });
  });

  it("rejects malformed or unsupported metadata", () => {
    expect(() => parseEcoregionMapMetadata({})).toThrow("missing its bounds");
    expect(() => parseEcoregionMapMetadata({
      projection: "EPSG:4326",
      resolutionMeters: 120,
      paddingPixels: 5,
      width: 20,
      height: 30,
      bounds: { minX: 100, minY: 200, maxX: 2_500, maxY: 3_800 },
    })).toThrow("invalid dimensions or projection");
  });

  it("converts map bounds into terrain-local kilometers", () => {
    expect(getEcoregionMapLocalBounds(
      { minX: 1_000, minY: 2_000, maxX: 5_000, maxY: 8_000 },
      [3_000, 6_000],
    )).toEqual([-2, -4, 2, 2]);
  });
});
