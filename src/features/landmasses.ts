import type { BoundaryCollection, BoundaryFeature, MultiPolygonCoordinates } from "../types";

type IslandBounds = {
  minLongitude: number;
  maxLongitude: number;
  minLatitude: number;
  maxLatitude: number;
};

function getOuterRingBounds(coordinates: MultiPolygonCoordinates[number]): IslandBounds {
  const outerRing = coordinates[0];
  if (!outerRing || outerRing.length === 0) {
    throw new Error("California boundary contains an empty polygon.");
  }
  return outerRing.reduce<IslandBounds>((bounds, [longitude, latitude]) => ({
    minLongitude: Math.min(bounds.minLongitude, longitude),
    maxLongitude: Math.max(bounds.maxLongitude, longitude),
    minLatitude: Math.min(bounds.minLatitude, latitude),
    maxLatitude: Math.max(bounds.maxLatitude, latitude),
  }), {
    minLongitude: Infinity,
    maxLongitude: -Infinity,
    minLatitude: Infinity,
    maxLatitude: -Infinity,
  });
}

function centerOfBounds(bounds: IslandBounds): [number, number] {
  return [
    (bounds.minLongitude + bounds.maxLongitude) / 2,
    (bounds.minLatitude + bounds.maxLatitude) / 2,
  ];
}

function isWithin(
  bounds: IslandBounds,
  [longitude, latitude]: [number, number],
  radiusLongitude: number,
  radiusLatitude: number,
): boolean {
  const [centerLongitude, centerLatitude] = centerOfBounds(bounds);
  return Math.abs(centerLongitude - longitude) <= radiusLongitude &&
    Math.abs(centerLatitude - latitude) <= radiusLatitude;
}

function makeFeature(
  id: string,
  name: string,
  polygons: MultiPolygonCoordinates,
): BoundaryFeature {
  if (polygons.length === 0) {
    throw new Error(`No California boundary components were assigned to ${name}.`);
  }
  return {
    type: "Feature",
    properties: { id, name },
    geometry: { type: "MultiPolygon", coordinates: polygons },
  };
}

