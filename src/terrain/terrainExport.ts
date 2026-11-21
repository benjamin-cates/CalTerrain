import {
  difference,
  intersection,
  type MultiPolygon,
  union,
} from "polygon-clipping";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  ShapeUtils,
  Uint32BufferAttribute,
  Vector2,
} from "three";
import type { BufferAttribute, InterleavedBufferAttribute } from "three";
import { DRACOExporter } from "three/addons/exporters/DRACOExporter.js";
import { createDecoderModule, createEncoderModule } from "draco3d";
import type { DracoDecoderModule } from "draco3d";
import dracoDecoderWasmUrl from "draco3d/draco_decoder.wasm";
import dracoEncoderWasmUrl from "draco3d/draco_encoder.wasm";
import { toLocal, WORLD_METERS } from "../geo";
import type {
  BoundaryCollection,
  BoundaryFeature,
  Position,
  TerrainMetadata,
} from "../types";
import {
  getStateBoundaryClipPolygons,
  intersectStateWithRegions,
} from "./terrainClip";
import { splitSurfaceTriangleByBoundary } from "./terrainExportSurface";
import {
  createTerrainClipPointQueryScratch,
  createTerrainClipPolygonIndex,
  getTerrainClipPolygonsContainingPoint,
  getTerrainClipSegmentsForTile,
  type TerrainClipPolygonIndex,
  type TerrainClipSegment,
} from "./terrainClipIndex";
import { TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS } from "./terrainSkirts";
import { heightFromRgb, type TerrainElevationRaster } from "./terrainHeight";
import {
  colorizeTerrainHeightPixels,
  type TerrainHeightPalette,
} from "./terrainHeightPalette";
import {
  createTerrainAccessoryOutline,
  createTerrainModelFootprints,
  getTerrainAccessoryBaseOverlapMm,
  getTerrainRegionLatitudeSpanKm,
  type LocalTerrainAccessory,
  type TerrainAccessory,
  type TerrainModelOptions,
} from "./terrainOrnament";

export const TERRAIN_EXPORT_RESOLUTIONS = [1_920, 960, 480, 240, 120, 60, 30] as const;
const COARSE_TERRAIN_TILE_RESOLUTION_METERS = 480;
export const CALIFORNIA_LATITUDE_SPAN_METERS = 1_052_987;
export const TERRAIN_EXPORT_SCALE_MIN_METERS = 0.01;
export const TERRAIN_EXPORT_SCALE_MAX_METERS = CALIFORNIA_LATITUDE_SPAN_METERS;
export const MAX_TERRAIN_EXPORT_FACES = 20_000_000;
export const MAX_TERRAIN_IMAGE_PIXELS = 32_000_000;
export const MAX_TERRAIN_IMAGE_DIMENSION = 32_767;

export type TerrainExportRegion = {
  id: string;
  name: string;
  polygons: Position[][][];
};

export type TerrainModelFileFormat = "glb" | "stl";

export type TerrainExportBoundingBox = {
  id: string;
  name: string;
  outline: Position[];
};

export type TerrainExportTriangleReport = {
  pieces: { id: string; name: string; count: number }[];
  total: number;
};

export type TerrainExportProgress = {
  tileIndex: number;
  tileCount: number;
  regionName: string;
};

export type TerrainExportOptions = {
  metadata: TerrainMetadata;
  center: Position;
  californiaPolygons: Position[][][];
  region: TerrainExportRegion;
  resolutionMeters: number;
  californiaLatitudeSpanMeters: number;
  verticalExaggeration: number;
  onProgress?: (progress: TerrainExportProgress) => void;
  onTriangleCount?: (count: number) => void;
};

type ExportTile = {
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
};

type ObjVertex = { x: number; y: number; z: number };

export type TerrainZipEntry = { name: string; content: string | Uint8Array<ArrayBuffer> };

const TERRAIN_TILE_PIXELS = 256;
const DEFAULT_TILE_SEGMENTS = 128;
const BOTTOM_TRIANGLE_COARSENING_FACTOR = DEFAULT_TILE_SEGMENTS;
const EXPORT_YIELD_INTERVAL = 8;
const POINT_TOLERANCE_KM = 0.000001;
const DRACO_CHUNK_FACE_LIMIT = 1_000_000;
const utf8Encoder = new TextEncoder();
let dracoDecoderModulePromise: Promise<DracoDecoderModule> | null = null;
let dracoEncoderModulePromise: Promise<unknown> | null = null;
const crc32Table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

export function getTerrainExportResolution(index: number): number {
  const boundedIndex = Math.max(0, Math.min(TERRAIN_EXPORT_RESOLUTIONS.length - 1, index));
  return TERRAIN_EXPORT_RESOLUTIONS[boundedIndex] ?? TERRAIN_EXPORT_RESOLUTIONS[1];
}

export function getTerrainGroundScale(center: Position): number {
  const centerLatitude = Math.atan(
    Math.sinh((center[1] / WORLD_METERS) * 2 * Math.PI),
  ) * 180 / Math.PI;
  return Math.cos(centerLatitude * Math.PI / 180);
}

export function getTerrainExportScaleMeters(step: number): number {
  const boundedStep = Math.max(0, Math.min(1_000, step));
  return TERRAIN_EXPORT_SCALE_MIN_METERS *
    (TERRAIN_EXPORT_SCALE_MAX_METERS / TERRAIN_EXPORT_SCALE_MIN_METERS) ** (boundedStep / 1_000);
}

export function getTerrainExportScaleStep(scaleMeters: number): number {
  const boundedScale = Math.max(
    TERRAIN_EXPORT_SCALE_MIN_METERS,
    Math.min(TERRAIN_EXPORT_SCALE_MAX_METERS, scaleMeters),
  );
  return Math.log(boundedScale / TERRAIN_EXPORT_SCALE_MIN_METERS) /
    Math.log(TERRAIN_EXPORT_SCALE_MAX_METERS / TERRAIN_EXPORT_SCALE_MIN_METERS) * 1_000;
}

export function formatTerrainExportScale(scaleMeters: number): string {
  if (scaleMeters >= 1_000) {
    return `${(scaleMeters / 1_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km`;
  }
  if (scaleMeters < 1) {
    return `${(scaleMeters * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} cm`;
  }
  return `${scaleMeters.toLocaleString("en-US", { maximumFractionDigits: 2 })} m`;
}

function getLocalPolygons(feature: BoundaryFeature, center: Position): Position[][][] {
  const polygons = feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
  return polygons.map((polygon) =>
    polygon.map((ring) => ring.map((point) => toLocal(point, center)))
  );
}

function getFeatureName(feature: BoundaryFeature, index: number): string {
  const category = String(feature.properties.category ?? "").trim();
  const name = String(feature.properties.name ?? `Region ${index + 1}`).trim();
  return category && category !== "Custom shape" ? `${category}: ${name}` : name;
}

function getFeatureId(feature: BoundaryFeature, index: number): string {
  return String(feature.properties.id ?? `${feature.properties.category ?? "region"}-${index}`);
}

export function createTerrainExportRegions(
  features: BoundaryCollection,
  state: BoundaryCollection,
  center: Position,
): { regions: TerrainExportRegion[]; californiaPolygons: Position[][][] } {
  const californiaPolygons = getStateBoundaryClipPolygons(state, center);
  const regions = features.features.flatMap((feature, index) => {
    const clippedPolygons = intersectStateWithRegions(
      californiaPolygons,
      [getLocalPolygons(feature, center)],
    );
    if (clippedPolygons.length === 0) return [];
    return [{
      id: getFeatureId(feature, index),
      name: getFeatureName(feature, index),
      polygons: clippedPolygons,
    }];
  });
  return { regions, californiaPolygons };
}

export function combineTerrainExportRegions(
  regions: TerrainExportRegion[],
  californiaPolygons: Position[][][],
): TerrainExportRegion {
  return {
    id: "combined",
    name: "Combined regions",
    polygons: intersectStateWithRegions(
      californiaPolygons,
      regions.map((region) => region.polygons),
    ),
  };
}

export function getTerrainExportBoundingBoxes(
  regions: TerrainExportRegion[],
): TerrainExportBoundingBox[] {
  return regions.flatMap((region) => {
    const points = region.polygons.flat(2);
    if (points.length === 0) return [];
    const bounds = points.reduce((current, [x, z]) => ({
      minX: Math.min(current.minX, x),
      minZ: Math.min(current.minZ, z),
      maxX: Math.max(current.maxX, x),
      maxZ: Math.max(current.maxZ, z),
    }), {
      minX: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxZ: -Infinity,
    });
    return [{
      id: region.id,
      name: region.name,
      outline: [
        [bounds.minX, bounds.minZ],
        [bounds.maxX, bounds.minZ],
        [bounds.maxX, bounds.maxZ],
        [bounds.minX, bounds.maxZ],
        [bounds.minX, bounds.minZ],
      ] as Position[],
    }];
  });
}

function getPolygonAreaKm2(polygon: Position[][]): number {
  const [outer, ...holes] = polygon;
  if (!outer) return 0;
  return Math.max(
    0,
    Math.abs(signedArea2D(outer)) / 2 -
      holes.reduce((area, ring) => area + Math.abs(signedArea2D(ring)) / 2, 0),
  );
}

function getRegionAreaKm2(polygons: Position[][][]): number {
  return polygons.reduce((area, polygon) => area + getPolygonAreaKm2(polygon), 0);
}

function getBottomAreaRefinementCount(
  areaKm2: number,
  resolutionMeters: number,
  groundScale: number,
): number {
  const bottomCellMeters = resolutionMeters * BOTTOM_TRIANGLE_COARSENING_FACTOR /
    Math.max(groundScale, Number.EPSILON);
  return Math.ceil(areaKm2 * 1_000_000 / (bottomCellMeters * bottomCellMeters));
}

