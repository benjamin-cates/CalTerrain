import {
  difference,
  intersection,
  union,
  type MultiPolygon,
} from "polygon-clipping";
import { fromLocal, toLocal } from "./geo";
import { customRegionGeometries, measureLineGeometries } from "./featureAnalysis";
import type { Position, Region } from "./types";

export type PolylineEnd = "start" | "end";
export type PolygonOperation = "union" | "intersection" | "difference";

const MIN_RETAINED_POLYLINE_METERS = 0.1;

function localPath(points: Position[], center: Position): Position[] {
  return points.map((position) => toLocal(position, center));
}

export function polylineLengthMeters(points: Position[]): number {
  return measureLineGeometries([points]);
}

function pointAtDistance(path: Position[], segmentLengths: number[], distanceMeters: number): Position {
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index] ?? 0;
    const start = path[index];
    const end = path[index + 1];
    if (!start || !end) continue;
    if (distanceMeters <= traversed + segmentLength || index === segmentLengths.length - 1) {
      const ratio = segmentLength === 0
        ? 0
        : Math.max(0, Math.min(1, (distanceMeters - traversed) / segmentLength));
      return [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio,
      ];
    }
    traversed += segmentLength;
  }
  const last = path.at(-1);
  if (!last) throw new Error("Cannot trim an empty polyline.");
  return last;
}

export function positionAtLineDistance(
  lines: Position[][],
  distanceMeters: number,
  center: Position,
): Position {
  let remainingDistance = Math.max(0, distanceMeters);
  for (const line of lines) {
    if (line.length < 2) continue;
    const path = localPath(line, center);
    const segmentLengths = line.slice(1).map((position, index) => {
      const previous = line[index];
      return previous ? measureLineGeometries([[previous, position]]) : 0;
    });
    const lineLength = segmentLengths.reduce((total, length) => total + length, 0);
    if (remainingDistance <= lineLength) {
      return fromLocal(pointAtDistance(path, segmentLengths, remainingDistance), center);
    }
    remainingDistance -= lineLength;
  }
  const last = lines.flatMap((line) => line).at(-1);
  if (!last) throw new Error("Cannot sample a line without coordinates.");
  return last;
}

export function shiftPolygonStart(points: Position[], startIndex: number): Position[] {
  const isClosed = points.length > 1 &&
    points[0]?.[0] === points.at(-1)?.[0] &&
    points[0]?.[1] === points.at(-1)?.[1];
  const openPoints = isClosed ? points.slice(0, -1) : [...points];
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= openPoints.length) {
    throw new RangeError("The polygon start index is outside the available vertices.");
  }
  const shifted = [...openPoints.slice(startIndex), ...openPoints.slice(0, startIndex)];
  if (isClosed && shifted[0]) shifted.push(shifted[0]);
  return shifted;
}

export function trimPolyline(
  points: Position[],
  startMeters: number,
  endMeters: number,
  center: Position,
): Position[] {
  if (points.length < 2) throw new Error("A polyline needs at least two points to trim.");
  const path = localPath(points, center);
  const segmentLengths = points.slice(1).map((position, index) => {
    const previous = points[index];
    return previous ? measureLineGeometries([[previous, position]]) : 0;
  });
  const totalLength = segmentLengths.reduce((total, length) => total + length, 0);
  const start = Math.max(0, startMeters);
  const end = Math.max(0, endMeters);
  if (start + end > totalLength - MIN_RETAINED_POLYLINE_METERS) {
    throw new RangeError("Trimming must leave at least 10 cm of line.");
  }
  const endDistance = totalLength - end;
  const trimmed: Position[] = [pointAtDistance(path, segmentLengths, start)];
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    traversed += segmentLengths[index] ?? 0;
    const vertex = path[index + 1];
    if (vertex && traversed > start && traversed < endDistance) trimmed.push(vertex);
  }
  trimmed.push(pointAtDistance(path, segmentLengths, endDistance));
  return trimmed.map((position) => fromLocal(position, center));
}

export function connectPolylines(
  first: Position[],
  second: Position[],
  firstEnd: PolylineEnd,
  secondEnd: PolylineEnd,
): Position[] {
  if (first.length < 2 || second.length < 2) {
    throw new Error("Both polylines need at least two points to connect.");
  }
  const orientedFirst = firstEnd === "start" ? [...first].reverse() : first;
  const orientedSecond = secondEnd === "end" ? [...second].reverse() : second;
  const firstEndpoint = orientedFirst.at(-1);
  const secondEndpoint = orientedSecond[0];
  if (!firstEndpoint || !secondEndpoint) throw new Error("Could not find polyline endpoints.");
  const sameEndpoint =
    firstEndpoint[0] === secondEndpoint[0] && firstEndpoint[1] === secondEndpoint[1];
  return sameEndpoint
    ? [...orientedFirst, ...orientedSecond.slice(1)]
    : [...orientedFirst, ...orientedSecond];
}

function closeRing(points: Position[]): Position[] {
  const ring = points.map((position) => [...position] as Position);
  const first = ring[0];
  const last = ring.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([...first]);
  }
  return ring;
}

