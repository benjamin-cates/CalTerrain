import { BufferGeometry, Float32BufferAttribute } from "three";
import type { Position } from "../types";
import {
  createTerrainClipPolygonIndex,
  getTerrainClipSegmentsForTile,
  type TerrainClipPolygonIndex,
} from "./terrainClipIndex";

export const TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS = -200;

function clipSegmentToTile(
  start: Position,
  end: Position,
  left: number,
  top: number,
  size: number,
): [Position, Position] | null {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  let minimum = 0;
  let maximum = 1;
  const boundaries: [number, number][] = [
    [-deltaX, start[0] - left],
    [deltaX, left + size - start[0]],
    [-deltaZ, start[1] - top],
    [deltaZ, top + size - start[1]],
  ];

  for (const [direction, distance] of boundaries) {
    if (direction === 0) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return null;
  }

  return [
    [start[0] + deltaX * minimum, start[1] + deltaZ * minimum],
    [start[0] + deltaX * maximum, start[1] + deltaZ * maximum],
  ];
}

export function makeTerrainSkirtGeometry(
  polygons: Position[][][],
  tileLeft: number,
  tileTop: number,
  tileSizeKm: number,
  divisions: number,
  clipIndex = createTerrainClipPolygonIndex(polygons),
): BufferGeometry {
  const halfSize = tileSizeKm / 2;
  const maximumSegmentLength = tileSizeKm / divisions;
  const tileCenterX = tileLeft + halfSize;
  const tileCenterZ = tileTop + halfSize;
  const skirtPositions: number[] = [];
  const skirtUvs: number[] = [];
  const skirtFlags: number[] = [];
  const skirtIndices: number[] = [];
  for (const segment of getTerrainClipSegmentsForTile(
    clipIndex,
    tileLeft,
    tileTop,
    tileSizeKm,
  )) {
        const clipped = clipSegmentToTile(
          segment.start,
          segment.end,
          tileLeft,
          tileTop,
          tileSizeKm,
        );
        if (!clipped) continue;
        const [clippedStart, clippedEnd] = clipped;
        const startX = clippedStart[0] - tileCenterX;
        const startZ = clippedStart[1] - tileCenterZ;
        const endX = clippedEnd[0] - tileCenterX;
        const endZ = clippedEnd[1] - tileCenterZ;
        if (startX === endX && startZ === endZ) continue;

        const segmentLength = Math.hypot(endX - startX, endZ - startZ);
        const segmentCount = Math.max(1, Math.ceil(segmentLength / maximumSegmentLength));
        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
          const startRatio = segmentIndex / segmentCount;
          const endRatio = (segmentIndex + 1) / segmentCount;
          const subsegmentStartX = startX + (endX - startX) * startRatio;
          const subsegmentStartZ = startZ + (endZ - startZ) * startRatio;
          const subsegmentEndX = startX + (endX - startX) * endRatio;
          const subsegmentEndZ = startZ + (endZ - startZ) * endRatio;
          const startU = (subsegmentStartX + halfSize) / tileSizeKm;
          const startV = (halfSize - subsegmentStartZ) / tileSizeKm;
          const endU = (subsegmentEndX + halfSize) / tileSizeKm;
          const endV = (halfSize - subsegmentEndZ) / tileSizeKm;
          const baseIndex = skirtPositions.length / 3;
          skirtPositions.push(
            subsegmentStartX, 0, subsegmentStartZ,
            subsegmentEndX, 0, subsegmentEndZ,
            subsegmentStartX, 0, subsegmentStartZ,
            subsegmentEndX, 0, subsegmentEndZ,
          );
          skirtUvs.push(startU, startV, endU, endV, startU, startV, endU, endV);
          skirtFlags.push(0, 0, 1, 1);
          skirtIndices.push(
            baseIndex, baseIndex + 1, baseIndex + 2,
            baseIndex + 1, baseIndex + 3, baseIndex + 2,
          );
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(skirtPositions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(skirtUvs, 2));
  geometry.setAttribute("terrainSkirt", new Float32BufferAttribute(skirtFlags, 1));
  geometry.setIndex(skirtIndices);
  if (skirtPositions.length > 0) {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return geometry;
}
