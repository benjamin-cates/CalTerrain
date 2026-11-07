import { countyId, countyName, fromLocal } from "./geo";
import { regionGeometry } from "./regions";
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
  return collection.features
    .filter((feature) => selected.has(getId(feature)))
    .map((feature) => ({
      type: "Feature",
      properties: {
        ...feature.properties,
        id: clipFeatureExportRegionId(category, getId(feature)),
        name: getName(feature),
        category: CLIP_FEATURE_CATEGORY_NAMES[category],
      },
      geometry: feature.geometry,
    }));
}

export function createRegionBoundaryExport(
  regions: Region[],
  clipSelections: ClipFeatureSelections,
  center: Position,
  counties: BoundaryCollection | null,
  nationalParks: BoundaryCollection | null,
  nationalForests: BoundaryCollection | null,
  longitudeLatitudeLines: BoundaryCollection | null,
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

  const boundaryFeatures = [
    ...selectedBoundaryFeatures(
      counties,
      clipSelections.counties,
      countyId,
      countyName,
      "counties",
    ),
    ...selectedBoundaryFeatures(
      nationalParks,
      clipSelections.nationalParks,
      (feature) => String(feature.properties.UNIT_CODE ?? "").trim(),
      (feature) => String(feature.properties.UNIT_NAME ?? "").trim(),
      "nationalParks",
    ),
    ...selectedBoundaryFeatures(
      nationalForests,
      clipSelections.nationalForests,
      (feature) => String(feature.properties.forestorgc ?? "").trim(),
      (feature) => String(feature.properties.forestname ?? "").trim(),
      "nationalForests",
    ),
    ...selectedBoundaryFeatures(
      longitudeLatitudeLines,
      clipSelections.longitudeLatitudeLines,
      (feature) => String(feature.properties.cellId ?? ""),
      (feature) => String(feature.properties.name ?? ""),
      "longitudeLatitudeLines",
    ),
  ];

  return {
    type: "FeatureCollection",
    features: [...customFeatures, ...boundaryFeatures],
  };
}
