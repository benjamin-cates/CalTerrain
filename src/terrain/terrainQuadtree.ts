import { WORLD_METERS } from "../geo";
import type { TerrainMetadata, Tile, ViewState } from "../types";

const MIN_ZOOM = 8;
const ZOOM_DISTANCE_SENSITIVITY = 0.7;
const ZOOM_DETAIL_BIAS = 1.25;
const ZOOM_OUT_HYSTERESIS = 2.4;

function splitDistance(zoom: number): number {
  return ZOOM_DETAIL_BIAS * 30 * 2 ** ((10.5 - zoom) / ZOOM_DISTANCE_SENSITIVITY);
}

export function selectTerrainTiles(
  view: ViewState,
  metadata: TerrainMetadata,
  previousTiles: Tile[] = [],
): Tile[] {
  const available = new Set(metadata.tiles);
  const previousDescendants = new Set<string>();
  for (const previousTile of previousTiles) {
    for (let zoom = MIN_ZOOM; zoom < previousTile.z; zoom += 1) {
      const scale = 2 ** (previousTile.z - zoom);
      previousDescendants.add(
        `${zoom}/${Math.floor(previousTile.x / scale)}/${Math.floor(previousTile.y / scale)}`,
      );
    }
  }
  const baseTiles = metadata.tiles
    .map((key) => key.split("/").map(Number))
    .filter(([zoom, x, y]) => zoom === MIN_ZOOM && x !== undefined && y !== undefined)
    .map(([z, x, y]) => ({ z: z ?? MIN_ZOOM, x: x ?? 0, y: y ?? 0 }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  if (baseTiles.length === 0) return [];

  const maxZoom = Math.max(MIN_ZOOM, ...metadata.zoomLevels);
  const selected: Tile[] = [];

  const refine = (tile: Tile) => {
    const tileSizeMeters = WORLD_METERS / 2 ** tile.z;
    const tileCenterX = ((tile.x + 0.5) * tileSizeMeters - WORLD_METERS / 2 - metadata.center[0]) / 1_000;
    const tileCenterZ = -((WORLD_METERS / 2 - (tile.y + 0.5) * tileSizeMeters) - metadata.center[1]) / 1_000;
    const halfSizeKm = tileSizeMeters / 2_000;
    const nearestX = Math.max(0, Math.abs(tileCenterX - view.target[0]) - halfSizeKm);
    const nearestZ = Math.max(0, Math.abs(tileCenterZ - view.target[1]) - halfSizeKm);
    const distance = Math.hypot(view.distance, nearestX, nearestZ);
    const wasRefined = previousDescendants.has(`${tile.z}/${tile.x}/${tile.y}`);
    const mergeDistance = splitDistance(tile.z) * ZOOM_OUT_HYSTERESIS;
    const threshold = wasRefined ? mergeDistance : splitDistance(tile.z);
    if (distance > threshold || tile.z >= maxZoom) {
      selected.push(tile);
      return;
    }

    const nextZoom = tile.z + 1;
    const children = [
      { z: nextZoom, x: tile.x * 2, y: tile.y * 2 },
      { z: nextZoom, x: tile.x * 2 + 1, y: tile.y * 2 },
      { z: nextZoom, x: tile.x * 2, y: tile.y * 2 + 1 },
      { z: nextZoom, x: tile.x * 2 + 1, y: tile.y * 2 + 1 },
    ];
    const availableChildren = children.filter((child) =>
      available.has(`${child.z}/${child.x}/${child.y}`),
    );
    if (availableChildren.length === 0) {
      selected.push(tile);
      return;
    }
    availableChildren.forEach(refine);
  };

  baseTiles.forEach(refine);
  return selected;
}
