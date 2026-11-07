import { heightFromRgb } from "./terrainHeight";

export type TerrainHeightPalette = "grayscale" | "rainbow" | "viridis" | "magma";
export type TerrainEmissivePalette = TerrainHeightPalette | "custom" | "solid";

export const TERRAIN_HEIGHT_PREVIEW_MIN_METERS = -100;
export const TERRAIN_HEIGHT_PREVIEW_MAX_METERS = 4_500;

const PALETTE_STOPS: Record<TerrainHeightPalette, [number, number, number][]> = {
  grayscale: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  rainbow: [
    [21, 34, 115],
    [17, 64, 111],
    [22, 89, 120],
    [35, 120, 40],
    [123, 132, 22],
    [226, 117, 82],
    [249, 140, 136],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [81, 18, 124],
    [183, 55, 121],
    [252, 137, 97],
    [252, 253, 191],
  ],
};

export function getTerrainHeightPaletteStops(
  palette: TerrainHeightPalette,
): readonly [number, number, number][] {
  return PALETTE_STOPS[palette];
}

function samplePalette(
  normalizedHeight: number,
  palette: TerrainHeightPalette,
): [number, number, number] {
  const stops = PALETTE_STOPS[palette];
  const scaledPosition = Math.max(0, Math.min(1, normalizedHeight)) * (stops.length - 1);
  const lowerIndex = Math.floor(scaledPosition);
  const upperIndex = Math.min(stops.length - 1, lowerIndex + 1);
  const amount = scaledPosition - lowerIndex;
  const lower = stops[lowerIndex] ?? [0, 0, 0];
  const upper = stops[upperIndex] ?? lower;
  if (palette === "rainbow") {
    const interpolateLinearChannel = (lowerChannel: number, upperChannel: number) => {
      const lowerLinear = srgbByteToLinear(lowerChannel);
      const upperLinear = srgbByteToLinear(upperChannel);
      return linearToSrgbByte(lowerLinear + (upperLinear - lowerLinear) * amount);
    };
    return [
      interpolateLinearChannel(lower[0], upper[0]),
      interpolateLinearChannel(lower[1], upper[1]),
      interpolateLinearChannel(lower[2], upper[2]),
    ];
  }
  return [
    Math.round(lower[0] + (upper[0] - lower[0]) * amount),
    Math.round(lower[1] + (upper[1] - lower[1]) * amount),
    Math.round(lower[2] + (upper[2] - lower[2]) * amount),
  ];
}

function srgbByteToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(channel: number): number {
  const normalized = Math.max(0, Math.min(1, channel));
  const encoded = normalized <= 0.0031308
    ? normalized * 12.92
    : 1.055 * normalized ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

export function getTerrainHeightPaletteColor(
  elevation: number,
  palette: TerrainHeightPalette,
): [number, number, number] {
  const heightRange = TERRAIN_HEIGHT_PREVIEW_MAX_METERS - TERRAIN_HEIGHT_PREVIEW_MIN_METERS;
  return samplePalette(
    (elevation - TERRAIN_HEIGHT_PREVIEW_MIN_METERS) / heightRange,
    palette,
  );
}

export function colorizeTerrainHeightPixels(
  pixels: Uint8ClampedArray,
  palette: TerrainHeightPalette,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3] ?? 0;
    output[offset + 3] = alpha;
    if (alpha < 128) continue;
    const elevation = heightFromRgb(
      pixels[offset] ?? 0,
      pixels[offset + 1] ?? 0,
      pixels[offset + 2] ?? 0,
    );
    const color = getTerrainHeightPaletteColor(elevation, palette);
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
  }
  return output;
}