export function estimateTerrainTriangleCount(
  region: TerrainExportRegion,
  resolutionMeters: number,
  groundScale = 1,
): number {
  const componentCount = region.polygons.length;
  const holeCount = region.polygons.reduce(
    (count, polygon) => count + Math.max(0, polygon.length - 1),
    0,
  );
  const boundarySides = region.polygons.reduce((count, polygon) =>
    count + polygon.reduce((ringCount, ring) => {
      const pointCount = ring.length > 1 &&
        ring[0]?.[0] === ring[ring.length - 1]?.[0] &&
        ring[0]?.[1] === ring[ring.length - 1]?.[1]
        ? ring.length - 1
        : ring.length;
      let estimatedSides = 0;
      for (let index = 0; index < pointCount; index += 1) {
        const start = ring[index];
        const end = ring[(index + 1) % pointCount];
        if (!start || !end) continue;
        const lengthMeters = Math.hypot(end[0] - start[0], end[1] - start[1]) * 1_000;
        estimatedSides += Math.max(1, Math.ceil(
          lengthMeters * groundScale / resolutionMeters,
        ));
      }
      return ringCount + estimatedSides;
    }, 0), 0);
  const minimumTriangles = Math.max(
    0,
    boundarySides + 2 * holeCount - 2 * componentCount,
  );
  const areaKm2 = getRegionAreaKm2(region.polygons);
  const bottomTriangles = minimumTriangles + 2 * getBottomAreaRefinementCount(
    areaKm2,
    resolutionMeters,
    groundScale,
  );
  const terrainCellMeters = resolutionMeters / Math.max(groundScale, Number.EPSILON);
  const topTriangles = Math.ceil(areaKm2 * 1_000_000 / (terrainCellMeters ** 2)) * 2;
  const wallTriangles = boundarySides * 2;
  return topTriangles + wallTriangles + bottomTriangles;
}

function getPolygonsBounds(polygons: Position[][][]): {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
} {
  return polygons.flat(2).reduce((bounds, [x, z]) => ({
    minX: Math.min(bounds.minX, x),
    minZ: Math.min(bounds.minZ, z),
    maxX: Math.max(bounds.maxX, x),
    maxZ: Math.max(bounds.maxZ, z),
  }), {
    minX: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxZ: -Infinity,
  });
}

export type TerrainImageDimensions = {
  width: number;
  height: number;
  pixelCount: number;
  pixelsPerKm: number;
  bounds: ReturnType<typeof getPolygonsBounds>;
};

export function getTerrainImageTilePixelBounds(
  tile: { x: number; y: number; z: number },
  center: Position,
  bounds: ReturnType<typeof getPolygonsBounds>,
  pixelsPerKm: number,
): { left: number; top: number; right: number; bottom: number } {
  const tileSizeMeters = WORLD_METERS / 2 ** tile.z;
  const projectedX = (x: number) =>
    (x * tileSizeMeters - WORLD_METERS / 2 - center[0]) / 1_000;
  const projectedZ = (y: number) =>
    (y * tileSizeMeters - WORLD_METERS / 2 + center[1]) / 1_000;
  return {
    left: Math.round((projectedX(tile.x) - bounds.minX) * pixelsPerKm),
    top: Math.round((projectedZ(tile.y) - bounds.minZ) * pixelsPerKm),
    right: Math.round((projectedX(tile.x + 1) - bounds.minX) * pixelsPerKm),
    bottom: Math.round((projectedZ(tile.y + 1) - bounds.minZ) * pixelsPerKm),
  };
}

export function getTerrainImageDimensions(
  region: TerrainExportRegion,
  resolutionMeters: number,
  groundScale = 1,
): TerrainImageDimensions {
  if (region.polygons.length === 0) {
    throw new Error(`${region.name} does not intersect California.`);
  }
  if (!Number.isFinite(resolutionMeters) || resolutionMeters <= 0) {
    throw new Error("Image export resolution must be greater than zero.");
  }
  if (!Number.isFinite(groundScale) || groundScale <= 0) {
    throw new Error("Image export ground scale must be greater than zero.");
  }
  const bounds = getPolygonsBounds(region.polygons);
  const pixelsPerKm = 1_000 * groundScale / resolutionMeters;
  const width = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) * pixelsPerKm));
  const height = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) * pixelsPerKm));
  return { width, height, pixelCount: width * height, pixelsPerKm, bounds };
}

export type TerrainImageExportOptions = {
  metadata: TerrainMetadata;
  center: Position;
  region: TerrainExportRegion;
  resolutionMeters: number;
  palette: TerrainHeightPalette;
  onProgress?: (progress: TerrainExportProgress) => void;
};

export async function createTerrainImageCanvas(
  options: TerrainImageExportOptions,
  targetCanvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const groundScale = getTerrainGroundScale(options.center);
  const dimensions = getTerrainImageDimensions(
    options.region,
    options.resolutionMeters,
    groundScale,
  );
  if (
    dimensions.pixelCount > MAX_TERRAIN_IMAGE_PIXELS ||
    dimensions.width > MAX_TERRAIN_IMAGE_DIMENSION ||
    dimensions.height > MAX_TERRAIN_IMAGE_DIMENSION
  ) {
    throw new Error(
      `This image requires ${dimensions.width.toLocaleString("en-US")} × ${dimensions.height.toLocaleString("en-US")} pixels. Choose a coarser resolution or smaller region.`,
    );
  }

  const zoom = getTerrainExportZoom(options.metadata, options.resolutionMeters);
  const tiles = getExportTiles(options.metadata, zoom, dimensions.bounds, options.center);
  if (tiles.length === 0) {
    throw new Error(`No terrain tiles are available at ${options.resolutionMeters} m resolution.`);
  }
  const canvas = targetCanvas ?? document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the terrain image canvas.");
  const tileCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = dimensions.width;
  maskCanvas.height = dimensions.height;
  const tileContext = tileCanvas.getContext("2d", { willReadFrequently: true });
  const maskContext = maskCanvas.getContext("2d");
  if (!tileContext || !maskContext) {
    throw new Error("Could not create canvases for terrain image export.");
  }
  context.clearRect(0, 0, dimensions.width, dimensions.height);
  context.imageSmoothingEnabled = true;
  tileContext.imageSmoothingEnabled = true;

  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    if (!tile) continue;
    const raster = await loadTileRaster(tile);
    if (
      raster.width < TERRAIN_TILE_PIXELS + 2 ||
      raster.height < TERRAIN_TILE_PIXELS + 2
    ) {
      throw new Error(`Terrain tile ${tile.z}/${tile.x}/${tile.y} is too small to export.`);
    }
    tileCanvas.width = raster.width;
    tileCanvas.height = raster.height;
    const tilePixels = tileContext.createImageData(raster.width, raster.height);
    tilePixels.data.set(colorizeTerrainHeightPixels(raster.pixels, options.palette));
    tileContext.putImageData(tilePixels, 0, 0);
    const destination = getTerrainImageTilePixelBounds(
      tile,
      options.center,
      dimensions.bounds,
      dimensions.pixelsPerKm,
    );
    context.drawImage(
      tileCanvas,
      1,
      1,
      TERRAIN_TILE_PIXELS,
      TERRAIN_TILE_PIXELS,
      destination.left,
      destination.top,
      Math.max(1, destination.right - destination.left),
      Math.max(1, destination.bottom - destination.top),
    );
    options.onProgress?.({
      tileIndex: tileIndex + 1,
      tileCount: tiles.length,
      regionName: options.region.name,
    });
    await yieldToBrowser();
  }

  maskContext.fillStyle = "#fff";
  for (const polygon of options.region.polygons) {
    maskContext.beginPath();
    for (const ring of polygon) {
      const [first, ...rest] = ring;
      if (!first) continue;
      maskContext.moveTo(
        (first[0] - dimensions.bounds.minX) * dimensions.pixelsPerKm,
        (first[1] - dimensions.bounds.minZ) * dimensions.pixelsPerKm,
      );
      for (const point of rest) {
        maskContext.lineTo(
          (point[0] - dimensions.bounds.minX) * dimensions.pixelsPerKm,
          (point[1] - dimensions.bounds.minZ) * dimensions.pixelsPerKm,
        );
      }
      maskContext.closePath();
    }
    maskContext.fill("evenodd");
  }
  context.globalCompositeOperation = "destination-in";
  context.drawImage(maskCanvas, 0, 0);
  context.globalCompositeOperation = "source-over";
  return canvas;
}

function getRegionTilePolygons(
  polygons: Position[][][],
  bounds: ReturnType<typeof getPolygonsBounds>,
): Position[][][] {
  return polygons.filter((polygon) => {
    const polygonBounds = getPolygonsBounds([polygon]);
    return polygonBounds.minX <= bounds.maxX &&
      polygonBounds.maxX >= bounds.minX &&
      polygonBounds.minZ <= bounds.maxZ &&
      polygonBounds.maxZ >= bounds.minZ;
  });
}

export function getTerrainExportZoom(
  metadata: TerrainMetadata,
  resolutionMeters: number,
): number {
  if (resolutionMeters >= COARSE_TERRAIN_TILE_RESOLUTION_METERS) {
    return metadata.zoomLevels.reduce(
      (coarsestZoom, zoom) => Math.min(coarsestZoom, zoom),
      metadata.zoomLevels[0] ?? 8,
    );
  }
  const centerLatitude =
    Math.atan(Math.sinh((metadata.center[1] / WORLD_METERS) * 2 * Math.PI)) * 180 / Math.PI;
  const latitudeScale = Math.cos(centerLatitude * Math.PI / 180);
  return metadata.zoomLevels.reduce((bestZoom, zoom) => {
    const spacing = WORLD_METERS / 2 ** zoom / DEFAULT_TILE_SEGMENTS * latitudeScale;
    const bestSpacing = WORLD_METERS / 2 ** bestZoom / DEFAULT_TILE_SEGMENTS * latitudeScale;
    return Math.abs(Math.log(spacing / resolutionMeters)) <
        Math.abs(Math.log(bestSpacing / resolutionMeters))
      ? zoom
      : bestZoom;
  }, metadata.zoomLevels[0] ?? 8);
}

