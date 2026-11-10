import {
  NoColorSpace,
  FrontSide,
  Material,
  MeshStandardMaterial,
  NearestFilter,
  SRGBColorSpace,
  type Side,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS } from "./terrainSkirts";

export type TerrainShaderUniforms = {
  uTerrainHeightMap: { value: Texture };
  uTerrainImageSize: { value: Vector2 };
  uTerrainTileSizeKm: { value: number };
  uTerrainExaggeration: { value: number };
  uTerrainSkirtBottomMeters: { value: number };
};
export type TerrainLineShaderUniforms = TerrainShaderUniforms & {
  uTerrainTileOrigin: { value: Vector2 };
};
type TerrainClipShaderUniforms = TerrainShaderUniforms & {
  uTerrainClipMask: { value: Texture };
  uTerrainClipMaskEnabled: { value: number };
  uTerrainPaletteStops: { value: Vector3[] };
  uTerrainPaletteStopCount: { value: number };
  uTerrainPaletteSolid: { value: number };
  uTerrainSolidColor: { value: Vector3 };
  uTerrainRegionMap: { value: Texture };
  uTerrainRegionMapEnabled: { value: number };
  uTerrainRegionMapBounds: { value: Vector4 };
};
type TerrainShader = Parameters<Material["onBeforeCompile"]>[0];

const heightTextureCache = new WeakMap<Texture, Texture>();

export function getTerrainHeightTexture(source: Texture): Texture {
  const cached = heightTextureCache.get(source);
  if (cached) return cached;

  const texture = source.clone();
  texture.colorSpace = NoColorSpace;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  source.addEventListener("dispose", () => {
    texture.dispose();
    heightTextureCache.delete(source);
  });
  heightTextureCache.set(source, texture);
  return texture;
}

export function createTerrainShaderUniforms(
  heightMap: Texture,
  tileSizeKm: number,
  exaggeration: number,
): TerrainShaderUniforms {
  const image = heightMap.image as HTMLImageElement;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) {
    throw new Error("Could not read the generated terrain texture dimensions.");
  }
  return {
    uTerrainHeightMap: { value: heightMap },
    uTerrainImageSize: { value: new Vector2(width, height) },
    uTerrainTileSizeKm: { value: tileSizeKm },
    uTerrainExaggeration: { value: exaggeration },
    uTerrainSkirtBottomMeters: { value: TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS },
  };
}

export function createTerrainStandardMaterial(
  colorMap: Texture,
  uniforms: TerrainClipShaderUniforms,
  side: Side = FrontSide,
  polygonOffset = false,
): MeshStandardMaterial {
  colorMap.colorSpace = SRGBColorSpace;
  const material = new MeshStandardMaterial({
    emissive: "#ffffff",
    map: colorMap,
    roughness: 0.96,
    side,
    alphaTest: 0.01,
    transparent: true,
    polygonOffset,
    polygonOffsetFactor: polygonOffset ? -1 : 0,
  });
  material.onBeforeCompile = (shader) => applyTerrainDisplacementShader(shader, uniforms);
  material.customProgramCacheKey = () => "terrain-bicubic-height-emissive-v1";
  return material;
}

