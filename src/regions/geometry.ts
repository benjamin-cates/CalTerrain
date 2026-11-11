import { countyId, countyName, featureRings, fromLocal, toLocal } from "../geo";
import type { BoundaryCollection, BoundaryFeature, Position, Region } from "../types";

export type RegionHandle = {
  id: string;
  kind: "center" | "size" | "rotation" | "axis-width" | "axis-height" | "vertex";
  index?: number;
  position: Position;
  height?: number;
};

export function regionsForSelectedCounties(
  visibleCountyIds: string[],
  counties: BoundaryCollection | null,
  clipCountyIds: string[] = [],
): Region[] {
  if (!counties || (visibleCountyIds.length === 0 && clipCountyIds.length === 0)) return [];
  const visible = new Set(visibleCountyIds);
  const clipped = new Set(clipCountyIds);
  const selected = new Set([...visible, ...clipped]);
  return counties.features
    .filter((feature) => selected.has(countyId(feature)))
    .map((feature) => {
      const id = countyId(feature);
      return {
        id: `county:${id}`,
        name: countyName(feature),
        type: "county" as const,
        countyId: id,
        ...(visible.has(id) ? {} : { visible: false }),
        ...(clipped.has(id) ? { clip: true } : {}),
      };
    });
}

function rotatePoint([x, z]: Position, rotation: number): Position {
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [x * cosine - z * sine, x * sine + z * cosine];
}

export function regionGeometry(
  region: Region,
  center: Position,
  counties: BoundaryCollection,
  rotationHandleOffsetKm = 1.5,
): {
  lines: Position[][];
  handles: RegionHandle[];
} {
  if (region.type === "county") {
    const feature = counties.features.find((item) => countyId(item) === region.countyId);
    return {
      lines: feature ? featureRings(feature).map((ring) => ring.map((point) => toLocal(point, center))) : [],
      handles: [],
    };
  }
  if (region.type === "point") {
    return { lines: [], handles: [] };
  }
  if (region.type === "polygon" || region.type === "polyline") {
    const points = region.points.map((point) => toLocal(point, center));
    const first = points[0];
    const lines = region.type === "polygon" && first ? [...points, first] : points;
    const centerPosition = points.reduce<Position>(
      (sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length],
      [0, 0],
    );
    return {
      lines: [lines],
      handles: [
        { id: region.id, kind: "center", position: centerPosition },
        ...points.map((position, index) => ({ id: region.id, kind: "vertex" as const, index, position })),
      ],
    };
  }
  const [x, z] = toLocal(region.center, center);
  const halfWidth = region.width / 2;
  const halfHeight = region.height / 2;
  const rotation = region.rotation ?? 0;
  const rotated = (point: Position) => {
    const [rotatedX, rotatedZ] = rotatePoint(point, rotation);
    return [x + rotatedX, z + rotatedZ] as Position;
  };
  const lines: Position[] = [];
  if (region.type === "rectangle") {
    lines.push(
      rotated([-halfWidth, -halfHeight]),
      rotated([halfWidth, -halfHeight]),
      rotated([halfWidth, halfHeight]),
      rotated([-halfWidth, halfHeight]),
      rotated([-halfWidth, -halfHeight]),
    );
  } else {
    for (let index = 0; index <= 100; index += 1) {
      const angle = index * Math.PI * 2 / 100;
      lines.push(rotated([Math.cos(angle) * halfWidth, Math.sin(angle) * halfHeight]));
    }
  }
  const handles: RegionHandle[] = [
    { id: region.id, kind: "center", position: [x, z] },
  ];
  if (region.type === "rectangle") {
    handles.push(
      { id: region.id, kind: "size", position: rotated([halfWidth, halfHeight]) },
      {
        id: region.id,
        kind: "rotation",
        position: rotated([0, -halfHeight - rotationHandleOffsetKm]),
      },
    );
  } else {
    handles.push(
      { id: region.id, kind: "axis-width", position: rotated([halfWidth, 0]) },
      { id: region.id, kind: "axis-height", position: rotated([0, halfHeight]) },
    );
  }
  return {
    lines: [lines],
    handles,
  };
}

export function regionClipRings(
  regions: Region[],
  center: Position,
  counties: BoundaryCollection,
): Position[][][] {
  return regions
    .filter((region) =>
      region.clip === true &&
      region.type !== "county" &&
      region.type !== "point" &&
      region.type !== "polyline"
    )
    .map((region) => regionGeometry(region, center, counties).lines
      .filter((line) => line.length >= 3)
      .map((line) => {
        const first = line[0];
        const last = line[line.length - 1];
        if (!first || !last || (first[0] === last[0] && first[1] === last[1])) return line;
        return [...line, first];
      })
      .filter((ring) => ring.length >= 4))
    .filter((rings) => rings.length > 0);
}

