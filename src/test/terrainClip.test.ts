import { describe, expect, it } from "bun:test";
import {
  intersectStateWithRegions,
  simplifyTerrainBoundaryRing,
} from "../terrain/terrainClip";
import type { Position } from "../types";

describe("state and region clip polygons", () => {
  it("uses the state boundary when region clipping is disabled", () => {
    const statePolygons: Position[][][] = [[[
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]]];

    expect(intersectStateWithRegions(statePolygons, null)).toBe(statePolygons);
  });

  it("returns no clip polygon when there are no visible regions", () => {
    const statePolygons: Position[][][] = [[[
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ]]];

    expect(intersectStateWithRegions(statePolygons, [])).toEqual([]);
  });

  it("unions visible regions before intersecting with the state boundary", () => {
    const stateRing: Position[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ];
    const regions: Position[][][][] = [
      [[[
        [-0.6, -0.5],
        [0.2, -0.5],
        [0.2, 0.5],
        [-0.6, 0.5],
        [-0.6, -0.5],
      ]]],
      [[[
        [-0.2, -0.5],
        [0.6, -0.5],
        [0.6, 0.5],
        [-0.2, 0.5],
        [-0.2, -0.5],
      ]]],
    ];
    const clipPolygons = intersectStateWithRegions([[stateRing]], regions);
    const outerRing = clipPolygons[0]?.[0];
    const xCoordinates = outerRing?.map(([x]) => x) ?? [];

    expect(clipPolygons).toHaveLength(1);
    expect(outerRing).toBeDefined();
    expect(Math.min(...xCoordinates)).toBeCloseTo(-0.6);
    expect(Math.max(...xCoordinates)).toBeCloseTo(0.6);
  });

  it("simplifies state border rings without opening them", () => {
    const ring: Position[] = [
      [0, 0],
      [0.1, 0.001],
      [0.2, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const simplified = simplifyTerrainBoundaryRing(ring, 0.01);

    expect(simplified.length).toBeLessThan(ring.length);
    expect(simplified[0]).toEqual(simplified[simplified.length - 1]);
  });
});
