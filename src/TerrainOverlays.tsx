import { useLoader, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  CanvasTexture,
  DoubleSide,
  SRGBColorSpace,
  Vector2,
  TextureLoader,
} from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import type { Texture } from "three";
import { toLocal, WORLD_METERS } from "./geo";
import {
  createLakeMeshGeometry,
  getLakeShoreElevation,
} from "./features/lakes";
import { regionGeometry } from "./regions/geometry";
import type { RegionHandle } from "./regions/geometry";
import { MOUNTAIN_PEAK_VISIBILITY_DISTANCE_KM, type MountainPeak } from "./features/mountains";
import {
  sampleTerrainMeshElevation,
  TERRAIN_TILE_MESH_SEGMENTS,
  type TerrainElevationRaster,
} from "./terrain/terrainHeight";
import {
  raycastTerrainMeshHit,
  type TerrainRaycast,
} from "./terrain/terrainRaycast";
import {
  applyTerrainLineHeightShader,
  createTerrainShaderUniforms,
  getTerrainHeightTexture,
  type TerrainLineShaderUniforms,
} from "./terrain/terrainShader";
import {
  HIGHWAY_SHIELD_VISIBILITY_DISTANCE_KM,
  highwayShieldStrideForDistance,
  type HighwayShield,
} from "./features/highways";
import type {
  BoundaryCollection,
  MeasurementSystem,
  Position,
  Region,
  RegionOperationPreview,
  Tile,
} from "./types";
import { formatElevation } from "./units";

const OVERLAY_LIFT_KM = 0.01;
const MAX_TERRAIN_LINE_SEGMENTS_PER_TILE = 30_000;
type LineBounds = { minX: number; minZ: number; maxX: number; maxZ: number };
const lineBoundsCache = new WeakMap<Position[], LineBounds>();
const tileLinePositionsCache = new WeakMap<Position[], WeakMap<Tile, number[]>>();
type CachedRegionGeometry = {
  center: Position;
  countyBoundaries: BoundaryCollection;
  rotationHandleOffsetKm: number;
  geometry: ReturnType<typeof regionGeometry>;
};
const regionGeometryCache = new WeakMap<Region, CachedRegionGeometry>();
const MAX_ROUTE_SHIELD_SIZE_KM = 2.5;
const ROUTE_SHIELD_SIZE_PER_DISTANCE = 0.02;
const MOUNTAIN_LABEL_HEIGHT_PER_DISTANCE = 0.02;
const MAX_MOUNTAIN_LABEL_HEIGHT_KM = 3;
const shieldTextures = new Map<string, CanvasTexture>();
const mountainTextures = new Map<string, CanvasTexture>();
const pointElevationTextures = new Map<string, CanvasTexture>();
let pointMarkerTexture: CanvasTexture | null = null;
const POINT_ELEVATION_LABEL_DISTANCE_KM = 800;

export type TerrainDrapedLineLayer = {
  id: string;
  lines: Position[][];
  color: string;
  lineWidth: number;
  opacity: number;
};

function getCachedRegionGeometry(
  region: Region,
  center: Position,
  countyBoundaries: BoundaryCollection,
  rotationHandleOffsetKm: number,
): ReturnType<typeof regionGeometry> {
  const cached = regionGeometryCache.get(region);
  if (
    cached &&
    cached.center === center &&
    cached.countyBoundaries === countyBoundaries &&
    cached.rotationHandleOffsetKm === rotationHandleOffsetKm
  ) return cached.geometry;

  const geometry = regionGeometry(region, center, countyBoundaries, rotationHandleOffsetKm);
  regionGeometryCache.set(region, {
    center,
    countyBoundaries,
    rotationHandleOffsetKm,
    geometry,
  });
  return geometry;
}

