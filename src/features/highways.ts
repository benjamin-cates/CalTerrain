import { geographicToMercator, toLocal } from "../geo";
import type { Position } from "../types";

export type HighwayGeometry =
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] };

export type HighwayFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: HighwayGeometry | null;
};

export type HighwayFeatureCollection = {
  type: "FeatureCollection";
  features: HighwayFeature[];
};

export type HighwayRouteType = "highway" | "interstate";

export type HighwayShield = {
  id: string;
  number: string;
  type: HighwayRouteType;
  position: Position;
  spacingIndex: number;
};

const INTERSTATE_ROUTE_NUMBERS = new Set([
  "5", "8", "10", "15", "40", "80", "105", "110", "205", "210", "215",
  "280", "380", "405", "505", "580", "605", "680", "710", "780", "805",
  "880", "905",
]);
export const HIGHWAY_SHIELD_VISIBILITY_DISTANCE_KM = 300;
export const HIGHWAY_LINE_JOIN_TOLERANCE_METERS = 200;
const SHIELD_SPACING_KM = 5;
const MINIMUM_SHIELDED_ROUTE_LENGTH_KM = 5;
const EARTH_RADIUS_METERS = 6_371_008.8;
const MIN_HIGHWAY_JOIN_DIRECTION_DOT = -0.99;
const ROUTE_OVERLAP_TOLERANCE_METERS = 50;
const ROUTE_OVERLAP_COVERAGE_RATIO = 0.99;
const ROUTE_OVERLAP_SAMPLE_INTERVAL_METERS = 100;
const ROUTE_SPATIAL_INDEX_CELL_METERS = 500;

type ProjectedPosition = { x: number; y: number; latitude: number };
type ProjectedSegment = { start: ProjectedPosition; end: ProjectedPosition };
type RouteSpatialIndex = Map<string, Set<ProjectedSegment>>;

export function highwayShieldStrideForDistance(distanceKm: number): number {
  if (distanceKm > 220) return 32;
  if (distanceKm > 150) return 24;
  if (distanceKm > 80) return 16;
  if (distanceKm > 40) return 8;
  if (distanceKm > 20) return 4;
  if (distanceKm > 10) return 2;
  return 1;
}

function routeDetails(feature: HighwayFeature): {
  number: string;
  type: HighwayRouteType;
} | null {
  const rawNumber = feature.properties.RouteNum;
  if (typeof rawNumber !== "string" && typeof rawNumber !== "number") return null;
  const number = String(rawNumber).trim().replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(number)) return null;
  return {
    number,
    type: INTERSTATE_ROUTE_NUMBERS.has(number) ? "interstate" : "highway",
  };
}

function linesForGeometry(geometry: HighwayGeometry): Position[][] {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}

function endpointDistanceMeters(first: Position, second: Position): number {
  const radians = Math.PI / 180;
  const latitude1 = first[1] * radians;
  const latitude2 = second[1] * radians;
  const latitudeDelta = latitude2 - latitude1;
  let longitudeDelta = (second[0] - first[0]) * radians;
  if (longitudeDelta > Math.PI) longitudeDelta -= Math.PI * 2;
  if (longitudeDelta < -Math.PI) longitudeDelta += Math.PI * 2;
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function routeLineKey(line: Position[]): string {
  const forward = line.map(([longitude, latitude]) => `${longitude},${latitude}`).join(";");
  const reverse = [...line].reverse()
    .map(([longitude, latitude]) => `${longitude},${latitude}`).join(";");
  return forward < reverse ? forward : reverse;
}

function projectPosition(position: Position): ProjectedPosition {
  const [x, y] = geographicToMercator(position[0], position[1]);
  return { x, y, latitude: position[1] };
}

function routeLineLengthMeters(line: Position[]): number {
  let length = 0;
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    const current = line[index];
    if (previous && current) length += endpointDistanceMeters(previous, current);
  }
  return length;
}

function spatialCellKey(x: number, y: number): string {
  return `${Math.floor(x / ROUTE_SPATIAL_INDEX_CELL_METERS)},${Math.floor(y / ROUTE_SPATIAL_INDEX_CELL_METERS)}`;
}

