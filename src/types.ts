import type { TerrainEmissivePalette } from "./terrain/terrainHeightPalette";

export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoordinates = Ring[];
export type MultiPolygonCoordinates = PolygonCoordinates[];
export type BoundaryGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: MultiPolygonCoordinates };
export type FeatureGeometry = BoundaryGeometry
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] };
export type BoundaryFeature = { type: "Feature"; properties: Record<string, unknown>; geometry: BoundaryGeometry };
export type BoundaryCollection = { type: "FeatureCollection"; features: BoundaryFeature[] };
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type TerrainMetadata = {
  bounds: Bounds;
  center: Position;
  tiles: string[];
  zoomLevels: number[];
};
export type Dataset = {
  counties: BoundaryCollection | null;
  longitudeLatitudeGrid: BoundaryCollection;
  metadata: TerrainMetadata;
  state: BoundaryCollection;
};
export type ViewState = { target: Position; distance: number; azimuth: number; polar: number };
export type MeasurementSystem = "metric" | "imperial";
export type Tile = { z: number; x: number; y: number };
export const COMBINED_IMAGE_PREVIEW_ID = "combined-image-preview";

export type TopographicFeatureCategory =
  | "highways"
  | "interstates"
  | "counties"
  | "peaks"
  | "nationalParks"
  | "nationalForests"
  | "longitudeLatitudeLines"
  | "railways";
export type TopographicFeatureSelections = Record<TopographicFeatureCategory, string[]>;
export type ClipFeatureCategory =
  | "counties"
  | "nationalParks"
  | "nationalForests"
  | "longitudeLatitudeLines";
export type ClipFeatureSelections = Record<ClipFeatureCategory, string[]>;
export type TopographicFeatureOption = {
  id: string;
  label: string;
  detail?: string;
  custom?: boolean;
  geometry?: FeatureGeometry;
  lines?: Position[][];
  position?: Position;
  prominenceMeters?: number;
  isolationKm?: number;
};

export const INITIAL_TOPOGRAPHIC_FEATURE_SELECTIONS: TopographicFeatureSelections = {
  highways: [],
  interstates: [],
  counties: [],
  peaks: [],
  nationalParks: [],
  nationalForests: [],
  longitudeLatitudeLines: [],
  railways: [],
};

export const INITIAL_CLIP_FEATURE_SELECTIONS: ClipFeatureSelections = {
  counties: [],
  nationalParks: [],
  nationalForests: [],
  longitudeLatitudeLines: [],
};

export type ViewSettings = {
  measurementSystem: MeasurementSystem;
  exaggeration: number;
  clip: boolean;
  terrainPalette: TerrainEmissivePalette;
  terrainEmissiveColor: string;
  terrainGradientLowColor: string;
  terrainGradientHighColor: string;
  lightColor: string;
  ambientLightIntensity: number;
  sunAzimuth: number;
  sunElevation: number;
};

type RegionBase = { id: string; name: string; visible?: boolean; clip?: boolean };
export type Region =
  | (RegionBase & {
      type: "ellipse" | "rectangle";
      center: Position;
      width: number;
      height: number;
      rotation?: number;
    })
  | (RegionBase & {
      type: "point";
      position: Position;
      elevationMeters?: number;
    })
  | (RegionBase & { type: "polygon"; points: Position[] })
  | (RegionBase & { type: "polyline"; points: Position[] })
  | (RegionBase & { type: "county"; countyId: string });

export type RegionOverlayPreview = {
  lines: Position[][];
  markerPositions: Position[];
  highlightedRegionIds: string[];
  hiddenRegionIds: string[];
  hiddenHandleIds: string[];
  lineColor: string;
  lineWidth: number;
};

export const INITIAL_VIEW: ViewState = {
  target: [0, 0],
  distance: 1_850,
  azimuth: 0.1,
  polar: 0.92,
};

export const INITIAL_SETTINGS: ViewSettings = {
  measurementSystem: "metric",
  exaggeration: 3,
  clip: false,
  terrainPalette: "grayscale",
  terrainEmissiveColor: "#404040",
  terrainGradientLowColor: "#152273",
  terrainGradientHighColor: "#f98c88",
  lightColor: "#bfbfbf",
  ambientLightIntensity: 0.15,
  sunAzimuth: 231,
  sunElevation: 15,
};