function getExportTiles(
  metadata: TerrainMetadata,
  zoom: number,
  bounds: ReturnType<typeof getPolygonsBounds>,
  center: Position,
): ExportTile[] {
  const tileSize = WORLD_METERS / 2 ** zoom;
  return metadata.tiles.flatMap((key) => {
    const [tileZoom, tileX, tileY] = key.split("/").map(Number);
    if (tileZoom !== zoom || tileX === undefined || tileY === undefined) return [];
    const minX = tileX * tileSize - WORLD_METERS / 2;
    const maxY = WORLD_METERS / 2 - tileY * tileSize;
    const left = (minX - center[0]) / 1_000;
    const top = -((maxY - center[1]) / 1_000);
    const size = tileSize / 1_000;
    if (
      left > bounds.maxX ||
      left + size < bounds.minX ||
      top > bounds.maxZ ||
      top + size < bounds.minZ
    ) return [];
    return [{ z: zoom, x: tileX, y: tileY, left, top, size }];
  });
}

async function loadTileRaster(tile: ExportTile): Promise<TerrainElevationRaster> {
  const source = `/data/terrain/tiles/${tile.z}/${tile.x}/${tile.y}.webp`;
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Could not load terrain tile ${tile.z}/${tile.x}/${tile.y} (${response.status}).`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read terrain tile pixels for export.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, pixels: image.data };
  } finally {
    bitmap.close();
  }
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

function sampleBicubicHeight(
  raster: TerrainElevationRaster,
  horizontal: number,
  vertical: number,
): number {
  const pixelX = horizontal * TERRAIN_TILE_PIXELS + 1;
  const pixelY = vertical * TERRAIN_TILE_PIXELS + 1;
  const baseX = Math.floor(pixelX);
  const baseY = Math.floor(pixelY);
  const fractionX = pixelX - baseX;
  const fractionY = pixelY - baseY;
  const decode = (x: number, y: number) => {
    const column = Math.max(0, Math.min(raster.width - 1, x));
    const row = Math.max(0, Math.min(raster.height - 1, y));
    const offset = (row * raster.width + column) * 4;
    if ((raster.pixels[offset + 3] ?? 0) < 128) return 0;
    return heightFromRgb(
      raster.pixels[offset] ?? 0,
      raster.pixels[offset + 1] ?? 0,
      raster.pixels[offset + 2] ?? 0,
    );
  };
  const rows: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    const sampleRow = baseY + row - 1;
    rows.push(cubic(
      decode(baseX - 1, sampleRow),
      decode(baseX, sampleRow),
      decode(baseX + 1, sampleRow),
      decode(baseX + 2, sampleRow),
      fractionX,
    ));
  }
  return cubic(rows[0] ?? 0, rows[1] ?? 0, rows[2] ?? 0, rows[3] ?? 0, fractionY);
}

function positionKey(point: Position): string {
  return `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
}

function segmentKey(start: Position, end: Position): string {
  const startKey = positionKey(start);
  const endKey = positionKey(end);
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

type BottomTriangle = [Position, Position, Position];

type OrnamentBoundaryHeightEdge = {
  start: Position;
  end: Position;
  startHeight: number;
  endHeight: number;
  boundarySegment: TerrainClipSegment;
};

const ORNAMENT_BOUNDARY_CELL_KM = 5;

function boundaryCellKey(x: number, z: number): string {
  return `${x},${z}`;
}

function getSegmentProjection(
  point: Position,
  start: Position,
  end: Position,
): { amount: number; distance: number } | null {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  if (lengthSquared === 0) return null;
  const amount = ((point[0] - start[0]) * deltaX +
    (point[1] - start[1]) * deltaZ) / lengthSquared;
  const projectedX = start[0] + amount * deltaX;
  const projectedZ = start[1] + amount * deltaZ;
  return {
    amount,
    distance: Math.hypot(point[0] - projectedX, point[1] - projectedZ),
  };
}

function refineBottomTriangles(
  triangles: BottomTriangle[],
  refinementCount: number,
): BottomTriangle[] {
  if (triangles.length === 0 || refinementCount === 0) return triangles;
  const groups = triangles.map((triangle) => [triangle]);
  for (let refinement = 0; refinement < refinementCount; refinement += 1) {
    const group = groups[refinement % groups.length];
    if (!group || group.length === 0) continue;
    const triangle = group.pop();
    if (!triangle) continue;
    const [a, b, c] = triangle;
    const center: Position = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
    ];
    group.push([a, b, center], [b, c, center], [c, a, center]);
  }
  return groups.flat();
}

class ObjBuilder {
  private readonly vertices: number[] = [];
  private readonly faces: number[] = [];
  private readonly vertexIndices = new Map<string, number>();
  private readonly wallEdges = new Set<string>();
  private readonly bottomBoundaryPoints = new Map<string, Map<string, Position>>();
  private readonly ornamentBoundaryHeightEdges = new Map<
    string,
    OrnamentBoundaryHeightEdge
  >();
  private readonly ornamentBoundaryHeightBuckets = new Map<
    string,
    Set<OrnamentBoundaryHeightEdge>
  >();

  constructor(
    private readonly horizontalScale: number,
    private readonly verticalExaggeration: number,
  ) {}

  get faceCount(): number {
    return this.faces.length / 3;
  }

  addVertex([x, elevation, z]: [number, number, number]): number {
    const scaled: ObjVertex = {
      x: x * this.horizontalScale,
      y: elevation * this.horizontalScale * this.verticalExaggeration,
      z: z * this.horizontalScale,
    };
    const key = `${scaled.x.toFixed(7)},${scaled.y.toFixed(7)},${scaled.z.toFixed(7)}`;
    const existing = this.vertexIndices.get(key);
    if (existing !== undefined) return existing;
    const index = this.vertices.length / 3;
    this.vertexIndices.set(key, index);
    this.vertices.push(scaled.x, scaled.y, scaled.z);
    return index;
  }

  addTopTriangle(vertices: [number, number, number][]): void {
    const [a, b, c] = vertices;
    if (!a || !b || !c) throw new Error("Terrain export encountered an incomplete triangle.");
    const signedArea = (b[0] - a[0]) * (c[2] - a[2]) -
      (b[2] - a[2]) * (c[0] - a[0]);
    const top = signedArea > 0 ? [a, c, b] as const : [a, b, c] as const;
    const topIndices = top.map((vertex) => this.addVertex(vertex));
    this.faces.push(topIndices[0]!, topIndices[1]!, topIndices[2]!);
  }

  addBottomTriangle([a, b, c]: BottomTriangle, bottomElevation: number): void {
    const signedArea = (b[0] - a[0]) * (c[1] - a[1]) -
      (b[1] - a[1]) * (c[0] - a[0]);
    const bottom = signedArea > 0 ? [a, b, c] as const : [a, c, b] as const;
    const indices = bottom.map(([x, z]) =>
      this.addVertex([x * 1_000, bottomElevation, z * 1_000])
    );
    this.faces.push(indices[0]!, indices[1]!, indices[2]!);
  }

  addBottomMesh(
    polygons: Position[][][],
    bottomElevation: number,
    resolutionMeters: number,
    groundScale: number,
  ): number {
    const triangles: BottomTriangle[] = [];
    for (const polygon of polygons) {
      const rings = polygon.map((ring) => {
        const closed = ring.length > 1 &&
          ring[0]?.[0] === ring[ring.length - 1]?.[0] &&
          ring[0]?.[1] === ring[ring.length - 1]?.[1];
        const sideCount = closed ? ring.length - 1 : ring.length;
        const detailedRing: Position[] = [];
        for (let index = 0; index < sideCount; index += 1) {
          const start = ring[index];
          const end = ring[(index + 1) % sideCount];
          if (!start || !end) continue;
          detailedRing.push(start);
          const boundaryPoints = this.bottomBoundaryPoints.get(segmentKey(start, end));
          if (!boundaryPoints) continue;
          const edgeX = end[0] - start[0];
          const edgeZ = end[1] - start[1];
          const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
          if (lengthSquared === 0) continue;
          const amountTolerance = POINT_TOLERANCE_KM / Math.sqrt(lengthSquared);
          const splitPoints = [...boundaryPoints.values()]
            .map((point) => ({
              point,
              amount: ((point[0] - start[0]) * edgeX +
                (point[1] - start[1]) * edgeZ) / lengthSquared,
            }))
            .filter(({ point, amount }) => {
              if (
                positionKey(point) === positionKey(start) ||
                positionKey(point) === positionKey(end) ||
                amount < -amountTolerance ||
                amount > 1 + amountTolerance
              ) {
                return false;
              }
              const projected: Position = [
                start[0] + edgeX * amount,
                start[1] + edgeZ * amount,
              ];
              return Math.hypot(point[0] - projected[0], point[1] - projected[1]) <=
                POINT_TOLERANCE_KM;
            })
            .sort((left, right) => left.amount - right.amount);
          for (const { point } of splitPoints) {
            const previous = detailedRing[detailedRing.length - 1];
            if (!previous || positionKey(previous) !== positionKey(point)) {
              detailedRing.push(point);
            }
          }
        }
        if (detailedRing.length > 0) detailedRing.push(detailedRing[0]!);
        return detailedRing;
      });
      const outer = rings[0];
      if (!outer || outer.length < 4) continue;
      const contour = ringPoints(outer);
      const holes = rings.slice(1).map(ringPoints);
      const points = [...contour, ...holes.flat()];
      for (const face of ShapeUtils.triangulateShape(contour, holes)) {
        const first = points[face[0] ?? -1];
        const second = points[face[1] ?? -1];
        const third = points[face[2] ?? -1];
        if (!first || !second || !third) continue;
        triangles.push([
          [first.x, first.y],
          [second.x, second.y],
          [third.x, third.y],
        ]);
      }
    }

    if (triangles.length === 0) {
      throw new Error("Could not triangulate the export boundary for its bottom surface.");
    }
    const refinementCount = getBottomAreaRefinementCount(
      getRegionAreaKm2(polygons),
      resolutionMeters,
      groundScale,
    );
    if (this.faceCount + triangles.length + refinementCount * 2 > MAX_TERRAIN_EXPORT_FACES) {
      throw new Error(
        `This export exceeds the ${MAX_TERRAIN_EXPORT_FACES.toLocaleString("en-US")} face browser limit. Select a smaller region or choose a coarser resolution.`,
      );
    }
    const refinedTriangles = refineBottomTriangles(triangles, refinementCount);
    for (const triangle of refinedTriangles) {
      this.addBottomTriangle(triangle, bottomElevation);
    }
    return refinedTriangles.length;
  }

