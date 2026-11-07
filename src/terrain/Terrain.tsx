import { useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  Color,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  PlaneGeometry,
  Texture,
  TextureLoader,
  Vector3,
} from "three";
import { WORLD_METERS } from "../geo";
import type { Position } from "../types";
import {
  createTerrainClipMaskTexture,
  retainTerrainClipMask,
  releaseTerrainClipMask,
} from "./terrainClipMask";
import {
  createTerrainClipPolygonIndex,
  type TerrainClipPolygonIndex,
} from "./terrainClipIndex";
import {
  createTerrainDepthMaterial,
  createTerrainShaderUniforms,
  createTerrainStandardMaterial,
  getTerrainHeightTexture,
} from "./terrainShader";
import { makeTerrainSkirtGeometry } from "./terrainSkirts";
import { TERRAIN_TILE_MESH_SEGMENTS } from "./terrainHeight";
import {
  getTerrainHeightPaletteStops,
  type TerrainEmissivePalette,
} from "./terrainHeightPalette";

const textureCleanupTimers = new Map<string, number>();
const terrainGeometries = new Map<number, BufferGeometry>();

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function retainTerrainTexture(source: string): void {
  const timer = textureCleanupTimers.get(source);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    textureCleanupTimers.delete(source);
  }
}

function releaseTerrainTexture(source: string, texture: Texture): void {
  const timer = window.setTimeout(() => {
    if (textureCleanupTimers.get(source) !== timer) return;
    useLoader.clear(TextureLoader, source);
    texture.dispose();
    textureCleanupTimers.delete(source);
  }, 1_000);
  textureCleanupTimers.set(source, timer);
}

function makeTerrainGeometry(
  tileSizeKm: number,
): BufferGeometry {
  const geometry = new PlaneGeometry(
    tileSizeKm,
    tileSizeKm,
    TERRAIN_TILE_MESH_SEGMENTS,
    TERRAIN_TILE_MESH_SEGMENTS,
  );
  geometry.rotateX(-Math.PI / 2);
  geometry.setAttribute(
    "terrainSkirt",
    new Float32BufferAttribute(
      new Float32Array(geometry.getAttribute("position")?.count ?? 0),
      1,
    ),
  );
  return geometry;
}

function getTerrainGeometry(tileSizeKm: number): BufferGeometry {
  let geometry = terrainGeometries.get(tileSizeKm);
  if (!geometry) {
    geometry = makeTerrainGeometry(tileSizeKm);
    terrainGeometries.set(tileSizeKm, geometry);
  }
  return geometry;
}

