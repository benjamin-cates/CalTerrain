import shp, { type ShapefileResult } from "shpjs";
import type {
  BoundaryCollection,
  BoundaryFeature,
  TopographicFeatureOption,
} from "../types";

export function filterBoundaryCollection(parsed: ShapefileResult): BoundaryCollection | null {
  if (Array.isArray(parsed) || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    return null;
  }
  const features: BoundaryFeature[] = [];
  for (const feature of parsed.features) {
    const geometry = feature.geometry;
    if (geometry === null) continue;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
      return null;
    }
    features.push({ type: "Feature", properties: feature.properties, geometry });
  }
  return features.length > 0 ? { type: "FeatureCollection", features } : null;
}

export async function fetchBoundaryShapefile(
  url: string,
  label: string,
): Promise<BoundaryCollection> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} boundary data could not be loaded.`);
  }
  const parsed = await shp(await response.arrayBuffer());
  const collection = filterBoundaryCollection(parsed);
  if (!collection) {
    throw new Error(`${label} boundary shapefile is incomplete or contains unsupported geometry.`);
  }
  return collection;
}

export async function fetchBoundaryGeoJson(
  url: string,
  label: string,
): Promise<BoundaryCollection> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} boundary data could not be loaded.`);
  }
  const collection = filterBoundaryCollection(await response.json());
  if (!collection) {
    throw new Error(`${label} boundary GeoJSON is incomplete or contains unsupported geometry.`);
  }
  return collection;
}

export function getBoundaryFeatureOptions(
  collection: BoundaryCollection,
  label: string,
  idField: string,
  nameField: string,
): TopographicFeatureOption[] {
  const seenIds = new Set<string>();
  const options = collection.features.map((feature, index) => {
    const rawId = feature.properties[idField];
    const rawName = feature.properties[nameField];
    if (
      (typeof rawId !== "string" && typeof rawId !== "number") ||
      typeof rawName !== "string" ||
      !String(rawId).trim() ||
      !rawName.trim()
    ) {
      throw new Error(`${label} boundary feature ${index + 1} is missing its ID or name.`);
    }
    const id = String(rawId).trim();
    if (seenIds.has(id)) {
      throw new Error(`${label} boundary shapefile contains duplicate feature IDs.`);
    }
    seenIds.add(id);
    return { id, label: rawName.trim(), geometry: feature.geometry };
  });
  return options.sort((left, right) => left.label.localeCompare(right.label));
}
