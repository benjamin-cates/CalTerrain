import { describe, expect, it } from "bun:test";
import {
  createHighwayShields,
  getHighwayLines,
  getHighwayRouteNumbers,
  getHighwayRouteLines,
  HIGHWAY_SHIELD_VISIBILITY_DISTANCE_KM,
  highwayShieldStrideForDistance,
  type HighwayFeature,
  type HighwayFeatureCollection,
} from "../features/highways";
import type { Position } from "../types";

function lineFeature(routeNumber: string, coordinates: Position[]): HighwayFeature {
  return {
    type: "Feature",
    properties: { RouteNum: routeNumber },
    geometry: { type: "LineString", coordinates },
  };
}

describe("highway feature preparation", () => {
  const collection: HighwayFeatureCollection = {
    type: "FeatureCollection",
    features: [
      lineFeature("005", [[0, 0], [2, 0]]),
      lineFeature("101", [[0, 0], [0.5, 0]]),
    ],
  };

  it("separates interstate routes from California state highways", () => {
    expect(getHighwayLines(collection, [0, 0], "interstate")).toHaveLength(1);
    expect(getHighwayLines(collection, [0, 0], "highway")).toHaveLength(1);
  });

  it("lists and filters individual route numbers", () => {
    expect(getHighwayRouteNumbers(collection, "interstate")).toEqual(["5"]);
    expect(getHighwayRouteNumbers(collection, "highway")).toEqual(["101"]);
    expect(getHighwayLines(collection, [0, 0], "highway", new Set(["5"]))).toHaveLength(0);
    expect(createHighwayShields(collection, [0, 0], new Set(["interstate/5"]))
      .every((shield) => shield.type === "interstate" && shield.number === "5")).toBe(true);
  });

  it("removes duplicate route lines and joins reversed segments within 200 meters", () => {
    const first = [[0, 0], [0.01, 0]] as Position[];
    const reversedContinuation = [[0.02, 0], [0.0117, 0]] as Position[];
    const outsideJoinTolerance = [[0.0219, 0], [0.03, 0]] as Position[];
    const duplicateFeatures = [
      lineFeature("101", first),
      lineFeature("101", [...first].reverse()),
      lineFeature("101", first),
      lineFeature("101", first),
      lineFeature("101", first),
    ];
    const lines = getHighwayRouteLines({
      type: "FeatureCollection",
      features: [
        ...duplicateFeatures,
        lineFeature("101", reversedContinuation),
        lineFeature("101", outsideJoinTolerance),
      ],
    }, "highway", "101");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([...first, [0.0117, 0], [0.02, 0]]);
    expect(lines[1]).toEqual(outsideJoinTolerance);
  });

  it("avoids joining a segment that immediately doubles back", () => {
    const first = [[0, 0], [0.01, 0]] as Position[];
    const doublesBack = [[0.009, 0], [0.001, 0]] as Position[];
    const continuation = [[0.011, 0], [0.02, 0]] as Position[];
    const lines = getHighwayRouteLines({
      type: "FeatureCollection",
      features: [
        lineFeature("101", first),
        lineFeature("101", doublesBack),
        lineFeature("101", continuation),
      ],
    }, "highway", "101");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual([...first, [0.011, 0], [0.02, 0]]);
    expect(lines).not.toContainEqual(doublesBack);
  });

  it("removes reversed, slightly offset partial lines covered by a complete route", () => {
    const completeRoute = [
      [0, 0],
      [0.01, 0],
      [0.02, 0],
      [0.03, 0],
      [0.04, 0],
    ] as Position[];
    const partialForward = [
      [0.01, 0.0001],
      [0.02, 0.0001],
      [0.03, 0.0001],
    ] as Position[];
    const partialReverse = [...partialForward].reverse();
    const lines = getHighwayRouteLines({
      type: "FeatureCollection",
      features: [
        lineFeature("5", partialForward),
        lineFeature("5", completeRoute),
        lineFeature("5", partialReverse),
      ],
    }, "interstate", "5");

    expect(lines).toEqual([completeRoute]);
  });

  it("creates route-numbered shields at five-kilometer intervals", () => {
    const shields = createHighwayShields(collection, [0, 0]);

    expect(shields.filter((shield) => shield.number === "5").every(
      (shield) => shield.type === "interstate",
    )).toBe(true);
    for (const number of ["5", "101"]) {
      const routeShields = shields.filter((shield) => shield.number === number);
      const spacing = routeShields.slice(1).map((shield, index) =>
        Math.hypot(
          shield.position[0] - routeShields[index]!.position[0],
          shield.position[1] - routeShields[index]!.position[1],
        )
      );
      expect(spacing.every((distance) => Math.abs(distance - 5) < 0.01)).toBe(true);
    }
  });

  it("keeps shield spacing consistent across unevenly sampled line vertices", () => {
    const unevenLine = lineFeature("101", [
      [0, 0],
      [0.18, 0],
      [0.71, 0],
      [1.2, 0],
    ]);
    const shields = createHighwayShields({
      type: "FeatureCollection",
      features: [unevenLine],
    }, [0, 0]);
    const spacing = shields.slice(1).map((shield, index) =>
      Math.hypot(
        shield.position[0] - shields[index]!.position[0],
        shield.position[1] - shields[index]!.position[1],
      )
    );

    expect(shields).toHaveLength(27);
    expect(spacing.every((distance) => Math.abs(distance - 5) < 0.01)).toBe(true);
  });

  it("places shields on route sections that fit within a close-zoom screen", () => {
    const shields = createHighwayShields({
      type: "FeatureCollection",
      features: [lineFeature("101", [[0, 0], [0.05, 0]])],
    }, [0, 0]);

    expect(shields).toHaveLength(1);
    expect(highwayShieldStrideForDistance(10)).toBe(1);
  });

  it("shows denser shield positions as the camera zooms in", () => {
    expect(HIGHWAY_SHIELD_VISIBILITY_DISTANCE_KM).toBe(300);
    expect(highwayShieldStrideForDistance(250)).toBe(32);
    expect(highwayShieldStrideForDistance(180)).toBe(24);
    expect(highwayShieldStrideForDistance(100)).toBe(16);
    expect(highwayShieldStrideForDistance(60)).toBe(8);
    expect(highwayShieldStrideForDistance(30)).toBe(4);
    expect(highwayShieldStrideForDistance(15)).toBe(2);
    expect(highwayShieldStrideForDistance(10)).toBe(1);
  });
});
