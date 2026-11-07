import { WORLD_METERS } from "../geo";
import type { Position, Tile } from "../types";
import {
  sampleTerrainMeshVertexElevation,
  TERRAIN_TILE_MESH_SEGMENTS,
  type TerrainElevationRaster,
} from "./terrainHeight";

type Vector3Tuple = [number, number, number];

export type TerrainRay = {
  origin: Vector3Tuple;
  direction: Vector3Tuple;
};

export type TerrainRaycast = (ray: TerrainRay, exaggeration: number) => Position | null;
export type TerrainRasterProvider = (tile: Tile) => TerrainElevationRaster | null;

type TileIntersection = {
  tile: Tile;
  start: number;
  end: number;
};

const RAY_EPSILON = 1e-8;

function intersectAxis(
  origin: number,
  direction: number,
  minimum: number,
  maximum: number,
): [number, number] | null {
  if (Math.abs(direction) < RAY_EPSILON) {
    return origin < minimum || origin > maximum ? null : [-Infinity, Infinity];
  }
  const first = (minimum - origin) / direction;
  const second = (maximum - origin) / direction;
  return first <= second ? [first, second] : [second, first];
}

function intersectTileBounds(
  ray: TerrainRay,
  tile: Tile,
  center: Position,
): TileIntersection | null {
  const tileSizeMeters = WORLD_METERS / 2 ** tile.z;
  const tileSizeKm = tileSizeMeters / 1_000;
  const left = (tile.x * tileSizeMeters - WORLD_METERS / 2 - center[0]) / 1_000;
  const top = -((WORLD_METERS / 2 - tile.y * tileSizeMeters - center[1]) / 1_000);
  const xRange = intersectAxis(ray.origin[0], ray.direction[0], left, left + tileSizeKm);
  const zRange = intersectAxis(ray.origin[2], ray.direction[2], top, top + tileSizeKm);
  if (!xRange || !zRange) return null;
  const start = Math.max(0, xRange[0], zRange[0]);
  const end = Math.min(xRange[1], zRange[1]);
  return start <= end ? { tile, start, end } : null;
}

