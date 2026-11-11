import { describe, expect, test } from "bun:test";
import { raycastTerrainMesh, raycastTerrainMeshHit } from "../terrain/terrainRaycast";
import type { TerrainElevationRaster } from "../terrain/terrainHeight";

function flatRaster(elevationMeters: number): TerrainElevationRaster {
  const raster: TerrainElevationRaster = {
    width: 258,
    height: 258,
    pixels: new Uint8ClampedArray(258 * 258 * 4),
  };
  const packedHeight = Math.round(elevationMeters + 32_768);
  const red = Math.floor(packedHeight / 256);
  const green = packedHeight % 256;
  for (let offset = 0; offset < raster.pixels.length; offset += 4) {
    raster.pixels[offset] = red;
    raster.pixels[offset + 1] = green;
    raster.pixels[offset + 3] = 255;
  }
  return raster;
}

describe("terrain mesh raycasting", () => {
  test("intersects the nearest point on a displaced terrain tile", () => {
    const raster = flatRaster(1_000);
    const hit = raycastTerrainMeshHit(
      { origin: [-1, 3, 0], direction: [1, -1, 0] },
      [{ z: 0, x: 0, y: 0 }],
      [0, 0],
      1,
      () => raster,
    );

    expect(hit?.position[0]).toBeCloseTo(1, 6);
    expect(hit?.position[1]).toBeCloseTo(0, 6);
    expect(hit?.elevationKm).toBeCloseTo(1, 6);
  });

  test("handles vertical rays and applies exaggeration at mesh vertices", () => {
    const raster = flatRaster(1_000);
    const exaggeratedHit = raycastTerrainMesh(
      { origin: [0, 6, 0], direction: [1, -1, 0] },
      [{ z: 0, x: 0, y: 0 }],
      [0, 0],
      5,
      () => raster,
    );
    const verticalHit = raycastTerrainMesh(
      { origin: [0, 6, 0], direction: [0, -1, 0] },
      [{ z: 0, x: 0, y: 0 }],
      [0, 0],
      5,
      () => raster,
    );

    expect(exaggeratedHit?.[0]).toBeCloseTo(1, 6);
    expect(exaggeratedHit?.[1]).toBeCloseTo(0, 6);
    expect(verticalHit).toEqual([0, 0]);
  });

  test("returns null when the ray misses loaded terrain tiles", () => {
    const hit = raycastTerrainMesh(
      { origin: [50_000, 3, 0], direction: [0, -1, 0] },
      [{ z: 0, x: 0, y: 0 }],
      [0, 0],
      1,
      () => flatRaster(1_000),
    );

    expect(hit).toBeNull();
  });
});