function getShieldTexture(shield: HighwayShield): CanvasTexture {
  const key = `${shield.type}/${shield.number}`;
  const cached = shieldTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = shield.type === "highway" ? 80 : 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a route shield canvas.");

  if (shield.type === "highway") {
    context.beginPath();
    const radiusX = shield.number.length > 2 ? 45 : shield.number.length > 1 ? 36 : 38;
    context.ellipse(64, 40, radiusX, 28, 0, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = "#d1d5d8";
    context.stroke();
  } else {
    context.beginPath();
    context.moveTo(17.2, 0);
    context.bezierCurveTo(31, 4.5, 46, 3.5, 64, 0);
    context.bezierCurveTo(82, 3.5, 97, 4.5, 110.8, 0);
    context.bezierCurveTo(122, 14, 128, 31, 128, 49.6);
    context.bezierCurveTo(128, 88.3, 100.8, 119.5, 64, 128);
    context.bezierCurveTo(27.2, 119.5, 0, 88.3, 0, 49.6);
    context.bezierCurveTo(0, 31, 6, 14, 17.2, 0);
    context.closePath();
    context.fillStyle = "#ffffff";
    context.fill();

    context.beginPath();
    context.moveTo(3.2, 49.6);
    context.bezierCurveTo(3.2, 42.8, 3.6, 36.2, 4.5, 29.9);
    context.lineTo(123.5, 29.9);
    context.bezierCurveTo(124.4, 36.2, 124.8, 42.8, 124.8, 49.6);
    context.bezierCurveTo(124.8, 86.8, 98.8, 117.5, 64, 124.7);
    context.bezierCurveTo(29.2, 117.5, 3.2, 86.8, 3.2, 49.6);
    context.closePath();
    context.fillStyle = "#174b87";
    context.fill();

    context.beginPath();
    context.moveTo(6.7, 26.7);
    context.bezierCurveTo(9.3, 18.3, 13.3, 10.6, 18.4, 3.7);
    context.bezierCurveTo(25.5, 5.6, 33, 6.6, 40.6, 6.6);
    context.bezierCurveTo(48.7, 6.6, 56.6, 5.5, 64, 3.3);
    context.bezierCurveTo(71.4, 5.5, 79.3, 6.6, 87.4, 6.6);
    context.bezierCurveTo(95, 6.6, 102.5, 5.6, 109.6, 3.7);
    context.bezierCurveTo(114.7, 10.6, 118.7, 18.3, 121.3, 26.7);
    context.closePath();
    context.fillStyle = "#af1e2d";
    context.fill();
  }

  context.fillStyle = shield.type === "highway" ? "#111111" : "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${shield.number.length > 2 ? 35 : 42}px Arial, sans-serif`;
  context.fillText(
    shield.number,
    64,
    shield.type === "highway" ? 40 : 68,
    90,
  );
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  shieldTextures.set(key, texture);
  return texture;
}

function getMountainTexture(peak: MountainPeak, measurementSystem: MeasurementSystem): CanvasTexture {
  const key = `${peak.id}/${measurementSystem}`;
  const cached = mountainTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a mountain label canvas.");
  const elevationLabel = peak.elevationMeters === undefined
    ? "Elevation unknown"
    : formatElevation(peak.elevationMeters, measurementSystem);
  context.font = "600 24px Arial, sans-serif";
  const nameWidth = context.measureText(peak.name).width;
  context.font = "600 19px Arial, sans-serif";
  const elevationWidth = context.measureText(elevationLabel).width;
  canvas.width = Math.ceil(Math.max(nameWidth, elevationWidth) + 116);

  context.beginPath();
  context.roundRect(2, 2, canvas.width - 4, 92, 16);
  context.fillStyle = "rgba(12, 20, 24, 0.88)";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#21918c";
  context.stroke();

  context.beginPath();
  context.moveTo(18, 75);
  context.lineTo(48, 19);
  context.lineTo(78, 75);
  context.closePath();
  context.fillStyle = "#21918c";
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = "#e8f4dc";
  context.stroke();

  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.font = "600 24px Arial, sans-serif";
  context.fillText(peak.name, 98, 39);
  context.fillStyle = "#21918c";
  context.font = "600 19px Arial, sans-serif";
  context.fillText(elevationLabel, 98, 69);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  mountainTextures.set(key, texture);
  return texture;
}

function getPointElevationTexture(
  elevationMeters: number,
  measurementSystem: MeasurementSystem,
): CanvasTexture {
  const label = formatElevation(elevationMeters, measurementSystem);
  const key = `${measurementSystem}/${label}`;
  const cached = pointElevationTextures.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 176;
  canvas.height = 56;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a custom point elevation label.");
  context.font = "600 28px Arial, sans-serif";
  canvas.width = Math.max(176, Math.ceil(context.measureText(label).width + 44));
  context.beginPath();
  context.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 14);
  context.fillStyle = "rgba(12, 20, 24, 0.9)";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#21918c";
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = "600 28px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  pointElevationTextures.set(key, texture);
  return texture;
}

