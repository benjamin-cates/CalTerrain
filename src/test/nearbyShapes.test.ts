import { describe, expect, it } from "bun:test";
import { distanceToLineSegments, geometryContainsPosition } from "../regions/nearbyShapes";
import type { FeatureGeometry } from "../types";

describe("nearby shape geometry", () => {
  it("finds positions inside polygon areas but outside their holes", () => {
    const geometry: FeatureGeometry = {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
      ],
    };

    expect(geometryContainsPosition(geometry, [1, 1])).toBe(true);
    expect(geometryContainsPosition(geometry, [5, 5])).toBe(false);
    expect(geometryContainsPosition(geometry, [12, 5])).toBe(false);
  });

  it("measures distance to the closest segment across line pieces", () => {
    expect(distanceToLineSegments([5, 2], [[[0, 0], [10, 0]], [[0, 6], [10, 6]]]))
      .toBe(2);
    expect(distanceToLineSegments([5, 2], [[[0, 0]]])).toBe(Infinity);
  });
});
