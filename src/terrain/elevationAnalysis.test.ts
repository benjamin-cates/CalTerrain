import { describe, expect, it } from "bun:test";
import { createTerrainElevationProfile, createTerrainElevationSampler, findTerrainElevationExtremum } from "./elevationAnalysis";
import type { TerrainElevationRaster } from "./terrainHeight";
import type { BoundaryGeometry, FeatureGeometry, TerrainMetadata } from "../types";

function rasterWithElevation(elevation: number): TerrainElevationRaster {
  const width = 259;
  const height = 259;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const encoded = elevation + 32_768;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = encoded >> 8;
    pixels[offset + 1] = encoded & 255;
    pixels[offset + 3] = 255;
  }
  return { width, height, pixels };
}

const center: [number, number] = [0, 0];
const stateBoundary: BoundaryGeometry = {
  type: "Polygon",
  coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
};

describe("terrain elevation analysis", () => {
  it("uses the highest available tile and reuses its raster", async () => {
    const metadata: TerrainMetadata = {
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      center,
      tiles: ["0/0/0", "1/1/1"],
      zoomLevels: [0, 1],
    };
    const loadedTiles: string[] = [];
    const sample = createTerrainElevationSampler(metadata, async (tileKey) => {
      loadedTiles.push(tileKey);
      return rasterWithElevation(875);
    });

    await expect(sample([0, 0])).resolves.toBe(875);
    await expect(sample([0, 0])).resolves.toBe(875);
    expect(loadedTiles).toEqual(["1/1/1"]);
  });

  it("returns null when no terrain tile covers a position", async () => {
    const metadata: TerrainMetadata = {
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      center,
      tiles: ["8/0/0"],
      zoomLevels: [8],
    };
    const sample = createTerrainElevationSampler(metadata, async () => rasterWithElevation(0));
    await expect(sample([0, 0])).resolves.toBeNull();
  });

  it("does not interpret transparent ocean pixels as zero-elevation land", async () => {
    const metadata: TerrainMetadata = {
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      center,
      tiles: ["1/1/1"],
      zoomLevels: [1],
    };
    const sample = createTerrainElevationSampler(metadata, async () => ({
      width: 259,
      height: 259,
      pixels: new Uint8ClampedArray(259 * 259 * 4),
    }));

    await expect(sample([0, 0])).resolves.toBeNull();
  });

  it("does not select a high value from inside a polygon hole", async () => {
    const polygon: FeatureGeometry = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]],
        [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006], [0.004, 0.004]],
      ],
    };
    const result = await findTerrainElevationExtremum(
      [polygon],
      [],
      [stateBoundary],
      center,
      8,
      "highest",
      async ([longitude, latitude]) =>
        longitude > 0.004 && longitude < 0.006 && latitude > 0.004 && latitude < 0.006
          ? 100_000
          : longitude * 1_000 + latitude,
    );

    expect(result.elevationMeters).toBeLessThan(100_000);
    expect(
      result.position[0] > 0.004 && result.position[0] < 0.006 &&
        result.position[1] > 0.004 && result.position[1] < 0.006,
    ).toBe(false);
  });

  it("finds line extrema using sampled points along the complete line", async () => {
    const result = await findTerrainElevationExtremum(
      [],
      [[[0, 0], [0.002, 0]]],
      [stateBoundary],
      center,
      8,
      "highest",
      async ([longitude]) => longitude * 1_000,
    );

    expect(result.position[0]).toBeCloseTo(0.002);
    expect(result.elevationMeters).toBeCloseTo(2);
  });

  it("keeps lowest-point candidates inside the state while retaining beach samples", async () => {
    const californiaBoundary: BoundaryGeometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    };
    const result = await findTerrainElevationExtremum(
      [],
      [[[-0.1, 0.5], [0.1, 0.5]]],
      [californiaBoundary],
      center,
      8,
      "lowest",
      async ([longitude]) => longitude <= 0 ? -1_000 : longitude < 0.01 ? -100 : 0,
    );

    expect(result.position[0]).toBeGreaterThan(0);
    expect(result.position[0]).toBeLessThan(0.01);
    expect(result.elevationMeters).toBe(-100);
  });

  it("samples an elevation profile with cumulative distance values", async () => {
    const profile = await createTerrainElevationProfile(
      [[[0, 0], [0.002, 0]]],
      center,
      async ([longitude]) => longitude * 1_000,
      50,
    );

    expect(profile.series).toHaveLength(1);
    expect(profile.series[0]?.length).toBeGreaterThan(2);
    expect(profile.series[0]?.[0]?.distanceMeters).toBe(0);
    expect(profile.series[0]?.at(-1)?.distanceMeters).toBeCloseTo(profile.totalDistanceMeters);
    expect(profile.series[0]?.at(-1)?.elevationMeters).toBeCloseTo(2);
  });

  it("keeps disjoint line pieces separate while accumulating their profile distance", async () => {
    const profile = await createTerrainElevationProfile(
      [
        [[0, 0], [0.001, 0]],
        [[0.003, 0], [0.004, 0]],
      ],
      center,
      async () => 100,
      50,
    );

    expect(profile.series).toHaveLength(2);
    expect(profile.series[1]?.[0]?.distanceMeters).toBeCloseTo(
      profile.series[0]?.at(-1)?.distanceMeters ?? 0,
    );
    expect(profile.totalDistanceMeters).toBeLessThan(250);
  });
});