function getPointMarkerTexture(): CanvasTexture {
  if (pointMarkerTexture) return pointMarkerTexture;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a custom point marker.");
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fillStyle = "#101816";
  context.fill();
  context.beginPath();
  context.arc(32, 32, 21, 0, Math.PI * 2);
  context.fillStyle = "#21918c";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#e8f4dc";
  context.stroke();

  pointMarkerTexture = new CanvasTexture(canvas);
  pointMarkerTexture.colorSpace = SRGBColorSpace;
  pointMarkerTexture.needsUpdate = true;
  return pointMarkerTexture;
}

function CustomPointMarker({
  position,
  elevationMeters,
  verticalExaggeration,
  cameraDistance,
  measurementSystem,
}: {
  position: Position;
  elevationMeters: number;
  verticalExaggeration: number;
  cameraDistance: number;
  measurementSystem: MeasurementSystem;
}) {
  const texture = useMemo(
    () => getPointElevationTexture(elevationMeters, measurementSystem),
    [elevationMeters, measurementSystem],
  );
  const markerTexture = useMemo(() => getPointMarkerTexture(), []);
  const groundHeight = elevationMeters * verticalExaggeration / 1_000;
  const markerSize = Math.max(0.175, Math.min(15, cameraDistance * 0.00375));
  const labelHeight = cameraDistance * 0.015;
  return (
    <>
      <sprite
        center={[0.5, 0.5]}
        position={[position[0], groundHeight + OVERLAY_LIFT_KM, position[1]]}
        scale={[markerSize, markerSize, 1]}
        renderOrder={7}
      >
        <spriteMaterial map={markerTexture} transparent depthTest={false} />
      </sprite>
      {cameraDistance <= POINT_ELEVATION_LABEL_DISTANCE_KM && (
        <sprite
          center={[0.5, 0]}
          position={[
            position[0],
            groundHeight + OVERLAY_LIFT_KM + markerSize * 0.5 + labelHeight * 0.3,
            position[1],
          ]}
          scale={[labelHeight * texture.image.width / texture.image.height, labelHeight, 1]}
          renderOrder={8}
        >
          <spriteMaterial map={texture} transparent depthTest={false} />
        </sprite>
      )}
    </>
  );
}

