import { describe, expect, it } from "bun:test";
import { DoubleSide, Material, Texture, Vector2, Vector3, Vector4 } from "three";
import {
  makeTerrainSkirtGeometry,
  TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS,
} from "../terrain/terrainSkirts";
import { applyTerrainDisplacementShader, createTerrainStandardMaterial } from "../terrain/terrainShader";
import type { Position } from "../types";

describe("terrain boundary skirts", () => {
  it("extrudes polygon edges with shader-marked bottom vertices", () => {
    const ring: Position[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ];
    const skirt = makeTerrainSkirtGeometry([[ring]], -1, -1, 2, 1);
    const positions = skirt.getAttribute("position");
    const skirtFlags = skirt.getAttribute("terrainSkirt");

    expect(TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS).toBe(-200);
    expect(positions.count).toBe(16);
    expect(skirt.getIndex()?.count).toBe(24);
    for (let index = 0; index < skirtFlags.count; index += 1) {
      expect(skirtFlags.getX(index)).toBe(index % 4 >= 2 ? 1 : 0);
    }
    for (let index = 0; index < positions.count; index += 4) {
      expect(positions.getX(index)).toBe(positions.getX(index + 2));
      expect(positions.getZ(index)).toBe(positions.getZ(index + 2));
      expect(positions.getX(index + 1)).toBe(positions.getX(index + 3));
      expect(positions.getZ(index + 1)).toBe(positions.getZ(index + 3));
    }
    skirt.dispose();
  });

  it("clips skirt segments to the tile bounds", () => {
    const ring: Position[] = [
      [-1, 0],
      [2, 0],
      [2, 2],
      [-1, 2],
      [-1, 0],
    ];
    const skirt = makeTerrainSkirtGeometry([[ring]], 0, 0, 1, 1);
    const positions = skirt.getAttribute("position");

    expect(positions.count).toBe(4);
    expect(positions.getX(0)).toBe(-0.5);
    expect(positions.getX(1)).toBe(0.5);
    expect(positions.getZ(0)).toBe(-0.5);
    expect(positions.getZ(1)).toBe(-0.5);
    skirt.dispose();
  });

  it("uses smaller skirt segments for higher-resolution tiles", () => {
    const ring: Position[] = [
      [-1, 0],
      [3, 0],
      [3, 4],
      [-1, 4],
      [-1, 0],
    ];
    const coarse = makeTerrainSkirtGeometry([[ring]], 0, 0, 2, 2);
    const fine = makeTerrainSkirtGeometry([[ring]], 0, 0, 1, 2);
    const largestSegment = (geometry: ReturnType<typeof makeTerrainSkirtGeometry>) => {
      const positions = geometry.getAttribute("position");
      let maximumLength = 0;
      for (let index = 0; index < positions.count; index += 4) {
        maximumLength = Math.max(
          maximumLength,
          Math.hypot(
            positions.getX(index + 1) - positions.getX(index),
            positions.getZ(index + 1) - positions.getZ(index),
          ),
        );
      }
      return maximumLength;
    };

    expect(largestSegment(coarse)).toBeLessThanOrEqual(1);
    expect(largestSegment(fine)).toBeLessThanOrEqual(0.5);
    coarse.dispose();
    fine.dispose();
  });

  it("keeps skirt faces opaque where the terrain texture is transparent over ocean", () => {
    const texture = new Texture();
    const uniforms = {
      uTerrainHeightMap: { value: texture },
      uTerrainImageSize: { value: new Vector2(259, 259) },
      uTerrainTileSizeKm: { value: 1 },
      uTerrainExaggeration: { value: 1 },
      uTerrainSkirtBottomMeters: { value: TERRAIN_SKIRT_BOTTOM_ELEVATION_METERS },
      uTerrainClipMask: { value: texture },
      uTerrainClipMaskEnabled: { value: 0 },
      uTerrainPaletteStops: { value: [new Vector3()] },
      uTerrainPaletteStopCount: { value: 1 },
      uTerrainPaletteSolid: { value: 0 },
      uTerrainSolidColor: { value: new Vector3() },
      uTerrainPreviewSolidEnabled: { value: 0 },
      uTerrainPreviewSolidColor: { value: new Vector3(1, 1, 1) },
      uTerrainRegionMap: { value: texture },
      uTerrainRegionMapEnabled: { value: 0 },
      uTerrainRegionMapBounds: { value: new Vector4() },
    };
    const material = createTerrainStandardMaterial(
      texture,
      uniforms,
      DoubleSide,
      false,
      { forceOpaque: true },
    );
    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>",
      fragmentShader: "#include <common>\n#include <map_fragment>\n#include <emissivemap_fragment>",
    } as Parameters<Material["onBeforeCompile"]>[0];

    applyTerrainDisplacementShader(shader, uniforms, true);

    expect(material.transparent).toBe(false);
    expect(material.alphaTest).toBe(0);
    expect(shader.fragmentShader).toContain(
      "uniform float uTerrainPreviewSolidEnabled;",
    );
    expect(shader.fragmentShader).toContain(
      "uniform vec3 uTerrainPreviewSolidColor;",
    );
    expect(shader.fragmentShader).toContain(
      "#include <map_fragment>\ndiffuseColor.a = 1.0;",
    );
    expect(shader.fragmentShader).toContain(
      "diffuseColor.rgb = uTerrainPreviewSolidColor;",
    );
    material.dispose();
    texture.dispose();
  });
});
