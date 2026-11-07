import { fromLocal, geographicToMercator, toLocal, WORLD_METERS } from "../geo";
import {
  TERRAIN_TILE_MESH_SEGMENTS,
  sampleTerrainMeshElevation,
  terrainSamplePixel,
  type TerrainElevationRaster,
} from "./terrainHeight";
import {
  createTerrainClipPointQueryScratch,
  createTerrainClipPolygonIndex,
  getTerrainClipPolygonsContainingPoint,
} from "./terrainClipIndex";
import type { BoundaryGeometry, FeatureGeometry, Position, TerrainMetadata } from "../types";

export type TerrainElevationSampler = (position: Position) => Promise<number | null>;

export type ElevationSample = {
  position: Position;
  elevationMeters: number;
};

export type ElevationProfilePoint = ElevationSample & {
  distanceMeters: number;
};

export type ElevationProfile = {
  series: ElevationProfilePoint[][];
  totalDistanceMeters: number;
};

export type ElevationExtremum = "highest" | "lowest";

type TerrainRasterLoader = (tileKey: string) => Promise<TerrainElevationRaster>;

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAX_POLYGON_SAMPLES = 100_000;
const MAX_LINE_SAMPLES = 20_000;
const MAX_PROFILE_SAMPLES = 4_000;
const STATE_BOUNDARY_TOLERANCE_KM = 0.000001;

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function distanceMeters(first: Position, second: Position): number {
  const deltaLatitude = radians(second[1] - first[1]);
  const deltaLongitude = radians(second[0] - first[0]);
  const firstLatitude = radians(first[1]);
  const secondLatitude = radians(second[1]);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS *
    Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

function loadTerrainRaster(tileKey: string): Promise<TerrainElevationRaster> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          reject(new Error(`Could not read terrain tile ${tileKey}.`));
          return;
        }
        context.drawImage(image, 0, 0);
        resolve({
          width: canvas.width,
          height: canvas.height,
          pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        });
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error(`Could not load terrain tile ${tileKey}.`));
    image.src = `/data/terrain/tiles/${tileKey}.webp`;
  });
}

function sampleLandElevation(
  raster: TerrainElevationRaster,
  gridX: number,
  gridY: number,
): number | null {
  const maximumGridCoordinate = TERRAIN_TILE_MESH_SEGMENTS - Number.EPSILON;
  const x = Math.max(0, Math.min(maximumGridCoordinate, gridX));
  const y = Math.max(0, Math.min(maximumGridCoordinate, gridY));
  const column = Math.floor(x);
  const row = Math.floor(y);
  const pixelCoordinates = [
    [column, row],
    [column, row + 1],
    [column + 1, row + 1],
    [column + 1, row],
  ];
  for (const [gridColumn, gridRow] of pixelCoordinates) {
    const pixelX = terrainSamplePixel(
      (gridColumn ?? 0) / TERRAIN_TILE_MESH_SEGMENTS,
      raster.width,
      true,
    );
    const pixelY = terrainSamplePixel(
      (gridRow ?? 0) / TERRAIN_TILE_MESH_SEGMENTS,
      raster.height,
      true,
    );
    if (raster.pixels[(pixelY * raster.width + pixelX) * 4 + 3] === 0) return null;
  }
  return sampleTerrainMeshElevation(
    raster,
    gridX,
    gridY,
    TERRAIN_TILE_MESH_SEGMENTS,
    true,
  );
}

export function createTerrainElevationSampler(
  metadata: TerrainMetadata,
  loadRaster: TerrainRasterLoader = loadTerrainRaster,
): TerrainElevationSampler {
  const availableTiles = new Set(metadata.tiles);
  const zoomLevels = [...metadata.zoomLevels].sort((first, second) => second - first);
  const rasterCache = new Map<string, Promise<TerrainElevationRaster>>();

  return async (position) => {
    const [mercatorX, mercatorY] = geographicToMercator(...position);
    for (const zoom of zoomLevels) {
      const tileSize = WORLD_METERS / 2 ** zoom;
      const tileX = Math.floor((mercatorX + WORLD_METERS / 2) / tileSize);
      const tileY = Math.floor((WORLD_METERS / 2 - mercatorY) / tileSize);
      const tileKey = `${zoom}/${tileX}/${tileY}`;
      if (!availableTiles.has(tileKey)) continue;

      let rasterPromise = rasterCache.get(tileKey);
      if (!rasterPromise) {
        rasterPromise = loadRaster(tileKey).catch((error: unknown) => {
          rasterCache.delete(tileKey);
          throw error;
        });
        rasterCache.set(tileKey, rasterPromise);
      }
      const raster = await rasterPromise;
      const gridX = ((mercatorX + WORLD_METERS / 2) / tileSize - tileX) *
        TERRAIN_TILE_MESH_SEGMENTS;
      const gridY = ((WORLD_METERS / 2 - mercatorY) / tileSize - tileY) *
        TERRAIN_TILE_MESH_SEGMENTS;
      return sampleLandElevation(raster, gridX, gridY);
    }
    return null;
  };
}

