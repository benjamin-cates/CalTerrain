import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import type { FeatureGeometry, Position } from "../types";

export function geometryContainsPosition(
  geometry: FeatureGeometry,
  position: Position,
): boolean {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return false;
  return booleanPointInPolygon(
    point(position),
    geometry as Parameters<typeof booleanPointInPolygon>[1],
  );
}

export function distanceToLineSegments(position: Position, lines: Position[][]): number {
  let minimumDistance = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (!start || !end) continue;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const lengthSquared = dx * dx + dy * dy;
      const projection = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, (
          (position[0] - start[0]) * dx + (position[1] - start[1]) * dy
        ) / lengthSquared));
      minimumDistance = Math.min(
        minimumDistance,
        Math.hypot(
          position[0] - (start[0] + projection * dx),
          position[1] - (start[1] + projection * dy),
        ),
      );
    }
  }
  return minimumDistance;
}