function TerrainTile({
  center,
  tile,
  texture,
  exaggeration,
  heightPalette,
  terrainEmissiveColor,
  terrainGradientLowColor,
  terrainGradientHighColor,
  onTerrainChange,
  clipPolygons,
  clipIndex,
}: {
  center: Position;
  tile: { z: number; x: number; y: number };
  texture: Texture;
  exaggeration: number;
  heightPalette: TerrainEmissivePalette;
  terrainEmissiveColor: string;
  terrainGradientLowColor: string;
  terrainGradientHighColor: string;
  onTerrainChange: () => void;
  clipPolygons: Position[][][];
  clipIndex: TerrainClipPolygonIndex;
}) {
  const image = `/data/terrain/tiles/${tile.z}/${tile.x}/${tile.y}.webp`;
  const tileSize = WORLD_METERS / 2 ** tile.z;
  const tileSizeKm = tileSize / 1_000;
  const minX = tile.x * tileSize - WORLD_METERS / 2;
  const maxY = WORLD_METERS / 2 - tile.y * tileSize;
  const tileLeft = (minX - center[0]) / 1_000;
  const tileTop = -((maxY - center[1]) / 1_000);
  const position: Position = [
    (minX + tileSize / 2 - center[0]) / 1_000,
    -((maxY - tileSize / 2) - center[1]) / 1_000,
  ];
  const geometry = useMemo(() => getTerrainGeometry(tileSizeKm), [tileSizeKm]);
  const clipMask = useMemo(
    () => createTerrainClipMaskTexture(
      clipPolygons,
      tileLeft,
      tileTop,
      tileSizeKm,
      clipIndex,
    ),
    [clipIndex, clipPolygons, tileLeft, tileSizeKm, tileTop],
  );
  const skirtGeometry = useMemo(
    () => makeTerrainSkirtGeometry(
      clipPolygons,
      tileLeft,
      tileTop,
      tileSizeKm,
      TERRAIN_TILE_MESH_SEGMENTS,
      clipIndex,
    ),
    [clipIndex, clipPolygons, tileLeft, tileSizeKm, tileTop],
  );
  const heightTexture = useMemo(() => getTerrainHeightTexture(texture), [texture]);
  const heightUniforms = useMemo(
    () => createTerrainShaderUniforms(heightTexture, tileSizeKm, exaggeration),
    [heightTexture, tileSizeKm],
  );
  heightUniforms.uTerrainExaggeration.value = exaggeration;
  const solidColor = useMemo(() => new Color(terrainEmissiveColor), [terrainEmissiveColor]);
  const gradientLowColor = useMemo(
    () => new Color(terrainGradientLowColor),
    [terrainGradientLowColor],
  );
  const gradientHighColor = useMemo(
    () => new Color(terrainGradientHighColor),
    [terrainGradientHighColor],
  );
  const shaderPalette = useMemo(() => {
    const paletteStops = heightPalette === "custom"
      ? [gradientLowColor, gradientHighColor].map((color) => new Vector3(
        linearToSrgb(color.r),
        linearToSrgb(color.g),
        linearToSrgb(color.b),
      ))
      : getTerrainHeightPaletteStops(
        heightPalette === "solid" ? "grayscale" : heightPalette,
      ).map(([red, green, blue]) => new Vector3(red / 255, green / 255, blue / 255));
    const lastStop = paletteStops[paletteStops.length - 1];
    if (!lastStop) throw new Error(`Height palette ${heightPalette} has no color stops.`);
    const paddedStops = [...paletteStops];
    while (paddedStops.length < 7) paddedStops.push(lastStop.clone());
    return { stops: paddedStops, count: paletteStops.length };
  }, [gradientHighColor, gradientLowColor, heightPalette]);
  const paletteUniforms = useMemo(() => ({
    uTerrainPaletteStops: { value: Array.from({ length: 7 }, () => new Vector3()) },
    uTerrainPaletteStopCount: { value: 2 },
    uTerrainPaletteLinearInterpolation: { value: 0 },
    uTerrainPaletteSolid: { value: 0 },
    uTerrainSolidColor: { value: new Vector3(1, 1, 1) },
  }), []);
  paletteUniforms.uTerrainPaletteStops.value = shaderPalette.stops;
  paletteUniforms.uTerrainPaletteStopCount.value = shaderPalette.count;
  paletteUniforms.uTerrainPaletteLinearInterpolation.value =
    heightPalette === "rainbow" || heightPalette === "custom" ? 1 : 0;
  paletteUniforms.uTerrainPaletteSolid.value = heightPalette === "solid" ? 1 : 0;
  paletteUniforms.uTerrainSolidColor.value.set(solidColor.r, solidColor.g, solidColor.b);
  const terrainUniforms = useMemo(
    () => ({
      ...heightUniforms,
      ...paletteUniforms,
      uTerrainClipMask: { value: clipMask.texture },
      uTerrainClipMaskEnabled: { value: 1 },
    }),
    [clipMask.texture, heightUniforms, paletteUniforms],
  );
  const skirtUniforms = useMemo(
    () => ({
      ...terrainUniforms,
      uTerrainClipMaskEnabled: { value: 0 },
    }),
    [terrainUniforms],
  );

  const terrainMaterial = useMemo(
    () => createTerrainStandardMaterial(
      texture,
      terrainUniforms,
      FrontSide,
      true,
    ),
    [terrainUniforms, texture],
  );
  const skirtMaterial = useMemo(
    () => createTerrainStandardMaterial(
      texture,
      skirtUniforms,
      DoubleSide,
      false,
    ),
    [skirtUniforms, texture],
  );
  const terrainDepthMaterial = useMemo(
    () => createTerrainDepthMaterial(texture, terrainUniforms),
    [terrainUniforms, texture],
  );
  const skirtDepthMaterial = useMemo(
    () => createTerrainDepthMaterial(texture, skirtUniforms),
    [skirtUniforms, texture],
  );

  useEffect(() => {
    retainTerrainTexture(image);
    return () => releaseTerrainTexture(image, texture);
  }, [image, texture]);
  useEffect(
    () => {
      retainTerrainClipMask(clipMask);
      return () => releaseTerrainClipMask(clipMask);
    },
    [clipMask],
  );
  useEffect(() => () => skirtGeometry.dispose(), [skirtGeometry]);
  useEffect(() => () => terrainMaterial.dispose(), [terrainMaterial]);
  useEffect(() => () => skirtMaterial.dispose(), [skirtMaterial]);
  useEffect(() => () => terrainDepthMaterial.dispose(), [terrainDepthMaterial]);
  useEffect(() => () => skirtDepthMaterial.dispose(), [skirtDepthMaterial]);
  useEffect(() => {
    onTerrainChange();
  }, [geometry, onTerrainChange, skirtGeometry]);

  return (
    <group position={[position[0], 0, position[1]]}>
      <mesh
        geometry={geometry}
        material={terrainMaterial}
        customDepthMaterial={terrainDepthMaterial}
        renderOrder={1}
        castShadow
        receiveShadow
        frustumCulled={false}
      />
      {skirtGeometry.getAttribute("position").count > 0 && (
        <mesh
          geometry={skirtGeometry}
          material={skirtMaterial}
          customDepthMaterial={skirtDepthMaterial}
          castShadow
          receiveShadow
          frustumCulled={false}
        />
      )}
    </group>
  );
}

