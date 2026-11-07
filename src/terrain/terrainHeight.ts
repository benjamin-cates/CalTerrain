export const TERRAIN_TILE_SIZE = 256;
export const TERRAIN_TILE_BORDER = 1;
export const TERRAIN_TILE_MESH_SEGMENTS = 128;

export type TerrainElevationRaster = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

export function heightFromRgb(red: number, green: number, blue: number): number {
  return red * 256 + green + blue / 256 - 32_768;
}

export function terrainSamplePixel(
  coordinate: number,
  imageSize: number,
  hasTileBorder: boolean,
): number {
  const pixel = hasTileBorder
    ? Math.round(coordinate * TERRAIN_TILE_SIZE) + TERRAIN_TILE_BORDER
    : Math.round(coordinate * (imageSize - 1));
  return Math.max(0, Math.min(imageSize - 1, pixel));
}

export function sampleTerrainMeshVertexElevation(
  raster: TerrainElevationRaster,
  gridX: number,
  gridY: number,
  divisions: number,
  hasTileBorder: boolean,
): number {
  const xIndex = terrainSamplePixel(gridX / divisions, raster.width, hasTileBorder);
  const yIndex = terrainSamplePixel(gridY / divisions, raster.height, hasTileBorder);
  const offset = (yIndex * raster.width + xIndex) * 4;
  if (raster.pixels[offset + 3] === 0) return 0;
  return heightFromRgb(
    raster.pixels[offset] ?? 0,
    raster.pixels[offset + 1] ?? 0,
    raster.pixels[offset + 2] ?? 0,
  );
}

export function sampleTerrainMeshElevation(
  raster: TerrainElevationRaster,
  gridX: number,
  gridY: number,
  divisions: number,
  hasTileBorder: boolean,
): number {
  const x = Math.max(0, Math.min(divisions - Number.EPSILON, gridX));
  const y = Math.max(0, Math.min(divisions - Number.EPSILON, gridY));
  const column = Math.floor(x);
  const row = Math.floor(y);
  const horizontal = x - column;
  const vertical = y - row;
  const topLeft = sampleTerrainMeshVertexElevation(raster, column, row, divisions, hasTileBorder);
  const bottomLeft = sampleTerrainMeshVertexElevation(raster, column, row + 1, divisions, hasTileBorder);
  const bottomRight = sampleTerrainMeshVertexElevation(raster, column + 1, row + 1, divisions, hasTileBorder);
  const topRight = sampleTerrainMeshVertexElevation(raster, column + 1, row, divisions, hasTileBorder);
  if (horizontal + vertical <= 1) {
    return topLeft * (1 - horizontal - vertical) +
      bottomLeft * vertical +
      topRight * horizontal;
  }
  return bottomLeft * (1 - horizontal) +
    bottomRight * (horizontal + vertical - 1) +
    topRight * (1 - vertical);
}