function addRouteLineToSpatialIndex(index: RouteSpatialIndex, line: Position[]): void {
  for (let pointIndex = 1; pointIndex < line.length; pointIndex += 1) {
    const startPosition = line[pointIndex - 1];
    const endPosition = line[pointIndex];
    if (!startPosition || !endPosition) continue;
    const start = projectPosition(startPosition);
    const end = projectPosition(endPosition);
    const segment: ProjectedSegment = { start, end };
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / (ROUTE_SPATIAL_INDEX_CELL_METERS / 2)));
    const indexedCells = new Set<string>();

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const ratio = sampleIndex / sampleCount;
      const cellX = Math.floor(
        (start.x + (end.x - start.x) * ratio) / ROUTE_SPATIAL_INDEX_CELL_METERS,
      );
      const cellY = Math.floor(
        (start.y + (end.y - start.y) * ratio) / ROUTE_SPATIAL_INDEX_CELL_METERS,
      );
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          indexedCells.add(`${cellX + offsetX},${cellY + offsetY}`);
        }
      }
    }

    for (const cell of indexedCells) {
      let segments = index.get(cell);
      if (!segments) {
        segments = new Set();
        index.set(cell, segments);
      }
      segments.add(segment);
    }
  }
}

function isNearIndexedRoute(position: Position, index: RouteSpatialIndex): boolean {
  const projected = projectPosition(position);
  const segments = index.get(spatialCellKey(projected.x, projected.y));
  if (!segments) return false;
  const latitudeScale = Math.cos(projected.latitude * Math.PI / 180);

  for (const { start, end } of segments) {
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const ratio = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(
        1,
        ((projected.x - start.x) * deltaX + (projected.y - start.y) * deltaY) /
        lengthSquared,
      ));
    const nearestX = start.x + deltaX * ratio;
    const nearestY = start.y + deltaY * ratio;
    const groundDistance = Math.hypot(projected.x - nearestX, projected.y - nearestY) *
      latitudeScale;
    if (groundDistance <= ROUTE_OVERLAP_TOLERANCE_METERS) return true;
  }
  return false;
}

function interpolatePosition(start: Position, end: Position, ratio: number): Position {
  let longitudeDelta = end[0] - start[0];
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  return [
    start[0] + longitudeDelta * ratio,
    start[1] + (end[1] - start[1]) * ratio,
  ];
}

function sampleRouteLine(line: Position[]): Position[] {
  const first = line[0];
  const last = line[line.length - 1];
  if (!first || !last) return [];
  const samples = [first];
  let traversed = 0;
  let nextSample = ROUTE_OVERLAP_SAMPLE_INTERVAL_METERS;
  let totalLength = 0;

  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1];
    const end = line[index];
    if (!start || !end) continue;
    const segmentLength = endpointDistanceMeters(start, end);
    if (segmentLength === 0) continue;
    while (nextSample < traversed + segmentLength) {
      samples.push(interpolatePosition(start, end, (nextSample - traversed) / segmentLength));
      nextSample += ROUTE_OVERLAP_SAMPLE_INTERVAL_METERS;
    }
    traversed += segmentLength;
    totalLength += segmentLength;
  }

  if (totalLength > 0) {
    let remaining = totalLength / 2;
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (!start || !end) continue;
      const segmentLength = endpointDistanceMeters(start, end);
      if (remaining <= segmentLength) {
        samples.push(interpolatePosition(start, end, remaining / segmentLength));
        break;
      }
      remaining -= segmentLength;
    }
  }
  if (last[0] !== first[0] || last[1] !== first[1]) samples.push(last);
  return samples;
}

function isCoveredByIndexedRoute(line: Position[], index: RouteSpatialIndex): boolean {
  const first = line[0];
  const last = line[line.length - 1];
  if (
    !first ||
    !last ||
    !isNearIndexedRoute(first, index) ||
    !isNearIndexedRoute(last, index)
  ) return false;
  const samples = sampleRouteLine(line);
  if (samples.length === 0) return false;
  const coveredCount = samples.reduce(
    (count, sample) => count + (isNearIndexedRoute(sample, index) ? 1 : 0),
    0,
  );
  return coveredCount / samples.length >= ROUTE_OVERLAP_COVERAGE_RATIO;
}

