import { describe, expect, it } from "bun:test";
import { fromLocal, toLocal } from "./geo";
import {
  combineCustomRegions,
  connectPolylines,
  polylineLengthMeters,
  trimPolyline,
} from "./customRegionOperations";
import type { Position, Region } from "./types";

const CENTER: Position = [-120, 37];

function local(x: number, y: number): Position {
  return fromLocal([x, y], CENTER);
}

function polygon(name: string, coordinates: [number, number][]): Region {
  return {
    id: name,
    name,
    type: "polygon",
    points: coordinates.map(([x, y]) => local(x, y)),
  };
}

function localPoints(points: Position[]): Position[] {
  return points.map((position) => toLocal(position, CENTER));
}

describe("custom region operations", () => {
  it("trims both ends by distance while retaining intermediate vertices", () => {
    const points = [local(0, 0), local(1, 0), local(1, 1)];
    const trimmed = trimPolyline(points, 250, 500, CENTER);
    const coordinates = localPoints(trimmed);
    const firstSegmentMeters = polylineLengthMeters(points.slice(0, 2));
    const secondSegmentMeters = polylineLengthMeters(points.slice(1));

    expect(polylineLengthMeters(points)).toBeCloseTo(firstSegmentMeters + secondSegmentMeters, 5);
    expect(coordinates[0]?.[0]).toBeCloseTo(250 / firstSegmentMeters, 4);
    expect(coordinates[1]?.[0]).toBeCloseTo(1, 4);
    expect(coordinates[1]?.[1]).toBeCloseTo(0, 4);
    expect(coordinates[2]?.[1]).toBeCloseTo(1 - 500 / secondSegmentMeters, 4);
  });

  it("rejects trimming away the entire polyline", () => {
    const points = [local(0, 0), local(1, 0)];
    expect(() => trimPolyline(points, 500, 500, CENTER)).toThrow(
      "Trimming must leave at least 10 cm of line.",
    );
  });

  it("connects the selected endpoints in the requested order", () => {
    const first = [local(0, 0), local(1, 0)];
    const second = [local(2, 0), local(3, 0)];

    const connected = localPoints(connectPolylines(first, second, "start", "end"));
    expect(connected).toHaveLength(4);
    expect(connected[0]?.[0]).toBeCloseTo(1, 5);
    expect(connected[1]?.[0]).toBeCloseTo(0, 5);
    expect(connected[2]?.[0]).toBeCloseTo(3, 5);
    expect(connected[3]?.[0]).toBeCloseTo(2, 5);
  });

  it("returns the shared area for an intersection", () => {
    const result = combineCustomRegions(
      polygon("first", [[0, 0], [10, 0], [10, 10], [0, 10]]),
      {
        id: "second",
        name: "second",
        type: "rectangle",
        center: local(10, 5),
        width: 10,
        height: 10,
      },
      "intersection",
      CENTER,
    );
    const coordinates = localPoints(result);

    expect(coordinates.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of coordinates) {
      expect(x).toBeGreaterThanOrEqual(5 - 1e-5);
      expect(x).toBeLessThanOrEqual(10 + 1e-5);
      expect(y).toBeGreaterThanOrEqual(-1e-5);
      expect(y).toBeLessThanOrEqual(10 + 1e-5);
    }
  });

  it("unions regions that share an edge into one custom polygon", () => {
    const result = combineCustomRegions(
      polygon("first", [[0, 0], [2, 0], [2, 2], [0, 2]]),
      polygon("second", [[2, 0], [4, 0], [4, 2], [2, 2]]),
      "union",
      CENTER,
    );
    const coordinates = localPoints(result);
    let twiceArea = 0;
    for (let index = 0; index < coordinates.length; index += 1) {
      const current = coordinates[index];
      const next = coordinates[(index + 1) % coordinates.length];
      if (current && next) twiceArea += current[0] * next[1] - next[0] * current[1];
    }

    expect(Math.abs(twiceArea) / 2).toBeCloseTo(8, 4);
  });

  it("closes a convertible polyline before applying polygon operations", () => {
    const triangle: [number, number][] = [[2, 2], [8, 2], [5, 8]];
    const result = combineCustomRegions(
      polygon("first", [[0, 0], [10, 0], [10, 10], [0, 10]]),
      {
        id: "triangle",
        name: "triangle",
        type: "polyline",
        points: triangle.map(([x, y]) => local(x, y)),
      },
      "intersection",
      CENTER,
    );

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(localPoints(result).every(([x, y]) => x >= 2 - 1e-5 && x <= 8 + 1e-5 &&
      y >= 2 - 1e-5 && y <= 8 + 1e-5)).toBe(true);
  });

  it("cuts a contained difference hole to the exterior boundary", () => {
    const result = combineCustomRegions(
      polygon("first", [[0, 0], [10, 0], [10, 10], [0, 10]]),
      polygon("inner", [[3, 3], [7, 3], [7, 7], [3, 7]]),
      "difference",
      CENTER,
    );
    const coordinates = localPoints(result);
    const counts = new Map<string, number>();
    for (const [x, y] of coordinates) {
      const key = `${x.toFixed(5)},${y.toFixed(5)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(coordinates.length).toBeGreaterThan(8);
    expect([...counts.values()].some((count) => count > 1)).toBe(true);
    expect(coordinates.some(([x, y]) => x >= 3 - 1e-5 && x <= 7 + 1e-5 &&
      y >= 3 - 1e-5 && y <= 7 + 1e-5)).toBe(true);
  });

  it("rejects a union that cannot be represented as one contiguous polygon", () => {
    expect(() => combineCustomRegions(
      polygon("first", [[0, 0], [2, 0], [2, 2], [0, 2]]),
      polygon("second", [[5, 0], [7, 0], [7, 2], [5, 2]]),
      "union",
      CENTER,
    )).toThrow("Union requires touching regions");
  });
});
