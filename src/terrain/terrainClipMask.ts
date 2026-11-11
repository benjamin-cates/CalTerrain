import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  type Texture,
} from "three";
import type { Position } from "../types";
import {
  createTerrainClipPointQueryScratch,
  createTerrainClipPolygonIndex,
  getTerrainClipPolygonsContainingPoint,
  getTerrainClipSegmentsForTile,
  type TerrainClipPolygonIndex,
  type TerrainClipPointQueryScratch,
  type TerrainClipSegment,
} from "./terrainClipIndex";

const TERRAIN_CLIP_MASK_SIZE = 512;
const MAX_REUSABLE_MASK_TEXTURES = 8;
type TerrainClipMaskScratch = {
  boundarySegments: TerrainClipSegment[];
  pointQuery: TerrainClipPointQueryScratch;
  drawnPolygons: Uint32Array;
  generation: number;
};
const clipMaskScratch = new WeakMap<TerrainClipPolygonIndex, TerrainClipMaskScratch>();
const reusableMaskTextures: CanvasTexture[] = [];
const pendingMaskReleases = new Map<CanvasTexture, number>();

export type TerrainClipMask = {
  texture: Texture;
  ownsTexture: boolean;
};

function makeSolidMaskTexture(value: number): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([value, value, value, value]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.colorSpace = NoColorSpace;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function getClipMaskScratch(index: TerrainClipPolygonIndex): TerrainClipMaskScratch {
  let scratch = clipMaskScratch.get(index);
  if (!scratch) {
    scratch = {
      boundarySegments: [],
      pointQuery: createTerrainClipPointQueryScratch(index),
      drawnPolygons: new Uint32Array(index.polygons.length),
      generation: 0,
    };
    clipMaskScratch.set(index, scratch);
  }
  return scratch;
}

function drawPolygon(
  context: CanvasRenderingContext2D,
  polygons: Position[][][],
  polygonIndex: number,
  drawnPolygons: Uint32Array,
  generation: number,
  tileLeft: number,
  tileTop: number,
  tileSizeKm: number,
): void {
  if (drawnPolygons[polygonIndex] === generation) return;
  drawnPolygons[polygonIndex] = generation;
  const polygon = polygons[polygonIndex];
  if (!polygon) return;
  for (const ring of polygon) {
    const first = ring[0];
    if (!first) continue;
    context.moveTo(
      ((first[0] - tileLeft) / tileSizeKm) * TERRAIN_CLIP_MASK_SIZE,
      ((first[1] - tileTop) / tileSizeKm) * TERRAIN_CLIP_MASK_SIZE,
    );
    for (let index = 1; index < ring.length; index += 1) {
      const point = ring[index];
      if (!point) continue;
      context.lineTo(
        ((point[0] - tileLeft) / tileSizeKm) * TERRAIN_CLIP_MASK_SIZE,
        ((point[1] - tileTop) / tileSizeKm) * TERRAIN_CLIP_MASK_SIZE,
      );
    }
    context.closePath();
  }
}

const EMPTY_MASK_TEXTURE = makeSolidMaskTexture(0);
const FULL_MASK_TEXTURE = makeSolidMaskTexture(255);

function acquireMaskCanvas(): {
  context: CanvasRenderingContext2D;
  texture: CanvasTexture;
} {
  const texture = reusableMaskTextures.pop();
  const canvas = texture
    ? texture.image as HTMLCanvasElement
    : document.createElement("canvas");
  if (!texture) {
    canvas.width = TERRAIN_CLIP_MASK_SIZE;
    canvas.height = TERRAIN_CLIP_MASK_SIZE;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    texture?.dispose();
    throw new Error("Could not create the terrain clip mask canvas.");
  }
  if (texture) {
    context.clearRect(0, 0, TERRAIN_CLIP_MASK_SIZE, TERRAIN_CLIP_MASK_SIZE);
    context.globalCompositeOperation = "source-over";
    return { context, texture };
  }

  const createdTexture = new CanvasTexture(canvas);
  context.globalCompositeOperation = "source-over";
  createdTexture.colorSpace = NoColorSpace;
  createdTexture.minFilter = LinearFilter;
  createdTexture.magFilter = LinearFilter;
  createdTexture.generateMipmaps = false;
  return { context, texture: createdTexture };
}

export function releaseTerrainClipMask(mask: TerrainClipMask): void {
  if (!mask.ownsTexture) return;
  if (!(mask.texture instanceof CanvasTexture)) {
    mask.texture.dispose();
    return;
  }
  const texture = mask.texture;
  const timeout = window.setTimeout(() => {
    pendingMaskReleases.delete(texture);
    if (reusableMaskTextures.length < MAX_REUSABLE_MASK_TEXTURES) {
      reusableMaskTextures.push(texture);
    } else {
      texture.dispose();
    }
  }, 0);
  pendingMaskReleases.set(texture, timeout);
}

export function retainTerrainClipMask(mask: TerrainClipMask): void {
  if (!mask.ownsTexture || !(mask.texture instanceof CanvasTexture)) return;
  const timeout = pendingMaskReleases.get(mask.texture);
  if (timeout !== undefined) {
    window.clearTimeout(timeout);
    pendingMaskReleases.delete(mask.texture);
  }
  const pooledIndex = reusableMaskTextures.indexOf(mask.texture);
  if (pooledIndex >= 0) reusableMaskTextures.splice(pooledIndex, 1);
}

export function createTerrainClipMaskTexture(
  polygons: Position[][][],
  tileLeft: number,
  tileTop: number,
  tileSizeKm: number,
  clipIndex = createTerrainClipPolygonIndex(polygons),
  excludedIndex: TerrainClipPolygonIndex | null = null,
): TerrainClipMask {
  const scratch = getClipMaskScratch(clipIndex);
  const boundarySegments = getTerrainClipSegmentsForTile(
    clipIndex,
    tileLeft,
    tileTop,
    tileSizeKm,
    scratch.boundarySegments,
  );
  const tileCenter: Position = [
    tileLeft + tileSizeKm / 2,
    tileTop + tileSizeKm / 2,
  ];
  const containingPolygons = getTerrainClipPolygonsContainingPoint(
    clipIndex,
    tileCenter,
    scratch.pointQuery,
  );
  if (boundarySegments.length === 0 && containingPolygons.length === 0) {
    return { texture: EMPTY_MASK_TEXTURE, ownsTexture: false };
  }

  const excludedScratch = excludedIndex ? getClipMaskScratch(excludedIndex) : null;
  const excludedBoundarySegments = excludedIndex && excludedScratch
    ? getTerrainClipSegmentsForTile(
      excludedIndex,
      tileLeft,
      tileTop,
      tileSizeKm,
      excludedScratch.boundarySegments,
    )
    : [];
  const excludedContainingPolygons = excludedIndex && excludedScratch
    ? getTerrainClipPolygonsContainingPoint(
      excludedIndex,
      tileCenter,
      excludedScratch.pointQuery,
    )
    : [];
  if (
    excludedBoundarySegments.length === 0 &&
    excludedContainingPolygons.length > 0
  ) {
    return { texture: EMPTY_MASK_TEXTURE, ownsTexture: false };
  }
  if (boundarySegments.length === 0 && excludedBoundarySegments.length === 0) {
    return { texture: FULL_MASK_TEXTURE, ownsTexture: false };
  }

  const { context, texture } = acquireMaskCanvas();
  if (boundarySegments.length === 0) {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, TERRAIN_CLIP_MASK_SIZE, TERRAIN_CLIP_MASK_SIZE);
  } else {
    context.beginPath();
    if (scratch.generation === 0xffff_ffff) {
      scratch.drawnPolygons.fill(0);
      scratch.generation = 1;
    } else {
      scratch.generation += 1;
    }
    for (const polygonNumber of containingPolygons) {
      drawPolygon(
        context,
        clipIndex.polygons,
        polygonNumber,
        scratch.drawnPolygons,
        scratch.generation,
        tileLeft,
        tileTop,
        tileSizeKm,
      );
    }
    for (const segment of boundarySegments) {
      drawPolygon(
        context,
        clipIndex.polygons,
        segment.polygonIndex,
        scratch.drawnPolygons,
        scratch.generation,
        tileLeft,
        tileTop,
        tileSizeKm,
      );
    }
    context.fillStyle = "#fff";
    context.fill("evenodd");
  }

  if (excludedIndex && excludedScratch && excludedBoundarySegments.length > 0) {
    if (excludedScratch.generation === 0xffff_ffff) {
      excludedScratch.drawnPolygons.fill(0);
      excludedScratch.generation = 1;
    } else {
      excludedScratch.generation += 1;
    }
    context.globalCompositeOperation = "destination-out";
    const excludedPolygonNumbers = new Set([
      ...excludedContainingPolygons,
      ...excludedBoundarySegments.map((segment) => segment.polygonIndex),
    ]);
    for (const polygonNumber of excludedPolygonNumbers) {
      context.beginPath();
      drawPolygon(
        context,
        excludedIndex.polygons,
        polygonNumber,
        excludedScratch.drawnPolygons,
        excludedScratch.generation,
        tileLeft,
        tileTop,
        tileSizeKm,
      );
      context.fill("evenodd");
    }
    context.globalCompositeOperation = "source-over";
  }

  texture.needsUpdate = true;
  return { texture, ownsTexture: true };
}
