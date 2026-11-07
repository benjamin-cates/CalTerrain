import { describe, expect, it } from "bun:test";
import {
  colorizeTerrainHeightPixels,
  getTerrainHeightPaletteColor,
  getTerrainHeightPaletteStops,
  type TerrainHeightPalette,
} from "./terrainHeightPalette";

function terrariumPixel(height: number, alpha = 255): Uint8ClampedArray {
  const encoded = height + 32_768;
  return new Uint8ClampedArray([
    Math.floor(encoded / 256),
    encoded % 256,
    0,
    alpha,
  ]);
}

function colorAt(height: number, palette: TerrainHeightPalette): number[] {
  return Array.from(colorizeTerrainHeightPixels(terrariumPixel(height), palette));
}

function relativeLuminance([red, green, blue]: number[]): number {
  const toLinear = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126729 * toLinear(red ?? 0) +
    0.7151522 * toLinear(green ?? 0) +
    0.072175 * toLinear(blue ?? 0);
}

function perceptualLightness(rgb: number[]): number {
  const luminance = relativeLuminance(rgb);
  return luminance > (6 / 29) ** 3
    ? 116 * Math.cbrt(luminance) - 16
    : 903.3 * luminance;
}

describe("terrain height preview palettes", () => {
  it("maps the grayscale range endpoints and clamps outside heights", () => {
    expect(colorAt(-100, "grayscale")).toEqual([0, 0, 0, 255]);
    expect(colorAt(4_500, "grayscale")).toEqual([255, 255, 255, 255]);
    expect(colorAt(-101, "grayscale")).toEqual([0, 0, 0, 255]);
    expect(colorAt(4_501, "grayscale")).toEqual([255, 255, 255, 255]);
  });

  it("uses the documented low-to-high rainbow and viridis colors", () => {
    expect(colorAt(-100, "rainbow")).toEqual([21, 34, 115, 255]);
    expect(colorAt(4_500, "rainbow")).toEqual([249, 140, 136, 255]);
    expect(colorAt(-100, "viridis")).toEqual([68, 1, 84, 255]);
    expect(colorAt(4_500, "viridis")).toEqual([253, 231, 37, 255]);
  });

  it("defines low-to-high magma colors", () => {
    const stops = getTerrainHeightPaletteStops("magma");

    expect(stops[0]).toEqual([0, 0, 4]);
    expect(stops.at(-1)).toEqual([252, 253, 191]);
  });

  it("increases rainbow lightness evenly from a darker low end", () => {
    const lightnessValues = Array.from({ length: 101 }, (_, index) => {
      const elevation = -100 + (4_600 * index) / 100;
      return perceptualLightness(getTerrainHeightPaletteColor(elevation, "rainbow"));
    });
    const first = lightnessValues[0] ?? 0;
    const last = lightnessValues[lightnessValues.length - 1] ?? first;
    const maxDeviation = Math.max(...lightnessValues.map((value, index) =>
      Math.abs(value - (first + ((last - first) * index) / (lightnessValues.length - 1))),
    ));

    expect(first).toBeLessThan(20);
    expect(last - first).toBeGreaterThan(50);
    expect(lightnessValues.every((value, index) => index === 0 || value > (lightnessValues[index - 1] ?? value))).toBe(true);
    expect(maxDeviation).toBeLessThan(0.75);
  });

  it("preserves transparent pixels", () => {
    expect(Array.from(colorizeTerrainHeightPixels(
      terrariumPixel(500, 0),
      "viridis",
    ))).toEqual([0, 0, 0, 0]);
  });
});
