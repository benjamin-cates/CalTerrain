import { intersection, type MultiPolygon } from "polygon-clipping";
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

export const TERRAIN_EXPORT_RESOLUTIONS = [240, 120, 60, 30] as const;
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

type ClipTriangle = {
  triangle: [Position, Position, Position];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
};

type ClipTriangleNode = {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  left?: ClipTriangleNode;
  right?: ClipTriangleNode;
  triangles?: ClipTriangle[];
};

type ClipTriangleIndex = { root: ClipTriangleNode | null };

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

  const zoom = getTerrainZoom(options.metadata, options.resolutionMeters);
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

function getTerrainZoom(metadata: TerrainMetadata, resolutionMeters: number): number {
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
          const splitPoints = [...boundaryPoints.values()]
            .map((point) => ({
              point,
              amount: ((point[0] - start[0]) * edgeX +
                (point[1] - start[1]) * edgeZ) / lengthSquared,
            }))
            .filter(({ point, amount }) => {
              if (amount <= POINT_TOLERANCE_KM || amount >= 1 - POINT_TOLERANCE_KM) {
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

  addWall(
    start: Position,
    end: Position,
    startHeight: number,
    endHeight: number,
    bottomElevation: number,
    boundarySegment: TerrainClipSegment,
  ): void {
    const startKey = positionKey(start);
    const endKey = positionKey(end);
    if (startKey === endKey) return;
    const sideKey = segmentKey(boundarySegment.start, boundarySegment.end);
    let points = this.bottomBoundaryPoints.get(sideKey);
    if (!points) {
      points = new Map();
      this.bottomBoundaryPoints.set(sideKey, points);
    }
    points.set(startKey, start);
    points.set(endKey, end);

    const edgeKey = segmentKey(start, end);
    if (this.wallEdges.has(edgeKey)) return;
    this.wallEdges.add(edgeKey);

    const topStart = this.addVertex([start[0] * 1_000, startHeight, start[1] * 1_000]);
    const topEnd = this.addVertex([end[0] * 1_000, endHeight, end[1] * 1_000]);
    const bottomStart = this.addVertex([start[0] * 1_000, bottomElevation, start[1] * 1_000]);
    const bottomEnd = this.addVertex([end[0] * 1_000, bottomElevation, end[1] * 1_000]);
    this.faces.push(
      topStart, bottomStart, bottomEnd,
      topStart, bottomEnd, topEnd,
    );
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

function pointOnSegment(point: Position, segment: TerrainClipSegment): boolean {
  const dx = segment.end[0] - segment.start[0];
  const dz = segment.end[1] - segment.start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return false;
  const projection = ((point[0] - segment.start[0]) * dx +
    (point[1] - segment.start[1]) * dz) / lengthSquared;
  if (projection < -POINT_TOLERANCE_KM || projection > 1 + POINT_TOLERANCE_KM) return false;
  const distance = Math.abs(
    dx * (segment.start[1] - point[1]) - (segment.start[0] - point[0]) * dz,
  ) / Math.sqrt(lengthSquared);
  return distance <= POINT_TOLERANCE_KM;
}

function segmentCrossesTriangleInterior(
  segment: TerrainClipSegment,
  triangle: [Position, Position, Position],
): boolean {
  const [start, end] = [segment.start, segment.end];
  const signedArea = (triangle[1][0] - triangle[0][0]) *
      (triangle[2][1] - triangle[0][1]) -
    (triangle[1][1] - triangle[0][1]) * (triangle[2][0] - triangle[0][0]);
  const orientation = signedArea >= 0 ? 1 : -1;
  let minimum = 0;
  let maximum = 1;
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
    const edgeStart = triangle[edgeIndex];
    const edgeEnd = triangle[(edgeIndex + 1) % 3];
    if (!edgeStart || !edgeEnd) continue;
    const edgeX = edgeEnd[0] - edgeStart[0];
    const edgeZ = edgeEnd[1] - edgeStart[1];
    const signedDistance = (point: Position) => orientation * (
      edgeX * (point[1] - edgeStart[1]) -
      edgeZ * (point[0] - edgeStart[0])
    );
    const startDistance = signedDistance(start);
    const endDistance = signedDistance(end);
    const delta = endDistance - startDistance;
    if (Math.abs(delta) <= Number.EPSILON) {
      if (startDistance < -POINT_TOLERANCE_KM) return false;
      continue;
    }
    const ratio = (-POINT_TOLERANCE_KM - startDistance) / delta;
    if (delta > 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  if (maximum - minimum <= Number.EPSILON) return false;
  const midpointRatio = (minimum + maximum) / 2;
  const midpoint: Position = [
    start[0] + (end[0] - start[0]) * midpointRatio,
    start[1] + (end[1] - start[1]) * midpointRatio,
  ];
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
    const edgeStart = triangle[edgeIndex];
    const edgeEnd = triangle[(edgeIndex + 1) % 3];
    if (!edgeStart || !edgeEnd) continue;
    const edgeX = edgeEnd[0] - edgeStart[0];
    const edgeZ = edgeEnd[1] - edgeStart[1];
    const cross = orientation * (
      edgeX * (midpoint[1] - edgeStart[1]) -
      edgeZ * (midpoint[0] - edgeStart[0])
    );
    if (cross <= POINT_TOLERANCE_KM) return false;
  }
  return true;
}

function getCollinearSegmentOverlap(
  start: Position,
  end: Position,
  segment: TerrainClipSegment,
): [Position, Position] | null {
  const edgeX = end[0] - start[0];
  const edgeZ = end[1] - start[1];
  const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
  if (lengthSquared === 0) return null;
  const distanceToLine = (point: Position) =>
    Math.abs(edgeX * (point[1] - start[1]) - edgeZ * (point[0] - start[0])) /
    Math.sqrt(lengthSquared);
  if (
    distanceToLine(segment.start) > POINT_TOLERANCE_KM ||
    distanceToLine(segment.end) > POINT_TOLERANCE_KM
  ) return null;
  const project = (point: Position) =>
    ((point[0] - start[0]) * edgeX + (point[1] - start[1]) * edgeZ) / lengthSquared;
  const first = project(segment.start);
  const second = project(segment.end);
  const overlapStart = Math.max(0, Math.min(first, second));
  const overlapEnd = Math.min(1, Math.max(first, second));
  if (overlapEnd - overlapStart <= POINT_TOLERANCE_KM) return null;
  return [
    [start[0] + edgeX * overlapStart, start[1] + edgeZ * overlapStart],
    [start[0] + edgeX * overlapEnd, start[1] + edgeZ * overlapEnd],
  ];
}

function ringPoints(ring: Position[]): Vector2[] {
  const points = ring.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  return points.map(([x, z]) => new Vector2(x, z));
}

function buildClipTriangleTree(triangles: ClipTriangle[]): ClipTriangleNode | null {
  if (triangles.length === 0) return null;
  const bounds = triangles.reduce((result, item) => ({
    minX: Math.min(result.minX, item.minX),
    minZ: Math.min(result.minZ, item.minZ),
    maxX: Math.max(result.maxX, item.maxX),
    maxZ: Math.max(result.maxZ, item.maxZ),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  if (triangles.length <= 8) return { ...bounds, triangles };
  const splitOnX = bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ;
  triangles.sort((a, b) => splitOnX
    ? (a.minX + a.maxX) - (b.minX + b.maxX)
    : (a.minZ + a.maxZ) - (b.minZ + b.maxZ));
  const middle = Math.floor(triangles.length / 2);
  return {
    ...bounds,
    left: buildClipTriangleTree(triangles.slice(0, middle)) ?? undefined,
    right: buildClipTriangleTree(triangles.slice(middle)) ?? undefined,
  };
}

function createClipTriangleIndex(polygons: Position[][][]): ClipTriangleIndex {
  const triangles: ClipTriangle[] = [];
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 4) continue;
    const contour = ringPoints(outer);
    const holes = polygon.slice(1).map(ringPoints);
    const faces = ShapeUtils.triangulateShape(contour, holes);
    const points = [...contour, ...holes.flat()];
    for (const face of faces) {
      const vertices = face.map((index) => points[index]) as [Vector2, Vector2, Vector2];
      const first = vertices[0];
      const second = vertices[1];
      const third = vertices[2];
      if (!first || !second || !third) continue;
      const triangle: [Position, Position, Position] = [
        [first.x, first.y],
        [second.x, second.y],
        [third.x, third.y],
      ];
      const signedArea = (second.x - first.x) * (third.y - first.y) -
        (second.y - first.y) * (third.x - first.x);
      if (Math.abs(signedArea) <= Number.EPSILON) continue;
      triangles.push({
        triangle,
        minX: Math.min(first.x, second.x, third.x),
        minZ: Math.min(first.y, second.y, third.y),
        maxX: Math.max(first.x, second.x, third.x),
        maxZ: Math.max(first.y, second.y, third.y),
      });
    }
  }
  if (triangles.length === 0) {
    throw new Error("Could not triangulate the clipped region for terrain export.");
  }
  return { root: buildClipTriangleTree(triangles) };
}

function queryClipTriangleTree(
  node: ClipTriangleNode | null,
  bounds: Pick<ClipTriangle, "minX" | "minZ" | "maxX" | "maxZ">,
  results: ClipTriangle[],
): void {
  if (
    !node ||
    node.minX > bounds.maxX ||
    node.maxX < bounds.minX ||
    node.minZ > bounds.maxZ ||
    node.maxZ < bounds.minZ
  ) return;
  if (node.triangles) {
    for (const triangle of node.triangles) {
      if (
        triangle.minX <= bounds.maxX &&
        triangle.maxX >= bounds.minX &&
        triangle.minZ <= bounds.maxZ &&
        triangle.maxZ >= bounds.minZ
      ) results.push(triangle);
    }
    return;
  }
  queryClipTriangleTree(node.left ?? null, bounds, results);
  queryClipTriangleTree(node.right ?? null, bounds, results);
}

function getClipTrianglesForTerrainTriangle(
  index: ClipTriangleIndex,
  triangle: [Position, Position, Position],
  results: ClipTriangle[],
): ClipTriangle[] {
  results.length = 0;
  queryClipTriangleTree(index.root, {
    minX: Math.min(triangle[0][0], triangle[1][0], triangle[2][0]),
    minZ: Math.min(triangle[0][1], triangle[1][1], triangle[2][1]),
    maxX: Math.max(triangle[0][0], triangle[1][0], triangle[2][0]),
    maxZ: Math.max(triangle[0][1], triangle[1][1], triangle[2][1]),
  }, results);
  return results;
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

function clipConvexPolygon(
  subject: Position[],
  clip: [Position, Position, Position],
): Position[] {
  const orientation = signedArea2D(clip) >= 0 ? 1 : -1;
  let output = subject.slice();
  for (let edgeIndex = 0; edgeIndex < 3 && output.length > 0; edgeIndex += 1) {
    const edgeStart = clip[edgeIndex];
    const edgeEnd = clip[(edgeIndex + 1) % 3];
    if (!edgeStart || !edgeEnd) continue;
    const edgeX = edgeEnd[0] - edgeStart[0];
    const edgeZ = edgeEnd[1] - edgeStart[1];
    const signedDistance = (point: Position) => orientation * (
      edgeX * (point[1] - edgeStart[1]) -
      edgeZ * (point[0] - edgeStart[0])
    );
    const input = output;
    output = [];
    let previous = input[input.length - 1];
    if (!previous) continue;
    let previousDistance = signedDistance(previous);
    for (const current of input) {
      const currentDistance = signedDistance(current);
      const previousInside = previousDistance >= -POINT_TOLERANCE_KM;
      const currentInside = currentDistance >= -POINT_TOLERANCE_KM;
      if (previousInside !== currentInside) {
        const denominator = previousDistance - currentDistance;
        if (denominator !== 0) {
          const ratio = previousDistance / denominator;
          output.push([
            previous[0] + (current[0] - previous[0]) * ratio,
            previous[1] + (current[1] - previous[1]) * ratio,
          ]);
        }
      }
      if (currentInside) output.push(current);
      previous = current;
      previousDistance = currentDistance;
    }
  }

  const deduplicated = output.filter((point, index) => {
    const previous = output[(index + output.length - 1) % output.length];
    return !previous ||
      Math.hypot(point[0] - previous[0], point[1] - previous[1]) > POINT_TOLERANCE_KM;
  });
  return deduplicated.length >= 3 && Math.abs(signedArea2D(deduplicated)) > 1e-12
    ? deduplicated
    : [];
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

function addTriangleWithClipBoundary(
  builder: ObjBuilder,
  triangle: [Position, Position, Position],
  heights: [number, number, number],
  boundarySegments: TerrainClipSegment[],
  clipIndex: TerrainClipPolygonIndex,
  pointScratch: ReturnType<typeof createTerrainClipPointQueryScratch>,
  clipTriangleIndex: ClipTriangleIndex,
  clipTriangleScratch: ClipTriangle[],
  bottomElevation: number,
): void {
  if (boundarySegments.some((segment) => segmentCrossesTriangleInterior(segment, triangle))) {
    const candidates = getClipTrianglesForTerrainTriangle(
      clipTriangleIndex,
      triangle,
      clipTriangleScratch,
    );
    for (const candidate of candidates) {
      const points = clipConvexPolygon(triangle, candidate.triangle);
      if (points.length < 3) continue;
      for (let index = 1; index < points.length - 1; index += 1) {
        const first = points[0];
        const second = points[index];
        const third = points[index + 1];
        if (!first || !second || !third) continue;
        const vertices: [Position, Position, Position] = [first, second, third];
        const vertexHeights = vertices.map((point) =>
          barycentricHeight(point, triangle, heights)
        ) as [number, number, number];
        builder.addTopTriangle(vertices.map((point, vertexIndex) => [
          point[0] * 1_000,
          vertexHeights[vertexIndex] ?? 0,
          point[1] * 1_000,
        ]));
      }
      for (let index = 0; index < points.length; index += 1) {
        const start = points[index];
        const end = points[(index + 1) % points.length];
        if (!start || !end || start[0] === end[0] && start[1] === end[1]) continue;
        const midpoint: Position = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        const boundarySegment = boundarySegments.find((segment) =>
          pointOnSegment(start, segment) &&
          pointOnSegment(end, segment) &&
          pointOnSegment(midpoint, segment)
        );
        if (!boundarySegment) continue;
        builder.addWall(
          start,
          end,
          barycentricHeight(start, triangle, heights),
          barycentricHeight(end, triangle, heights),
          bottomElevation,
          boundarySegment,
        );
      }
    }
    return;
  }

  const centroid: Position = [
    (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
    (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
  ];
  if (getTerrainClipPolygonsContainingPoint(clipIndex, centroid, pointScratch).length === 0) {
    return;
  }
  addFullTerrainTriangle(builder, triangle, heights);
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
    const start = triangle[edgeIndex];
    const end = triangle[(edgeIndex + 1) % 3];
    if (!start || !end) continue;
    for (const segment of boundarySegments) {
      const overlap = getCollinearSegmentOverlap(start, end, segment);
      if (!overlap) continue;
      builder.addWall(
        overlap[0],
        overlap[1],
        barycentricHeight(overlap[0], triangle, heights),
        barycentricHeight(overlap[1], triangle, heights),
        bottomElevation,
        segment,
      );
    }
  }
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function createTerrainMesh(options: TerrainExportOptions): Promise<ObjBuilder> {
  const { metadata, center, californiaPolygons, region } = options;
  if (region.polygons.length === 0) throw new Error(`${region.name} does not intersect California.`);
  if (!Number.isFinite(options.resolutionMeters) || options.resolutionMeters <= 0) {
    throw new Error("Terrain export resolution must be greater than zero.");
  }
  if (
    !Number.isFinite(options.californiaLatitudeSpanMeters) ||
    options.californiaLatitudeSpanMeters < TERRAIN_EXPORT_SCALE_MIN_METERS ||
    options.californiaLatitudeSpanMeters > TERRAIN_EXPORT_SCALE_MAX_METERS
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
  const regionBounds = getPolygonsBounds(region.polygons);
  const zoom = getTerrainZoom(metadata, options.resolutionMeters);
  const tiles = getExportTiles(metadata, zoom, regionBounds, center);
  if (tiles.length === 0) {
    throw new Error(`No terrain tiles are available at ${options.resolutionMeters} m resolution.`);
  }

  const clipIndex: TerrainClipPolygonIndex = createTerrainClipPolygonIndex(region.polygons);
  const pointScratch = createTerrainClipPointQueryScratch(clipIndex);
  const builder = new ObjBuilder(horizontalScale, options.verticalExaggeration);
  const bottomElevation = TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS;
  const groundScale = getTerrainGroundScale(center);

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
    const clipPolygons = getRegionTilePolygons(region.polygons, tileBounds);
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
    const clipTriangleIndex = createClipTriangleIndex(tileClipPolygons);
    const clipTriangleScratch: ClipTriangle[] = [];
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
        } else {
          addTriangleWithClipBoundary(
            builder,
            firstTriangle,
            firstHeights,
            boundarySegments,
            clipIndex,
            pointScratch,
            clipTriangleIndex,
            clipTriangleScratch,
            bottomElevation,
          );
          addTriangleWithClipBoundary(
            builder,
            secondTriangle,
            secondHeights,
            boundarySegments,
            clipIndex,
            pointScratch,
            clipTriangleIndex,
            clipTriangleScratch,
            bottomElevation,
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

  builder.addBottomMesh(
    region.polygons,
    bottomElevation,
    options.resolutionMeters,
    groundScale,
  );

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

export async function createTerrainObj(options: TerrainExportOptions): Promise<string> {
  const mesh = await createTerrainMesh(options);
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