export function deriveCaliforniaLandmasses(
  california: BoundaryCollection,
): BoundaryCollection {
  const components = california.features.flatMap((feature) =>
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates
  );
  const componentBounds = components.map(getOuterRingBounds);
  const assigned = new Set<number>();
  const groups = new Map<string, MultiPolygonCoordinates>();

  const assignMatching = (
    id: string,
    predicate: (bounds: IslandBounds) => boolean,
  ) => {
    const matches: MultiPolygonCoordinates = [];
    for (let index = 0; index < components.length; index += 1) {
      const bounds = componentBounds[index];
      const component = components[index];
      if (bounds && component && !assigned.has(index) && predicate(bounds)) {
        assigned.add(index);
        matches.push(component);
      }
    }
    groups.set(id, matches);
  };

  assignMatching("delta-islands", (bounds) => {
    const [longitude, latitude] = centerOfBounds(bounds);
    return longitude >= -122.1 && longitude <= -121.7 && latitude >= 37.95 && latitude <= 38.2;
  });
  assignMatching("santa-catalina-island", (bounds) =>
    isWithin(bounds, [-118.471, 33.410], 0.2, 0.1)
  );
  assignMatching("san-clemente-island", (bounds) =>
    isWithin(bounds, [-118.487, 32.900], 0.2, 0.1)
  );
  assignMatching("san-nicolas-island", (bounds) =>
    isWithin(bounds, [-119.517, 33.252], 0.12, 0.08)
  );
  assignMatching("santa-barbara-island", (bounds) =>
    isWithin(bounds, [-119.035, 33.478], 0.1, 0.08)
  );
  assignMatching("anacapa-islands", (bounds) =>
    isWithin(bounds, [-119.4, 34.01], 0.1, 0.04)
  );
  assignMatching("santa-cruz-island", (bounds) =>
    isWithin(bounds, [-119.734, 34.026], 0.25, 0.1)
  );
  assignMatching("santa-rosa-island", (bounds) =>
    isWithin(bounds, [-120.109, 33.971], 0.2, 0.1)
  );
  assignMatching("san-miguel-island", (bounds) =>
    isWithin(bounds, [-120.378, 34.043], 0.08, 0.05)
  );
  assignMatching("treasure-island", (bounds) =>
    isWithin(bounds, [-122.3685, 37.8156], 0.035, 0.035)
  );
  assignMatching("angel-island", (bounds) =>
    isWithin(bounds, [-122.4316, 37.8618], 0.035, 0.035)
  );
  assignMatching("south-farallon-island", (bounds) =>
    isWithin(bounds, [-123.007, 37.699], 0.04, 0.035)
  );

  const mainComponentIndex = componentBounds
    .map((bounds, index) => ({ bounds, index }))
    .filter(({ index }) => !assigned.has(index))
    .sort((left, right) => {
      const leftComponent = components[left.index];
      const rightComponent = components[right.index];
      return (rightComponent?.[0]?.length ?? 0) - (leftComponent?.[0]?.length ?? 0);
    })[0]?.index;
  if (mainComponentIndex === undefined) {
    throw new Error("Could not identify the California mainland boundary.");
  }
  assigned.add(mainComponentIndex);
  const mainland = [
    components[mainComponentIndex]!,
    ...(groups.get("delta-islands") ?? []),
  ];

  const expectedCounts: Record<string, number> = {
    "delta-islands": 6,
    "treasure-island": 1,
    "angel-island": 1,
    "south-farallon-island": 2,
    "santa-catalina-island": 1,
    "san-clemente-island": 1,
    "san-nicolas-island": 1,
    "santa-barbara-island": 1,
    "anacapa-islands": 3,
    "santa-cruz-island": 1,
    "santa-rosa-island": 1,
    "san-miguel-island": 2,
  };
  for (const [id, expectedCount] of Object.entries(expectedCounts)) {
    const actualCount = groups.get(id)?.length ?? 0;
    if (actualCount !== expectedCount) {
      throw new Error(
        `Expected ${expectedCount} California boundary components for ${id}; found ${actualCount}.`,
      );
    }
  }

  return {
    type: "FeatureCollection",
    features: [
      makeFeature("mainland", "MAINLAND", mainland),
      makeFeature(
        "south-farallon-island",
        "South Farallon Island",
        groups.get("south-farallon-island") ?? [],
      ),
      makeFeature(
        "treasure-island",
        "Treasure Island",
        groups.get("treasure-island") ?? [],
      ),
      makeFeature("angel-island", "Angel Island", groups.get("angel-island") ?? []),
      makeFeature("anacapa-islands", "Anacapa Islands", groups.get("anacapa-islands") ?? []),
      makeFeature(
        "santa-barbara-island",
        "Santa Barbara Island",
        groups.get("santa-barbara-island") ?? [],
      ),
      makeFeature(
        "santa-catalina-island",
        "Santa Catalina Island",
        groups.get("santa-catalina-island") ?? [],
      ),
      makeFeature(
        "santa-cruz-island",
        "Santa Cruz Island",
        groups.get("santa-cruz-island") ?? [],
      ),
      makeFeature(
        "santa-rosa-island",
        "Santa Rosa Island",
        groups.get("santa-rosa-island") ?? [],
      ),
      makeFeature(
        "san-clemente-island",
        "San Clemente Island",
        groups.get("san-clemente-island") ?? [],
      ),
      makeFeature(
        "san-miguel-island",
        "San Miguel Island",
        groups.get("san-miguel-island") ?? [],
      ),
      makeFeature(
        "san-nicolas-island",
        "San Nicolas Island",
        groups.get("san-nicolas-island") ?? [],
      ),
    ],
  };
}
