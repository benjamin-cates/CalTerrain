import { describe, expect, test } from "bun:test";
import shp from "shpjs";
import { geographicToMercator } from "../geo";
import {
  createLakeMeshGeometry,
  getLakePerimeterMedianElevation,
  getLakePerimeterRings,
  getLakeShoreElevation,
  lakeFeatureName,
} from "../features/lakes";
import { filterBoundaryCollection, getBoundaryFeatureOptions } from "../terrain/boundaryShapefile";
import type { BoundaryFeature } from "../types";

const lake: BoundaryFeature = {
  type: "Feature",
  properties: { FID: 1, GlobalID: "lake-1", NAME: "Test Lake" },
  geometry: {
    type: "Polygon",
    coordinates: [[
      [-120, 35],
      [-119.99, 35],
      [-119.99, 35.01],
      [-120, 35.01],
      [-120, 35],
    ]],
  },
};

describe("lake features", () => {
  test("loads named, uniquely identified polygons from the lake archive", async () => {
    const archive = Bun.file(
      new URL("../../public/data/features/California_Lakes_mini.zip", import.meta.url),
    );
    const collection = filterBoundaryCollection(await shp(await archive.arrayBuffer()));

    expect(collection).not.toBeNull();
    expect(collection?.features).toHaveLength(205);
    const options = getBoundaryFeatureOptions(
      collection!,
      "Lake",
      "GlobalID",
      "GlobalID",
    );
    expect(options).toHaveLength(205);
    expect(options.every((option) => option.geometry)).toBe(true);
    expect(lakeFeatureName(collection!.features[0]!)).not.toBe("");
  });

  test("sets the surface at the 80th percentile of sampled perimeter elevations", () => {
    const center = geographicToMercator(-120, 35);
    let sampleIndex = 0;
    const elevations = [10, 20, 30, 40, 50];
    const shoreElevation = getLakeShoreElevation(lake, center, () =>
      elevations[sampleIndex++] ?? null
    );

    expect(shoreElevation).toBe(42);
    expect(getLakeShoreElevation(lake, center, () => null)).toBeNull();
  });

  test("computes the median perimeter elevation without counting closed ring endpoints twice", async () => {
    const rings = getLakePerimeterRings(lake.geometry);
    const samples = [10, 20, 30, 40];
    let sampleIndex = 0;
    const median = await getLakePerimeterMedianElevation(rings, async () =>
      samples[sampleIndex++] ?? null
    );

    expect(rings[0]).toHaveLength(4);
    expect(sampleIndex).toBe(4);
    expect(median).toBe(25);
  });

  test("creates a flat surface with a deep skirt", () => {
    const geometry = createLakeMeshGeometry(
      lake,
      geographicToMercator(-120, 35),
      103,
      2,
    );

    expect(geometry).not.toBeNull();
    expect(geometry?.getAttribute("position").count).toBeGreaterThan(0);
    expect(geometry?.boundingBox?.max.y).toBeCloseTo(0.206);
    expect(geometry?.boundingBox?.min.y).toBeCloseTo(-1.794);
    geometry?.dispose();
  });

  test("uses the GNIS name and record ID when the primary name is missing", () => {
    expect(lakeFeatureName({
      ...lake,
      properties: { FID: 9, NAME: " ", GNIS_NAME: "Fallback Lake" },
    })).toBe("Fallback Lake");
    expect(lakeFeatureName({
      ...lake,
      properties: { FID: 9, NAME: "" },
    })).toBe("Lake 9");
  });
});
