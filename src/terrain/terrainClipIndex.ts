import type { Position } from "../types";

type Bounds = {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
};

export type TerrainClipSegment = Bounds & {
  start: Position;
  end: Position;
  polygonIndex: number;
};

type SegmentNode = Bounds & {
  left?: SegmentNode;
  right?: SegmentNode;
  segments?: TerrainClipSegment[];
};

export type TerrainClipPolygonIndex = {
  polygons: Position[][][];
  root: SegmentNode | null;
};

export type TerrainClipPointQueryScratch = {
  crossings: TerrainClipSegment[];
  parity: Uint8Array;
  result: number[];
};

const LEAF_SEGMENT_COUNT = 8;

function getBounds(segments: TerrainClipSegment[]): Bounds {
  return segments.reduce<Bounds>((bounds, segment) => ({
    minX: Math.min(bounds.minX, segment.minX),
    minZ: Math.min(bounds.minZ, segment.minZ),
    maxX: Math.max(bounds.maxX, segment.maxX),
    maxZ: Math.max(bounds.maxZ, segment.maxZ),
  }), {
    minX: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxZ: -Infinity,
  });
}

function buildSegmentTree(segments: TerrainClipSegment[]): SegmentNode | null {
  if (segments.length === 0) return null;
  const bounds = getBounds(segments);
  if (segments.length <= LEAF_SEGMENT_COUNT) {
    return { ...bounds, segments };
  }

  const splitOnX = bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ;
  segments.sort((a, b) => splitOnX
    ? (a.minX + a.maxX) - (b.minX + b.maxX)
    : (a.minZ + a.maxZ) - (b.minZ + b.maxZ));
  const middle = Math.floor(segments.length / 2);
  const left = buildSegmentTree(segments.slice(0, middle));
  const right = buildSegmentTree(segments.slice(middle));
  return { ...bounds, left: left ?? undefined, right: right ?? undefined };
}

export function createTerrainClipPolygonIndex(
  polygons: Position[][][],
): TerrainClipPolygonIndex {
  const segments: TerrainClipSegment[] = [];
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const polygon = polygons[polygonIndex];
    if (!polygon) continue;
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];
        if (!start || !end) continue;
        segments.push({
          start,
          end,
          polygonIndex,
          minX: Math.min(start[0], end[0]),
          minZ: Math.min(start[1], end[1]),
          maxX: Math.max(start[0], end[0]),
          maxZ: Math.max(start[1], end[1]),
        });
      }
    }
  }
  return { polygons, root: buildSegmentTree(segments) };
}

function queryTileSegments(
  root: SegmentNode | null,
  left: number,
  top: number,
  right: number,
  bottom: number,
  size: number,
  results: TerrainClipSegment[],
): void {
  if (
    !root ||
    root.minX > right ||
    root.maxX < left ||
    root.minZ > bottom ||
    root.maxZ < top
  ) return;
  if (root.segments) {
    for (const segment of root.segments) {
      if (
        segment.minX <= right &&
        segment.maxX >= left &&
        segment.minZ <= bottom &&
        segment.maxZ >= top &&
        segmentIntersectsTile(segment, left, top, size)
      ) results.push(segment);
    }
    return;
  }
  queryTileSegments(root.left ?? null, left, top, right, bottom, size, results);
  queryTileSegments(root.right ?? null, left, top, right, bottom, size, results);
}

function queryPointCrossings(
  root: SegmentNode | null,
  x: number,
  z: number,
  results: TerrainClipSegment[],
): void {
  if (!root || root.maxX < x || root.minZ > z || root.maxZ < z) return;
  if (root.segments) {
    for (const segment of root.segments) {
      if (segment.maxX >= x && segment.minZ <= z && segment.maxZ >= z) {
        results.push(segment);
      }
    }
    return;
  }
  queryPointCrossings(root.left ?? null, x, z, results);
  queryPointCrossings(root.right ?? null, x, z, results);
}

function segmentIntersectsTile(
  segment: TerrainClipSegment,
  left: number,
  top: number,
  size: number,
): boolean {
  const deltaX = segment.end[0] - segment.start[0];
  const deltaZ = segment.end[1] - segment.start[1];
  let minimum = 0;
  let maximum = 1;

  const leftDirection = -deltaX;
  const leftDistance = segment.start[0] - left;
  if (leftDirection === 0) {
    if (leftDistance < 0) return false;
  } else {
    const ratio = leftDistance / leftDirection;
    if (leftDirection < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }

  const rightDirection = deltaX;
  const rightDistance = left + size - segment.start[0];
  if (rightDirection === 0) {
    if (rightDistance < 0) return false;
  } else {
    const ratio = rightDistance / rightDirection;
    if (rightDirection < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }

  const topDirection = -deltaZ;
  const topDistance = segment.start[1] - top;
  if (topDirection === 0) {
    if (topDistance < 0) return false;
  } else {
    const ratio = topDistance / topDirection;
    if (topDirection < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }

  const bottomDirection = deltaZ;
  const bottomDistance = top + size - segment.start[1];
  if (bottomDirection === 0) {
    if (bottomDistance < 0) return false;
  } else {
    const ratio = bottomDistance / bottomDirection;
    if (bottomDirection < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
  }

  return minimum <= maximum;
}

export function getTerrainClipSegmentsForTile(
  index: TerrainClipPolygonIndex,
  left: number,
  top: number,
  size: number,
  results: TerrainClipSegment[] = [],
): TerrainClipSegment[] {
  results.length = 0;
  const right = left + size;
  const bottom = top + size;
  queryTileSegments(index.root, left, top, right, bottom, size, results);
  return results;
}

export function createTerrainClipPointQueryScratch(
  index: TerrainClipPolygonIndex,
): TerrainClipPointQueryScratch {
  return {
    crossings: [],
    parity: new Uint8Array(index.polygons.length),
    result: [],
  };
}

export function getTerrainClipPolygonsContainingPoint(
  index: TerrainClipPolygonIndex,
  [x, z]: Position,
  scratch: TerrainClipPointQueryScratch = createTerrainClipPointQueryScratch(index),
): number[] {
  scratch.crossings.length = 0;
  scratch.result.length = 0;
  scratch.parity.fill(0);
  queryPointCrossings(index.root, x, z, scratch.crossings);
  for (const segment of scratch.crossings) {
    if ((segment.start[1] > z) !== (segment.end[1] > z)) {
      const intersectionX =
        ((segment.end[0] - segment.start[0]) * (z - segment.start[1])) /
          (segment.end[1] - segment.start[1]) +
        segment.start[0];
      if (x < intersectionX) {
        scratch.parity[segment.polygonIndex] = (scratch.parity[segment.polygonIndex] ?? 0) ^ 1;
      }
    }
  }
  for (let index = 0; index < scratch.parity.length; index += 1) {
    if (scratch.parity[index]) scratch.result.push(index);
  }
  return scratch.result;
}