function regionAsMultiPolygon(region: Region, center: Position): MultiPolygon {
  if (region.type === "point" || region.type === "county") {
    throw new Error("Points and counties cannot be used as custom polygon regions.");
  }
  const polygons = region.type === "polyline"
    ? [[region.points]]
    : customRegionGeometries(region, center).flatMap((geometry) => {
      if (geometry.type === "Polygon") return [geometry.coordinates];
      if (geometry.type === "MultiPolygon") return geometry.coordinates;
      return [];
    });
  if (
    region.type === "polyline" &&
    new Set(region.points.map(([longitude, latitude]) => `${longitude},${latitude}`)).size < 3
  ) {
    throw new Error("A polyline needs at least three distinct points to become a polygon.");
  }
  const converted = polygons
    .map((polygon) => polygon.map((ring) => closeRing(ring.map((position) => toLocal(position, center)))))
    .filter((polygon) => polygon[0] && polygon[0].length >= 4);
  if (converted.length === 0) {
    throw new Error("This custom region cannot be converted to a polygon.");
  }
  return converted as MultiPolygon;
}

function openRing(ring: Position[]): Position[] {
  if (
    ring.length > 1 &&
    ring[0]?.[0] === ring.at(-1)?.[0] &&
    ring[0]?.[1] === ring.at(-1)?.[1]
  ) {
    return ring.slice(0, -1);
  }
  return [...ring];
}

function bridgeHole(outer: Position[], holeRing: Position[]): Position[] {
  const hole = openRing(holeRing);
  if (outer.length < 3 || hole.length < 3) return outer;
  let nearestDistanceSquared = Infinity;
  let nearestEdge = -1;
  let nearestHoleVertex = -1;
  let nearestOuterPoint: Position | null = null;
  for (let edgeIndex = 0; edgeIndex < outer.length; edgeIndex += 1) {
    const start = outer[edgeIndex];
    const end = outer[(edgeIndex + 1) % outer.length];
    if (!start || !end) continue;
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    for (let holeIndex = 0; holeIndex < hole.length; holeIndex += 1) {
      const candidate = hole[holeIndex];
      if (!candidate) continue;
      const ratio = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, (
          (candidate[0] - start[0]) * deltaX +
          (candidate[1] - start[1]) * deltaY
        ) / lengthSquared));
      const outerPoint: Position = [
        start[0] + deltaX * ratio,
        start[1] + deltaY * ratio,
      ];
      const distanceSquared =
        (candidate[0] - outerPoint[0]) ** 2 + (candidate[1] - outerPoint[1]) ** 2;
      if (distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestEdge = edgeIndex;
        nearestHoleVertex = holeIndex;
        nearestOuterPoint = outerPoint;
      }
    }
  }
  if (nearestEdge < 0 || nearestHoleVertex < 0 || !nearestOuterPoint) return outer;
  const rotatedHole = [
    ...hole.slice(nearestHoleVertex),
    ...hole.slice(0, nearestHoleVertex),
  ];
  const nextEdgeIndex = (nearestEdge + 1) % outer.length;
  const outerPath = nextEdgeIndex === 0
    ? [...outer.slice(0, nearestEdge + 1), nearestOuterPoint]
    : [
      ...outer.slice(0, nearestEdge + 1),
      nearestOuterPoint,
      ...outer.slice(nextEdgeIndex),
    ];
  return [
    ...outerPath.slice(0, nearestEdge + 2),
    ...rotatedHole,
    rotatedHole[0]!,
    nearestOuterPoint,
    ...outerPath.slice(nearestEdge + 2),
  ];
}

export function combineCustomRegions(
  first: Region,
  second: Region,
  operation: PolygonOperation,
  center: Position,
): Position[] {
  const firstPolygon = regionAsMultiPolygon(first, center);
  const secondPolygon = regionAsMultiPolygon(second, center);
  let result: MultiPolygon;
  if (operation === "union") {
    result = union(firstPolygon, secondPolygon);
  } else if (operation === "intersection") {
    result = intersection(firstPolygon, secondPolygon);
  } else {
    result = difference(firstPolygon, secondPolygon);
  }
  if (result.length === 0) {
    throw new Error(
      operation === "intersection"
        ? "The selected custom regions do not overlap."
        : operation === "difference"
          ? "The selected region removes the entire current polygon."
          : "The union did not produce a polygon.",
    );
  }
  if (result.length !== 1) {
    throw new Error(
      operation === "union"
        ? "Union requires touching regions so the result is one contiguous polygon."
        : "This operation creates multiple separate pieces, which one custom polygon cannot represent.",
    );
  }
  const polygon = result[0];
  const exterior = polygon?.[0];
  if (!exterior) throw new Error("The operation did not produce a polygon boundary.");
  let output = openRing(exterior);
  for (const hole of polygon.slice(1)) output = bridgeHole(output, hole);
  if (output.length < 3) throw new Error("The operation did not produce a valid polygon.");
  return output.map((position) => fromLocal(position, center));
}
