import type { ShapefileFeature, ShapefileResult } from "shpjs";
import type { Position, TopographicFeatureOption } from "./types";

type RiverGeometry = Extract<
  NonNullable<ShapefileFeature["geometry"]>,
  { type: "LineString" | "MultiLineString" }
>;

export type RiverFeature = {
  type: "Feature";
  properties: { name: string };
  geometry: RiverGeometry;
};

export type RiverFeatureCollection = {
  type: "FeatureCollection";
  features: RiverFeature[];
};

function isValidLine(coordinates: Position[]): boolean {
  return coordinates.length >= 2 &&
    coordinates.every((position) =>
      Number.isFinite(position[0]) && Number.isFinite(position[1])
    );
}

function isRiverGeometry(
  geometry: ShapefileFeature["geometry"],
): geometry is RiverGeometry {
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

export function parseRiverShapefile(parsed: ShapefileResult): RiverFeatureCollection {
  if (Array.isArray(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error("River shapefile must contain one feature collection.");
  }

  const seenNames = new Set<string>();
  const features: RiverFeature[] = [];
  for (const [index, feature] of parsed.features.entries()) {
    const rawName = feature.properties.name;
    if (typeof rawName !== "string" || !rawName.trim() || !isRiverGeometry(feature.geometry)) {
      throw new Error(`River shapefile feature ${index + 1} is missing a name or line geometry.`);
    }
    const name = rawName.trim();
    if (seenNames.has(name)) {
      throw new Error(`River shapefile contains duplicate river name "${name}".`);
    }
    seenNames.add(name);
    features.push({
      type: "Feature",
      properties: { name },
      geometry: feature.geometry,
    });
  }

  if (features.length === 0) {
    throw new Error("River shapefile contains no rivers.");
  }
  return { type: "FeatureCollection", features };
}

export function getRiverFeatureOptions(
  collection: RiverFeatureCollection,
): TopographicFeatureOption[] {
  return collection.features.map((feature) => ({
    id: feature.properties.name,
    label: feature.properties.name,
    lines: feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates,
  }));
}
