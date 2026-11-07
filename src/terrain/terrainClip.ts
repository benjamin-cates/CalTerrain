import { intersection, union, type MultiPolygon } from "polygon-clipping";
import { toLocal } from "../geo";
import type { BoundaryCollection, Position } from "../types";

export const TERRAIN_BORDER_SIMPLIFICATION_KM = 0.01;

export function getStateBoundaryClipPolygons(
  state: BoundaryCollection,
  center: Position,
): Position[][][] {
  return state.features.flatMap((feature) => {
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    return polygons.map((polygon) =>
      polygon.map((ring) =>
        simplifyTerrainBoundaryRing(
          ring.map((point) => toLocal(point, center)),
          TERRAIN_BORDER_SIMPLIFICATION_KM,
        )
      )
    );
  });
}

function simplifyOpenLine(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2) return points;
  const toleranceSquared = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length > 0) {
    const range = pending.pop();
    if (!range) continue;
    const [startIndex, endIndex] = range;
    const start = points[startIndex];
    const end = points[endIndex];
    if (!start || !end) continue;
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const lengthSquared = dx * dx + dz * dz;
    let farthestIndex = -1;
    let farthestDistanceSquared = toleranceSquared;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const point = points[index];
      if (!point) continue;
      const projection = lengthSquared === 0
        ? 0
        : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared,
          ),
        );
      const distanceX = point[0] - (start[0] + projection * dx);
      const distanceZ = point[1] - (start[1] + projection * dz);
      const distanceSquared = distanceX * distanceX + distanceZ * distanceZ;
      if (distanceSquared > farthestDistanceSquared) {
        farthestDistanceSquared = distanceSquared;
        farthestIndex = index;
      }
    }
    if (farthestIndex >= 0) {
      keep[farthestIndex] = 1;
      pending.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

export function simplifyTerrainBoundaryRing(ring: Position[], tolerance: number): Position[] {
  if (ring.length <= 4) return ring;
  const openRing = ring.slice(0, -1);
  const first = openRing[0];
  if (!first) return ring;
  let farthestIndex = 1;
  let farthestDistanceSquared = 0;
  for (let index = 1; index < openRing.length; index += 1) {
    const point = openRing[index];
    if (!point) continue;
    const distanceX = point[0] - first[0];
    const distanceZ = point[1] - first[1];
    const distanceSquared = distanceX * distanceX + distanceZ * distanceZ;
    if (distanceSquared > farthestDistanceSquared) {
      farthestDistanceSquared = distanceSquared;
      farthestIndex = index;
    }
  }
  const firstPath = simplifyOpenLine(openRing.slice(0, farthestIndex + 1), tolerance);
  const secondPath = simplifyOpenLine(
    [...openRing.slice(farthestIndex), first],
    tolerance,
  );
  const simplified = [...firstPath, ...secondPath.slice(1)];
  return simplified.length >= 4 ? simplified : ring;
}

export function intersectStateWithRegions(
  statePolygons: Position[][][],
  regions: Position[][][][] | null,
): Position[][][] {
  if (regions === null) return statePolygons;
  if (regions.length === 0) return [];
  const [firstRegion, ...additionalRegions] = regions;
  if (!firstRegion) return [];
  const regionUnion = union(firstRegion as MultiPolygon, ...additionalRegions as MultiPolygon[]);
  return intersection(statePolygons as MultiPolygon, regionUnion);
}