export function TerrainTiles({
  center,
  exaggeration,
  heightPalette,
  terrainEmissiveColor,
  terrainGradientLowColor,
  terrainGradientHighColor,
  onTerrainChange,
  clipPolygons,
  tiles,
}: {
  center: Position;
  exaggeration: number;
  heightPalette: TerrainEmissivePalette;
  terrainEmissiveColor: string;
  terrainGradientLowColor: string;
  terrainGradientHighColor: string;
  onTerrainChange: () => void;
  clipPolygons: Position[][][];
  tiles: { z: number; x: number; y: number }[];
}) {
  const sources = tiles.map((tile) => `/data/terrain/tiles/${tile.z}/${tile.x}/${tile.y}.webp`);
  const textures = useLoader(TextureLoader, sources);
  const clipIndex = useMemo(
    () => createTerrainClipPolygonIndex(clipPolygons),
    [clipPolygons],
  );

  return (
    <group>
      {tiles.map((tile, index) => {
        const texture = textures[index];
        if (!texture) throw new Error(`Missing elevation texture for ${sources[index]}.`);
        return (
          <TerrainTile
            key={`${tile.z}/${tile.x}/${tile.y}`}
            center={center}
            exaggeration={exaggeration}
            heightPalette={heightPalette}
            terrainEmissiveColor={terrainEmissiveColor}
            terrainGradientLowColor={terrainGradientLowColor}
            terrainGradientHighColor={terrainGradientHighColor}
            onTerrainChange={onTerrainChange}
            clipPolygons={clipPolygons}
            clipIndex={clipIndex}
            texture={texture}
            tile={tile}
          />
        );
      })}
    </group>
  );
}
