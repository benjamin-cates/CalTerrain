import { describe, expect, it } from "bun:test";
import { createTerrainClipMaskTexture } from "../terrain/terrainClipMask";
import { createTerrainClipPolygonIndex } from "../terrain/terrainClipIndex";
import type { Position } from "../types";

describe("terrain clip mask texture reuse", () => {
  it("reuses a solid mask for tiles fully inside the clip polygons", () => {
    const ring: Position[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
      [-10, -10],
    ];
    const first = createTerrainClipMaskTexture([[ring]], -1, -1, 1);
    const second = createTerrainClipMaskTexture([[ring]], 1, 1, 1);

    expect(first.ownsTexture).toBe(false);
    expect(second.ownsTexture).toBe(false);
    expect(first.texture).toBe(second.texture);
  });

  it("reuses a transparent mask for tiles fully outside the clip polygons", () => {
    const ring: Position[] = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ];
    const first = createTerrainClipMaskTexture([[ring]], -1, -1, 1);
    const second = createTerrainClipMaskTexture([], 1, 1, 1);

    expect(first.ownsTexture).toBe(false);
    expect(second.ownsTexture).toBe(false);
    expect(first.texture).toBe(second.texture);
  });

  it("reuses an empty mask for tiles fully covered by an excluded lake", () => {
    const stateRing: Position[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
      [-10, -10],
    ];
    const lakeRing: Position[] = [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
      [-5, -5],
    ];
    const clipPolygons = [[stateRing]];
    const lakePolygons = [[lakeRing]];
    const mask = createTerrainClipMaskTexture(
      clipPolygons,
      -1,
      -1,
      1,
      createTerrainClipPolygonIndex(clipPolygons),
      createTerrainClipPolygonIndex(lakePolygons),
    );
    const emptyMask = createTerrainClipMaskTexture([], -1, -1, 1);

    expect(mask.ownsTexture).toBe(false);
    expect(mask.texture).toBe(emptyMask.texture);
  });

  it("keeps a full mask when selected lakes do not intersect a tile", () => {
    const stateRing: Position[] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
      [-10, -10],
    ];
    const lakeRing: Position[] = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
    ];
    const clipPolygons = [[stateRing]];
    const lakePolygons = [[lakeRing]];
    const mask = createTerrainClipMaskTexture(
      clipPolygons,
      -1,
      -1,
      1,
      createTerrainClipPolygonIndex(clipPolygons),
      createTerrainClipPolygonIndex(lakePolygons),
    );
    const fullMask = createTerrainClipMaskTexture(
      clipPolygons,
      -1,
      -1,
      1,
      createTerrainClipPolygonIndex(clipPolygons),
    );

    expect(mask.ownsTexture).toBe(false);
    expect(mask.texture).toBe(fullMask.texture);
  });
});
