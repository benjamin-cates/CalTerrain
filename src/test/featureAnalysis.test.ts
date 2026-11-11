import { describe, expect, it } from "bun:test";
import { fromLocal } from "../geo";
import {
  featureGeometryPositions,
  linePiecesFromGeometries,
  measureLineGeometries,
  measurePolygonGeometries,
  polygonPiecesFromGeometries,
} from "../regions/analysis";
import type { FeatureGeometry, Position } from "../types";

const CENTER: Position = [-120, 37];

function local(x: number, y: number): Position {
  return fromLocal([x, y], CENTER);
}

describe("feature analysis", () => {
  it("measures independent open line segments without connecting them", () => {
    const firstLine = [local(0, 0), local(1, 0)];
    const secondLine = [local(10, 0), local(11, 0)];

    expect(measureLineGeometries([firstLine, secondLine])).toBeCloseTo(
      measureLineGeometries([firstLine]) * 2,
      5,
    );
    expect(linePiecesFromGeometries([{
      type: "MultiLineString",
      coordinates: [firstLine, secondLine],
    }])).toEqual([firstLine, secondLine]);
  });

  it("subtracts polygon holes from area and keeps each exterior piece convertible", () => {
    const exterior = [local(0, 0), local(4, 0), local(4, 4), local(0, 4), local(0, 0)];
    const hole = [local(1, 1), local(2, 1), local(2, 2), local(1, 2), local(1, 1)];
    const polygon: FeatureGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[...exterior], [...hole]],
        [[local(10, 0), local(11, 0), local(10, 1), local(10, 0)]],
      ],
    };
    const withoutHole = measurePolygonGeometries([{
      type: "Polygon",
      coordinates: [[...exterior]],
    }]);
    const withHole = measurePolygonGeometries([polygon]);

    expect(withHole.areaSquareMeters).toBeGreaterThan(0);
    expect(withHole.areaSquareMeters).toBeLessThan(withoutHole.areaSquareMeters);
    expect(polygonPiecesFromGeometries([polygon])).toHaveLength(2);
    expect(featureGeometryPositions([polygon])).toContainEqual(local(0, 0));
  });
});