  addTopMesh(polygons: Position[][][]): void {
    for (const polygon of polygons) {
      const rings = polygon.map(ringPoints);
      const outer = rings[0];
      if (!outer || outer.length < 3) continue;
      const holes = rings.slice(1);
      const points = [...outer, ...holes.flat()];
      for (const face of ShapeUtils.triangulateShape(outer, holes)) {
        const first = points[face[0] ?? -1];
        const second = points[face[1] ?? -1];
        const third = points[face[2] ?? -1];
        if (!first || !second || !third) continue;
        this.addTopTriangle([
          [first.x * 1_000, 0, first.y * 1_000],
          [second.x * 1_000, 0, second.y * 1_000],
          [third.x * 1_000, 0, third.y * 1_000],
        ]);
      }
    }
  }

  addAccessoryPrism(
    polygon: Position[],
    bottomElevation: number,
    topElevation: number,
  ): void {
    const closed = polygon.length > 1 &&
      polygon[0]?.[0] === polygon[polygon.length - 1]?.[0] &&
      polygon[0]?.[1] === polygon[polygon.length - 1]?.[1];
    const ring = closed ? polygon.slice(0, -1) : polygon;
    if (ring.length < 3) return;
    const points = ring.map((point) => new Vector2(point[0], point[1]));
    const area = signedArea2D(ring);
    const interiorOnLeft = area > 0;
    for (const face of ShapeUtils.triangulateShape(points, [])) {
      const first = ring[face[0] ?? -1];
      const second = ring[face[1] ?? -1];
      const third = ring[face[2] ?? -1];
      if (!first || !second || !third) continue;
      this.addTopTriangle([
        [first[0] * 1_000, topElevation, first[1] * 1_000],
        [second[0] * 1_000, topElevation, second[1] * 1_000],
        [third[0] * 1_000, topElevation, third[1] * 1_000],
      ]);
      this.addBottomTriangle([first, second, third], bottomElevation);
    }
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      if (!start || !end) continue;
      const boundarySegment: TerrainClipSegment = {
        start,
        end,
        minX: Math.min(start[0], end[0]),
        minZ: Math.min(start[1], end[1]),
        maxX: Math.max(start[0], end[0]),
        maxZ: Math.max(start[1], end[1]),
        polygonIndex: -1,
        interiorOnLeft,
      };
      this.addWall(
        start,
        end,
        topElevation,
        topElevation,
        bottomElevation,
        boundarySegment,
      );
    }
  }

  addOrnamentBoundaryEdge(
    start: Position,
    end: Position,
    startHeight: number,
    endHeight: number,
    boundarySegment: TerrainClipSegment,
  ): void {
    if (positionKey(start) === positionKey(end)) return;
    if (startHeight * endHeight < 0) {
      const amount = startHeight / (startHeight - endHeight);
      const crossing: Position = [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ];
      this.addOrnamentBoundaryEdge(
        start,
        crossing,
        startHeight,
        0,
        boundarySegment,
      );
      this.addOrnamentBoundaryEdge(
        crossing,
        end,
        0,
        endHeight,
        boundarySegment,
      );
      return;
    }
    const edgeKey = segmentKey(start, end);
    if (this.ornamentBoundaryHeightEdges.has(edgeKey)) return;
    const edge: OrnamentBoundaryHeightEdge = {
      start,
      end,
      startHeight,
      endHeight,
      boundarySegment,
    };
    this.ornamentBoundaryHeightEdges.set(edgeKey, edge);
    const minX = Math.floor(
      Math.min(start[0], end[0]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const maxX = Math.floor(
      Math.max(start[0], end[0]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const minZ = Math.floor(
      Math.min(start[1], end[1]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const maxZ = Math.floor(
      Math.max(start[1], end[1]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const key = boundaryCellKey(x, z);
        let bucket = this.ornamentBoundaryHeightBuckets.get(key);
        if (!bucket) {
          bucket = new Set();
          this.ornamentBoundaryHeightBuckets.set(key, bucket);
        }
        bucket.add(edge);
      }
    }
  }

  addOrnamentWalls(
    polygons: Position[][][],
    center: Position,
    innerRadiusKm: number,
    outerRadiusKm: number,
    bottomElevation: number,
    clipTerrain: boolean,
  ): void {
    this.addOrnamentSeamWalls(center, innerRadiusKm, outerRadiusKm);
    for (const polygon of polygons) {
      for (const [ringIndex, rawRing] of polygon.entries()) {
        const isClosed = rawRing.length > 1 &&
          rawRing[0]?.[0] === rawRing[rawRing.length - 1]?.[0] &&
          rawRing[0]?.[1] === rawRing[rawRing.length - 1]?.[1];
        const ring = isClosed ? rawRing.slice(0, -1) : rawRing;
        if (ring.length < 3) continue;
        const ringInteriorOnLeft = signedArea2D(ring) > 0;
        const interiorOnLeft = ringIndex === 0
          ? ringInteriorOnLeft
          : !ringInteriorOnLeft;
        for (let index = 0; index < ring.length; index += 1) {
          const start = ring[index];
          const end = ring[(index + 1) % ring.length];
          if (!start || !end) continue;
          const edgeX = end[0] - start[0];
          const edgeZ = end[1] - start[1];
          const length = Math.hypot(edgeX, edgeZ);
          if (length === 0) continue;
          const boundarySegment: TerrainClipSegment = {
            start,
            end,
            minX: Math.min(start[0], end[0]),
            minZ: Math.min(start[1], end[1]),
            maxX: Math.max(start[0], end[0]),
            maxZ: Math.max(start[1], end[1]),
            polygonIndex: -1,
            interiorOnLeft,
          };
          const candidates = this.getOrnamentBoundaryEdges(start, end);
          const splitPoints: Array<{ point: Position; amount: number }> = [
            { point: start, amount: 0 },
            { point: end, amount: 1 },
          ];
          for (const candidate of candidates) {
            for (const point of [candidate.start, candidate.end]) {
              const projection = getSegmentProjection(point, start, end);
              if (!projection || projection.distance > POINT_TOLERANCE_KM) {
                continue;
              }
              const amountTolerance = POINT_TOLERANCE_KM / length;
              if (
                projection.amount < -amountTolerance ||
                projection.amount > 1 + amountTolerance
              ) continue;
              splitPoints.push({
                point: [
                  start[0] + edgeX * Math.max(0, Math.min(1, projection.amount)),
                  start[1] + edgeZ * Math.max(0, Math.min(1, projection.amount)),
                ],
                amount: Math.max(0, Math.min(1, projection.amount)),
              });
            }
          }
          splitPoints.sort((left, right) => left.amount - right.amount);
          const uniquePoints = splitPoints.filter((entry, pointIndex) =>
            pointIndex === 0 ||
            positionKey(entry.point) !== positionKey(
              splitPoints[pointIndex - 1]!.point,
            )
          );
          for (let pointIndex = 0; pointIndex < uniquePoints.length - 1; pointIndex += 1) {
            const first = uniquePoints[pointIndex];
            const second = uniquePoints[pointIndex + 1];
            if (!first || !second || second.amount - first.amount <= 1e-10) continue;
            const midpoint: Position = [
              (first.point[0] + second.point[0]) / 2,
              (first.point[1] + second.point[1]) / 2,
            ];
            let topStart = 0;
            let topEnd = 0;
            const midpointRadius = Math.hypot(
              midpoint[0] - center[0],
              midpoint[1] - center[1],
            );
            const isHandleOpeningEdge = clipTerrain &&
              midpointRadius >= innerRadiusKm * 0.99 &&
              midpointRadius <= innerRadiusKm + POINT_TOLERANCE_KM;
            if (!isHandleOpeningEdge) {
              const heightEdge = candidates.find((candidate) => {
                const projection = getSegmentProjection(
                  midpoint,
                  candidate.start,
                  candidate.end,
                );
                return projection !== null &&
                  projection.amount >= -1e-8 &&
                  projection.amount <= 1 + 1e-8 &&
                  projection.distance <= POINT_TOLERANCE_KM;
              });
              if (heightEdge) {
                topStart = Math.max(0, this.getOrnamentEdgeHeight(heightEdge, first.point));
                topEnd = Math.max(0, this.getOrnamentEdgeHeight(heightEdge, second.point));
              }
            }
            this.addWall(
              first.point,
              second.point,
              topStart,
              topEnd,
              bottomElevation,
              boundarySegment,
              boundarySegment,
            );
          }
        }
      }
    }
  }

  private getOrnamentBoundaryEdges(
    start: Position,
    end: Position,
  ): OrnamentBoundaryHeightEdge[] {
    const minX = Math.floor(
      Math.min(start[0], end[0]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const maxX = Math.floor(
      Math.max(start[0], end[0]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const minZ = Math.floor(
      Math.min(start[1], end[1]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const maxZ = Math.floor(
      Math.max(start[1], end[1]) / ORNAMENT_BOUNDARY_CELL_KM,
    );
    const edges = new Set<OrnamentBoundaryHeightEdge>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        const bucket = this.ornamentBoundaryHeightBuckets.get(
          boundaryCellKey(x, z),
        );
        if (bucket) for (const edge of bucket) edges.add(edge);
      }
    }
    return [...edges];
  }

  private getOrnamentEdgeHeight(
    edge: OrnamentBoundaryHeightEdge,
    point: Position,
  ): number {
    const projection = getSegmentProjection(point, edge.start, edge.end);
    if (!projection) return edge.startHeight;
    const amount = Math.max(0, Math.min(1, projection.amount));
    return edge.startHeight + (edge.endHeight - edge.startHeight) * amount;
  }

  private addOrnamentSeamWalls(
    center: Position,
    innerRadiusKm: number,
    outerRadiusKm: number,
  ): void {
    for (const edge of this.ornamentBoundaryHeightEdges.values()) {
      const midpoint: Position = [
        (edge.start[0] + edge.end[0]) / 2,
        (edge.start[1] + edge.end[1]) / 2,
      ];
      const radius = Math.hypot(
        midpoint[0] - center[0],
        midpoint[1] - center[1],
      );
      if (
        radius < innerRadiusKm - POINT_TOLERANCE_KM ||
        radius > outerRadiusKm + POINT_TOLERANCE_KM
      ) continue;
      const startHeight = Math.max(0, edge.startHeight);
      const endHeight = Math.max(0, edge.endHeight);
      if (startHeight === 0 && endHeight === 0) continue;
      this.addWall(
        edge.start,
        edge.end,
        startHeight,
        endHeight,
        0,
        edge.boundarySegment,
      );
    }
  }

  addWall(
    start: Position,
    end: Position,
    startHeight: number,
    endHeight: number,
    bottomElevation: number,
    boundarySegment: TerrainClipSegment,
    bottomBoundarySegment: TerrainClipSegment = boundarySegment,
  ): void {
    const startKey = positionKey(start);
    const endKey = positionKey(end);
    if (startKey === endKey) return;
    const sideKey = segmentKey(
      bottomBoundarySegment.start,
      bottomBoundarySegment.end,
    );
    let points = this.bottomBoundaryPoints.get(sideKey);
    if (!points) {
      points = new Map();
      this.bottomBoundaryPoints.set(sideKey, points);
    }
    points.set(startKey, start);
    points.set(endKey, end);

    const edgeKey = segmentKey(start, end);
    const startHeightKey = (startHeight * this.horizontalScale *
      this.verticalExaggeration).toFixed(7);
    const endHeightKey = (endHeight * this.horizontalScale *
      this.verticalExaggeration).toFixed(7);
    const bottomHeightKey = (bottomElevation * this.horizontalScale *
      this.verticalExaggeration).toFixed(7);
    const orderedHeightKey = startKey < endKey
      ? `${startHeightKey}|${endHeightKey}`
      : `${endHeightKey}|${startHeightKey}`;
    const wallKey = `${edgeKey}|${orderedHeightKey}|${bottomHeightKey}`;
    if (this.wallEdges.has(wallKey)) return;
    this.wallEdges.add(wallKey);

    const topStart = this.addVertex([start[0] * 1_000, startHeight, start[1] * 1_000]);
    const topEnd = this.addVertex([end[0] * 1_000, endHeight, end[1] * 1_000]);
    const bottomStart = this.addVertex([start[0] * 1_000, bottomElevation, start[1] * 1_000]);
    const bottomEnd = this.addVertex([end[0] * 1_000, bottomElevation, end[1] * 1_000]);
    const edgeX = end[0] - start[0];
    const edgeZ = end[1] - start[1];
    const boundaryX = boundarySegment.end[0] - boundarySegment.start[0];
    const boundaryZ = boundarySegment.end[1] - boundarySegment.start[1];
    const followsBoundary = edgeX * boundaryX + edgeZ * boundaryZ >= 0;
    const interiorOnLeft = followsBoundary
      ? boundarySegment.interiorOnLeft
      : !boundarySegment.interiorOnLeft;
    if (interiorOnLeft) {
      this.faces.push(
        topStart, bottomEnd, bottomStart,
        topStart, topEnd, bottomEnd,
      );
    } else {
      this.faces.push(
        topStart, bottomStart, bottomEnd,
        topStart, bottomEnd, topEnd,
      );
    }
  }

  toGeometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute(Float32Array.from(this.vertices), 3),
    );
    geometry.setIndex(new Uint32BufferAttribute(Uint32Array.from(this.faces), 1));
    return geometry;
  }

  release(): void {
    this.vertices.length = 0;
    this.faces.length = 0;
    this.vertexIndices.clear();
    this.wallEdges.clear();
    this.bottomBoundaryPoints.clear();
    this.ornamentBoundaryHeightEdges.clear();
    this.ornamentBoundaryHeightBuckets.clear();
  }

  toString(name: string): string {
    const safeName = name.replace(/[\r\n]/g, " ").trim() || "Terrain";
    const vertices = [];
    for (let index = 0; index < this.vertices.length; index += 3) {
      vertices.push(`v ${this.vertices[index]} ${this.vertices[index + 1]} ${this.vertices[index + 2]}`);
    }
    const faces = [];
    for (let index = 0; index < this.faces.length; index += 3) {
      faces.push(`f ${this.faces[index]! + 1} ${this.faces[index + 1]! + 1} ${this.faces[index + 2]! + 1}`);
    }
    return `o ${safeName}\n${vertices.join("\n")}\n${faces.join("\n")}\n`;
  }

  toBinaryStl(name: string): ArrayBuffer {
    const triangleCount = this.faces.length / 3;
    if (!Number.isSafeInteger(triangleCount) || triangleCount > 0xffff_ffff) {
      throw new Error("The terrain mesh has too many triangles for binary STL.");
    }
    const buffer = new ArrayBuffer(84 + triangleCount * 50);
    const header = utf8Encoder.encode(
      `CalTerrain binary STL: ${name.replace(/[\r\n]/g, " ").trim() || "Terrain"}`,
    );
    new Uint8Array(buffer, 0, 80).set(header.subarray(0, 80));
    const view = new DataView(buffer);
    view.setUint32(80, triangleCount, true);
    let offset = 84;
    for (let faceIndex = 0; faceIndex < this.faces.length; faceIndex += 3) {
      const firstOffset = this.faces[faceIndex]! * 3;
      const secondOffset = this.faces[faceIndex + 1]! * 3;
      const thirdOffset = this.faces[faceIndex + 2]! * 3;
      const firstX = this.vertices[firstOffset]!;
      const firstY = -this.vertices[firstOffset + 2]!;
      const firstZ = this.vertices[firstOffset + 1]!;
      const secondX = this.vertices[secondOffset]!;
      const secondY = -this.vertices[secondOffset + 2]!;
      const secondZ = this.vertices[secondOffset + 1]!;
      const thirdX = this.vertices[thirdOffset]!;
      const thirdY = -this.vertices[thirdOffset + 2]!;
      const thirdZ = this.vertices[thirdOffset + 1]!;
      const abX = secondX - firstX;
      const abY = secondY - firstY;
      const abZ = secondZ - firstZ;
      const acX = thirdX - firstX;
      const acY = thirdY - firstY;
      const acZ = thirdZ - firstZ;
      const normalX = abY * acZ - abZ * acY;
      const normalY = abZ * acX - abX * acZ;
      const normalZ = abX * acY - abY * acX;
      const normalLength = Math.hypot(normalX, normalY, normalZ);
      const normalScale = normalLength > 0 ? 1 / normalLength : 0;
      view.setFloat32(offset, normalX * normalScale, true);
      view.setFloat32(offset + 4, normalY * normalScale, true);
      view.setFloat32(offset + 8, normalZ * normalScale, true);
      view.setFloat32(offset + 12, firstX, true);
      view.setFloat32(offset + 16, firstY, true);
      view.setFloat32(offset + 20, firstZ, true);
      view.setFloat32(offset + 24, secondX, true);
      view.setFloat32(offset + 28, secondY, true);
      view.setFloat32(offset + 32, secondZ, true);
      view.setFloat32(offset + 36, thirdX, true);
      view.setFloat32(offset + 40, thirdY, true);
      view.setFloat32(offset + 44, thirdZ, true);
      offset += 48;
      view.setUint16(offset, 0, true);
      offset += 2;
    }
    return buffer;
  }
}

function barycentricHeight(
  point: Position,
  triangle: [Position, Position, Position],
  heights: [number, number, number],
): number {
  const [a, b, c] = triangle;
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) +
    (c[0] - b[0]) * (a[1] - c[1]);
  if (denominator === 0) throw new Error("Terrain export encountered a degenerate mesh triangle.");
  const first = ((b[1] - c[1]) * (point[0] - c[0]) +
    (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const second = ((c[1] - a[1]) * (point[0] - c[0]) +
    (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  return first * heights[0] + second * heights[1] + (1 - first - second) * heights[2];
}

function ringPoints(ring: Position[]): Vector2[] {
  const points = ring.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  return points.map(([x, z]) => new Vector2(x, z));
}

function signedArea2D(points: Position[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area;
}

function addFullTerrainTriangle(
  builder: ObjBuilder,
  triangle: [Position, Position, Position],
  heights: [number, number, number],
): void {
  builder.addTopTriangle(
    triangle.map((point, index) => [
      point[0] * 1_000,
      heights[index] ?? 0,
      point[1] * 1_000,
    ]),
  );
}

type HeightVertex = { point: Position; height: number };

function clipTriangleAtSeaLevel(
  triangle: [Position, Position, Position],
  heights: [number, number, number],
  keepAboveSeaLevel: boolean,
): HeightVertex[] {
  const vertices = triangle.map((point, index) => ({
    point,
    height: heights[index] ?? 0,
  }));
  if (vertices.every(({ height }) => height === 0)) {
    return keepAboveSeaLevel ? vertices : [];
  }
  const clipped: HeightVertex[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (!current || !next) continue;
    const currentInside = keepAboveSeaLevel
      ? current.height >= 0
      : current.height <= 0;
    const nextInside = keepAboveSeaLevel
      ? next.height >= 0
      : next.height < 0;
    if (currentInside) clipped.push(current);
    if (current.height * next.height < 0) {
      const amount = current.height / (current.height - next.height);
      clipped.push({
        point: [
          current.point[0] + (next.point[0] - current.point[0]) * amount,
          current.point[1] + (next.point[1] - current.point[1]) * amount,
        ],
        height: 0,
      });
    }
  }
  return clipped;
}

function addOrnamentSurfaceTriangle(
  builder: ObjBuilder,
  triangle: [Position, Position, Position],
  heights: [number, number, number],
): void {
  for (const [aboveSeaLevel, surfaceHeight] of [
    [true, false],
    [false, true],
  ] as const) {
    const polygon = clipTriangleAtSeaLevel(triangle, heights, aboveSeaLevel);
    for (let index = 1; index < polygon.length - 1; index += 1) {
      const first = polygon[0];
      const second = polygon[index];
      const third = polygon[index + 1];
      if (!first || !second || !third) continue;
      addFullTerrainTriangle(
        builder,
        [first.point, second.point, third.point],
        surfaceHeight ? [0, 0, 0] : [
          first.height,
          second.height,
          third.height,
        ],
      );
    }
  }
}

function addTriangleWithClipBoundary(
  builder: ObjBuilder,
  triangle: [Position, Position, Position],
  heights: [number, number, number],
  boundarySegments: TerrainClipSegment[],
  clipIndex: TerrainClipPolygonIndex,
  pointScratch: ReturnType<typeof createTerrainClipPointQueryScratch>,
  bottomElevation: number,
  modelHandles: {
    center: Position;
    innerRadiusKm: number;
    clipTerrain: boolean;
  }[] | null,
): void {
  const split = splitSurfaceTriangleByBoundary(
    triangle,
    boundarySegments,
    (point) => getTerrainClipPolygonsContainingPoint(
      clipIndex,
      point,
      pointScratch,
    ).length > 0,
  );
  for (const part of split.triangles) {
    const vertexHeights = part.map((point) =>
      barycentricHeight(point, triangle, heights)
    ) as [number, number, number];
    if (modelHandles !== null) addOrnamentSurfaceTriangle(builder, part, vertexHeights);
    else addFullTerrainTriangle(builder, part, vertexHeights);
  }
  for (const wall of split.walls) {
    const startHeight = barycentricHeight(wall.start, triangle, heights);
    const endHeight = barycentricHeight(wall.end, triangle, heights);
    if (modelHandles !== null && modelHandles.length > 0) {
      const midpoint: Position = [
        (wall.start[0] + wall.end[0]) / 2,
        (wall.start[1] + wall.end[1]) / 2,
      ];
      const handleOpening = modelHandles.find((handle) =>
        handle.clipTerrain && Math.hypot(
          midpoint[0] - handle.center[0],
          midpoint[1] - handle.center[1],
        ) <= handle.innerRadiusKm + POINT_TOLERANCE_KM
      );
      if (handleOpening) {
        if (startHeight > 0 || endHeight > 0) {
          builder.addWall(
            wall.start,
            wall.end,
            Math.max(0, startHeight),
            Math.max(0, endHeight),
            0,
            wall.boundarySegment,
          );
        }
        builder.addOrnamentBoundaryEdge(
          wall.start,
          wall.end,
          startHeight,
          endHeight,
          wall.boundarySegment,
        );
      } else {
        builder.addOrnamentBoundaryEdge(
          wall.start,
          wall.end,
          startHeight,
          endHeight,
          wall.boundarySegment,
        );
      }
    } else {
      builder.addWall(
        wall.start,
        wall.end,
        modelHandles === null ? startHeight : Math.max(0, startHeight),
        modelHandles === null ? endHeight : Math.max(0, endHeight),
        bottomElevation,
        wall.boundarySegment,
      );
    }
  }
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function createTerrainMesh(
  options: TerrainExportOptions,
  bottomElevation = TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS,
  model?: TerrainModelOptions,
): Promise<ObjBuilder> {
  const { metadata, center, californiaPolygons, region } = options;
  if (region.polygons.length === 0) throw new Error(`${region.name} does not intersect California.`);
  if (!Number.isFinite(options.resolutionMeters) || options.resolutionMeters <= 0) {
    throw new Error("Terrain export resolution must be greater than zero.");
  }
  if (
    !Number.isFinite(options.californiaLatitudeSpanMeters) ||
    options.californiaLatitudeSpanMeters <= 0 ||
    (!model && (
      options.californiaLatitudeSpanMeters < TERRAIN_EXPORT_SCALE_MIN_METERS ||
      options.californiaLatitudeSpanMeters > TERRAIN_EXPORT_SCALE_MAX_METERS
    ))
  ) {
    throw new Error("California export latitude span is outside the supported range.");
  }
  const californiaBounds = getPolygonsBounds(californiaPolygons);
  const californiaProjectedSpanMeters = (californiaBounds.maxZ - californiaBounds.minZ) * 1_000;
  if (!Number.isFinite(californiaProjectedSpanMeters) || californiaProjectedSpanMeters <= 0) {
    throw new Error("Could not calculate California's projected latitude span.");
  }
  if (!Number.isFinite(options.verticalExaggeration) || options.verticalExaggeration <= 0) {
    throw new Error("Terrain exaggeration must be greater than zero.");
  }
  const horizontalScale = options.californiaLatitudeSpanMeters / californiaProjectedSpanMeters;
  const regionSpanKm = getTerrainRegionLatitudeSpanKm(region);
  const localAccessories: LocalTerrainAccessory[] = model
    ? model.accessories.map((accessory) => ({
      ...accessory,
      position: toLocal(accessory.position, center),
      sizeKm: accessory.sizeMm * regionSpanKm / model.latitudeSpanMm,
    }))
    : [];
  const modelFootprints = model
    ? createTerrainModelFootprints(region, localAccessories)
    : undefined;
  const modelHandles = model
    ? localAccessories.flatMap((accessory) => accessory.type === "handle"
      ? [{
        center: accessory.position,
        innerRadiusKm: accessory.sizeKm * 0.4,
        outerRadiusKm: accessory.sizeKm * 0.5,
      clipTerrain: accessory.clipTerrain !== false,
      }]
      : [])
    : null;
  const terrainPolygons = modelFootprints?.surface ?? region.polygons;
  const exportPolygons = modelFootprints?.footprint ?? region.polygons;
  const regionBounds = getPolygonsBounds(region.polygons);
  const zoom = getTerrainExportZoom(metadata, options.resolutionMeters);
  const tiles = getExportTiles(metadata, zoom, regionBounds, center);
  if (tiles.length === 0) {
    throw new Error(`No terrain tiles are available at ${options.resolutionMeters} m resolution.`);
  }

  const clipIndex: TerrainClipPolygonIndex = createTerrainClipPolygonIndex(terrainPolygons);
  const pointScratch = createTerrainClipPointQueryScratch(clipIndex);
  const builder = new ObjBuilder(horizontalScale, options.verticalExaggeration);
  const groundScale = getTerrainGroundScale(center);
  const exportBottomElevation = model
    ? -(model.baseThicknessMm / 1_000) /
      (horizontalScale * options.verticalExaggeration)
    : bottomElevation;

  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    if (!tile) continue;
    options.onProgress?.({
      tileIndex: tileIndex + 1,
      tileCount: tiles.length,
      regionName: region.name,
    });
    const raster = await loadTileRaster(tile);
    if (raster.width < 3 || raster.height < 3) {
      throw new Error(`Terrain tile ${tile.z}/${tile.x}/${tile.y} is too small to sample.`);
    }
    const tileBounds = {
      minX: tile.left,
      minZ: tile.top,
      maxX: tile.left + tile.size,
      maxZ: tile.top + tile.size,
    };
    const clipPolygons = getRegionTilePolygons(terrainPolygons, tileBounds);
    if (clipPolygons.length === 0) continue;
    const tileRectangle: Position[][][] = [[[
      [tile.left, tile.top],
      [tile.left + tile.size, tile.top],
      [tile.left + tile.size, tile.top + tile.size],
      [tile.left, tile.top + tile.size],
      [tile.left, tile.top],
    ]]];
    const tileClipPolygons = intersection(
      tileRectangle as MultiPolygon,
      clipPolygons as MultiPolygon,
    ) as Position[][][];
    if (tileClipPolygons.length === 0) continue;
    const divisions = Math.max(
      1,
      Math.ceil(tile.size * 1_000 * groundScale / options.resolutionMeters),
    );
    const vertexHeights = new Float64Array((divisions + 1) * (divisions + 1));
    for (let row = 0; row <= divisions; row += 1) {
      for (let column = 0; column <= divisions; column += 1) {
        vertexHeights[row * (divisions + 1) + column] = sampleBicubicHeight(
          raster,
          column / divisions,
          row / divisions,
        );
      }
    }
    const cellSize = tile.size / divisions;
    const cellSegments: TerrainClipSegment[] = [];
    for (let row = 0; row < divisions; row += 1) {
      const z0 = tile.top + row * cellSize;
      const z1 = z0 + cellSize;
      for (let column = 0; column < divisions; column += 1) {
        const x0 = tile.left + column * cellSize;
        const x1 = x0 + cellSize;
        const boundarySegments = getTerrainClipSegmentsForTile(
          clipIndex,
          x0,
          z0,
          cellSize,
          cellSegments,
        );
        if (boundarySegments.length === 0) {
          const containing = getTerrainClipPolygonsContainingPoint(
            clipIndex,
            [(x0 + x1) / 2, (z0 + z1) / 2],
            pointScratch,
          );
          if (containing.length === 0) continue;
        }

        const topLeft: Position = [x0, z0];
        const bottomLeft: Position = [x0, z1];
        const bottomRight: Position = [x1, z1];
        const topRight: Position = [x1, z0];
        const topLeftHeight = vertexHeights[row * (divisions + 1) + column] ?? 0;
        const bottomLeftHeight = vertexHeights[(row + 1) * (divisions + 1) + column] ?? 0;
        const bottomRightHeight = vertexHeights[(row + 1) * (divisions + 1) + column + 1] ?? 0;
        const topRightHeight = vertexHeights[row * (divisions + 1) + column + 1] ?? 0;
        const firstTriangle: [Position, Position, Position] = [topLeft, bottomLeft, topRight];
        const secondTriangle: [Position, Position, Position] = [bottomLeft, bottomRight, topRight];
        const firstHeights: [number, number, number] = [
          topLeftHeight,
          bottomLeftHeight,
          topRightHeight,
        ];
        const secondHeights: [number, number, number] = [
          bottomLeftHeight,
          bottomRightHeight,
          topRightHeight,
        ];
        if (boundarySegments.length === 0) {
          if (model) {
            addOrnamentSurfaceTriangle(builder, firstTriangle, firstHeights);
            addOrnamentSurfaceTriangle(builder, secondTriangle, secondHeights);
          } else {
            builder.addTopTriangle(firstTriangle.map((point, index) => [
              point[0] * 1_000,
              firstHeights[index] ?? 0,
              point[1] * 1_000,
            ]));
            builder.addTopTriangle(secondTriangle.map((point, index) => [
              point[0] * 1_000,
              secondHeights[index] ?? 0,
              point[1] * 1_000,
            ]));
          }
        } else {
          addTriangleWithClipBoundary(
            builder,
            firstTriangle,
            firstHeights,
            boundarySegments,
            clipIndex,
            pointScratch,
            exportBottomElevation,
            modelHandles,
          );
          addTriangleWithClipBoundary(
            builder,
            secondTriangle,
            secondHeights,
            boundarySegments,
            clipIndex,
            pointScratch,
            exportBottomElevation,
            modelHandles,
          );
        }
        if (builder.faceCount > MAX_TERRAIN_EXPORT_FACES) {
          throw new Error(
            `This export exceeds the ${MAX_TERRAIN_EXPORT_FACES.toLocaleString("en-US")} face browser limit. Select a smaller region or choose a coarser resolution.`,
          );
        }
      }
      if (row % EXPORT_YIELD_INTERVAL === 0) await yieldToBrowser();
    }
  }

  if (modelFootprints && model) {
    builder.addTopMesh(modelFootprints.baseOnly);
    for (const handle of modelHandles ?? []) {
      builder.addOrnamentWalls(
        modelFootprints.footprint,
        handle.center,
        handle.innerRadiusKm,
        handle.outerRadiusKm,
        exportBottomElevation,
        handle.clipTerrain,
      );
    }
  }
  builder.addBottomMesh(
    exportPolygons,
    exportBottomElevation,
    options.resolutionMeters,
    groundScale,
  );

  for (const accessory of localAccessories) {
    if (accessory.type === "handle") continue;
    const outline = createTerrainAccessoryOutline(
      accessory.type,
      accessory.position,
      accessory.sizeKm,
      accessory.rotationDegrees,
    );
    const topElevation = ((accessory.thicknessMm ?? 1) / 1_000) /
      (horizontalScale * options.verticalExaggeration);
    const accessoryBottomElevation = model
      ? -getTerrainAccessoryBaseOverlapMm(model.baseThicknessMm) / 1_000 /
        (horizontalScale * options.verticalExaggeration)
      : exportBottomElevation;
    builder.addAccessoryPrism(outline, accessoryBottomElevation, topElevation);
  }

  if (builder.faceCount === 0) {
    throw new Error(`${region.name} did not overlap any terrain tile data.`);
  }
  return builder;
}

function padToFourBytes(bytes: Uint8Array, padding = 0): Uint8Array {
  const padded = new Uint8Array((bytes.byteLength + 3) & ~3);
  padded.set(bytes);
  if (padding !== 0) padded.fill(padding, bytes.byteLength);
  return padded;
}

type EncodedDracoChunk = {
  bytes: Uint8Array;
  vertexCount: number;
  indexCount: number;
  min: [number, number, number];
  max: [number, number, number];
};

function createDracoChunkGeometry(
  sourcePositions: BufferAttribute | InterleavedBufferAttribute,
  sourceIndices: BufferAttribute,
  firstIndex: number,
  endIndex: number,
): BufferGeometry {
  const indexCount = endIndex - firstIndex;
  const positions = new Float32Array(indexCount * 3);
  const indices = new Uint32Array(indexCount);
  const vertexIndices = new Map<number, number>();
  let vertexCount = 0;

  for (let sourceOffset = firstIndex; sourceOffset < endIndex; sourceOffset += 1) {
    const sourceIndex = sourceIndices.getX(sourceOffset);
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sourcePositions.count) {
      throw new Error("Terrain export contains an invalid vertex index.");
    }
    let chunkIndex = vertexIndices.get(sourceIndex);
    if (chunkIndex === undefined) {
      chunkIndex = vertexCount;
      vertexIndices.set(sourceIndex, vertexCount);
      positions[vertexCount * 3] = sourcePositions.getX(sourceIndex);
      positions[vertexCount * 3 + 1] = sourcePositions.getY(sourceIndex);
      positions[vertexCount * 3 + 2] = sourcePositions.getZ(sourceIndex);
      vertexCount += 1;
    }
    indices[sourceOffset - firstIndex] = chunkIndex;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(positions.subarray(0, vertexCount * 3), 3),
  );
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  return geometry;
}

function getDracoDecoderModule(): Promise<DracoDecoderModule> {
  if (!dracoDecoderModulePromise) {
    dracoDecoderModulePromise = createDecoderModule({
      locateFile: (file) => file.endsWith(".wasm") ? dracoDecoderWasmUrl : file,
    }).catch((error: unknown) => {
      dracoDecoderModulePromise = null;
      throw error;
    });
  }
  return dracoDecoderModulePromise;
}

async function inspectEncodedDracoChunk(bytes: Uint8Array): Promise<{
  vertexCount: number;
  indexCount: number;
  min: [number, number, number];
  max: [number, number, number];
}> {
  const module = await getDracoDecoderModule();
  const decoder = new module.Decoder();
  const decoderBuffer = new module.DecoderBuffer();
  const mesh = new module.Mesh();
  const decodedPositions = new module.DracoFloat32Array();

  try {
    const encodedBytes = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    decoderBuffer.Init(encodedBytes, encodedBytes.byteLength);
    const status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
    if (!status.ok()) throw new Error("Could not verify compressed terrain chunk.");
    const positionId = decoder.GetAttributeId(mesh, module.POSITION);
    if (positionId < 0) throw new Error("Compressed terrain chunk is missing positions.");
    const positionAttribute = decoder.GetAttribute(mesh, positionId);
    decoder.GetAttributeFloatForAllPoints(mesh, positionAttribute, decodedPositions);

    const vertexCount = mesh.num_points();
    if (decodedPositions.size() !== vertexCount * 3) {
      throw new Error("Compressed terrain chunk has an invalid position count.");
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const offset = vertex * 3;
      const x = decodedPositions.GetValue(offset);
      const y = decodedPositions.GetValue(offset + 1);
      const z = decodedPositions.GetValue(offset + 2);
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
      max[2] = Math.max(max[2], z);
    }
    return {
      vertexCount,
      indexCount: mesh.num_faces() * 3,
      min,
      max,
    };
  } finally {
    module.destroy(decodedPositions);
    module.destroy(mesh);
    module.destroy(decoderBuffer);
    module.destroy(decoder);
  }
}

async function encodeDracoChunk(
  exporter: DRACOExporter,
  geometry: BufferGeometry,
): Promise<EncodedDracoChunk> {
  if (!geometry.boundingBox || !geometry.getIndex()) {
    throw new Error("Could not calculate terrain export bounds.");
  }

  const object = new Mesh(geometry, new MeshBasicMaterial());
  try {
    const compressed = await exporter.parseAsync(object, {
      exportNormals: false,
      exportUvs: false,
      quantization: [20, 8, 8, 8, 8],
    });
    const bytes = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
    return {
      bytes,
      ...await inspectEncodedDracoChunk(bytes),
    };
  } finally {
    geometry.dispose();
    object.material.dispose();
  }
}

function createDracoGlb(
  mesh: ObjBuilder,
  name: string,
  maxPrimitiveFaces: number,
): Promise<ArrayBuffer> {
  const geometry = mesh.toGeometry();
  mesh.release();
  return createDracoGlbFromGeometry(geometry, name, maxPrimitiveFaces);
}

function createDracoGlbFromGeometry(
  geometry: BufferGeometry,
  name: string,
  maxPrimitiveFaces: number,
): Promise<ArrayBuffer> {
  const encode = async (): Promise<ArrayBuffer> => {
    const positions = geometry.getAttribute("position");
    const indices = geometry.getIndex();
    if (!indices || indices.count % 3 !== 0) {
      throw new Error("Terrain export geometry must contain indexed triangles.");
    }

    const global = globalThis as typeof globalThis & {
      DracoEncoderModule?: () => Promise<unknown>;
    };
    if (!dracoEncoderModulePromise) {
      dracoEncoderModulePromise = createEncoderModule({
        locateFile: (file) => file.endsWith(".wasm") ? dracoEncoderWasmUrl : file,
      }).catch((error: unknown) => {
        dracoEncoderModulePromise = null;
        throw error;
      });
      global.DracoEncoderModule = () => dracoEncoderModulePromise!;
    }
    await dracoEncoderModulePromise;

    const faceCount = indices.count / 3;
    const exporter = new DRACOExporter();
    const chunks: EncodedDracoChunk[] = [];
    for (let firstFace = 0; firstFace < faceCount; firstFace += maxPrimitiveFaces) {
      const endFace = Math.min(firstFace + maxPrimitiveFaces, faceCount);
      const chunkGeometry = createDracoChunkGeometry(
        positions,
        indices,
        firstFace * 3,
        endFace * 3,
      );
      chunks.push(await encodeDracoChunk(exporter, chunkGeometry));
      await yieldToBrowser();
    }

    let binaryLength = 0;
    const bufferViews = chunks.map((chunk) => {
      const bufferView = {
        buffer: 0,
        byteOffset: binaryLength,
        byteLength: chunk.bytes.byteLength,
      };
      binaryLength += (chunk.bytes.byteLength + 3) & ~3;
      return bufferView;
    });
    const accessors: {
      componentType: number;
      count: number;
      type: string;
      min?: [number, number, number];
      max?: [number, number, number];
    }[] = [];
    const primitives = chunks.map((chunk, index) => {
      const positionAccessor = accessors.length;
      accessors.push({
        componentType: 5126,
        count: chunk.vertexCount,
        type: "VEC3",
        min: chunk.min,
        max: chunk.max,
      });
      const indexAccessor = accessors.length;
      accessors.push({
        componentType: 5125,
        count: chunk.indexCount,
        type: "SCALAR",
      });
      return {
        attributes: { POSITION: positionAccessor },
        indices: indexAccessor,
        mode: 4,
        extensions: {
          KHR_draco_mesh_compression: {
            bufferView: index,
            attributes: { POSITION: 0 },
          },
        },
      };
    });

    const gltf = {
      asset: { version: "2.0", generator: "California Terrain Viewer" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name, mesh: 0 }],
      meshes: [{ primitives }],
      accessors,
      bufferViews,
      buffers: [{ byteLength: binaryLength }],
      extensionsUsed: ["KHR_draco_mesh_compression"],
      extensionsRequired: ["KHR_draco_mesh_compression"],
    };
    const jsonChunk = padToFourBytes(utf8Encoder.encode(JSON.stringify(gltf)), 0x20);
    const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binaryLength;
    if (totalLength > 0xffffffff) {
      throw new Error("Compressed terrain export exceeds the maximum GLB file size.");
    }
    const glb = new Uint8Array(totalLength);
    const view = new DataView(glb.buffer);
    writeUint32(view, 0, 0x46546c67);
    writeUint32(view, 4, 2);
    writeUint32(view, 8, totalLength);
    writeUint32(view, 12, jsonChunk.byteLength);
    writeUint32(view, 16, 0x4e4f534a);
    glb.set(jsonChunk, 20);
    const binaryOffset = 20 + jsonChunk.byteLength;
    writeUint32(view, binaryOffset, binaryLength);
    writeUint32(view, binaryOffset + 4, 0x004e4942);
    chunks.forEach((chunk, index) => {
      const bufferView = bufferViews[index];
      if (!bufferView) throw new Error("Terrain export is missing a Draco buffer view.");
      glb.set(chunk.bytes, binaryOffset + 8 + bufferView.byteOffset);
    });
    return glb.buffer;
  };

  return encode().finally(() => geometry.dispose());
}

function validateTerrainModelOptions(model: TerrainModelOptions): void {
  if (!Number.isFinite(model.baseThicknessMm) ||
      model.baseThicknessMm <= 0 ||
      model.baseThicknessMm > 100) {
    throw new Error("Model base thickness must be between 0 and 100 millimeters.");
  }
  if (!Number.isFinite(model.latitudeSpanMm) ||
      model.latitudeSpanMm < 10 ||
      model.latitudeSpanMm > 500) {
    throw new Error("Model latitude span must be between 10 and 500 millimeters.");
  }
  for (const accessory of model.accessories) {
    const [longitude, latitude] = accessory.position;
    if (
      !Number.isFinite(accessory.sizeMm) ||
      accessory.sizeMm < 1 ||
      accessory.sizeMm > 500 ||
      !Number.isFinite(accessory.rotationDegrees) ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(latitude) ||
      latitude < -85.05112878 ||
      latitude > 85.05112878
    ) {
      throw new Error("Model accessory size, position, or rotation is invalid.");
    }
    if (
      accessory.type !== "handle" &&
      (accessory.thicknessMm === undefined ||
        !Number.isFinite(accessory.thicknessMm) ||
        accessory.thicknessMm < 1 ||
        accessory.thicknessMm > 10)
    ) {
      throw new Error(
        "Heart and star accessories need a thickness between 1 and 10 millimeters.",
      );
    }
  }
}

function getTerrainModelExportOptions(
  options: Omit<TerrainExportOptions, "californiaLatitudeSpanMeters">,
  model: TerrainModelOptions,
): TerrainExportOptions {
  validateTerrainModelOptions(model);
  const californiaBounds = getPolygonsBounds(options.californiaPolygons);
  const californiaSpanMeters = (californiaBounds.maxZ - californiaBounds.minZ) * 1_000;
  const regionSpanMeters = getTerrainRegionLatitudeSpanKm(options.region) * 1_000;
  if (!Number.isFinite(californiaSpanMeters) || californiaSpanMeters <= 0) {
    throw new Error("Could not calculate California's projected latitude span.");
  }
  if (!Number.isFinite(regionSpanMeters) || regionSpanMeters <= 0) {
    throw new Error("Could not calculate the selected element's latitude span.");
  }
  return {
    ...options,
    californiaLatitudeSpanMeters:
      (model.latitudeSpanMm / 1_000) * californiaSpanMeters / regionSpanMeters,
  };
}

export async function createTerrainObj(
  options: TerrainExportOptions,
  model?: TerrainModelOptions,
): Promise<string> {
  const meshOptions = model
    ? getTerrainModelExportOptions(options, model)
    : options;
  const mesh = await createTerrainMesh(meshOptions, undefined, model);
  options.onTriangleCount?.(mesh.faceCount);
  return mesh.toString(options.region.name);
}

export async function createTerrainGlb(
  options: TerrainExportOptions,
  maxPrimitiveFaces = DRACO_CHUNK_FACE_LIMIT,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxPrimitiveFaces) || maxPrimitiveFaces < 1) {
    throw new Error("GLB Draco primitive size must be a positive whole number of faces.");
  }
  const mesh = await createTerrainMesh(options);
  options.onTriangleCount?.(mesh.faceCount);
  return createDracoGlb(mesh, options.region.name, maxPrimitiveFaces);
}

export async function createTerrainModelGlb(
  options: Omit<TerrainExportOptions, "californiaLatitudeSpanMeters">,
  model: TerrainModelOptions,
  maxPrimitiveFaces = DRACO_CHUNK_FACE_LIMIT,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxPrimitiveFaces) || maxPrimitiveFaces < 1) {
    throw new Error("GLB Draco primitive size must be a positive whole number of faces.");
  }
  validateTerrainModelOptions(model);
  const mesh = await createTerrainMesh(
    getTerrainModelExportOptions(options, model),
    undefined,
    model,
  );
  options.onTriangleCount?.(mesh.faceCount);
  return createDracoGlb(mesh, options.region.name, maxPrimitiveFaces);
}

export async function createTerrainModelStl(
  options: Omit<TerrainExportOptions, "californiaLatitudeSpanMeters">,
  model: TerrainModelOptions,
): Promise<ArrayBuffer> {
  validateTerrainModelOptions(model);
  const mesh = await createTerrainMesh(
    getTerrainModelExportOptions(options, model),
    undefined,
    model,
  );
  try {
    options.onTriangleCount?.(mesh.faceCount);
    return mesh.toBinaryStl(options.region.name);
  } finally {
    mesh.release();
  }
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum = (crc32Table[(checksum ^ byte) & 0xff] ?? 0) ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

export function createStoreZip(entries: TerrainZipEntry[]): Blob {
  const localRecords: Uint8Array<ArrayBuffer>[] = [];
  const centralRecords: Uint8Array<ArrayBuffer>[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = utf8Encoder.encode(entry.name);
    const content = typeof entry.content === "string"
      ? utf8Encoder.encode(entry.content)
      : entry.content;
    const checksum = crc32(content);
    if (content.length > 0xffffffff || localOffset > 0xffffffff) {
      throw new Error("ZIP export exceeds the 4 GB archive limit.");
    }
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, content.length);
    writeUint32(localView, 22, content.length);
    writeUint16(localView, 26, name.length);
    localHeader.set(name, 30);
    localRecords.push(localHeader, content);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, content.length);
    writeUint32(centralView, 24, content.length);
    writeUint16(centralView, 28, name.length);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(name, 46);
    centralRecords.push(centralHeader);
    localOffset += localHeader.length + content.length;
  }

  const centralDirectorySize = centralRecords.reduce((sum, record) => sum + record.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralDirectorySize);
  writeUint32(endView, 16, localOffset);
  return new Blob([...localRecords, ...centralRecords, endRecord], { type: "application/zip" });
}

export function terrainExportFilename(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${slug || "terrain"}.glb`;
}