export function regionClipPolygons(
  regions: Region[],
  center: Position,
  counties: BoundaryCollection,
): Position[][][][] {
  const polygons: Position[][][][] = [];
  for (const region of regions) {
    if (region.clip !== true) continue;
    if (region.type === "county") {
      const feature = counties.features.find((item) => countyId(item) === region.countyId);
      if (!feature) continue;
      const countyPolygons = feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
      polygons.push(countyPolygons.map((polygon) =>
        polygon.map((ring) => ring.map((point) => toLocal(point, center)))
      ));
      continue;
    }
    if (region.type === "point" || region.type === "polyline") continue;

    const regionPolygons = regionGeometry(region, center, counties).lines
      .filter((line) => line.length >= 3)
      .map((line) => {
        const first = line[0];
        const last = line[line.length - 1];
        const ring = !first || !last || (first[0] === last[0] && first[1] === last[1])
          ? line
          : [...line, first];
        return [ring];
      });
    if (regionPolygons.length > 0) polygons.push(regionPolygons);
  }
  return polygons;
}

export function boundaryFeatureClipPolygons(
  collection: BoundaryCollection | null,
  selectedIds: string[],
  getId: (feature: BoundaryFeature) => string,
  center: Position,
): Position[][][][] {
  if (!collection || selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  return collection.features
    .filter((feature) => selected.has(getId(feature)))
    .map((feature) => {
      const polygons = feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
      return polygons.map((polygon) =>
        polygon.map((ring) => ring.map((point) => toLocal(point, center)))
      );
    });
}

export function bisectPolygonClosingEdge(points: Position[]): Position | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 3 || !first || !last) return null;
  return [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
}

export function extendPolylineEnd(
  points: Position[],
  center: Position,
  segmentLengthKm: number,
): Position | null {
  const previous = points[points.length - 2];
  const last = points[points.length - 1];
  if (!previous || !last || points.length < 2) return null;

  const previousLocal = toLocal(previous, center);
  const lastLocal = toLocal(last, center);
  const direction: Position = [
    lastLocal[0] - previousLocal[0],
    lastLocal[1] - previousLocal[1],
  ];
  const directionLength = Math.hypot(direction[0], direction[1]);
  const unitDirection: Position = directionLength > 1e-6
    ? [direction[0] / directionLength, direction[1] / directionLength]
    : [1, 0];

  return fromLocal([
    lastLocal[0] + unitDirection[0] * segmentLengthKm,
    lastLocal[1] + unitDirection[1] * segmentLengthKm,
  ], center);
}

export function moveRegionHandle(region: Region, handle: RegionHandle, local: Position, center: Position): Region {
  if (region.id !== handle.id) return region;
  if ((region.type === "polygon" || region.type === "polyline") && handle.kind === "center") {
    const localPoints = region.points.map((point) => toLocal(point, center));
    if (localPoints.length === 0) return region;
    const currentCenter = localPoints.reduce<Position>(
      (sum, point) => [sum[0] + point[0] / localPoints.length, sum[1] + point[1] / localPoints.length],
      [0, 0],
    );
    const delta: Position = [local[0] - currentCenter[0], local[1] - currentCenter[1]];
    return {
      ...region,
      points: localPoints.map((point) =>
        fromLocal([point[0] + delta[0], point[1] + delta[1]], center)
      ),
    };
  }
  if (
    (region.type === "polygon" || region.type === "polyline") &&
    handle.kind === "vertex" &&
    handle.index !== undefined
  ) {
    return {
      ...region,
      points: region.points.map((point, index) => index === handle.index ? fromLocal(local, center) : point),
    };
  }
  if (region.type === "ellipse" || region.type === "rectangle") {
    if (handle.kind === "center") return { ...region, center: fromLocal(local, center) };
    const origin = toLocal(region.center, center);
    const delta: Position = [local[0] - origin[0], local[1] - origin[1]];
    const rotation = region.rotation ?? 0;
    if (handle.kind === "rotation" && region.type === "rectangle") {
      return {
        ...region,
        rotation: Math.atan2(delta[0], -delta[1]) * 180 / Math.PI,
      };
    }
    if (handle.kind === "size") {
      const localDelta = rotatePoint(delta, -rotation);
      return {
        ...region,
        width: Math.max(0.1, Math.abs(localDelta[0]) * 2),
        height: Math.max(0.1, Math.abs(localDelta[1]) * 2),
      };
    }
    if (handle.kind === "axis-width" && region.type === "ellipse") {
      return {
        ...region,
        width: Math.max(0.1, Math.hypot(...delta) * 2),
        rotation: Math.atan2(delta[1], delta[0]) * 180 / Math.PI,
      };
    }
    if (handle.kind === "axis-height" && region.type === "ellipse") {
      return {
        ...region,
        height: Math.max(0.1, Math.hypot(...delta) * 2),
        rotation: (Math.atan2(delta[1], delta[0]) - Math.PI / 2) * 180 / Math.PI,
      };
    }
  }
  return region;
}