const terrainHeightShader = `
uniform sampler2D uTerrainHeightMap;
uniform vec2 uTerrainImageSize;
uniform float uTerrainTileSizeKm;
uniform float uTerrainExaggeration;
uniform float uTerrainSkirtBottomMeters;
uniform sampler2D uTerrainClipMask;
uniform float uTerrainClipMaskEnabled;

float terrainCubic(float p0, float p1, float p2, float p3, float t) {
  return 0.5 * (
    2.0 * p1 +
    (-p0 + p2) * t +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t
  );
}

float terrainCubicDerivative(float p0, float p1, float p2, float p3, float t) {
  return 0.5 * (
    -p0 + p2 +
    2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t +
    3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t
  );
}

float terrainDecodeTexel(float column, float row) {
  vec2 texelUv = vec2(
    (column + 0.5) / uTerrainImageSize.x,
    1.0 - (row + 0.5) / uTerrainImageSize.y
  );
  vec4 sampleColor = texture2D(uTerrainHeightMap, texelUv);
  if (sampleColor.a < 0.5) return 0.0;
  return sampleColor.r * 65280.0 +
    sampleColor.g * 255.0 +
    sampleColor.b * 0.99609375 -
    32768.0;
}

void terrainSampleHeightAndSlope(
  vec2 terrainUv,
  out float heightMeters,
  out vec2 slopeMetersPerKm
) {
  vec2 pixel = vec2(
    terrainUv.x * 256.0 + 1.0,
    (1.0 - terrainUv.y) * 256.0 + 1.0
  );
  vec2 basePixel = floor(pixel);
  vec2 fraction = fract(pixel);
  float rows[4];
  float rowSlopesX[4];

  for (int row = 0; row < 4; row++) {
    float sampleRow = basePixel.y + float(row - 1);
    float h0 = terrainDecodeTexel(basePixel.x - 1.0, sampleRow);
    float h1 = terrainDecodeTexel(basePixel.x, sampleRow);
    float h2 = terrainDecodeTexel(basePixel.x + 1.0, sampleRow);
    float h3 = terrainDecodeTexel(basePixel.x + 2.0, sampleRow);
    rows[row] = terrainCubic(h0, h1, h2, h3, fraction.x);
    rowSlopesX[row] = terrainCubicDerivative(h0, h1, h2, h3, fraction.x);
  }

  heightMeters = terrainCubic(rows[0], rows[1], rows[2], rows[3], fraction.y);
  float slopeX = terrainCubic(
    rowSlopesX[0], rowSlopesX[1], rowSlopesX[2], rowSlopesX[3], fraction.y
  );
  float slopeZ = terrainCubicDerivative(rows[0], rows[1], rows[2], rows[3], fraction.y);
  slopeMetersPerKm = vec2(slopeX, slopeZ) * (256.0 / uTerrainTileSizeKm);
}
`;

const TERRAIN_EMISSIVE_STRENGTH = 0.42;
const terrainHeightPaletteShader = `
uniform vec3 uTerrainPaletteStops[7];
uniform int uTerrainPaletteStopCount;
uniform float uTerrainPaletteLinearInterpolation;
uniform float uTerrainPaletteSolid;
uniform vec3 uTerrainSolidColor;
varying float vTerrainHeightMeters;

vec3 terrainPaletteSrgbToLinear(vec3 color) {
  vec3 low = color / 12.92;
  vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), color));
}

vec3 terrainHeightPaletteEmissive(float heightMeters) {
  if (uTerrainPaletteSolid > 0.5) {
    return uTerrainSolidColor * ${TERRAIN_EMISSIVE_STRENGTH.toFixed(2)};
  }
  float heightRange = clamp((heightMeters + 100.0) / 4600.0, 0.0, 1.0);
  float palettePosition = heightRange * float(uTerrainPaletteStopCount - 1);
  int lowerIndex = int(floor(palettePosition));
  int upperIndex = min(lowerIndex + 1, uTerrainPaletteStopCount - 1);
  float interpolation = fract(palettePosition);
  vec3 lowerStop = uTerrainPaletteStops[lowerIndex];
  vec3 upperStop = uTerrainPaletteStops[upperIndex];
  if (uTerrainPaletteLinearInterpolation > 0.5) {
    return mix(
      terrainPaletteSrgbToLinear(lowerStop),
      terrainPaletteSrgbToLinear(upperStop),
      interpolation
    ) * ${TERRAIN_EMISSIVE_STRENGTH.toFixed(2)};
  }
  vec3 paletteSrgb = mix(
    lowerStop,
    upperStop,
    interpolation
  );
  return terrainPaletteSrgbToLinear(paletteSrgb) * ${TERRAIN_EMISSIVE_STRENGTH.toFixed(2)};
}
`;

const terrainRegionMapShader = `
uniform sampler2D uTerrainRegionMap;
uniform float uTerrainRegionMapEnabled;
uniform vec4 uTerrainRegionMapBounds;
varying vec2 vTerrainRegionMapUv;

vec3 terrainRegionMapSrgbToLinear(vec3 color) {
  vec3 low = color / 12.92;
  vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), color));
}
`;

