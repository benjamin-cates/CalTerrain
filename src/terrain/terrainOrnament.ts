import { difference, intersection, union, type MultiPolygon } from "polygon-clipping";
import {
  BufferGeometry,
  ExtrudeGeometry,
  Path,
  Shape,
} from "three";
import type { Position } from "../types";
import type { TerrainExportRegion } from "./terrainExport";

export type TerrainAccessory = {
  id: string;
  type: "handle" | "heart" | "star";
  position: Position;
  sizeMm: number;
  rotationDegrees: number;
  thicknessMm?: number;
  clipTerrain?: boolean;
};
export type TerrainAccessoryType = TerrainAccessory["type"];

export const TERRAIN_ACCESSORY_BASE_OVERLAP_MM = 0.1;

export function getTerrainAccessoryBaseOverlapMm(baseThicknessMm: number): number {
  return Math.min(TERRAIN_ACCESSORY_BASE_OVERLAP_MM, baseThicknessMm / 2);
}

export type TerrainModelOptions = {
  baseThicknessMm: number;
  latitudeSpanMm: number;
  accessories: TerrainAccessory[];
};

export type LocalTerrainAccessory = Omit<TerrainAccessory, "position"> & {
  position: Position;
  sizeKm: number;
};

export type TerrainModelFootprints = {
  surface: Position[][][];
  footprint: Position[][][];
  baseOnly: Position[][][];
  outerRadiusKm: number;
  innerRadiusKm: number;
};

function getOpenRing(ring: Position[]): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first && last && first[0] === last[0] && first[1] === last[1]
    ? ring.slice(0, -1)
    : ring;
}

function makeShape(ring: Position[], unitsPerLocalKm: number): Shape | null {
  const points = getOpenRing(ring);
  const first = points[0];
  if (!first || points.length < 3) return null;
  const shape = new Shape();
  shape.moveTo(first[0] * unitsPerLocalKm, first[1] * unitsPerLocalKm);
  for (const [x, z] of points.slice(1)) {
    shape.lineTo(x * unitsPerLocalKm, z * unitsPerLocalKm);
  }
  shape.lineTo(first[0] * unitsPerLocalKm, first[1] * unitsPerLocalKm);
  return shape;
}

function createBoundaryExtrusionShapes(
  region: TerrainExportRegion,
  unitsPerLocalKm: number,
): Shape[] {
  return region.polygons.flatMap((polygon) => {
    const outer = polygon[0];
    if (!outer) return [];
    const shape = makeShape(outer, unitsPerLocalKm);
    if (!shape) return [];
    for (const ring of polygon.slice(1)) {
      const points = getOpenRing(ring);
      const first = points[0];
      if (!first || points.length < 3) continue;
      const hole = new Path();
      hole.moveTo(first[0] * unitsPerLocalKm, first[1] * unitsPerLocalKm);
      for (const [x, z] of points.slice(1)) {
        hole.lineTo(x * unitsPerLocalKm, z * unitsPerLocalKm);
      }
      hole.lineTo(first[0] * unitsPerLocalKm, first[1] * unitsPerLocalKm);
      shape.holes.push(hole);
    }
    return [shape];
  });
}

function positionExtrusion(
  geometry: ExtrudeGeometry,
  topY: number,
): BufferGeometry {
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, topY, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function makeCircle(
  center: Position,
  radiusKm: number,
  steps = 96,
): MultiPolygon {
  const ring: Position[] = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = index * Math.PI * 2 / steps;
    ring.push([
      center[0] + Math.cos(angle) * radiusKm,
      center[1] + Math.sin(angle) * radiusKm,
    ]);
  }
  ring.push(ring[0]!);
  return [[ring]];
}

