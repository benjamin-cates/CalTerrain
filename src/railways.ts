import type {
  ShapefileFeature,
  ShapefileResult,
} from "shpjs";
import type { Position, TopographicFeatureOption } from "./types";

type RailwayGeometry = Extract<
  NonNullable<ShapefileFeature["geometry"]>,
  { type: "LineString" | "MultiLineString" }
>;

export type RailwayFeature = {
  type: "Feature";
  properties: Record<string, unknown> & { name: string };
  geometry: RailwayGeometry;
};

export type RailwayFeatureCollection = {
  type: "FeatureCollection";
  features: RailwayFeature[];
};

function isValidLine(coordinates: Position[]): boolean {
  return coordinates.length >= 2 &&
    coordinates.every((position) =>
      Number.isFinite(position[0]) && Number.isFinite(position[1])
    );
}

function isRailwayGeometry(
  geometry: ShapefileFeature["geometry"],
): geometry is RailwayGeometry {
  if (!geometry) return false;
  if (geometry.type === "LineString") {
    return isValidLine(geometry.coordinates);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.length > 0 &&
      geometry.coordinates.every(isValidLine);
  }
  return false;
}

export function parseRailwayShapefile(parsed: ShapefileResult): RailwayFeatureCollection {
  if (Array.isArray(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("Railway shapefile must contain one feature collection.");
  }

  const seenNames = new Set<string>();
  const features: RailwayFeature[] = [];
  for (const [index, feature] of parsed.features.entries()) {
    const rawName = feature.properties.name;
    if (typeof rawName !== "string" || !rawName.trim() || !isRailwayGeometry(feature.geometry)) {
      throw new Error(`Railway shapefile feature ${index + 1} is missing a name or line geometry.`);
    }
    const name = rawName.trim();
    if (seenNames.has(name)) {
      throw new Error(`Railway shapefile contains duplicate route name "${name}".`);
    }
    seenNames.add(name);
    features.push({
      type: "Feature",
      properties: { ...feature.properties, name },
      geometry: feature.geometry,
    });
  }

  if (features.length === 0) {
    throw new Error("Railway shapefile contains no routes.");
  }
  return { type: "FeatureCollection", features };
}

export function getRailwayFeatureOptions(
  collection: RailwayFeatureCollection,
): TopographicFeatureOption[] {
  return collection.features.map((feature) => ({
    id: feature.properties.name,
    label: feature.properties.name,
    lines: feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates,
  }));
}
