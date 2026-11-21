import { describe, expect, it } from "bun:test";
import {
  createTerrainAccessoryOutline,
  createTerrainModelFootprints,
  createTerrainModelPreviewGeometries,
  getDefaultTerrainAccessoryPosition,
  getDefaultTerrainHandlePosition,
  getTerrainAccessoryBaseOverlapMm,
  getTerrainAccessoryTopY,
  getTerrainRegionLargestDimension,
  getTerrainRegionLatitudeSpanKm,
  type LocalTerrainAccessory,
} from "../terrain/terrainOrnament";
import type { TerrainExportRegion } from "../terrain/terrainExport";

function pointInRing([x, z]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const current = ring[index];
    const previous = ring[previousIndex];
    if (!current || !previous) continue;
    if ((current[1] > z) !== (previous[1] > z) &&
      x < (previous[0] - current[0]) * (z - current[1]) /
        (previous[1] - current[1]) + current[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function containsPoint(
  polygons: [number, number][][][],
  point: [number, number],
): boolean {
  return polygons.some(([outer, ...holes]) =>
    outer !== undefined &&
    pointInRing(point, outer) &&
    !holes.some((hole) => pointInRing(point, hole))
  );
}

describe("3D model accessories", () => {
  const region: TerrainExportRegion = {
    id: "model-test",
    name: "Model test",
    polygons: [[[
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [-2, -2],
    ]]],
  };

  it("uses the selected region bounds for model size and default accessory positions", () => {
    expect(getTerrainRegionLargestDimension(region)).toBe(4);
    expect(getTerrainRegionLatitudeSpanKm(region)).toBe(4);
    expect(getDefaultTerrainHandlePosition(region)).toEqual([0, -2]);
    expect(getDefaultTerrainAccessoryPosition(region, "heart")).toEqual([0, 0]);
  });

  it("uses accessory thickness as a fixed height above sea level", () => {
    expect(getTerrainAccessoryTopY({ thicknessMm: 3 }, 4, 100)).toBeCloseTo(0.12);
    expect(getTerrainAccessoryTopY({ thicknessMm: 5 }, 4, 100)).toBeCloseTo(0.2);
  });

  it("extends heart and star accessories only slightly into the base", () => {
    const accessory: LocalTerrainAccessory = {
      id: "heart",
      type: "heart",
      position: [0, 0],
      sizeMm: 10,
      sizeKm: 0.4,
      rotationDegrees: 0,
      thicknessMm: 3,
    };
    const geometries = createTerrainModelPreviewGeometries(region, [accessory], 3, 100);
    const accessoryGeometry = geometries.accessories[0]?.geometry;
    if (!accessoryGeometry) throw new Error("Expected preview accessory geometry.");
    accessoryGeometry.computeBoundingBox();
    expect(accessoryGeometry.boundingBox?.min.y).toBeCloseTo(
      -getTerrainAccessoryBaseOverlapMm(3) * 4 / 100,
    );
    expect(accessoryGeometry.boundingBox?.max.y).toBeCloseTo(0.12);
    geometries.base.dispose();
    accessoryGeometry.dispose();
  });

  it("does not create a base-only footprint when there is no handle", () => {
    const footprints = createTerrainModelFootprints(region, []);
    expect(footprints.footprint).toBe(region.polygons);
    expect(footprints.surface).toBe(region.polygons);
    expect(footprints.baseOnly).toEqual([]);
  });

  it("cuts an annular handle opening from terrain and model base", () => {
    const handle: LocalTerrainAccessory = {
      id: "handle",
      type: "handle",
      position: [0, 0],
      sizeMm: 10,
      sizeKm: 0.4,
      rotationDegrees: 0,
    };
    const footprints = createTerrainModelFootprints(region, [handle]);
    expect(footprints.surface).toHaveLength(1);
    expect(footprints.surface[0]).toHaveLength(2);
    expect(footprints.footprint[0]).toHaveLength(2);
    expect(footprints.baseOnly).toHaveLength(0);
  });

  it("preserves terrain under the handle opening and cuts only the overhang when clipping is disabled", () => {
    const handle: LocalTerrainAccessory = {
      id: "handle",
      type: "handle",
      position: [0, 0],
      sizeMm: 10,
      sizeKm: 0.4,
      rotationDegrees: 0,
      clipTerrain: false,
    };
    const footprints = createTerrainModelFootprints(region, [handle]);
    expect(footprints.surface).toHaveLength(1);
    expect(footprints.surface[0]).toHaveLength(1);
    expect(footprints.footprint).toHaveLength(1);
    expect(footprints.footprint[0]).toHaveLength(1);
    const geometries = createTerrainModelPreviewGeometries(
      region,
      [handle],
      3,
      100,
      footprints,
    );
    geometries.base.computeBoundingBox();
    expect(geometries.base.boundingBox?.min.y).toBeCloseTo(-0.12);
    expect(geometries.base.boundingBox?.max.y).toBeCloseTo(0);
    geometries.base.dispose();
    geometries.accessories.forEach(({ geometry }) => geometry.dispose());
  });

  it("cuts only the off-terrain portion of a non-clipping handle opening", () => {
    const handle: LocalTerrainAccessory = {
      id: "handle",
      type: "handle",
      position: [2.1, 0],
      sizeMm: 10,
      sizeKm: 0.4,
      rotationDegrees: 0,
      clipTerrain: false,
    };
    const footprints = createTerrainModelFootprints(region, [handle]);
    expect(containsPoint(footprints.surface, [1.97, 0])).toBe(true);
    expect(containsPoint(footprints.footprint, [1.97, 0])).toBe(true);
    expect(containsPoint(footprints.footprint, [2.2, 0])).toBe(false);
    expect(containsPoint(footprints.footprint, [2.15, 0.17])).toBe(true);
  });

  it("extends the base where a handle projects beyond the selected region", () => {
    const handle: LocalTerrainAccessory = {
      id: "handle",
      type: "handle",
      position: [2.1, 0],
      sizeMm: 10,
      sizeKm: 0.4,
      rotationDegrees: 0,
    };
    const footprints = createTerrainModelFootprints(region, [handle]);
    expect(footprints.baseOnly.length).toBeGreaterThan(0);
  });

  it("creates rotated heart and star outlines with the requested physical size", () => {
    for (const type of ["heart", "star"] as const) {
      const outline = createTerrainAccessoryOutline(type, [1, 2], 0.4, 30);
      expect(outline[0]).toEqual(outline.at(-1));
      expect(outline.length).toBeGreaterThan(10);
      expect(Math.max(...outline.map(([x]) => x)) -
        Math.min(...outline.map(([x]) => x))).toBeGreaterThan(0);
    }
  });
});