function replaceShaderChunk(shader: TerrainShader, chunk: string, replacement: string): void {
  if (!shader.vertexShader.includes(chunk)) {
    throw new Error(`Could not configure terrain vertex shader chunk: ${chunk}`);
  }
  shader.vertexShader = shader.vertexShader.replace(chunk, replacement);
}

function replaceFragmentShaderChunk(
  shader: TerrainShader,
  chunk: string,
  replacement: string,
): void {
  if (!shader.fragmentShader.includes(chunk)) {
    throw new Error(`Could not configure terrain fragment shader chunk: ${chunk}`);
  }
  shader.fragmentShader = shader.fragmentShader.replace(chunk, replacement);
}

function applyTerrainHeightVertexShader(
  shader: TerrainShader,
  uniforms: TerrainShaderUniforms,
  updateNormals: boolean,
  passHeightToFragment = false,
  passRegionMapUv = false,
): void {
  Object.assign(shader.uniforms, uniforms);
  replaceShaderChunk(
    shader,
    "#include <common>",
    `#include <common>\n${terrainHeightShader}\nattribute float terrainSkirt;${passHeightToFragment ? "\nvarying float vTerrainHeightMeters;" : ""}${passRegionMapUv ? "\nuniform vec4 uTerrainRegionMapBounds;\nvarying vec2 vTerrainRegionMapUv;" : ""}`,
  );
  if (updateNormals) {
    replaceShaderChunk(
      shader,
      "#include <beginnormal_vertex>",
      `
      float terrainHeightMeters;
      vec2 terrainSlopeMetersPerKm;
      terrainSampleHeightAndSlope(uv, terrainHeightMeters, terrainSlopeMetersPerKm);
      vec3 terrainNormal = normalize(vec3(
        -terrainSlopeMetersPerKm.x * uTerrainExaggeration / 1000.0,
        1.0,
        -terrainSlopeMetersPerKm.y * uTerrainExaggeration / 1000.0
      ));
      vec3 objectNormal = normalize(mix(terrainNormal, normal, terrainSkirt));
    `,
    );
  }
  replaceShaderChunk(
    shader,
    "#include <begin_vertex>",
    `${updateNormals ? "" : `
      float terrainHeightMeters;
      vec2 terrainSlopeMetersPerKm;
      terrainSampleHeightAndSlope(uv, terrainHeightMeters, terrainSlopeMetersPerKm);
    `}
      vec3 transformed = vec3(position);
      float terrainSurfaceHeight = terrainHeightMeters * uTerrainExaggeration / 1000.0;
      float terrainSkirtBottom = uTerrainSkirtBottomMeters * uTerrainExaggeration / 1000.0;
      transformed.y = mix(terrainSurfaceHeight, terrainSkirtBottom, terrainSkirt);
      ${passHeightToFragment ? "vTerrainHeightMeters = mix(terrainHeightMeters, uTerrainSkirtBottomMeters, terrainSkirt);" : ""}
      ${passRegionMapUv ? `
        vec4 terrainWorldPosition = modelMatrix * vec4(transformed, 1.0);
        vTerrainRegionMapUv = vec2(
          (terrainWorldPosition.x - uTerrainRegionMapBounds.x) /
            (uTerrainRegionMapBounds.z - uTerrainRegionMapBounds.x),
          (-terrainWorldPosition.z - uTerrainRegionMapBounds.y) /
            (uTerrainRegionMapBounds.w - uTerrainRegionMapBounds.y)
        );
      ` : ""}
    `,
  );
}