export function getTerrainRegionLargestDimension(region: TerrainExportRegion): number {
  const points = region.polygons.flat(2);
  if (points.length === 0) return 0;
  const bounds = points.reduce((result, [x, z]) => ({
    minX: Math.min(result.minX, x),
    minZ: Math.min(result.minZ, z),
    maxX: Math.max(result.maxX, x),
    maxZ: Math.max(result.maxZ, z),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  return Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
}

export function getTerrainRegionLatitudeSpanKm(region: TerrainExportRegion): number {
  const points = region.polygons.flat(2);
  if (points.length === 0) return 0;
  const [minZ, maxZ] = points.reduce(
    ([minimum, maximum], [, z]) => [
      Math.min(minimum, z),
      Math.max(maximum, z),
    ],
    [Infinity, -Infinity],
  );
  return maxZ - minZ;
}

export function getTerrainAccessoryTopY(
  accessory: Pick<TerrainAccessory, "thicknessMm">,
  regionSpanKm: number,
  latitudeSpanMm: number,
): number {
  return (accessory.thicknessMm ?? 1) * regionSpanKm / latitudeSpanMm;
}

export function getDefaultTerrainHandlePosition(region: TerrainExportRegion): Position {
  const points = region.polygons.flatMap((polygon) =>
    polygon.flatMap((ring) => getOpenRing(ring))
  );
  if (points.length === 0) throw new Error("Cannot place a handle for an empty region.");
  const northernmostZ = points.reduce(
    (minimum, [, z]) => Math.min(minimum, z),
    Infinity,
  );
  const northernmostPoints = points.filter(([, z]) => Math.abs(z - northernmostZ) < 1e-9);
  const longitude = northernmostPoints.reduce((total, [x]) => total + x, 0) /
    northernmostPoints.length;
  return [longitude, northernmostZ];
}

export function getDefaultTerrainAccessoryPosition(
  region: TerrainExportRegion,
  type: TerrainAccessory["type"],
): Position {
  if (type === "handle") return getDefaultTerrainHandlePosition(region);
  const points = region.polygons.flat(2);
  if (points.length === 0) throw new Error("Cannot place an accessory for an empty region.");
  const bounds = points.reduce((result, [x, z]) => ({
    minX: Math.min(result.minX, x),
    minZ: Math.min(result.minZ, z),
    maxX: Math.max(result.maxX, x),
    maxZ: Math.max(result.maxZ, z),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2];
}

function createDisk(center: Position, radiusKm: number): MultiPolygon {
  return makeCircle(center, radiusKm);
}

export function createTerrainAccessoryOutline(
  type: Exclude<TerrainAccessory["type"], "handle">,
  center: Position,
  sizeKm: number,
  rotationDegrees: number,
): Position[] {
  const pointCount = type === "heart" ? 64 : 10;
  const rotation = rotationDegrees * Math.PI / 180;
  const points: Position[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    let x: number;
    let z: number;
    if (type === "heart") {
      const angle = index * Math.PI * 2 / pointCount;
      x = 16 * Math.sin(angle) ** 3 / 32;
      z = -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle) -
        2 * Math.cos(3 * angle) - Math.cos(4 * angle)) / 34;
    } else {
      const angle = index * Math.PI / 5 - Math.PI / 2;
      const radius = index % 2 === 0 ? 0.5 : 0.22;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
    }
    const scaledX = x * sizeKm;
    const scaledZ = z * sizeKm;
    points.push([
      center[0] + scaledX * Math.cos(rotation) - scaledZ * Math.sin(rotation),
      center[1] + scaledX * Math.sin(rotation) + scaledZ * Math.cos(rotation),
    ]);
  }
  points.push(points[0]!);
  return points;
}

export function createTerrainModelFootprints(
  region: TerrainExportRegion,
  accessories: LocalTerrainAccessory[],
): TerrainModelFootprints {
  let surface = region.polygons as MultiPolygon;
  let footprint = region.polygons as MultiPolygon;
  for (const accessory of accessories) {
    if (accessory.type !== "handle") continue;
    const outerRadiusKm = accessory.sizeKm / 2;
    const innerRadiusKm = outerRadiusKm * 0.8;
    const outerDisk = createDisk(accessory.position, outerRadiusKm);
    const innerDisk = createDisk(accessory.position, innerRadiusKm);
    if (accessory.clipTerrain !== false) {
      surface = difference(surface, innerDisk) as MultiPolygon;
      footprint = difference(
        union(footprint, outerDisk) as MultiPolygon,
        innerDisk,
      ) as MultiPolygon;
    } else {
      const annulus = difference(outerDisk, innerDisk) as MultiPolygon;
      footprint = union(footprint, annulus) as MultiPolygon;
    }
  }
  const firstHandle = accessories.find((accessory) => accessory.type === "handle");
  const baseOnly = firstHandle
    ? difference(footprint, surface) as MultiPolygon
    : [];
  const outerRadiusKm = firstHandle ? firstHandle.sizeKm / 2 : 0;
  return {
    surface,
    footprint,
    baseOnly,
    outerRadiusKm,
    innerRadiusKm: outerRadiusKm * 0.8,
  };
}

export function createTerrainModelPreviewGeometries(
  region: TerrainExportRegion,
  accessories: LocalTerrainAccessory[],
  baseThicknessMm: number,
  latitudeSpanMm: number,
  footprints?: TerrainModelFootprints,
): {
  base: BufferGeometry;
  accessories: { id: string; geometry: BufferGeometry }[];
} {
  const modelFootprints = footprints ?? createTerrainModelFootprints(region, accessories);
  const baseShapes = createBoundaryExtrusionShapes(
    { ...region, polygons: modelFootprints.footprint },
    1,
  );
  if (baseShapes.length === 0) throw new Error("Could not create the model base shape.");
  const regionSpanKm = getTerrainRegionLatitudeSpanKm(region);
  const worldKmPerMm = regionSpanKm / latitudeSpanMm;
  const base = positionExtrusion(
    new ExtrudeGeometry(baseShapes, {
      depth: baseThicknessMm * worldKmPerMm,
      bevelEnabled: false,
    }),
    0,
  );
  const accessoryGeometries = accessories.flatMap((accessory) => {
    if (accessory.type === "handle") return [];
    const outline = createTerrainAccessoryOutline(
      accessory.type,
      accessory.position,
      accessory.sizeKm,
      accessory.rotationDegrees,
    );
    const shape = makeShape(outline, 1);
    if (!shape) return [];
    const topY = getTerrainAccessoryTopY(
      accessory,
      regionSpanKm,
      latitudeSpanMm,
    );
    const depth = topY +
      getTerrainAccessoryBaseOverlapMm(baseThicknessMm) * worldKmPerMm;
    return [{
      id: accessory.id,
      geometry: positionExtrusion(
        new ExtrudeGeometry(shape, { depth, bevelEnabled: false }),
        topY,
      ),
    }];
  });
  return { base, accessories: accessoryGeometries };
}
