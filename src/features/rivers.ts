import type { ShapefileFeature, ShapefileResult } from "shpjs";
import type { Position, TopographicFeatureOption } from "../types";

type RiverGeometry = Extract<
  NonNullable<ShapefileFeature["geometry"]>,
  { type: "LineString" | "MultiLineString" }
>;

export type RiverFeature = {
  type: "Feature";
  properties: { name: string };
  geometry: RiverGeometry;
};

export type RiverFeatureCollection = {
  type: "FeatureCollection";
  features: RiverFeature[];
};

function isValidLine(coordinates: Position[]): boolean {
  return coordinates.length >= 2 &&
    coordinates.every((position) =>
      Number.isFinite(position[0]) && Number.isFinite(position[1])
    );
}

function isRiverGeometry(
  geometry: ShapefileFeature["geometry"],
): geometry is RiverGeometry {
  if (!geometry) return false;
  if (geometry.type === "LineString") {
    return isValidLine(geometry.coordinates);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.length > 0 &&
      geometry.coordinates.every(isValidLine);
  }
  return false;
}

export function parseRiverShapefile(parsed: ShapefileResult): RiverFeatureCollection {
  if (Array.isArray(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("River shapefile must contain one feature collection.");
  }

  const seenNames = new Set<string>();
  const features: RiverFeature[] = [];
  for (const [index, feature] of parsed.features.entries()) {
    const rawName = feature.properties.name;
    if (typeof rawName !== "string" || !rawName.trim() || !isRiverGeometry(feature.geometry)) {
      throw new Error(`River shapefile feature ${index + 1} is missing a name or line geometry.`);
    }
    const name = rawName.trim();
    if (seenNames.has(name)) {
      throw new Error(`River shapefile contains duplicate river name "${name}".`);
    }
    seenNames.add(name);
    features.push({
      type: "Feature",
      properties: { name },
      geometry: feature.geometry,
    });
  }

  if (features.length === 0) {
    throw new Error("River shapefile contains no rivers.");
  }
  return { type: "FeatureCollection", features };
}

export function getRiverFeatureOptions(
  collection: RiverFeatureCollection,
): TopographicFeatureOption[] {
  return collection.features.map((feature) => ({
    id: feature.properties.name,
    label: feature.properties.name,
    lines: feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates,
  }));
}

type EndpointSide = "start" | "end";
type LineEndpoint = { pathIndex: number; side: EndpointSide };
type PathConnections = { start: LineEndpoint | null; end: LineEndpoint | null };

function endpointKey(position: Position): string {
  return `${position[0]},${position[1]}`;
}

export function mergeRiverLinePaths(lines: Position[][]): Position[][] {
  const paths = lines.filter((line) => line.length >= 2);
  const endpoints = new Map<string, LineEndpoint[]>();
  const connections: PathConnections[] = paths.map(() => ({ start: null, end: null }));

  paths.forEach((line, pathIndex) => {
    for (const side of ["start", "end"] as const) {
      const position = side === "start" ? line[0] : line.at(-1);
      if (!position) continue;
      const key = endpointKey(position);
      const matches = endpoints.get(key) ?? [];
      matches.push({ pathIndex, side });
      endpoints.set(key, matches);
    }
  });

  for (const matches of endpoints.values()) {
    if (matches.length !== 2 || matches[0]?.pathIndex === matches[1]?.pathIndex) continue;
    const [first, second] = matches;
    if (!first || !second) continue;
    const firstConnections = connections[first.pathIndex];
    const secondConnections = connections[second.pathIndex];
    if (!firstConnections || !secondConnections) continue;
    firstConnections[first.side] = second;
    secondConnections[second.side] = first;
  }

  const merged: Position[][] = [];
  const consumed = new Set<number>();
  const pathOrder = paths.map((_, index) => index).sort((first, second) => {
    const firstConnections = connections[first];
    const secondConnections = connections[second];
    const firstIsOpen = firstConnections && (!firstConnections.start || !firstConnections.end);
    const secondIsOpen = secondConnections && (!secondConnections.start || !secondConnections.end);
    return Number(secondIsOpen) - Number(firstIsOpen);
  });
  for (const pathIndex of pathOrder) {
    if (consumed.has(pathIndex)) continue;
    const path = paths[pathIndex];
    const pathConnections = connections[pathIndex];
    if (!path || !pathConnections) continue;

    const startSide: EndpointSide = pathConnections.start ? "end" : "start";
    let points = startSide === "start" ? [...path] : [...path].reverse();
    let currentIndex = pathIndex;
    let exitSide: EndpointSide = startSide === "start" ? "end" : "start";
    consumed.add(pathIndex);

    while (true) {
      const next = connections[currentIndex]?.[exitSide];
      if (!next || consumed.has(next.pathIndex)) break;
      const nextPath = paths[next.pathIndex];
      if (!nextPath) break;
      const orientedPath = next.side === "start" ? nextPath : [...nextPath].reverse();
      points = [...points, ...orientedPath.slice(1)];
      consumed.add(next.pathIndex);
      currentIndex = next.pathIndex;
      exitSide = next.side === "start" ? "end" : "start";
    }

    merged.push(points);
  }
  return merged;
}
