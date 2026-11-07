import { describe, expect, it } from "bun:test";
import { createTerrainClipMaskTexture } from "./terrainClipMask";
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
});