function polygonCoordinates(geometry: FeatureGeometry): Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function lineGeometries(geometry: FeatureGeometry): Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function polygonSamplePositions(
  geometries: FeatureGeometry[],
  center: Position,
  maxZoom: number,
): Position[] {
  const polygons = geometries.flatMap(polygonCoordinates)
    .map((polygon) => polygon.map((ring) => ring.map((point) => toLocal(point, center))))
    .filter((polygon) => (polygon[0]?.length ?? 0) >= 3);
  if (polygons.length === 0) return [];

  const index = createTerrainClipPolygonIndex(polygons);
  const scratch = createTerrainClipPointQueryScratch(index);
  const exteriorPoints = polygons.flatMap((polygon) => polygon[0] ?? []);
  const bounds = exteriorPoints.reduce((current, [x, z]) => ({
    minX: Math.min(current.minX, x),
    maxX: Math.max(current.maxX, x),
    minZ: Math.min(current.minZ, z),
    maxZ: Math.max(current.maxZ, z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const { minX, maxX, minZ, maxZ } = bounds;
  const width = maxX - minX;
  const height = maxZ - minZ;
  if (width <= 0 || height <= 0) return [];

  const nativeSpacingKm = WORLD_METERS / 2 ** maxZoom /
    TERRAIN_TILE_MESH_SEGMENTS / 1_000;
  let spacing = Math.max(nativeSpacingKm, Math.sqrt(width * height / MAX_POLYGON_SAMPLES));
  let columns = Math.max(1, Math.ceil(width / spacing));
  let rows = Math.max(1, Math.ceil(height / spacing));
  while (columns * rows > MAX_POLYGON_SAMPLES) {
    spacing *= Math.sqrt(columns * rows / MAX_POLYGON_SAMPLES) * 1.01;
    columns = Math.max(1, Math.ceil(width / spacing));
    rows = Math.max(1, Math.ceil(height / spacing));
  }

  const samples: Position[] = [];
  for (let row = 0; row < rows; row += 1) {
    const z = minZ + (row + 0.5) * height / rows;
    for (let column = 0; column < columns; column += 1) {
      const x = minX + (column + 0.5) * width / columns;
      if (getTerrainClipPolygonsContainingPoint(index, [x, z], scratch).length > 0) {
        samples.push(fromLocal([x, z], center));
      }
    }
  }
  return [...samples, ...polygons.flatMap((polygon) =>
    (polygon[0] ?? []).map((point) => fromLocal(point, center))
  )];
}

function lineSamplePositions(
  lines: Position[][],
  center: Position,
  maxSamples: number,
): Position[] {
  const usableLines = lines.filter((line) => line.length >= 2);
  const lineLengths = usableLines.map((line) =>
    line.slice(1).reduce((total, point, index) => {
      const previous = line[index];
      return previous ? total + distanceMeters(previous, point) : total;
    }, 0)
  );
  const totalLength = lineLengths.reduce((total, length) => total + length, 0);
  if (totalLength === 0) return usableLines.flat();
  const spacing = Math.max(30, totalLength / maxSamples);
  const positions: Position[] = [];

  usableLines.forEach((line, lineIndex) => {
    const localLine = line.map((point) => toLocal(point, center));
    const segmentLengths = line.slice(1).map((point, index) => {
      const previous = line[index];
      return previous ? distanceMeters(previous, point) : 0;
    });
    const total = lineLengths[lineIndex] ?? 0;
    const intervals = Math.max(1, Math.ceil(total / spacing));
    const distances = Array.from({ length: intervals + 1 }, (_, index) =>
      total * index / intervals
    );
    positions.push(...positionsAlongLine(localLine, segmentLengths, distances, center));
  });
  return positions;
}

function distanceToSegmentKm(point: Position, start: Position, end: Position): number {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  const ratio = lengthSquared > 0
    ? Math.max(0, Math.min(1, (
      (point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaZ
    ) / lengthSquared))
    : 0;
  return Math.hypot(
    point[0] - (start[0] + deltaX * ratio),
    point[1] - (start[1] + deltaZ * ratio),
  );
}

function positionsInsideState(
  positions: Position[],
  stateGeometries: BoundaryGeometry[],
  center: Position,
): Position[] {
  const statePolygons = stateGeometries.flatMap(polygonCoordinates)
    .map((polygon) => polygon.map((ring) => ring.map((point) => toLocal(point, center))));
  const index = createTerrainClipPolygonIndex(statePolygons);
  if (!index.root) {
    throw new Error("California boundary data is not available for lowest-point analysis.");
  }
  const scratch = createTerrainClipPointQueryScratch(index);
  return positions.filter((position) => {
    const localPosition = toLocal(position, center);
    if (getTerrainClipPolygonsContainingPoint(index, localPosition, scratch).length === 0) {
      return false;
    }
    return !scratch.crossings.some((segment) =>
      distanceToSegmentKm(localPosition, segment.start, segment.end) <=
        STATE_BOUNDARY_TOLERANCE_KM
    );
  });
}

async function samplePositions(
  positions: Position[],
  sampleElevation: TerrainElevationSampler,
  batchSize = 96,
): Promise<ElevationSample[]> {
  const samples: ElevationSample[] = [];
  for (let start = 0; start < positions.length; start += batchSize) {
    const batch = positions.slice(start, start + batchSize);
    const elevations = await Promise.all(batch.map((position) => sampleElevation(position)));
    elevations.forEach((elevation, index) => {
      const position = batch[index];
      if (elevation !== null && position) samples.push({ position, elevationMeters: elevation });
    });
  }
  return samples;
}

export async function findTerrainElevationExtremum(
  geometries: FeatureGeometry[],
  lines: Position[][],
  stateGeometries: BoundaryGeometry[],
  center: Position,
  maxZoom: number,
  extremum: ElevationExtremum,
  sampleElevation: TerrainElevationSampler,
): Promise<ElevationSample> {
  const geometryPositions = [
    ...polygonSamplePositions(geometries, center, maxZoom),
    ...lineSamplePositions(lines, center, MAX_LINE_SAMPLES),
  ];
  const positions = extremum === "lowest"
    ? positionsInsideState(geometryPositions, stateGeometries, center)
    : geometryPositions;
  const samples = await samplePositions(positions, sampleElevation);
  if (samples.length === 0) {
    throw new Error("No terrain data is available for this region.");
  }
  return samples.reduce((best, sample) =>
    extremum === "highest"
      ? sample.elevationMeters > best.elevationMeters ? sample : best
      : sample.elevationMeters < best.elevationMeters ? sample : best
  );
}

function positionsAlongLine(
  localLine: Position[],
  segmentLengths: number[],
  distances: number[],
  center: Position,
): Position[] {
  const positions: Position[] = [];
  let segment = 0;
  let traversed = 0;
  for (const distance of distances) {
    while (
      segment < segmentLengths.length - 1 &&
      distance > traversed + (segmentLengths[segment] ?? 0)
    ) {
      traversed += segmentLengths[segment] ?? 0;
      segment += 1;
    }
    const segmentLength = segmentLengths[segment] ?? 0;
    const start = localLine[segment];
    const end = localLine[segment + 1];
    if (!start || !end) continue;
    const ratio = segmentLength > 0
      ? Math.max(0, Math.min(1, (distance - traversed) / segmentLength))
      : 0;
    positions.push(fromLocal([
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ], center));
  }
  return positions;
}

export async function createTerrainElevationProfile(
  lines: Position[][],
  center: Position,
  sampleElevation: TerrainElevationSampler,
  spacingMeters = 250,
): Promise<ElevationProfile> {
  const usableLines = lines.filter((line) => line.length >= 2);
  const lengths = usableLines.map((line) =>
    line.slice(1).reduce((total, point, index) => {
      const previous = line[index];
      return previous ? total + distanceMeters(previous, point) : total;
    }, 0)
  );
  const totalDistanceMeters = lengths.reduce((total, length) => total + length, 0);
  if (totalDistanceMeters <= 0) {
    throw new Error("This line does not have enough length to create an elevation profile.");
  }

  const intervalLimit = Math.max(1, MAX_PROFILE_SAMPLES - usableLines.length);
  const sampleSpacing = Math.max(spacingMeters, totalDistanceMeters / intervalLimit);
  const profileLines: ElevationProfilePoint[][] = [];
  let distanceOffset = 0;

  for (let lineIndex = 0; lineIndex < usableLines.length; lineIndex += 1) {
    const line = usableLines[lineIndex];
    if (!line) continue;
    const localLine = line.map((position) => toLocal(position, center));
    const segmentLengths = line.slice(1).map((position, index) => {
      const previous = line[index];
      return previous ? distanceMeters(previous, position) : 0;
    });
    const lineLength = lengths[lineIndex] ?? 0;
    const intervals = Math.max(1, Math.ceil(lineLength / sampleSpacing));
    const distances = Array.from({ length: intervals + 1 }, (_, index) =>
      lineLength * index / intervals
    );
    const positions = positionsAlongLine(localLine, segmentLengths, distances, center);
    const elevations: (number | null)[] = [];
    for (let start = 0; start < positions.length; start += 64) {
      const batch = positions.slice(start, start + 64);
      elevations.push(...await Promise.all(batch.map((position) => sampleElevation(position))));
    }
    const profilePoints = positions.flatMap((position, index) => {
      const elevation = elevations[index];
      return elevation === null || elevation === undefined
        ? []
        : [{
          position,
          elevationMeters: elevation,
          distanceMeters: distanceOffset + lineLength * index / intervals,
        }];
    });
    if (profilePoints.length > 0) profileLines.push(profilePoints);
    distanceOffset += lineLength;
  }

  if (profileLines.length === 0) {
    throw new Error("No terrain data is available along this line.");
  }
  return { series: profileLines, totalDistanceMeters };
}