function MountainPeakMarker({
  peak,
  position,
  elevationMeters,
  verticalExaggeration,
  cameraDistance,
  measurementSystem,
}: {
  peak: MountainPeak;
  position: Position;
  elevationMeters: number;
  verticalExaggeration: number;
  cameraDistance: number;
  measurementSystem: MeasurementSystem;
}) {
  const texture = useMemo(
    () => getMountainTexture(peak, measurementSystem),
    [measurementSystem, peak],
  );
  const height = elevationMeters * verticalExaggeration / 1_000 + 0.1;
  const labelHeight = Math.min(
    MAX_MOUNTAIN_LABEL_HEIGHT_KM,
    cameraDistance * MOUNTAIN_LABEL_HEIGHT_PER_DISTANCE,
  );
  const labelAspect = texture.image.width / texture.image.height;
  return (
    <sprite
      center={[0, 0.5]}
      position={[position[0], height, position[1]]}
      scale={[labelHeight * labelAspect, labelHeight, 1]}
      renderOrder={6}
    >
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function RouteShieldMarker({
  shield,
  height,
  cameraDistance,
}: {
  shield: HighwayShield;
  height: number;
  cameraDistance: number;
}) {
  const texture = useMemo(() => getShieldTexture(shield), [shield.number, shield.type]);
  const size = Math.min(
    MAX_ROUTE_SHIELD_SIZE_KM,
    cameraDistance * ROUTE_SHIELD_SIZE_PER_DISTANCE,
  );
  const scale: [number, number, number] = shield.type === "highway"
    ? [size * 1.35, size * 0.78, 1]
    : [size, size, 1];
  return (
    <sprite
      position={[shield.position[0], height + OVERLAY_LIFT_KM, shield.position[1]]}
      scale={scale}
      renderOrder={6}
    >
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function decodeElevationRaster(texture: Texture): TerrainElevationRaster {
  const image = texture.image as HTMLImageElement;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    throw new Error("Could not read the terrain elevation texture for region overlays.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

function clipSegmentToTile(
  start: Position,
  end: Position,
  left: number,
  top: number,
  right: number,
  bottom: number,
  result: Float64Array,
): boolean {
  const startX = start[0];
  const startZ = start[1];
  const deltaX = end[0] - startX;
  const deltaZ = end[1] - startZ;
  const endX = end[0];
  const endZ = end[1];

  if (
    Math.max(startX, endX) < left ||
    Math.min(startX, endX) > right ||
    Math.max(startZ, endZ) < top ||
    Math.min(startZ, endZ) > bottom
  ) {
    return false;
  }

  if (
    startX >= left && startX <= right &&
    startZ >= top && startZ <= bottom &&
    endX >= left && endX <= right &&
    endZ >= top && endZ <= bottom
  ) {
    result[0] = startX;
    result[1] = startZ;
    result[2] = endX;
    result[3] = endZ;
    return true;
  }

  let startT = 0;
  let endT = 1;

  if (deltaX === 0) {
    if (startX < left || startX > right) return false;
  } else if (deltaX > 0) {
    startT = Math.max(startT, (left - startX) / deltaX);
    endT = Math.min(endT, (right - startX) / deltaX);
  } else {
    startT = Math.max(startT, (right - startX) / deltaX);
    endT = Math.min(endT, (left - startX) / deltaX);
  }
  if (startT > endT) return false;

  if (deltaZ === 0) {
    if (startZ < top || startZ > bottom) return false;
  } else if (deltaZ > 0) {
    startT = Math.max(startT, (top - startZ) / deltaZ);
    endT = Math.min(endT, (bottom - startZ) / deltaZ);
  } else {
    startT = Math.max(startT, (bottom - startZ) / deltaZ);
    endT = Math.min(endT, (top - startZ) / deltaZ);
  }
  if (startT > endT) return false;

  result[0] = startX + startT * deltaX;
  result[1] = startZ + startT * deltaZ;
  result[2] = startX + endT * deltaX;
  result[3] = startZ + endT * deltaZ;
  return true;
}

function getLineBounds(line: Position[]): LineBounds {
  const cachedBounds = lineBoundsCache.get(line);
  if (cachedBounds) return cachedBounds;

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of line) {
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  const bounds = { minX, minZ, maxX, maxZ };
  lineBoundsCache.set(line, bounds);
  return bounds;
}

function getTileLinePositions(
  line: Position[],
  bounds: LineBounds,
  tile: Tile,
  left: number,
  top: number,
  right: number,
  bottom: number,
  tileSizeKm: number,
): number[] {
  let positionsByTile = tileLinePositionsCache.get(line);
  const cachedPositions = positionsByTile?.get(tile);
  if (cachedPositions) return cachedPositions;

  const positions: number[] = [];
  if (
    bounds.maxX >= left && bounds.minX <= right &&
    bounds.maxZ >= top && bounds.minZ <= bottom
  ) {
    const clipped = new Float64Array(4);
    const addSegment = (startX: number, startZ: number, endX: number, endZ: number) => {
      positions.push(startX, 0, startZ, endX, 0, endZ);
    };
    let segmentBudget = MAX_TERRAIN_LINE_SEGMENTS_PER_TILE;
    for (let index = 1; index < line.length && segmentBudget > 0; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (!start || !end || !clipSegmentToTile(start, end, left, top, right, bottom, clipped)) {
        continue;
      }
      const fromX = clipped[0]!;
      const fromZ = clipped[1]!;
      const toX = clipped[2]!;
      const toZ = clipped[3]!;
      const length = Math.hypot(toX - fromX, toZ - fromZ);
      const segmentCount = Math.min(
        segmentBudget,
        Math.max(1, Math.ceil(length / (tileSizeKm / TERRAIN_TILE_MESH_SEGMENTS))),
      );
      for (let step = 0; step < segmentCount; step += 1) {
        const startT = step / segmentCount;
        const endT = (step + 1) / segmentCount;
        addSegment(
          fromX + (toX - fromX) * startT,
          fromZ + (toZ - fromZ) * startT,
          fromX + (toX - fromX) * endT,
          fromZ + (toZ - fromZ) * endT,
        );
      }
      segmentBudget -= segmentCount;
    }
  }

  if (!positionsByTile) {
    positionsByTile = new WeakMap();
    tileLinePositionsCache.set(line, positionsByTile);
  }
  positionsByTile.set(tile, positions);
  return positions;
}

function makeTileLineGeometry(
  lines: Position[][],
  center: Position,
  tile: Tile,
): LineSegmentsGeometry {
  const tileSize = WORLD_METERS / 2 ** tile.z;
  const tileSizeKm = tileSize / 1_000;
  const left = (tile.x * tileSize - WORLD_METERS / 2 - center[0]) / 1_000;
  const top = -((WORLD_METERS / 2 - tile.y * tileSize - center[1]) / 1_000);
  const right = left + tileSizeKm;
  const bottom = top + tileSizeKm;
  const positions: number[] = [];
  let segmentBudget = MAX_TERRAIN_LINE_SEGMENTS_PER_TILE;
  for (const line of lines) {
    if (segmentBudget === 0) break;
    const bounds = getLineBounds(line);
    if (
      !bounds ||
      bounds.maxX < left || bounds.minX > right ||
      bounds.maxZ < top || bounds.minZ > bottom
    ) continue;
    const linePositions = getTileLinePositions(
      line,
      bounds,
      tile,
      left,
      top,
      right,
      bottom,
      tileSizeKm,
    );
    const positionCount = Math.min(linePositions.length, segmentBudget * 6);
    for (let index = 0; index < positionCount; index += 1) {
      const position = linePositions[index];
      if (position !== undefined) positions.push(position);
    }
    segmentBudget -= positionCount / 6;
  }

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  return geometry;
}

function TerrainDrapedLineTile({
  lines,
  center,
  tile,
  texture,
  verticalExaggeration,
  color,
  lineWidth,
  opacity,
}: {
  lines: Position[][];
  center: Position;
  tile: Tile;
  texture: Texture;
  verticalExaggeration: number;
  color: string;
  lineWidth: number;
  opacity: number;
}) {
  const { size } = useThree();
  const tileSize = WORLD_METERS / 2 ** tile.z;
  const tileSizeKm = tileSize / 1_000;
  const tileLeft = (tile.x * tileSize - WORLD_METERS / 2 - center[0]) / 1_000;
  const tileTop = -((WORLD_METERS / 2 - tile.y * tileSize - center[1]) / 1_000);
  const geometry = useMemo(
    () => makeTileLineGeometry(lines, center, tile),
    [center, lines, tile],
  );
  const heightTexture = useMemo(() => getTerrainHeightTexture(texture), [texture]);
  const uniforms = useMemo<TerrainLineShaderUniforms>(
    () => ({
      ...createTerrainShaderUniforms(heightTexture, tileSizeKm, verticalExaggeration),
      uTerrainTileOrigin: { value: new Vector2(tileLeft, tileTop) },
    }),
    [heightTexture, tileLeft, tileSizeKm, tileTop],
  );
  uniforms.uTerrainExaggeration.value = verticalExaggeration;
  const line = useMemo(() => {
    const material = new LineMaterial({
      color,
      linewidth: lineWidth,
      transparent: true,
      opacity,
      depthTest: false,
      resolution: new Vector2(size.width, size.height),
    });
    material.onBeforeCompile = (shader) => applyTerrainLineHeightShader(shader, uniforms);
    material.customProgramCacheKey = () => "terrain-line-bicubic-height-v1";
    const object = new LineSegments2(geometry, material);
    object.renderOrder = 4;
    return object;
  }, [color, geometry, lineWidth, opacity, size.height, size.width, uniforms]);
  useEffect(() => () => {
    geometry.dispose();
    line.material.dispose();
  }, [geometry, line]);
  if ((geometry.getAttribute("instanceStart")?.count ?? 0) === 0) return null;
  return <primitive object={line} />;
}

export function TerrainOverlays({
  mapRegions,
  selectedRegionId,
  regionOperationPreview,
  center,
  countyBoundaries,
  drapedLineLayers,
  lakes,
  selectedLakeIds,
  highwayRouteShields,
  mountainPeaks,
  showMountainPeaks,
  cameraTarget,
  showHighways,
  showInterstates,
  cameraDistance,
  verticalExaggeration,
  measurementSystem,
  terrainTiles,
  onRegionHandlesChange,
  onRegionPointElevationChange,
  onTerrainRaycastReady,
}: {
  mapRegions: Region[];
  selectedRegionId: string | null;
  regionOperationPreview: RegionOperationPreview | null;
  center: Position;
  countyBoundaries: BoundaryCollection;
  drapedLineLayers: TerrainDrapedLineLayer[];
  lakes: BoundaryCollection | null;
  selectedLakeIds: string[];
  highwayRouteShields: HighwayShield[];
  mountainPeaks: MountainPeak[];
  showMountainPeaks: boolean;
  cameraTarget: Position;
  showHighways: boolean;
  showInterstates: boolean;
  cameraDistance: number;
  verticalExaggeration: number;
  measurementSystem: MeasurementSystem;
  terrainTiles: Tile[];
  onRegionHandlesChange: (handles: RegionHandle[]) => void;
  onRegionPointElevationChange: (id: string, elevationMeters: number) => void;
  onTerrainRaycastReady: (raycast: TerrainRaycast | null) => void;
}) {
  const terrainTileUrls = terrainTiles.map((tile) => `/data/terrain/tiles/${tile.z}/${tile.x}/${tile.y}.webp`);
  const loadedTerrainTextures = useLoader(TextureLoader, terrainTileUrls);
  const terrainTexturesByTile = useMemo(
    () => new Map<string, Texture>(terrainTiles.flatMap((tile, index) => {
      const texture = loadedTerrainTextures[index];
      return texture ? [[`${tile.z}/${tile.x}/${tile.y}`, texture] as const] : [];
    })),
    [loadedTerrainTextures, terrainTiles],
  );
  const elevationRasterCache = useMemo(
    () => new Map<string, TerrainElevationRaster>(),
    [terrainTexturesByTile],
  );
  const getElevationRaster = useMemo(() => (tile: Tile) => {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    const cached = elevationRasterCache.get(key);
    if (cached) return cached;
    const texture = terrainTexturesByTile.get(key);
    if (!texture) return null;
    const raster = decodeElevationRaster(texture);
    elevationRasterCache.set(key, raster);
    return raster;
  }, [elevationRasterCache, terrainTexturesByTile]);
  const sampleTerrainElevation = useMemo(() => {
    const orderedTiles = [...terrainTiles].sort((left, right) => right.z - left.z);

    return (position: Position): number | null => {
      const mercatorX = center[0] + position[0] * 1_000;
      const mercatorY = center[1] - position[1] * 1_000;
      for (const tile of orderedTiles) {
        const tileSize = WORLD_METERS / 2 ** tile.z;
        const tileX = Math.floor((mercatorX + WORLD_METERS / 2) / tileSize);
        const tileY = Math.floor((WORLD_METERS / 2 - mercatorY) / tileSize);
        if (tile.x !== tileX || tile.y !== tileY) continue;

        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const raster = getElevationRaster(tile);
        if (!raster) throw new Error(`Missing elevation texture for tile ${key}.`);

        const gridX = ((mercatorX + WORLD_METERS / 2) / tileSize - tileX) * TERRAIN_TILE_MESH_SEGMENTS;
        const gridY = ((WORLD_METERS / 2 - mercatorY) / tileSize - tileY) * TERRAIN_TILE_MESH_SEGMENTS;
        return sampleTerrainMeshElevation(raster, gridX, gridY, TERRAIN_TILE_MESH_SEGMENTS, true);
      }
      return null;
    };
  }, [center, getElevationRaster, terrainTiles]);
  const lakeMeshes = useMemo(() => {
    if (!lakes || selectedLakeIds.length === 0) return [];
    const selectedIds = new Set(selectedLakeIds);
    return lakes.features.flatMap((feature) => {
      const id = String(feature.properties.GlobalID ?? "").trim();
      if (!selectedIds.has(id)) return [];
      const shoreElevation = getLakeShoreElevation(feature, center, sampleTerrainElevation);
      if (shoreElevation === null) return [];
      const geometry = createLakeMeshGeometry(
        feature,
        center,
        shoreElevation,
        verticalExaggeration,
      );
      return geometry ? [{ id, geometry }] : [];
    });
  }, [center, lakes, sampleTerrainElevation, selectedLakeIds, verticalExaggeration]);
  useEffect(() => () => {
    lakeMeshes.forEach(({ geometry }) => geometry.dispose());
  }, [lakeMeshes]);
  const raycastTerrainMesh = useMemo<TerrainRaycast>(
    () => (ray, verticalExaggeration) =>
      raycastTerrainMeshHit(ray, terrainTiles, center, verticalExaggeration, getElevationRaster),
    [center, getElevationRaster, terrainTiles],
  );
  useEffect(() => {
    onTerrainRaycastReady(raycastTerrainMesh);
    return () => onTerrainRaycastReady(null);
  }, [onTerrainRaycastReady, raycastTerrainMesh]);

  const regionOverlays = useMemo(() => mapRegions
    .filter((region) => !regionOperationPreview?.hiddenRegionIds.includes(region.id))
    .filter((region) =>
      region.visible !== false ||
      regionOperationPreview?.highlightedRegionIds.includes(region.id)
    )
    .filter((region) => region.type !== "county" || region.id === selectedRegionId)
    .map((region) => ({
      region,
      ...getCachedRegionGeometry(
        region,
        center,
        countyBoundaries,
        Math.max(1.5, cameraDistance * 0.012),
      ),
    })), [center, countyBoundaries, cameraDistance, mapRegions, selectedRegionId, regionOperationPreview]);
  const operationPreviewLinesLocal = useMemo(
    () => (regionOperationPreview?.lines ?? [])
      .map((line) => line.map((position) => toLocal(position, center))),
    [center, regionOperationPreview],
  );
  const operationPreviewMarkersLocal = useMemo(
    () => (regionOperationPreview?.markerPositions ?? []).map((position, index) => {
      const localPosition = toLocal(position, center);
      return {
        id: index,
        position: localPosition,
        height: (sampleTerrainElevation(localPosition) ?? 0) * verticalExaggeration / 1_000 + OVERLAY_LIFT_KM,
      };
    }),
    [center, verticalExaggeration, sampleTerrainElevation, regionOperationPreview],
  );
  const regionHandlePositions = useMemo(() => regionOverlays
    .filter(({ region }) =>
      region.id === selectedRegionId &&
      !regionOperationPreview?.hiddenHandleIds.includes(region.id)
    )
    .flatMap(({ handles: regionHandles }) => regionHandles.map((handle) => ({
      ...handle,
      height: (sampleTerrainElevation(handle.position) ?? 0) * verticalExaggeration / 1_000 + OVERLAY_LIFT_KM,
    }))), [verticalExaggeration, regionOverlays, sampleTerrainElevation, selectedRegionId, regionOperationPreview]);
  const customPointRegions = useMemo(() => mapRegions.flatMap((region) => {
    if (region.type !== "point") return [];
    const position = toLocal(region.position, center);
    return [{
      region,
      position,
      sampledElevation: sampleTerrainElevation(position),
    }];
  }), [center, mapRegions, sampleTerrainElevation]);
  useEffect(() => {
    for (const { region, sampledElevation } of customPointRegions) {
      if (sampledElevation !== null && sampledElevation !== region.elevationMeters) {
        onRegionPointElevationChange(region.id, sampledElevation);
      }
    }
  }, [customPointRegions, onRegionPointElevationChange]);
  const visiblePointRegions = customPointRegions.filter(({ region }) => region.visible !== false);
  const visibleHighwayShields = useMemo(() => {
    if (cameraDistance > HIGHWAY_SHIELD_VISIBILITY_DISTANCE_KM) return [];
    const visibleRadius = cameraDistance * 0.6;
    const spacingStride = highwayShieldStrideForDistance(cameraDistance);
    return highwayRouteShields.filter((shield) =>
      (shield.type === "highway" ? showHighways : showInterstates) &&
      shield.spacingIndex % spacingStride === 0 &&
      Math.hypot(
        shield.position[0] - cameraTarget[0],
        shield.position[1] - cameraTarget[1],
      ) <= visibleRadius
    );
  }, [cameraDistance, highwayRouteShields, showHighways, showInterstates, cameraTarget]);
  const visibleMountainPeaks = useMemo(() => {
    if (!showMountainPeaks || cameraDistance > MOUNTAIN_PEAK_VISIBILITY_DISTANCE_KM) return [];
    const visibleRadius = cameraDistance * 0.6;
    return mountainPeaks.flatMap((peak) => {
      const position = toLocal(peak.position, center);
      return Math.hypot(
        position[0] - cameraTarget[0],
        position[1] - cameraTarget[1],
      ) <= visibleRadius
        ? [{
          peak,
          position,
          elevationMeters: peak.elevationMeters ?? sampleTerrainElevation(position) ?? 0,
        }]
        : [];
    });
  }, [center, cameraDistance, mountainPeaks, sampleTerrainElevation, showMountainPeaks, cameraTarget]);
  useEffect(() => {
    onRegionHandlesChange(regionHandlePositions);
    return () => onRegionHandlesChange([]);
  }, [regionHandlePositions, onRegionHandlesChange]);

  return (
    <group>
      {lakeMeshes.map(({ id, geometry }) => (
        <mesh key={id} geometry={geometry} frustumCulled={false} renderOrder={1}>
          <meshBasicMaterial
            color="#73c9e8"
            transparent
            depthTest
            depthWrite
            side={DoubleSide}
          />
        </mesh>
      ))}
      {regionOverlays.map(({ region, lines }) => (
        terrainTiles.map((tile) => {
          const texture = terrainTexturesByTile.get(`${tile.z}/${tile.x}/${tile.y}`);
          if (!texture) return null;
          return (
            <TerrainDrapedLineTile
              key={`${region.id}-${tile.z}/${tile.x}/${tile.y}`}
              lines={lines}
              center={center}
              tile={tile}
              texture={texture}
              verticalExaggeration={verticalExaggeration}
              color={regionOperationPreview?.highlightedRegionIds.includes(region.id)
                ? "#f5c66f"
                : "#21918c"}
              lineWidth={regionOperationPreview?.highlightedRegionIds.includes(region.id)
                ? 4.5
                : region.id === selectedRegionId ? 3.5 : 2.5}
              opacity={regionOperationPreview?.highlightedRegionIds.includes(region.id) ? 1 : 0.95}
            />
          );
        })
      ))}
      {operationPreviewLinesLocal.flatMap((lines, index) => terrainTiles.map((tile) => {
        const texture = terrainTexturesByTile.get(`${tile.z}/${tile.x}/${tile.y}`);
        if (!texture) return null;
        return (
          <TerrainDrapedLineTile
            key={`shape-operation-preview-${index}-${tile.z}/${tile.x}/${tile.y}`}
            lines={[lines]}
            center={center}
            tile={tile}
            texture={texture}
            verticalExaggeration={verticalExaggeration}
            color={regionOperationPreview?.lineColor ?? "#d58cff"}
            lineWidth={regionOperationPreview?.lineWidth ?? 5}
            opacity={1}
          />
        );
      }))}
      {operationPreviewMarkersLocal.map((marker) => (
        <mesh
          key={`shape-operation-endpoint-${marker.id}`}
          position={[marker.position[0], marker.height, marker.position[1]]}
          renderOrder={7}
        >
          <sphereGeometry args={[Math.max(0.15, cameraDistance * 0.008), 18, 14]} />
          <meshBasicMaterial
            color={regionOperationPreview?.lineColor ?? "#ffda45"}
            depthTest={false}
            transparent
            opacity={1}
          />
        </mesh>
      ))}
      {drapedLineLayers.flatMap((layer) => terrainTiles.map((tile) => {
        const texture = terrainTexturesByTile.get(`${tile.z}/${tile.x}/${tile.y}`);
        if (!texture) return null;
        return (
          <TerrainDrapedLineTile
            key={`${layer.id}-${tile.z}/${tile.x}/${tile.y}`}
            lines={layer.lines}
            center={center}
            tile={tile}
            texture={texture}
            verticalExaggeration={verticalExaggeration}
            color={layer.color}
            lineWidth={layer.lineWidth}
            opacity={layer.opacity}
          />
        );
      }))}
      {visibleHighwayShields.map((shield) => (
        <RouteShieldMarker
          key={shield.id}
          shield={shield}
          height={(sampleTerrainElevation(shield.position) ?? 0) * verticalExaggeration / 1_000}
          cameraDistance={cameraDistance}
        />
      ))}
      {visiblePointRegions.map(({ region, position, sampledElevation }) => (
        <CustomPointMarker
          key={region.id}
          position={position}
          elevationMeters={sampledElevation ?? region.elevationMeters ?? 0}
          verticalExaggeration={verticalExaggeration}
          cameraDistance={cameraDistance}
          measurementSystem={measurementSystem}
        />
      ))}
      {visibleMountainPeaks.map(({ peak, position, elevationMeters }) => (
        <MountainPeakMarker
          key={peak.id}
          peak={peak}
          position={position}
          elevationMeters={elevationMeters}
          verticalExaggeration={verticalExaggeration}
          cameraDistance={cameraDistance}
          measurementSystem={measurementSystem}
        />
      ))}
      {regionOverlays.filter(({ region }) => region.id === selectedRegionId).flatMap(({ region }) => {
        const handlesForRegion = regionHandlePositions.filter((handle) => handle.id === region.id);
        return handlesForRegion.map((handle) => (
          <mesh key={`${handle.kind}-${handle.index ?? 0}`}
            position={[handle.position[0], handle.height ?? OVERLAY_LIFT_KM, handle.position[1]]}
            renderOrder={5}>
            <sphereGeometry args={[Math.max(0.12, cameraDistance * 0.008), 16, 12]} />
            <meshBasicMaterial
              color={(region.type === "polygon" || region.type === "polyline") &&
                handle.kind === "center"
                ? "#f5c66f"
                : handle.kind === "size" || handle.kind === "axis-width"
                  ? "#ffffff"
                  : "#21918c"}
              depthTest={false}
              transparent
              opacity={0.98}
            />
          </mesh>
        ));
      })}
    </group>
  );
}
