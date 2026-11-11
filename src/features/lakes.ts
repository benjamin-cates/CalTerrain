import {
  BufferGeometry,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
} from "three";
import { featureRings, toLocal } from "../geo";
import type { BoundaryFeature, BoundaryGeometry, Position } from "../types";

export const LAKE_SKIRT_DEPTH_METERS = 1_000;

function propertyText(feature: BoundaryFeature, field: string): string {
  const value = feature.properties[field];
  return (typeof value === "string" || typeof value === "number")
    ? String(value).trim()
    : "";
}

export function lakeFeatureName(feature: BoundaryFeature): string {
  return propertyText(feature, "NAME") ||
    propertyText(feature, "GNIS_NAME") ||
    `Lake ${propertyText(feature, "FID") || propertyText(feature, "GlobalID")}`;
}

export function getLakePerimeterRings(geometry: BoundaryGeometry): Position[][] {
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  return polygons.flatMap((polygon) => polygon.map((ring) => {
    const isClosed = ring.length > 1 &&
      ring[0]?.[0] === ring.at(-1)?.[0] &&
      ring[0]?.[1] === ring.at(-1)?.[1];
    return isClosed ? ring.slice(0, -1) : ring;
  }));
}

export async function getLakePerimeterMedianElevation(
  rings: Position[][],
  sampleElevation: (position: Position) => Promise<number | null>,
): Promise<number | null> {
  const positions = rings.flat();
  const elevations: number[] = [];
  let nextPositionIndex = 0;
  let samplingFailed = false;
  let samplingError: unknown;
  const workerCount = Math.min(8, positions.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextPositionIndex < positions.length && !samplingFailed) {
      const position = positions[nextPositionIndex];
      nextPositionIndex += 1;
      if (!position) continue;
      try {
        const elevation = await sampleElevation(position);
        if (elevation !== null && Number.isFinite(elevation)) elevations.push(elevation);
      } catch (error) {
        samplingFailed = true;
        samplingError = error;
      }
    }
  }));
  if (samplingFailed) throw samplingError;
  if (elevations.length === 0) return null;

  elevations.sort((left, right) => left - right);
  const middleIndex = Math.floor(elevations.length / 2);
  const middleElevation = elevations[middleIndex];
  if (middleElevation === undefined) return null;
  if (elevations.length % 2 === 1) return middleElevation;
  const lowerElevation = elevations[middleIndex - 1];
  if (lowerElevation === undefined) return null;
  return (lowerElevation + middleElevation) / 2;
}

export function getLakeShoreElevation(
  feature: BoundaryFeature,
  center: Position,
  sampleElevation: (position: Position) => number | null,
): number | null {
  const perimeterElevations: number[] = [];
  for (const ring of featureRings(feature)) {
    for (const point of ring) {
      const elevation = sampleElevation(toLocal(point, center));
      if (elevation !== null && Number.isFinite(elevation)) {
        perimeterElevations.push(elevation);
      }
    }
  }
  if (perimeterElevations.length === 0) return null;

  perimeterElevations.sort((left, right) => left - right);
  const percentileIndex = (perimeterElevations.length - 1) * 0.8;
  const lowerIndex = Math.floor(percentileIndex);
  const upperIndex = Math.ceil(percentileIndex);
  const lowerElevation = perimeterElevations[lowerIndex];
  const upperElevation = perimeterElevations[upperIndex];
  if (lowerElevation === undefined || upperElevation === undefined) return null;
  return lowerElevation + (upperElevation - lowerElevation) *
    (percentileIndex - lowerIndex);
}

type LakePolygon = {
  rings: Vector2[][];
  contour: Vector2[];
  holes: Vector2[][];
  points: Vector2[];
  faces: number[][];
};

function localRing(ring: Position[], center: Position): Vector2[] | null {
  const coordinates = ring.length > 1 &&
      ring[0]?.[0] === ring.at(-1)?.[0] &&
      ring[0]?.[1] === ring.at(-1)?.[1]
    ? ring.slice(0, -1)
    : ring;
  if (coordinates.length < 3) return null;
  const points = coordinates.map((position) => {
    const [x, z] = toLocal(position, center);
    return new Vector2(x, z);
  });
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? points
    : null;
}

function appendTriangle(
  positions: number[],
  first: Vector2,
  second: Vector2,
  third: Vector2,
  height: number,
  reverse: boolean,
): void {
  const points = reverse
    ? [first, third, second]
    : [first, second, third];
  for (const point of points) {
    positions.push(point.x, height, point.y);
  }
}

export function createLakeMeshGeometry(
  feature: BoundaryFeature,
  center: Position,
  shoreElevationMeters: number,
  verticalExaggeration: number,
): BufferGeometry | null {
  const sourcePolygons = feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  const polygons: LakePolygon[] = [];

  for (const sourceRings of sourcePolygons) {
    const rings = sourceRings.map((ring) => localRing(ring, center));
    if (rings.some((ring) => ring === null)) return null;
    const validRings = rings.filter((ring): ring is Vector2[] => ring !== null);
    const contour = validRings[0];
    if (!contour) return null;
    const holes = validRings.slice(1);
    const points = [...contour, ...holes.flat()];
    polygons.push({
      rings: validRings,
      contour,
      holes,
      points,
      faces: ShapeUtils.triangulateShape(contour, holes),
    });
  }

  const top = shoreElevationMeters * verticalExaggeration / 1_000;
  const bottom = (shoreElevationMeters - LAKE_SKIRT_DEPTH_METERS) *
    verticalExaggeration / 1_000;
  const positions: number[] = [];
  for (const polygon of polygons) {
    for (const face of polygon.faces) {
      const first = polygon.points[face[0] ?? -1];
      const second = polygon.points[face[1] ?? -1];
      const third = polygon.points[face[2] ?? -1];
      if (!first || !second || !third) continue;
      const signedArea = (second.x - first.x) * (third.y - first.y) -
        (second.y - first.y) * (third.x - first.x);
      const reverse = signedArea > 0;
      appendTriangle(positions, first, second, third, top, reverse);
      appendTriangle(positions, first, second, third, bottom, !reverse);
    }

    for (const ring of polygon.rings) {
      for (let index = 0; index < ring.length; index += 1) {
        const first = ring[index];
        const second = ring[(index + 1) % ring.length];
        if (!first || !second) continue;
        positions.push(
          first.x, top, first.y,
          first.x, bottom, first.y,
          second.x, bottom, second.y,
          first.x, top, first.y,
          second.x, bottom, second.y,
          second.x, top, second.y,
        );
      }
    }
  }

  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
