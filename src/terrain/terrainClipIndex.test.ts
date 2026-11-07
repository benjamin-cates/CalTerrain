import { describe, expect, it } from "bun:test";
import {
  createTerrainClipPointQueryScratch,
  createTerrainClipPolygonIndex,
  getTerrainClipPolygonsContainingPoint,
  getTerrainClipSegmentsForTile,
} from "./terrainClipIndex";
import type { Position } from "../types";

describe("terrain clip polygon index", () => {
  it("preserves point-in-polygon results for outer rings and holes", () => {
    const outerRing: Position[] = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [-2, -2],
    ];
    const hole: Position[] = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
      [-0.5, -0.5],
    ];
    const index = createTerrainClipPolygonIndex([[outerRing, hole]]);

    expect(getTerrainClipPolygonsContainingPoint(index, [1, 1])).toEqual([0]);
    expect(getTerrainClipPolygonsContainingPoint(index, [0, 0])).toEqual([]);
    expect(getTerrainClipPolygonsContainingPoint(index, [3, 0])).toEqual([]);
  });

  it("returns only boundary segments that intersect the tile", () => {
    const ring: Position[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const index = createTerrainClipPolygonIndex([[ring]]);

    expect(getTerrainClipSegmentsForTile(index, -1, 4, 2)).toHaveLength(1);
    expect(getTerrainClipSegmentsForTile(index, 4, 4, 2)).toHaveLength(0);
  });

  it("reuses provided query scratch without retaining previous results", () => {
    const ring: Position[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const index = createTerrainClipPolygonIndex([[ring]]);
    const segments: ReturnType<typeof getTerrainClipSegmentsForTile> = [];
    const pointScratch = createTerrainClipPointQueryScratch(index);

    expect(getTerrainClipSegmentsForTile(index, -1, 4, 2, segments)).toHaveLength(1);
    expect(getTerrainClipSegmentsForTile(index, 4, 4, 2, segments)).toBe(segments);
    expect(segments).toHaveLength(0);
    expect(getTerrainClipPolygonsContainingPoint(index, [1, 1], pointScratch)).toBe(
      pointScratch.result,
    );
    expect(pointScratch.result).toEqual([0]);
    expect(getTerrainClipPolygonsContainingPoint(index, [11, 5], pointScratch)).toEqual([]);
  });
});
