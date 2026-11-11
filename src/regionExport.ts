import { countyId, countyName, fromLocal } from "./geo";
import { regionGeometry } from "./regions/geometry";
import type {
  BoundaryCollection,
  BoundaryFeature,
  ClipFeatureCategory,
  ClipFeatureSelections,
  Position,
  Region,
} from "./types";

const EMPTY_BOUNDARIES: BoundaryCollection = {
  type: "FeatureCollection",
  features: [],
};

const CLIP_FEATURE_CATEGORY_NAMES: Record<ClipFeatureCategory, string> = {
  counties: "County",
  nationalParks: "National park",
  nationalForests: "National forest",
  longitudeLatitudeLines: "Longitude and latitude cell",
  ecoregions: "Ecoregion",
};

export function clipFeatureExportRegionId(
  category: ClipFeatureCategory,
  featureId: string,
): string {
  return `${CLIP_FEATURE_CATEGORY_NAMES[category]}:${featureId}`;
}

function selectedBoundaryFeatures(
  collection: BoundaryCollection | null,
  selectedIds: string[],
  getId: (feature: BoundaryFeature) => string,
  getName: (feature: BoundaryFeature) => string,
  category: ClipFeatureCategory,
): BoundaryFeature[] {
  if (!collection || selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  return collection.features.flatMap((feature) => {
    const featureId = getId(feature);
    if (!selected.has(featureId)) return [];
    return [{
      type: "Feature" as const,
      properties: {
        ...feature.properties,
        id: clipFeatureExportRegionId(category, featureId),
        name: getName(feature),
        category: CLIP_FEATURE_CATEGORY_NAMES[category],
      },
      geometry: feature.geometry,
    }];
  });
}

export function createRegionBoundaryExport(
  regions: Region[],
  clipSelections: ClipFeatureSelections,
  center: Position,
  counties: BoundaryCollection | null,
  nationalParks: BoundaryCollection | null,
  nationalForests: BoundaryCollection | null,
  longitudeLatitudeLines: BoundaryCollection | null,
  ecoregions: BoundaryCollection | null,
): BoundaryCollection {
  const customFeatures: BoundaryFeature[] = regions
    .filter((region) =>
      region.type !== "county" &&
      region.type !== "point" &&
      region.type !== "polyline" &&
      region.clip === true
    )
    .flatMap((region) => {
      const line = regionGeometry(region, center, EMPTY_BOUNDARIES).lines[0];
      if (!line || line.length < 4) return [];
      return [{
        type: "Feature",
        properties: { id: region.id, name: region.name, category: "Custom shape" },
        geometry: {
          type: "Polygon",
          coordinates: [line.map((point) => fromLocal(point, center))],
        },
      }];
    });

  const boundarySources = [
    { collection: counties, category: "counties", getId: countyId, getName: countyName },
    {
      collection: nationalParks,
      category: "nationalParks",
      getId: (feature: BoundaryFeature) => String(feature.properties.UNIT_CODE ?? "").trim(),
      getName: (feature: BoundaryFeature) => String(feature.properties.UNIT_NAME ?? "").trim(),
    },
    {
      collection: nationalForests,
      category: "nationalForests",
      getId: (feature: BoundaryFeature) => String(feature.properties.forestorgc ?? "").trim(),
      getName: (feature: BoundaryFeature) => String(feature.properties.forestname ?? "").trim(),
    },
    {
      collection: longitudeLatitudeLines,
      category: "longitudeLatitudeLines",
      getId: (feature: BoundaryFeature) => String(feature.properties.cellId ?? ""),
      getName: (feature: BoundaryFeature) => String(feature.properties.name ?? ""),
    },
    {
      collection: ecoregions,
      category: "ecoregions",
      getId: (feature: BoundaryFeature) => String(feature.properties.US_L4CODE ?? "").trim(),
      getName: (feature: BoundaryFeature) => String(feature.properties.US_L4NAME ?? "").trim(),
    },
  ] as const;
  const boundaryFeatures = boundarySources.flatMap((source) =>
    selectedBoundaryFeatures(
      source.collection,
      clipSelections[source.category],
      source.getId,
      source.getName,
      source.category,
    )
  );

  return {
    type: "FeatureCollection",
    features: [...customFeatures, ...boundaryFeatures],
  };
}
