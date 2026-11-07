import { fromLocal } from "./geo";
import { regionGeometry } from "./regions";
import type { BoundaryCollection, FeatureGeometry, Position, Region } from "./types";

const EMPTY_BOUNDARIES: BoundaryCollection = {
  type: "FeatureCollection",
  features: [],
};
const EARTH_RADIUS_METERS = 6_371_008.8;

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function longitudeDelta(first: number, second: number): number {
  let delta = radians(second - first);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

function segmentLengthMeters([longitude1, latitude1]: Position, [longitude2, latitude2]: Position): number {
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = longitudeDelta(longitude1, longitude2);
  const firstLatitude = radians(latitude1);
  const secondLatitude = radians(latitude2);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function pathLengthMeters(path: Position[]): number {
  let length = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (previous && current) length += segmentLengthMeters(previous, current);
  }
  return length;
}

function ringLengthMeters(ring: Position[]): number {
  const length = pathLengthMeters(ring);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    return length + segmentLengthMeters(last, first);
  }
  return length;
}

function ringAreaSquareMeters(ring: Position[]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index];
    const second = ring[(index + 1) % ring.length];
    if (!first || !second) continue;
    sum += longitudeDelta(first[0], second[0]) *
      (2 + Math.sin(radians(first[1])) + Math.sin(radians(second[1])));
  }
  return Math.abs(sum * EARTH_RADIUS_METERS ** 2 / 2);
}

function polygonsForGeometry(geometry: FeatureGeometry): Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function linesForGeometry(geometry: FeatureGeometry): Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

export function measureLineGeometries(lines: Position[][]): number {
  return lines.reduce((total, line) => total + pathLengthMeters(line), 0);
}

export function measurePolygonGeometries(geometries: FeatureGeometry[]): {
  perimeterMeters: number;
  areaSquareMeters: number;
} {
  let perimeterMeters = 0;
  let areaSquareMeters = 0;
  for (const geometry of geometries) {
    for (const polygon of polygonsForGeometry(geometry)) {
      polygon.forEach((ring, index) => {
        perimeterMeters += ringLengthMeters(ring);
        const area = ringAreaSquareMeters(ring);
        areaSquareMeters += index === 0 ? area : -area;
      });
    }
  }
  return { perimeterMeters, areaSquareMeters: Math.max(0, areaSquareMeters) };
}

export function polygonPiecesFromGeometries(geometries: FeatureGeometry[]): Position[][] {
  return geometries.flatMap((geometry) =>
    polygonsForGeometry(geometry).flatMap((polygon) => {
      const exterior = polygon[0];
      if (!exterior) return [];
      const points = exterior.length > 1 &&
        exterior[0]?.[0] === exterior[exterior.length - 1]?.[0] &&
        exterior[0]?.[1] === exterior[exterior.length - 1]?.[1]
        ? exterior.slice(0, -1)
        : exterior;
      return new Set(points.map(([longitude, latitude]) => `${longitude},${latitude}`)).size >= 3
        ? [points]
        : [];
    })
  );
}

export function linePiecesFromGeometries(geometries: FeatureGeometry[]): Position[][] {
  return geometries.flatMap(linesForGeometry)
    .filter((line) => line.length >= 2);
}

export function featureGeometryPositions(geometries: FeatureGeometry[]): Position[] {
  return geometries.flatMap((geometry) => [
    ...polygonsForGeometry(geometry).flatMap((polygon) => polygon.flat()),
    ...linesForGeometry(geometry).flat(),
  ]);
}

export function customRegionGeometries(region: Region, center: Position): FeatureGeometry[] {
  if (region.type === "point" || region.type === "county") return [];
  if (region.type === "polyline") {
    return [{ type: "LineString", coordinates: region.points }];
  }
  const lines = regionGeometry(region, center, EMPTY_BOUNDARIES).lines;
  return lines.map((line) => ({
    type: "Polygon",
    coordinates: [line.map((point) => fromLocal(point, center))],
  }));
}
