import type { BoundaryFeature, Position, Ring } from "./types";

export const WORLD_METERS = 40_075_016.68557849;

export function mercatorToGeographic(x: number, y: number): Position {
  return [
    (x / WORLD_METERS) * 360,
    (Math.atan(Math.sinh((y / WORLD_METERS) * 2 * Math.PI)) * 180) / Math.PI,
  ];
}

export function geographicToMercator(longitude: number, latitude: number): Position {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [
    (longitude * WORLD_METERS) / 360,
    (Math.log(Math.tan(Math.PI / 4 + (clampedLatitude * Math.PI) / 360)) * WORLD_METERS) /
      (2 * Math.PI),
  ];
}

export function featureRings(feature: BoundaryFeature): Ring[] {
  return feature.geometry.type === "Polygon"
    ? feature.geometry.coordinates
    : feature.geometry.coordinates.flatMap((polygon) => polygon);
}

export function countyId(feature: BoundaryFeature): string {
  return String(feature.properties.CENSUS_GEO ?? feature.properties.CDTFA_COUN ?? "");
}

export function countyName(feature: BoundaryFeature): string {
  return String(feature.properties.CDTFA_COUN ?? feature.properties.CENSUS_PLA ?? countyId(feature));
}

export function formatCoordinates(position: Position): string {
  const [longitude, latitude] = mercatorToGeographic(position[0], position[1]);
  return `${Math.abs(latitude).toFixed(3)}° ${latitude < 0 ? "S" : "N"}, ${Math.abs(longitude).toFixed(3)}° ${longitude < 0 ? "W" : "E"}`;
}

export function toLocal(position: Position, center: Position): Position {
  const mercator = geographicToMercator(...position);
  return [(mercator[0] - center[0]) / 1_000, -(mercator[1] - center[1]) / 1_000];
}

export function fromLocal(position: Position, center: Position): Position {
  return mercatorToGeographic(center[0] + position[0] * 1_000, center[1] - position[1] * 1_000);
}