function removeCoveredRouteLines(lines: Position[][]): Position[][] {
  const ordered = lines.map((line) => ({
    line,
    length: routeLineLengthMeters(line),
    key: routeLineKey(line),
  })).sort((first, second) =>
    second.length - first.length || first.key.localeCompare(second.key)
  );
  const index: RouteSpatialIndex = new Map();
  const uniqueRoutes: Position[][] = [];

  for (const candidate of ordered) {
    if (candidate.length === 0) continue;
    if (uniqueRoutes.length > 0 && isCoveredByIndexedRoute(candidate.line, index)) continue;
    uniqueRoutes.push(candidate.line);
    addRouteLineToSpatialIndex(index, candidate.line);
  }
  return uniqueRoutes;
}

function lineDirection(start: Position, end: Position): Position {
  const radians = Math.PI / 180;
  let longitudeDelta = (end[0] - start[0]) * radians;
  if (longitudeDelta > Math.PI) longitudeDelta -= Math.PI * 2;
  if (longitudeDelta < -Math.PI) longitudeDelta += Math.PI * 2;
  const meanLatitude = (start[1] + end[1]) * radians / 2;
  return [
    longitudeDelta * Math.cos(meanLatitude),
    (end[1] - start[1]) * radians,
  ];
}

function joinDirectionDot(
  current: Position[],
  candidate: Position[],
  connectAtStart: boolean,
  reverseCandidate: boolean,
): number {
  const orientedCandidate = reverseCandidate ? [...candidate].reverse() : candidate;
  const incomingLine = connectAtStart ? orientedCandidate : current;
  const outgoingLine = connectAtStart ? current : orientedCandidate;
  const incomingStart = incomingLine[incomingLine.length - 2];
  const incomingEnd = incomingLine[incomingLine.length - 1];
  const outgoingStart = outgoingLine[0];
  const outgoingEnd = outgoingLine[1];
  if (!incomingStart || !incomingEnd || !outgoingStart || !outgoingEnd) return 1;
  const incoming = lineDirection(incomingStart, incomingEnd);
  const outgoing = lineDirection(outgoingStart, outgoingEnd);
  const magnitudeProduct = Math.hypot(...incoming) * Math.hypot(...outgoing);
  if (magnitudeProduct === 0) return 1;
  return (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / magnitudeProduct;
}

function mergeRouteLines(lines: Position[][]): Position[][] {
  const uniqueLines = new Map<string, Position[]>();
  for (const line of lines) {
    const points = line.filter((point, index) =>
      index === 0 || point[0] !== line[index - 1]?.[0] || point[1] !== line[index - 1]?.[1]
    );
    if (points.length < 2) continue;
    const key = routeLineKey(points);
    if (!uniqueLines.has(key)) uniqueLines.set(key, points);
  }

  const remaining = removeCoveredRouteLines([...uniqueLines.values()]);
  const merged: Position[][] = [];
  while (remaining.length > 0) {
    let current: Position[] | undefined = remaining.shift();
    if (!current) continue;
    while (true) {
      let closest: {
        index: number;
        distance: number;
        connectAtStart: boolean;
        reverseCandidate: boolean;
      } | null = null;
      const currentStart = current[0];
      const currentEnd = current[current.length - 1];
      if (!currentStart || !currentEnd) break;

      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const candidateStart = candidate?.[0];
        const candidateEnd = candidate?.[candidate.length - 1];
        if (!candidateStart || !candidateEnd) continue;
        const matches: {
          distance: number;
          connectAtStart: boolean;
          reverseCandidate: boolean;
        }[] = [
            { distance: endpointDistanceMeters(currentEnd, candidateStart), connectAtStart: false, reverseCandidate: false },
            { distance: endpointDistanceMeters(currentEnd, candidateEnd), connectAtStart: false, reverseCandidate: true },
            { distance: endpointDistanceMeters(currentStart, candidateEnd), connectAtStart: true, reverseCandidate: false },
            { distance: endpointDistanceMeters(currentStart, candidateStart), connectAtStart: true, reverseCandidate: true },
          ];
        for (const match of matches) {
          if (
            match.distance <= HIGHWAY_LINE_JOIN_TOLERANCE_METERS &&
            joinDirectionDot(
              current,
              candidate,
              match.connectAtStart,
              match.reverseCandidate,
            ) >= MIN_HIGHWAY_JOIN_DIRECTION_DOT &&
            (!closest || match.distance < closest.distance)
          ) {
            closest = { index, ...match };
          }
        }
      }

      if (!closest) break;
      const candidate = remaining.splice(closest.index, 1)[0];
      if (!candidate) break;
      const orientedCandidate: Position[] = closest.reverseCandidate
        ? [...candidate].reverse()
        : candidate;
      if (closest.connectAtStart) {
        current = [...orientedCandidate, ...current];
      } else {
        current = [...current, ...orientedCandidate];
      }
    }
    merged.push(current);
  }
  return removeCoveredRouteLines(merged);
}

