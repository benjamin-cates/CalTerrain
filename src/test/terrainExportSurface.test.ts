import { describe, expect, it } from "bun:test";
import {
  splitSurfaceTriangleByBoundary,
} from "../terrain/terrainExportSurface";
import type { Position } from "../types";
import type { TerrainClipSegment } from "../terrain/terrainClipIndex";

const surfaceTriangle: [Position, Position, Position] = [
  [0, 0],
  [4, 0],
  [0, 4],
];

function boundarySegment(
  start: Position,
  end: Position,
  interiorOnLeft = false,
): TerrainClipSegment {
  return {
    start,
    end,
    polygonIndex: 0,
    interiorOnLeft,
    minX: Math.min(start[0], end[0]),
    minZ: Math.min(start[1], end[1]),
    maxX: Math.max(start[0], end[0]),
    maxZ: Math.max(start[1], end[1]),
  };
}

function pointInRing([x, z]: Position, ring: Position[]): boolean {
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

describe("terrain export surface splitting", () => {
  it("uses only two triangles when a straight boundary crosses a surface triangle", () => {
    const result = splitSurfaceTriangleByBoundary(
      surfaceTriangle,
      [boundarySegment([2, 0], [0, 2])],
      ([x, z]) => x + z > 2,
    );

    expect(result.triangles).toHaveLength(2);
    expect(result.walls).toHaveLength(1);
    const wall = result.walls[0];
    expect(wall).toBeDefined();
    expect([wall!.start, wall!.end].sort(([firstX], [secondX]) => firstX - secondX))
      .toEqual([[0, 2], [2, 0]]);
  });

  it("adds one surface triangle for a boundary corner inside the cell", () => {
    const boundary: Position[] = [
      [3, 0],
      [4, 0],
      [0, 4],
      [0, 3],
      [1.5, 1],
      [3, 0],
    ];
    const result = splitSurfaceTriangleByBoundary(
      surfaceTriangle,
      [
        boundarySegment([3, 0], [4, 0]),
        boundarySegment([4, 0], [0, 4]),
        boundarySegment([0, 4], [0, 3]),
        boundarySegment([0, 3], [1.5, 1]),
        boundarySegment([1.5, 1], [3, 0]),
      ],
      (point) => pointInRing(point, boundary),
    );

    expect(result.triangles).toHaveLength(3);
    expect(result.walls).toHaveLength(5);
  });
});
