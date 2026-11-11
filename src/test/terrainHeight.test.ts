import { describe, expect, it } from "bun:test";
import {
  sampleTerrainMeshElevation,
  terrainSamplePixel,
} from "../terrain/terrainHeight";

function rasterWithElevations(width: number, height: number, elevations: number[][]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  elevations.forEach((row, y) => row.forEach((elevation, x) => {
    const encoded = elevation + 32_768;
    const offset = (y * width + x) * 4;
    pixels[offset] = encoded >> 8;
    pixels[offset + 1] = encoded & 255;
    pixels[offset + 3] = 255;
  }));
  return { width, height, pixels };
}

describe("terrain mesh elevation sampling", () => {
  it("interpolates heights using the same two triangles as the terrain mesh", () => {
    const raster = rasterWithElevations(3, 3, [
      [0, 200, 400],
      [100, 300, 500],
      [200, 400, 600],
    ]);

    expect(sampleTerrainMeshElevation(raster, 0.25, 0.25, 2, false)).toBe(75);
    expect(sampleTerrainMeshElevation(raster, 0.75, 0.75, 2, false)).toBe(225);
  });

  it("samples tile vertices inside the one-pixel border", () => {
    const pixels = new Uint8ClampedArray(259 * 259 * 4);
    const offset = (1 * 259 + 1) * 4;
    const encoded = 32_768 + 500;
    pixels[offset] = encoded >> 8;
    pixels[offset + 1] = encoded & 255;
    pixels[offset + 3] = 255;
    const raster = { width: 259, height: 259, pixels };

    expect(terrainSamplePixel(1, 259, true)).toBe(257);
    expect(sampleTerrainMeshElevation(raster, 0, 0, 128, true)).toBe(500);
  });
});