export function getHighwayLines(
  collection: HighwayFeatureCollection,
  center: Position,
  routeType: HighwayRouteType,
  routeNumbers?: ReadonlySet<string>,
): Position[][] {
  return collection.features.flatMap((feature) => {
    const route = routeDetails(feature);
    if (
      route?.type !== routeType ||
      !feature.geometry ||
      (routeNumbers && !routeNumbers.has(route.number))
    ) return [];
    return linesForGeometry(feature.geometry).map((line) =>
      line.map((position) => toLocal(position, center))
    );
  });
}

export function getHighwayRouteNumbers(
  collection: HighwayFeatureCollection,
  routeType: HighwayRouteType,
): string[] {
  return [...new Set(collection.features.flatMap((feature) => {
    const route = routeDetails(feature);
    return route?.type === routeType ? [route.number] : [];
  }))].sort((left, right) => Number(left) - Number(right));
}

export function getHighwayRouteLines(
  collection: HighwayFeatureCollection,
  routeType: HighwayRouteType,
  routeNumber: string,
): Position[][] {
  const lines = collection.features.flatMap((feature) => {
    const route = routeDetails(feature);
    if (route?.type !== routeType || route.number !== routeNumber || !feature.geometry) return [];
    return linesForGeometry(feature.geometry);
  });
  return mergeRouteLines(lines);
}

export function createHighwayShields(
  collection: HighwayFeatureCollection,
  center: Position,
  selectedRoutes?: ReadonlySet<string>,
): HighwayShield[] {
  const routes = new Map<string, {
    number: string;
    type: HighwayRouteType;
    lines: Position[][];
  }>();
  for (const feature of collection.features) {
    const route = routeDetails(feature);
    if (!route || !feature.geometry) continue;
    const key = `${route.type}/${route.number}`;
    if (selectedRoutes && !selectedRoutes.has(key)) continue;
    let group = routes.get(key);
    if (!group) {
      group = { ...route, lines: [] };
      routes.set(key, group);
    }
    group.lines.push(...linesForGeometry(feature.geometry).map((line) =>
      line.map((position) => toLocal(position, center))
    ));
  }

  const shields: HighwayShield[] = [];
  for (const route of routes.values()) {
    for (let lineIndex = 0; lineIndex < route.lines.length; lineIndex += 1) {
      const line = route.lines[lineIndex];
      if (!line) continue;
      let lineLength = 0;
      for (let index = 1; index < line.length; index += 1) {
        const start = line[index - 1];
        const end = line[index];
        if (start && end) lineLength += Math.hypot(end[0] - start[0], end[1] - start[1]);
      }
      if (lineLength < MINIMUM_SHIELDED_ROUTE_LENGTH_KM) continue;

      const firstDistance = lineLength < SHIELD_SPACING_KM
        ? lineLength / 2
        : SHIELD_SPACING_KM / 2;
      let nextShieldDistance = firstDistance;
      let spacingIndex = 0;
      let traversed = 0;
      for (let index = 1; index < line.length; index += 1) {
        const start = line[index - 1];
        const end = line[index];
        if (!start || !end) continue;
        const segmentLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (segmentLength === 0) continue;
        while (nextShieldDistance <= traversed + segmentLength) {
          const ratio = (nextShieldDistance - traversed) / segmentLength;
          shields.push({
            id: `${route.type}-${route.number}-${lineIndex}-${spacingIndex}`,
            number: route.number,
            type: route.type,
            position: [
              start[0] + (end[0] - start[0]) * ratio,
              start[1] + (end[1] - start[1]) * ratio,
            ],
            spacingIndex,
          });
          spacingIndex += 1;
          nextShieldDistance += SHIELD_SPACING_KM;
        }
        traversed += segmentLength;
      }
    }
  }
  return shields;
}
