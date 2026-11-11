import { union, type MultiPolygon } from "polygon-clipping";
import type { Bounds, Position } from "../types";
import type { BoundaryCollection, BoundaryFeature } from "../types";

export type EcoregionMapMetadata = {
  projection: "EPSG:3857";
  resolutionMeters: number;
  paddingPixels: number;
  width: number;
  height: number;
  bounds: Bounds;
};

type EcoregionGroup = {
  name: string;
  level3Name: string;
  polygons: MultiPolygon[];
};

export function dissolveEcoregionFeatures(
  collection: BoundaryCollection,
): BoundaryCollection {
  const groups = new Map<string, EcoregionGroup>();
  for (const [index, feature] of collection.features.entries()) {
    const rawCode = feature.properties.US_L4CODE;
    const rawName = feature.properties.US_L4NAME;
    const rawLevel3Name = feature.properties.US_L3NAME;
    if (
      (typeof rawCode !== "string" && typeof rawCode !== "number") ||
      typeof rawName !== "string" ||
      typeof rawLevel3Name !== "string" ||
      !String(rawCode).trim() ||
      !rawName.trim() ||
      !rawLevel3Name.trim()
    ) {
      throw new Error(`Ecoregion shapefile feature ${index + 1} is missing its region ID or name.`);
    }

    const code = String(rawCode).trim();
    const name = rawName.trim();
    const level3Name = rawLevel3Name.trim();
    let group = groups.get(code);
    if (!group) {
      group = { name, level3Name, polygons: [] };
      groups.set(code, group);
    } else if (group.name !== name || group.level3Name !== level3Name) {
      throw new Error(`Ecoregion ${code} has inconsistent region names.`);
    }

    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    group.polygons.push(...polygons.map((polygon) => [polygon] as MultiPolygon));
  }

  const features: BoundaryFeature[] = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([code, group]) => {
      const [first, ...additional] = group.polygons;
      if (!first) throw new Error(`Ecoregion ${code} has no polygon geometry.`);
      const coordinates = union(first, ...additional);
      if (coordinates.length === 0) {
        throw new Error(`Ecoregion ${code} produced no dissolved polygon geometry.`);
      }
      return {
        type: "Feature",
        properties: {
          US_L4CODE: code,
          US_L4NAME: group.name,
          US_L3NAME: group.level3Name,
        },
        geometry: {
          type: "MultiPolygon",
          coordinates: coordinates as Position[][][],
        },
      };
    });

  if (features.length === 0) {
    throw new Error("The ecoregion shapefile contains no Level IV regions.");
  }
  return { type: "FeatureCollection", features };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseEcoregionMapMetadata(value: unknown): EcoregionMapMetadata {
  if (!isRecord(value) || !isRecord(value.bounds)) {
    throw new Error("Ecoregion map metadata is missing its bounds.");
  }
  const { projection, resolutionMeters, paddingPixels, width, height, bounds } = value;
  const boundValues = ["minX", "minY", "maxX", "maxY"].map((key) => bounds[key]);
  if (
    projection !== "EPSG:3857" ||
    typeof resolutionMeters !== "number" ||
    !Number.isFinite(resolutionMeters) ||
    resolutionMeters <= 0 ||
    typeof paddingPixels !== "number" ||
    !Number.isInteger(paddingPixels) ||
    paddingPixels < 0 ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !boundValues.every((bound) => typeof bound === "number" && Number.isFinite(bound))
  ) {
    throw new Error("Ecoregion map metadata contains invalid dimensions or projection.");
  }
  const [minX, minY, maxX, maxY] = boundValues as number[];
  if (
    minX === undefined || minY === undefined || maxX === undefined || maxY === undefined ||
    maxX <= minX || maxY <= minY
  ) {
    throw new Error("Ecoregion map metadata has invalid projected bounds.");
  }
  return {
    projection,
    resolutionMeters,
    paddingPixels,
    width,
    height,
    bounds: { minX, minY, maxX, maxY },
  };
}

export function getEcoregionMapLocalBounds(
  bounds: Bounds,
  center: Position,
): [number, number, number, number] {
  return [
    (bounds.minX - center[0]) / 1_000,
    (bounds.minY - center[1]) / 1_000,
    (bounds.maxX - center[0]) / 1_000,
    (bounds.maxY - center[1]) / 1_000,
  ];
}