function dot(left: Vector3Tuple, right: Vector3Tuple): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract(left: Vector3Tuple, right: Vector3Tuple): Vector3Tuple {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vector3Tuple, right: Vector3Tuple): Vector3Tuple {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function intersectTriangle(
  ray: TerrainRay,
  first: Vector3Tuple,
  second: Vector3Tuple,
  third: Vector3Tuple,
): number | null {
  const edge1 = subtract(second, first);
  const edge2 = subtract(third, first);
  const p = cross(ray.direction, edge2);
  const determinant = dot(edge1, p);
  if (Math.abs(determinant) < RAY_EPSILON) return null;

  const inverseDeterminant = 1 / determinant;
  const fromFirst = subtract(ray.origin, first);
  const u = dot(fromFirst, p) * inverseDeterminant;
  if (u < -RAY_EPSILON || u > 1 + RAY_EPSILON) return null;

  const q = cross(fromFirst, edge1);
  const v = dot(ray.direction, q) * inverseDeterminant;
  if (v < -RAY_EPSILON || u + v > 1 + RAY_EPSILON) return null;

  const distance = dot(edge2, q) * inverseDeterminant;
  return distance >= 0 ? distance : null;
}

function intersectTileMesh(
  ray: TerrainRay,
  { tile, start, end }: TileIntersection,
  center: Position,
  exaggeration: number,
  raster: TerrainElevationRaster,
): number | null {
  const tileSizeMeters = WORLD_METERS / 2 ** tile.z;
  const tileSizeKm = tileSizeMeters / 1_000;
  const cellSizeKm = tileSizeKm / TERRAIN_TILE_MESH_SEGMENTS;
  const left = (tile.x * tileSizeMeters - WORLD_METERS / 2 - center[0]) / 1_000;
  const top = -((WORLD_METERS / 2 - tile.y * tileSizeMeters - center[1]) / 1_000);
  const startX = ray.origin[0] + ray.direction[0] * start;
  const startZ = ray.origin[2] + ray.direction[2] * start;
  const gridX = (startX - left) / cellSizeKm;
  const gridY = (startZ - top) / cellSizeKm;
  const stepX = Math.sign(ray.direction[0]);
  const stepY = Math.sign(ray.direction[2]);
  const nearestGridX = Math.round(gridX);
  const nearestGridY = Math.round(gridY);
  const adjustedGridX = stepX < 0 && Math.abs(gridX - nearestGridX) < RAY_EPSILON
    ? nearestGridX - RAY_EPSILON
    : gridX;
  const adjustedGridY = stepY < 0 && Math.abs(gridY - nearestGridY) < RAY_EPSILON
    ? nearestGridY - RAY_EPSILON
    : gridY;
  let column = Math.max(0, Math.min(
    TERRAIN_TILE_MESH_SEGMENTS - 1,
    Math.floor(adjustedGridX),
  ));
  let row = Math.max(0, Math.min(
    TERRAIN_TILE_MESH_SEGMENTS - 1,
    Math.floor(adjustedGridY),
  ));
  const deltaX = stepX === 0 ? Infinity : cellSizeKm / Math.abs(ray.direction[0]);
  const deltaY = stepY === 0 ? Infinity : cellSizeKm / Math.abs(ray.direction[2]);
  let nextX = stepX === 0
    ? Infinity
    : (left + (column + (stepX > 0 ? 1 : 0)) * cellSizeKm - ray.origin[0]) /
      ray.direction[0];
  let nextY = stepY === 0
    ? Infinity
    : (top + (row + (stepY > 0 ? 1 : 0)) * cellSizeKm - ray.origin[2]) /
      ray.direction[2];
  let current = start;

  for (let visited = 0; visited < TERRAIN_TILE_MESH_SEGMENTS * 2 + 4; visited += 1) {
    const cellEnd = Math.min(end, nextX, nextY);
    const vertex = (x: number, y: number): Vector3Tuple => [
      left + x * cellSizeKm,
      sampleTerrainMeshVertexElevation(
        raster,
        x,
        y,
        TERRAIN_TILE_MESH_SEGMENTS,
        true,
      ) * exaggeration / 1_000,
      top + y * cellSizeKm,
    ];
    const topLeft = vertex(column, row);
    const bottomLeft = vertex(column, row + 1);
    const bottomRight = vertex(column + 1, row + 1);
    const topRight = vertex(column + 1, row);
    const intersections = [
      intersectTriangle(ray, topLeft, bottomLeft, topRight),
      intersectTriangle(ray, bottomLeft, bottomRight, topRight),
    ];
    for (const distance of intersections) {
      if (
        distance !== null &&
        distance >= current - RAY_EPSILON &&
        distance <= cellEnd + RAY_EPSILON
      ) return distance;
    }

    if (cellEnd >= end - RAY_EPSILON) break;
    const crossX = nextX <= cellEnd + RAY_EPSILON;
    const crossY = nextY <= cellEnd + RAY_EPSILON;
    current = cellEnd;
    if (crossX) {
      column += stepX;
      nextX += deltaX;
    }
    if (crossY) {
      row += stepY;
      nextY += deltaY;
    }
    if (
      column < 0 || column >= TERRAIN_TILE_MESH_SEGMENTS ||
      row < 0 || row >= TERRAIN_TILE_MESH_SEGMENTS
    ) break;
  }
  return null;
}

export function raycastTerrainMesh(
  ray: TerrainRay,
  tiles: Tile[],
  center: Position,
  exaggeration: number,
  getRaster: TerrainRasterProvider,
): Position | null {
  const intersections = tiles
    .map((tile) => intersectTileBounds(ray, tile, center))
    .filter((intersection): intersection is TileIntersection => intersection !== null)
    .sort((left, right) =>
      left.start - right.start || right.tile.z - left.tile.z
    );
  let nearestDistance = Infinity;

  for (const intersection of intersections) {
    if (intersection.start > nearestDistance) break;
    const raster = getRaster(intersection.tile);
    if (!raster) continue;
    const distance = intersectTileMesh(ray, intersection, center, exaggeration, raster);
    if (distance !== null && distance < nearestDistance) nearestDistance = distance;
  }
  if (!Number.isFinite(nearestDistance)) return null;
  return [
    ray.origin[0] + ray.direction[0] * nearestDistance,
    ray.origin[2] + ray.direction[2] * nearestDistance,
  ];
}