function applyTerrainClipMaskFragmentShader(
  shader: TerrainShader,
  uniforms: TerrainClipShaderUniforms,
  chunk: string,
  useHeightPalette = false,
  useRegionMap = false,
): void {
  replaceFragmentShaderChunk(
    shader,
    "#include <common>",
    `#include <common>
     uniform sampler2D uTerrainClipMask;
     uniform float uTerrainClipMaskEnabled;
     ${useHeightPalette ? terrainHeightPaletteShader : ""}
     ${useRegionMap ? terrainRegionMapShader : ""}`,
  );
  Object.assign(shader.uniforms, {
    uTerrainClipMask: uniforms.uTerrainClipMask,
    uTerrainClipMaskEnabled: uniforms.uTerrainClipMaskEnabled,
    ...(useHeightPalette && {
      uTerrainPaletteStops: uniforms.uTerrainPaletteStops,
      uTerrainPaletteStopCount: uniforms.uTerrainPaletteStopCount,
      uTerrainPaletteSolid: uniforms.uTerrainPaletteSolid,
      uTerrainSolidColor: uniforms.uTerrainSolidColor,
    }),
    ...(useRegionMap && {
      uTerrainRegionMap: uniforms.uTerrainRegionMap,
      uTerrainRegionMapEnabled: uniforms.uTerrainRegionMapEnabled,
      uTerrainRegionMapBounds: uniforms.uTerrainRegionMapBounds,
    }),
  });
  replaceFragmentShaderChunk(
    shader,
    chunk,
    `${chunk}\nif (uTerrainClipMaskEnabled > 0.5 && texture2D(uTerrainClipMask, vMapUv).a < 0.5) discard;`,
  );
}

export function applyTerrainDisplacementShader(
  shader: TerrainShader,
  uniforms: TerrainClipShaderUniforms,
): void {
  applyTerrainHeightVertexShader(shader, uniforms, true, true, true);
  replaceFragmentShaderChunk(
    shader,
    "#include <map_fragment>",
    `#include <map_fragment>
     diffuseColor.rgb = vec3(1.0);
     if (uTerrainRegionMapEnabled > 0.5) {
       vec4 regionMapColor = texture2D(uTerrainRegionMap, vTerrainRegionMapUv);
       diffuseColor.rgb = mix(
         diffuseColor.rgb,
         terrainRegionMapSrgbToLinear(regionMapColor.rgb),
         regionMapColor.a
       );
     }`,
  );
  applyTerrainClipMaskFragmentShader(
    shader,
    uniforms,
    "#include <map_fragment>",
    true,
    true,
  );
  replaceFragmentShaderChunk(
    shader,
    "#include <emissivemap_fragment>",
    `#include <emissivemap_fragment>
     totalEmissiveRadiance = terrainHeightPaletteEmissive(vTerrainHeightMeters);`,
  );
}

export function applyTerrainLineHeightShader(
  shader: TerrainShader,
  uniforms: TerrainLineShaderUniforms,
): void {
  Object.assign(shader.uniforms, uniforms);
  replaceShaderChunk(
    shader,
    "#include <common>",
    `#include <common>\n${terrainHeightShader}\nuniform vec2 uTerrainTileOrigin;`,
  );
  replaceShaderChunk(
    shader,
    "vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );",
    `
      vec3 terrainLineStart = instanceStart;
      float terrainLineStartHeight;
      vec2 terrainLineStartSlope;
      vec2 terrainLineStartUv = vec2(
        (instanceStart.x - uTerrainTileOrigin.x) / uTerrainTileSizeKm,
        1.0 - (instanceStart.z - uTerrainTileOrigin.y) / uTerrainTileSizeKm
      );
      terrainSampleHeightAndSlope(terrainLineStartUv, terrainLineStartHeight, terrainLineStartSlope);
      terrainLineStart.y = terrainLineStartHeight * uTerrainExaggeration / 1000.0 + 0.01;
      vec4 start = modelViewMatrix * vec4( terrainLineStart, 1.0 );
    `,
  );
  replaceShaderChunk(
    shader,
    "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
    `
      vec3 terrainLineEnd = instanceEnd;
      float terrainLineEndHeight;
      vec2 terrainLineEndSlope;
      vec2 terrainLineEndUv = vec2(
        (instanceEnd.x - uTerrainTileOrigin.x) / uTerrainTileSizeKm,
        1.0 - (instanceEnd.z - uTerrainTileOrigin.y) / uTerrainTileSizeKm
      );
      terrainSampleHeightAndSlope(terrainLineEndUv, terrainLineEndHeight, terrainLineEndSlope);
      terrainLineEnd.y = terrainLineEndHeight * uTerrainExaggeration / 1000.0 + 0.01;
      vec4 end = modelViewMatrix * vec4( terrainLineEnd, 1.0 );
    `,
  );
}
