import {
  useCallback,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { ElevationProfilePopup } from "./ElevationProfilePopup";
import type { ElevationProfile, ElevationExtremum } from "./terrain/elevationAnalysis";
import {
  formatLatitudeLongitudePoints,
  parseLatitudeLongitudePoints,
} from "./regions/pointList";
import { bisectPolygonClosingEdge } from "./regions/geometry";
import { mergeRiverLinePaths } from "./features/rivers";
import {
  customRegionGeometries,
  featureGeometryPositions,
  linePiecesFromGeometries,
  measureLineGeometries,
  measurePolygonGeometries,
  polygonPiecesFromGeometries,
} from "./regions/analysis";
import type { MountainPeak } from "./features/mountains";
import type { NewCustomMountainPeak } from "./features/useCustomMountainPeaks";
import {
  connectPolylines,
  clipPolylineToRegion,
  positionAtLineDistance,
  polylineLengthMeters,
  shiftPolygonStart,
  trimPolyline,
  type PolygonOperation,
  type PolylineEnd,
} from "./regions/operations";
import {
  distanceFromDisplay,
  distanceToDisplay,
  distanceUnit,
  elevationFromDisplay,
  elevationToDisplay,
  elevationUnit,
  formatElevation,
  formatLength,
} from "./units";
import { RegionEditor, ShapePointsEditor } from "./sidebar/RegionEditors";
import { MorePopup } from "./sidebar/MorePopup";
import { ExportSection } from "./sidebar/ExportSection";
import { HEIGHT_PALETTES } from "./sidebar/heightPalettes";
import {
  FeatureOptionsPopup,
  type CategorizedFeatureOption,
} from "./sidebar/FeatureOptionsPopup";
import type {
  TerrainExportRegion,
  TerrainExportTriangleReport,
} from "./terrain/terrainExport";
import type { TerrainHeightPalette } from "./terrain/terrainHeightPalette";
import type {
  Position,
  Region,
  RegionOperationPreview,
  NearbyShapes,
  FeatureGeometry,
  ClipFeatureCategory,
  ClipFeatureSelections,
  TopographicFeatureCategory,
  TopographicFeatureOption,
  TopographicFeatureSelections,
  ViewSettings,
} from "./types";

type Props = {
  settings: ViewSettings;
  onSettingsChange: (settings: ViewSettings) => void;
  regions: Region[];
  center: Position | null;
  selectedRegionId: string | null;
  clipExportRegions: { id: string; name: string }[];
  canExportClipRegions: boolean;
  onExportClipRegions: () => void;
  terrainExportBusy: boolean;
  terrainExportStatus: string | null;
  terrainExportError: string | null;
  terrainExportRegions: TerrainExportRegion[];
  terrainExportGroundScale: number;
  terrainExportTriangleReport: TerrainExportTriangleReport | null;
  onExportTerrainRegion: (
    regionId: string,
    resolutionMeters: number,
    californiaLatitudeSpanMeters: number,
  ) => void;
  onExportTerrainZip: (resolutionMeters: number, californiaLatitudeSpanMeters: number) => void;
  onExportTerrainCombined: (
    resolutionMeters: number,
    californiaLatitudeSpanMeters: number,
  ) => void;
  onExportImageRegion: (regionId: string, resolutionMeters: number) => void;
  onExportImageCombined: (resolutionMeters: number) => void;
  onExportImageZip: (resolutionMeters: number) => void;
  exportFormat: "image" | "model";
  onSetExportFormat: (format: "image" | "model") => void;
  resolutionIndex: number;
  onSetResolutionIndex: (index: number) => void;
  selectedImageRegionId: string | null;
  onSelectImageRegion: (regionId: string) => void;
  heightPalette: TerrainHeightPalette;
  onSetHeightPalette: (palette: TerrainHeightPalette) => void;
  topographicOptions: Record<TopographicFeatureCategory, TopographicFeatureOption[]>;
  topographicSelections: TopographicFeatureSelections;
  clipSelections: ClipFeatureSelections;
  topographicStatus: Record<TopographicFeatureCategory, { loading: boolean; error: string | null }>;
  customPeaksLoaded: boolean;
  customPeakStorageError: string | null;
  onRequestTopographicData: (category: TopographicFeatureCategory) => void;
  onToggleTopographicFeature: (
    category: TopographicFeatureCategory,
    id: string,
    enabled: boolean,
  ) => void;
  onToggleClipFeature: (
    category: ClipFeatureCategory,
    id: string,
    enabled: boolean,
  ) => void;
  onSetAllTopographicFeatures: (category: TopographicFeatureCategory, enabled: boolean) => void;
  onAddCustomPeak: (peak: NewCustomMountainPeak) => void;
  onRemoveCustomPeak: (id: string) => void;
  onAdd: (type: Exclude<Region["type"], "county" | "point">) => void;
  onAppendPolylinePoint: (regionId: string) => void;
  onConvertRegion: (regionId: string) => void;
  onConvertFeature: (category: TopographicFeatureCategory, id: string) => void;
  onTrimPolyline: (regionId: string, points: Position[]) => void;
  onClipPolyline: (regionId: string, lines: Position[][]) => void;
  onConnectPolylines: (regionId: string, otherRegionId: string, points: Position[]) => void;
  onCombineRegions: (
    regionId: string,
    otherRegionId: string,
    operation: PolygonOperation,
  ) => string | null;
  onRegionPreviewChange: (preview: RegionOperationPreview | null) => void;
  onFocusRegion: (regionId: string) => void;
  onFocusFeature: (category: TopographicFeatureCategory, id: string) => void;
  nearbyShapes: NearbyShapes | null;
  onDismissNearbyShapes: () => void;
  activeRegionDragIdRef: { current: string | null };
  onCreateElevationPoint: (
    geometries: FeatureGeometry[],
    lines: Position[][],
    extremum: ElevationExtremum,
    sourceName: string,
  ) => Promise<void>;
  onCreateElevationProfile: (lines: Position[][]) => Promise<ElevationProfile>;
  onSampleElevation: (position: Position) => Promise<number | null>;
  onAddSamplePoint: (position: Position, elevationMeters: number, sourceName: string) => void;
  placingCustomPoint: boolean;
  onStartCustomPointPlacement: () => void;
  onAddCurrentLocation: (position: Position) => void;
  onSelect: (id: string | null) => void;
  onUpdate: (region: Region) => void;
  onRemove: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onToggleClip: (id: string) => void;
};

type FeatureCategoryButton = {
  id: TopographicFeatureCategory;
  label: string;
  categories?: TopographicFeatureCategory[];
};

function compareHighwayFeatureOptions(
  left: CategorizedFeatureOption,
  right: CategorizedFeatureOption,
): number {
  const leftNumber = Number(left.option.label.match(/\d+/)?.[0] ?? Number.POSITIVE_INFINITY);
  const rightNumber = Number(right.option.label.match(/\d+/)?.[0] ?? Number.POSITIVE_INFINITY);
  return leftNumber - rightNumber ||
    left.category.localeCompare(right.category);
}

type MoreTarget =
  | { kind: "region"; id: string; selectedRegionIdAtOpen: string | null }
  | {
    kind: "feature";
    category: TopographicFeatureCategory;
    id: string;
    selectedRegionIdAtOpen: string | null;
  };

type MorePage =
  | "sample"
  | "shift-start"
  | "trim"
  | "clip"
  | "connect"
  | "union"
  | "intersection"
  | "difference";

function regionTypeLabel(region: Region): string {
  if (region.type === "ellipse") return "Circle";
  if (region.type === "rectangle") return "Rectangle";
  if (region.type === "county") return "County";
  if (region.type === "point") return "Point";
  return region.type === "polygon" ? "Polygon" : "Line";
}

function polylineEndPosition(points: Position[], end: PolylineEnd): Position | undefined {
  return end === "start" ? points[0] : points.at(-1);
}

function featureTypeLabel(category: TopographicFeatureCategory): string {
  switch (category) {
    case "highways": return "Highway route";
    case "interstates": return "Interstate route";
    case "rivers": return "River";
    case "counties": return "County";
    case "peaks": return "Mountain peak";
    case "nationalParks": return "National park";
    case "nationalForests": return "National forest";
    case "longitudeLatitudeLines": return "Latitude/longitude cell";
    case "railways": return "Railway route";
    case "ecoregions": return "Ecoregion";
  }
}

const TOPOGRAPHIC_CATEGORIES: FeatureCategoryButton[] = [
  { id: "ecoregions", label: "Ecoregions" },
  { id: "peaks", label: "Mountain peaks" },
  { id: "rivers", label: "Rivers" },
];

const MANMADE_CATEGORIES: FeatureCategoryButton[] = [
  { id: "counties", label: "Counties" },
  { id: "longitudeLatitudeLines", label: "Long/Lat borders" },
  { id: "nationalForests", label: "National forests" },
  { id: "nationalParks", label: "National parks" },
  { id: "highways", label: "Highways & Interstates", categories: ["highways", "interstates"] },
  { id: "railways", label: "Passenger rail" },
];

const FEATURE_SOURCES: Partial<Record<TopographicFeatureCategory, { label: string; href: string }>> = {
  highways: {
    label: "California Highways and Interstates",
    href: "https://gis.data.ca.gov/datasets/8aa7227fac664e9cb72c8a62f0d43bd5_0/explore",
  },
  interstates: {
    label: "California Highways and Interstates",
    href: "https://gis.data.ca.gov/datasets/8aa7227fac664e9cb72c8a62f0d43bd5_0/explore",
  },
  rivers: {
    label: "National Hydrography Dataset (NHD)",
    href: "https://data.cnra.ca.gov/dataset/national-hydrography-dataset-nhd",
  },
  counties: {
    label: "California County Boundaries and Identifiers",
    href: "https://gis.data.ca.gov/datasets/California::california-county-boundaries-and-identifiers/explore",
  },
  peaks: {
    label: "List of Mountain Peaks of California (Wikipedia)",
    href: "https://en.wikipedia.org/wiki/List_of_mountain_peaks_of_California",
  },
  nationalParks: {
    label: "National Parks (USDOT Open Data)",
    href: "https://data-usdot.opendata.arcgis.com/datasets/usdot::national-parks/explore",
  },
  nationalForests: {
    label: "Forest Administrative Boundaries (U.S. Forest Service)",
    href: "https://data-usfs.hub.arcgis.com/datasets/usfs::forest-administrative-boundaries-feature-layer/explore",
  },
  ecoregions: {
    label: "EPA Level IV Ecoregions",
    href: "https://www.epa.gov/eco-research/ecoregions-north-america",
  },
};

function isClipFeatureCategory(category: TopographicFeatureCategory): category is ClipFeatureCategory {
  return category === "counties" ||
    category === "nationalParks" ||
    category === "nationalForests" ||
    category === "longitudeLatitudeLines" ||
    category === "ecoregions";
}

function VisibilityIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 3l14 14M8.2 5.2A9.9 9.9 0 0 1 10 5c4.2 0 7 5 7 5a13 13 0 0 1-2.1 2.6M6.1 6.1C4.1 7.3 3 10 3 10s2.8 5 7 5a7.7 7.7 0 0 0 2-.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="10" cy="4" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="10" cy="16" r="1.5" />
    </svg>
  );
}

function KnifeIcon() {
  return (
    <svg viewBox="0 0 86 98" fill="currentColor" aria-hidden="true">
      <path d="M17 67.5C19.5 67.5 29 77.5 29 79.5C29 81.5 14.5 97.5 12.4227 97.5C10.3453 97.5 0 87 0 84.5C0 82 14.5 67.5 17 67.5Z" />
      <path d="M84.5 0L22 62.5L36 76.5C36 76.5 37 77.5 39 79C41 80.5 66 56.5 75.5 39.5C87.3357 19 87.0929 5.44502 84.5 0Z" />
    </svg>
  );
}

export const Sidebar = memo(function Sidebar(props: Props) {
  const { settings } = props;
  const shapeRegions = props.regions.filter(
    (region): region is Exclude<Region, { type: "county" }> => region.type !== "county",
  );
  const regionLabels = new Map<string, string>();
  const regionCounts = new Map<Region["type"], number>();
  for (const region of shapeRegions) {
    const number = (regionCounts.get(region.type) ?? 0) + 1;
    regionCounts.set(region.type, number);
    const typeLabel = regionTypeLabel(region);
    regionLabels.set(
      region.id,
      region.isConverted ? `${typeLabel}: ${region.name}` : `${typeLabel} ${number}`,
    );
  }
  const [featurePanel, setFeaturePanel] = useState<TopographicFeatureCategory | null>(null);
  const [featurePanelPosition, setFeaturePanelPosition] = useState({ top: 16, left: 320 });
  const [moreTarget, setMoreTarget] = useState<MoreTarget | null>(null);
  const [morePosition, setMorePosition] = useState({ top: 16, left: 320 });
  const [morePage, setMorePage] = useState<MorePage | null>(null);
  const [moreActionError, setMoreActionError] = useState<string | null>(null);
  const [featureSearchQuery, setFeatureSearchQuery] = useState("");
  const [nearbyListLeft, setNearbyListLeft] = useState<number | null>(null);
  const [samplePercent, setSamplePercent] = useState(50);
  const [sampleElevationMeters, setSampleElevationMeters] = useState<number | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [polygonStartIndex, setPolygonStartIndex] = useState("1");
  const [extremumLoading, setExtremumLoading] = useState<ElevationExtremum | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [elevationProfile, setElevationProfile] = useState<ElevationProfile | null>(null);
  const [profileName, setProfileName] = useState("");
  const [trimStartMeters, setTrimStartMeters] = useState(0);
  const [trimEndMeters, setTrimEndMeters] = useState(0);
  const [connectOtherId, setConnectOtherId] = useState<string | null>(null);
  const [clipRegionId, setClipRegionId] = useState<string | null>(null);
  const [combineOtherId, setCombineOtherId] = useState<string | null>(null);
  const [connectEnds, setConnectEnds] = useState<{
    current: PolylineEnd;
    other: PolylineEnd;
  }>({ current: "end", other: "start" });
  const [pointsEditorRegionId, setPointsEditorRegionId] = useState<string | null>(null);
  const [pointsEditorPosition, setPointsEditorPosition] = useState({ top: 16, left: 320 });
  const [pointsTransferBusy, setPointsTransferBusy] = useState(false);
  const [currentLocationLoading, setCurrentLocationLoading] = useState(false);
  const [currentLocationError, setCurrentLocationError] = useState<string | null>(null);
  const [pointsTransferFeedback, setPointsTransferFeedback] = useState<{
    regionId: string;
    message: string;
    error: boolean;
  } | null>(null);
  const [customPeakDialogOpen, setCustomPeakDialogOpen] = useState(false);
  const [customPeakForm, setCustomPeakForm] = useState({
    name: "",
    range: "",
    latitude: "",
    longitude: "",
    elevation: "",
    prominence: "",
    isolation: "",
  });
  const [customPeakFormError, setCustomPeakFormError] = useState<string | null>(null);
  const featurePanelRef = useRef<HTMLDivElement>(null);
  const featureListRef = useRef<HTMLDivElement>(null);
  const featurePanelButtonRef = useRef<HTMLButtonElement>(null);
  const morePopupRef = useRef<HTMLDivElement>(null);
  const nearbyShapesRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const extremumRequestRef = useRef(0);
  const sampleRequestRef = useRef(0);
  const profileRequestRef = useRef(0);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const pointsEditorRef = useRef<HTMLDivElement>(null);
  const pointsEditorTriggerRef = useRef<HTMLDivElement>(null);
  const pointsClipboardOperationRef = useRef(0);
  const enableAllRef = useRef<HTMLInputElement>(null);
  const closePointsEditor = useCallback(() => {
    pointsClipboardOperationRef.current += 1;
    setPointsEditorRegionId(null);
    setPointsTransferBusy(false);
    setPointsTransferFeedback(null);
  }, []);
  const distanceUnitLabel = distanceUnit(settings.measurementSystem);
  const elevationUnitLabel = elevationUnit(settings.measurementSystem);
  const pointsEditorRegion = shapeRegions.find(
    (region): region is Extract<Region, { type: "polygon" | "polyline" }> =>
      region.id === pointsEditorRegionId &&
      (region.type === "polygon" || region.type === "polyline"),
  );
  const moreRegion = moreTarget?.kind === "region"
    ? shapeRegions.find((region) => region.id === moreTarget.id)
    : undefined;
  const otherPolylineRegions = moreRegion?.type === "polyline"
    ? shapeRegions.filter((region): region is Extract<Region, { type: "polyline" }> =>
      region.type === "polyline" && region.id !== moreRegion.id)
    : [];
  const clipRegionCandidates = moreRegion?.type === "polyline"
    ? shapeRegions.filter((region) =>
      region.id !== moreRegion.id &&
      region.type !== "point" &&
      region.type !== "polyline"
    )
    : [];
  const selectedClipRegion = clipRegionCandidates.find((region) => region.id === clipRegionId);
  const combineRegionCandidates = moreRegion &&
    (moreRegion.type === "polygon" || moreRegion.type === "ellipse" || moreRegion.type === "rectangle")
    ? shapeRegions.filter((region) =>
      region.id !== moreRegion.id &&
      region.type !== "point" &&
      (region.type !== "polyline" ||
        new Set(region.points.map(([longitude, latitude]) => `${longitude},${latitude}`)).size >= 3)
    )
    : [];
  const selectedConnectRegion = otherPolylineRegions.find((region) => region.id === connectOtherId);
  const selectedCombineRegion = combineRegionCandidates.find((region) => region.id === combineOtherId);
  const moreFeatureCategory = moreTarget?.kind === "feature" ? moreTarget.category : null;
  const moreFeatureOption = moreFeatureCategory
    ? props.topographicOptions[moreFeatureCategory].find((option) => option.id === moreTarget?.id)
    : undefined;
  const moreGeometries: FeatureGeometry[] = moreRegion && props.center
    ? customRegionGeometries(moreRegion, props.center)
    : moreFeatureOption?.geometry ? [moreFeatureOption.geometry] : [];
  const moreLineGeometries = useMemo(() => {
    if (moreRegion?.type === "polyline") return [moreRegion.points];
    if (moreFeatureOption?.lines) return moreFeatureOption.lines;
    return linePiecesFromGeometries(
      moreFeatureOption?.geometry ? [moreFeatureOption.geometry] : [],
    );
  }, [moreFeatureOption, moreRegion]);
  const hasPolygonGeometry = moreGeometries.some((geometry) =>
    geometry.type === "Polygon" || geometry.type === "MultiPolygon"
  );
  const polygonMeasurements = hasPolygonGeometry
    ? measurePolygonGeometries(moreGeometries)
    : undefined;
  const lineLengthMeters = moreLineGeometries.length > 0
    ? measureLineGeometries(moreLineGeometries)
    : undefined;
  const sampleDistanceMeters = (lineLengthMeters ?? 0) * samplePercent / 100;
  const samplePosition = useMemo(() => moreLineGeometries.length > 0 &&
    (lineLengthMeters ?? 0) > 0 &&
    props.center
    ? positionAtLineDistance(moreLineGeometries, sampleDistanceMeters, props.center)
    : null,
    [lineLengthMeters, moreLineGeometries, props.center, sampleDistanceMeters]);
  const polygonPointCount = moreRegion?.type === "polygon"
    ? moreRegion.points.length - (
      moreRegion.points.length > 1 &&
        moreRegion.points[0]?.[0] === moreRegion.points.at(-1)?.[0] &&
        moreRegion.points[0]?.[1] === moreRegion.points.at(-1)?.[1]
        ? 1
        : 0
    )
    : 0;
  const trimTotalMeters = moreRegion?.type === "polyline" && props.center
    ? polylineLengthMeters(moreRegion.points)
    : 0;
  const trimStartLimit = Math.max(0, trimTotalMeters - trimEndMeters - 0.1);
  const trimEndLimit = Math.max(0, trimTotalMeters - trimStartMeters - 0.1);
  const moreName = moreRegion?.name ?? moreFeatureOption?.label;
  const moreType = moreRegion
    ? regionTypeLabel(moreRegion)
    : moreFeatureCategory ? featureTypeLabel(moreFeatureCategory) : undefined;
  const moreConvertLabel = moreRegion
    ? moreRegion.type === "point"
      ? undefined
      : moreRegion.type === "polygon"
        ? "Convert to polyline"
        : "Convert to polygon"
    : moreFeatureCategory === "peaks"
      ? "Convert to point"
      : hasPolygonGeometry
        ? "Convert to polygons"
        : moreLineGeometries.length > 0
          ? "Convert to polylines"
          : undefined;
  const moreConversionDisabled = moreRegion?.type === "polyline"
    ? new Set(moreRegion.points.map((point) => `${point[0]},${point[1]}`)).size < 3
    : moreFeatureCategory === "peaks"
      ? !moreFeatureOption?.position
      : false;
  const parsedPolygonStartIndex = Number(polygonStartIndex);
  const polygonStartIndexValid = Number.isInteger(parsedPolygonStartIndex) &&
    parsedPolygonStartIndex >= 1 &&
    parsedPolygonStartIndex <= polygonPointCount;
  const polygonStartPreviewPosition = moreRegion?.type === "polygon" &&
    polygonStartIndexValid
    ? moreRegion.points[parsedPolygonStartIndex - 1] ?? null
    : null;
  const setSetting = <K extends keyof ViewSettings>(key: K, value: ViewSettings[K]) =>
    props.onSettingsChange({ ...settings, [key]: value });
  const setEcoregionMap = (mode: "broad" | "fine") => {
    const regionMap = settings.regionMap === mode ? "none" : mode;
    props.onSettingsChange({
      ...settings,
      regionMap,
      ...(regionMap === "none" ? {} : { terrainPalette: "none" }),
    });
  };
  const setTerrainPalette = (terrainPalette: Exclude<ViewSettings["terrainPalette"], "none">) =>
    props.onSettingsChange({ ...settings, terrainPalette, regionMap: "none" });
  const closeMorePopup = () => {
    extremumRequestRef.current += 1;
    setExtremumLoading(null);
    props.onRegionPreviewChange(null);
    setMoreTarget(null);
    setMorePage(null);
    setMoreActionError(null);
  };
  const openMorePage = (page: MorePage) => {
    props.onRegionPreviewChange(null);
    setMoreActionError(null);
    setMorePage(page);
    if (page === "trim") {
      setTrimStartMeters(0);
      setTrimEndMeters(0);
    } else if (page === "connect") {
      setConnectOtherId(null);
      setConnectEnds({ current: "end", other: "start" });
    } else if (page === "shift-start") {
      setPolygonStartIndex("1");
    } else if (page === "clip") {
      setClipRegionId(null);
    } else {
      setCombineOtherId(null);
    }
  };
  const openSamplePointPage = () => {
    if (!lineLengthMeters || lineLengthMeters <= 0 || !moreTarget) return;
    setSamplePercent(50);
    setSampleElevationMeters(null);
    setSampleLoading(false);
    if (moreTarget.kind === "region") {
      props.onFocusRegion(moreTarget.id);
    } else {
      props.onFocusFeature(moreTarget.category, moreTarget.id);
    }
    openMorePage("sample");
  };
  const applySamplePoint = () => {
    if (!samplePosition || sampleElevationMeters === null || !moreName) return;
    props.onAddSamplePoint(samplePosition, sampleElevationMeters, moreName);
    closeMorePopup();
  };
  const applyPolygonStartShift = () => {
    if (moreRegion?.type !== "polygon" || !polygonStartIndexValid) return;
    try {
      props.onUpdate({
        ...moreRegion,
        points: shiftPolygonStart(moreRegion.points, parsedPolygonStartIndex - 1),
      });
      setMoreActionError(null);
      closeMorePopup();
    } catch (error) {
      setMoreActionError(
        error instanceof Error ? error.message : "Could not shift the polygon start point.",
      );
    }
  };
  const updateTrimDistance = (edge: PolylineEnd, meters: number) => {
    if (edge === "start") {
      setTrimStartMeters(Math.max(0, Math.min(trimStartLimit, meters)));
    } else {
      setTrimEndMeters(Math.max(0, Math.min(trimEndLimit, meters)));
    }
    setMoreActionError(null);
  };
  const applyTrim = () => {
    if (moreRegion?.type !== "polyline" || !props.center) return;
    try {
      props.onTrimPolyline(
        moreRegion.id,
        trimPolyline(moreRegion.points, trimStartMeters, trimEndMeters, props.center),
      );
      closeMorePopup();
    } catch (error) {
      setMoreActionError(error instanceof Error ? error.message : "Could not trim the polyline.");
    }
  };
  const applyPolylineClip = () => {
    if (moreRegion?.type !== "polyline" || !props.center || !selectedClipRegion) return;
    try {
      const clippedLines = clipPolylineToRegion(
        moreRegion.points,
        selectedClipRegion,
        props.center,
      );
      if (clippedLines.length === 0) {
        throw new Error("The polyline does not intersect the selected region.");
      }
      props.onClipPolyline(moreRegion.id, clippedLines);
      closeMorePopup();
    } catch (error) {
      setMoreActionError(
        error instanceof Error ? error.message : "Could not clip the polyline to this region.",
      );
    }
  };
  const applyConnection = () => {
    if (moreRegion?.type !== "polyline" || !selectedConnectRegion) return;
    try {
      props.onConnectPolylines(
        moreRegion.id,
        selectedConnectRegion.id,
        connectPolylines(
          moreRegion.points,
          selectedConnectRegion.points,
          connectEnds.current,
          connectEnds.other,
        ),
      );
      closeMorePopup();
    } catch (error) {
      setMoreActionError(error instanceof Error ? error.message : "Could not connect the polylines.");
    }
  };
  const applyPolygonOperation = (operation: PolygonOperation) => {
    if (!moreRegion || !selectedCombineRegion) return;
    const error = props.onCombineRegions(moreRegion.id, selectedCombineRegion.id, operation);
    if (error) {
      setMoreActionError(error);
      return;
    }
    closeMorePopup();
  };
  const openTopographicPanel = (
    category: TopographicFeatureCategory,
    button: HTMLButtonElement,
  ) => {
    closePointsEditor();
    closeMorePopup();
    setFeatureSearchQuery("");
    if (featurePanel === category) {
      setFeaturePanel(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    setFeaturePanelPosition({
      top: Math.max(8, Math.min(bounds.top, window.innerHeight - 560)),
      left: Math.max(8, Math.min(bounds.right + 8, window.innerWidth - 350)),
    });
    featurePanelButtonRef.current = button;
    setFeaturePanel(category);
    props.onRequestTopographicData(category);
  };
  const togglePointsEditor = (
    region: Extract<Region, { type: "polygon" | "polyline" }>,
    button: HTMLButtonElement,
  ) => {
    if (pointsEditorRegionId === region.id) {
      closePointsEditor();
      return;
    }
    closePointsEditor();
    closeMorePopup();
    const bounds = button.getBoundingClientRect();
    setPointsEditorPosition({
      top: Math.max(8, Math.min(bounds.top, window.innerHeight - 360)),
      left: Math.max(8, Math.min(bounds.right + 8, window.innerWidth - 350)),
    });
    setFeaturePanel(null);
    setCustomPeakDialogOpen(false);
    if (props.placingCustomPoint) props.onStartCustomPointPlacement();
    props.onSelect(region.id);
    setPointsEditorRegionId(region.id);
  };
  const downloadShapePoints = () => {
    if (!pointsEditorRegion) return;
    try {
      const csv = formatLatitudeLongitudePoints(pointsEditorRegion.points);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const fileName = pointsEditorRegion.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "shape-points";
      link.href = url;
      link.download = `${fileName}-points.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setPointsTransferFeedback({
        regionId: pointsEditorRegion.id,
        message: `Downloaded ${pointsEditorRegion.points.length} points as CSV.`,
        error: false,
      });
    } catch (error) {
      setPointsTransferFeedback({
        regionId: pointsEditorRegion.id,
        message: error instanceof Error ? error.message : "Could not download the points CSV.",
        error: true,
      });
    }
  };
  const copyShapePoints = async () => {
    if (!pointsEditorRegion) return;
    const region = pointsEditorRegion;
    const request = ++pointsClipboardOperationRef.current;
    setPointsTransferBusy(true);
    setPointsTransferFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard writing is not available in this browser context.");
      }
      await navigator.clipboard.writeText(formatLatitudeLongitudePoints(region.points));
      if (request === pointsClipboardOperationRef.current) {
        setPointsTransferFeedback({
          regionId: region.id,
          message: `Copied ${region.points.length} points to the clipboard.`,
          error: false,
        });
      }
    } catch (error) {
      if (request === pointsClipboardOperationRef.current) {
        setPointsTransferFeedback({
          regionId: region.id,
          message: error instanceof Error ? error.message : "Could not copy the points.",
          error: true,
        });
      }
    } finally {
      if (request === pointsClipboardOperationRef.current) setPointsTransferBusy(false);
    }
  };
  const pasteShapePoints = async () => {
    if (!pointsEditorRegion) return;
    const region = pointsEditorRegion;
    const request = ++pointsClipboardOperationRef.current;
    setPointsTransferBusy(true);
    setPointsTransferFeedback(null);
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error("Clipboard reading is not available in this browser context.");
      }
      const clipboardText = await navigator.clipboard.readText();
      if (request !== pointsClipboardOperationRef.current) return;
      const result = parseLatitudeLongitudePoints(clipboardText);
      if (!result.valid) {
        setPointsTransferFeedback({
          regionId: region.id,
          message: `Clipboard format is invalid. ${result.error}`,
          error: true,
        });
        return;
      }
      const minimumPointCount = region.type === "polygon" ? 3 : 2;
      if (result.points.length < minimumPointCount) {
        setPointsTransferFeedback({
          regionId: region.id,
          message: `Clipboard format is valid, but a ${region.type} needs at least ${minimumPointCount} points.`,
          error: true,
        });
        return;
      }
      props.onUpdate({ ...region, points: result.points });
      setPointsTransferFeedback({
        regionId: region.id,
        message: `Clipboard format is valid. Pasted ${result.points.length} points.`,
        error: false,
      });
    } catch (error) {
      if (request === pointsClipboardOperationRef.current) {
        setPointsTransferFeedback({
          regionId: region.id,
          message: error instanceof Error ? error.message : "Could not read the clipboard.",
          error: true,
        });
      }
    } finally {
      if (request === pointsClipboardOperationRef.current) setPointsTransferBusy(false);
    }
  };
  const addPolygonPoint = (region: Extract<Region, { type: "polygon" }>) => {
    const midpoint = bisectPolygonClosingEdge(region.points);
    if (midpoint) props.onUpdate({ ...region, points: [...region.points, midpoint] });
  };
  const addShapePoint = (region: Extract<Region, { type: "polygon" | "polyline" }>) => {
    if (region.type === "polygon") addPolygonPoint(region);
    else props.onAppendPolylinePoint(region.id);
  };
  const toggleMorePopup = (
    target: MoreTarget,
    button: HTMLButtonElement,
    adjacentToSidebar = false,
    preferredTop?: number,
  ) => {
    const sameTarget = moreTarget?.kind === target.kind &&
      moreTarget.id === target.id &&
      (moreTarget.kind !== "feature" || target.kind !== "feature" ||
        moreTarget.category === target.category);
    if (sameTarget) {
      closeMorePopup();
      return;
    }
    extremumRequestRef.current += 1;
    setExtremumLoading(null);
    props.onRegionPreviewChange(null);
    setMorePage(null);
    setMoreActionError(null);
    const bounds = button.getBoundingClientRect();
    const sidebarBounds = sidebarRef.current?.getBoundingClientRect();
    setMorePosition({
      top: Math.max(8, Math.min(preferredTop ?? bounds.top, window.innerHeight - 360)),
      left: Math.max(8, Math.min(
        adjacentToSidebar && sidebarBounds ? sidebarBounds.right + 8 : bounds.right + 8,
        window.innerWidth - 350,
      )),
    });
    moreTriggerRef.current = button;
    setMoreTarget(target);
  };
  const createElevationPoint = async (extremum: ElevationExtremum) => {
    if (!moreName) return;
    const request = ++extremumRequestRef.current;
    setExtremumLoading(extremum);
    setMoreActionError(null);
    try {
      await props.onCreateElevationPoint(
        moreGeometries,
        moreLineGeometries,
        extremum,
        moreName,
      );
      if (request === extremumRequestRef.current) closeMorePopup();
    } catch (error) {
      if (request === extremumRequestRef.current) {
        setMoreActionError(
          error instanceof Error ? error.message : "Could not find a terrain elevation point.",
        );
        setExtremumLoading(null);
      }
    }
  };
  const addCurrentLocation = async () => {
    setCurrentLocationError(null);
    if (!navigator.geolocation) {
      setCurrentLocationError("Location access is not available in this browser.");
      return;
    }

    setCurrentLocationLoading(true);
    try {
      const location = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          maximumAge: 60_000,
          timeout: 15_000,
        });
      });
      props.onAddCurrentLocation([
        location.coords.longitude,
        location.coords.latitude,
      ]);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === 1) {
          setCurrentLocationError("Location permission was denied.");
        } else if (error.code === 3) {
          setCurrentLocationError("Could not determine your location before the request timed out.");
        } else {
          setCurrentLocationError("Your location could not be determined.");
        }
      } else {
        setCurrentLocationError(
          error instanceof Error ? error.message : "Could not get your current location.",
        );
      }
    } finally {
      setCurrentLocationLoading(false);
    }
  };
  const openElevationProfile = async () => {
    if (!moreName) return;
    const request = ++profileRequestRef.current;
    setProfileName(moreName);
    setElevationProfile(null);
    setProfileError(null);
    setProfileLoading(true);
    setProfileDialogOpen(true);
    try {
      const profileLines = moreFeatureCategory === "rivers"
        ? mergeRiverLinePaths(moreLineGeometries)
        : moreLineGeometries;
      const profile = await props.onCreateElevationProfile(profileLines);
      if (request === profileRequestRef.current) setElevationProfile(profile);
    } catch (error) {
      if (request === profileRequestRef.current) {
        setProfileError(
          error instanceof Error ? error.message : "Could not create the elevation profile.",
        );
      }
    } finally {
      if (request === profileRequestRef.current) setProfileLoading(false);
    }
  };
  const closeElevationProfile = () => {
    profileRequestRef.current += 1;
    setProfileDialogOpen(false);
    setProfileLoading(false);
  };
  const submitCustomPeak = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const optionalNumber = (value: string) => value.trim() ? Number(value) : undefined;
    const elevation = optionalNumber(customPeakForm.elevation);
    const prominence = optionalNumber(customPeakForm.prominence);
    const isolation = optionalNumber(customPeakForm.isolation);
    const elevationMeters = elevation === undefined
      ? undefined
      : elevationFromDisplay(elevation, settings.measurementSystem);
    const prominenceMeters = prominence === undefined
      ? undefined
      : elevationFromDisplay(prominence, settings.measurementSystem);
    const isolationKm = isolation === undefined
      ? undefined
      : distanceFromDisplay(isolation, settings.measurementSystem);
    if ([elevationMeters, prominenceMeters, isolationKm].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
    )) {
      setCustomPeakFormError("Optional elevation, prominence, and isolation must be non-negative numbers.");
      return;
    }
    props.onAddCustomPeak({
      name: customPeakForm.name.trim(),
      range: customPeakForm.range.trim(),
      position: [Number(customPeakForm.longitude), Number(customPeakForm.latitude)],
      ...(elevationMeters === undefined ? {} : { elevationMeters }),
      ...(prominenceMeters === undefined ? {} : { prominenceMeters }),
      ...(isolationKm === undefined ? {} : { isolationKm }),
    });
    setCustomPeakForm({
      name: "",
      range: "",
      latitude: "",
      longitude: "",
      elevation: "",
      prominence: "",
      isolation: "",
    });
    setCustomPeakFormError(null);
    setCustomPeakDialogOpen(false);
  };
  const featurePanelCategories: TopographicFeatureCategory[] = featurePanel === "highways"
    ? ["highways", "interstates"]
    : featurePanel ? [featurePanel] : [];
  const inlineFeatureDetail = featurePanel !== null &&
    moreTarget?.kind === "feature" &&
    featurePanelCategories.includes(moreTarget.category);
  const moreClipCategory =
    moreTarget?.kind === "feature" &&
      isClipFeatureCategory(moreTarget.category)
      ? moreTarget.category
      : null;
  const featureOptionCount = featurePanelCategories.reduce(
    (count, category) => count + props.topographicOptions[category].length,
    0,
  );
  const featurePanelOptions: CategorizedFeatureOption[] = featurePanelCategories.flatMap((category) =>
    props.topographicOptions[category].map((option) => ({ category, option }))
  );
  if (featurePanel === "highways") {
    featurePanelOptions.sort(compareHighwayFeatureOptions);
  } else {
    featurePanelOptions.sort((a, b) =>
      a.option.label.localeCompare(b.option.label, undefined, { numeric: true, sensitivity: "base" })
    );
  }
  const selectedFeatureCount = featurePanel
    ? featurePanelOptions.filter(({ category, option }) =>
      props.topographicSelections[category].includes(option.id)
    ).length
    : 0;
  const featurePanelLoading = featurePanelCategories.some((category) =>
    props.topographicStatus[category].loading
  );
  const featurePanelErrors = featurePanelCategories.flatMap((category) => {
    const error = props.topographicStatus[category].error;
    return error ? [{ category, error }] : [];
  });
  const featurePanelLabel = featurePanel
    ? [...TOPOGRAPHIC_CATEGORIES, ...MANMADE_CATEGORIES]
      .find((category) => category.id === featurePanel)?.label ?? "Feature"
    : "Feature";
  const featureSearchTerm = featureSearchQuery.trim().toLowerCase();
  const filteredFeatureOptions = featurePanelOptions.filter(({ option }) =>
    `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(featureSearchTerm)
  );
  const visibleFeatureOptions = featurePanelOptions.filter(({ category, option }) =>
    props.topographicSelections[category].includes(option.id)
  );
  const cutFeatureOptions = featurePanelOptions.filter(({ category, option }) =>
    isClipFeatureCategory(category) && props.clipSelections[category].includes(option.id)
  );
  const quickAccessOptions = featureSearchTerm
    ? []
    : [...new Map([
      ...(visibleFeatureOptions.length > 0 && visibleFeatureOptions.length < 10
        ? visibleFeatureOptions
        : []),
      ...(cutFeatureOptions.length > 0 && cutFeatureOptions.length < 10
        ? cutFeatureOptions
        : []),
    ].map((item) => [`${item.category}:${item.option.id}`, item])).values()];
  const renderFeatureOption = (item: CategorizedFeatureOption, list: "quick" | "all") => {
    const { category, option } = item;
    const isVisible = props.topographicSelections[category].includes(option.id);
    const clipCategory = isClipFeatureCategory(category) ? category : null;
    const isClipped = clipCategory !== null &&
      props.clipSelections[clipCategory].includes(option.id);
    return (
      <div className="topographic-feature-option" key={`${list}:${category}:${option.id}`}>
        <div className="topographic-feature-name">
          <strong>{option.label}</strong>
          {option.detail && <small>{option.detail}</small>}
        </div>
        <div className="topographic-feature-actions">
          <button className="region-visibility" type="button"
            aria-label={`${isVisible ? "Hide" : "Show"} ${option.label}`}
            aria-pressed={isVisible}
            title={isVisible ? "Hide boundary" : "Show boundary"}
            onClick={() => props.onToggleTopographicFeature(category, option.id, !isVisible)}>
            <VisibilityIcon visible={isVisible} />
          </button>
          {clipCategory !== null ? (
            <button className="region-clip" type="button"
              aria-label={`${isClipped ? "Remove" : "Add"} ${option.label} ${isClipped ? "from" : "to"} cuts`}
              aria-pressed={isClipped}
              title={isClipped ? "Remove from cuts" : "Add to cuts"}
              onClick={() =>
                props.onToggleClipFeature(clipCategory, option.id, !isClipped)
              }>
              <KnifeIcon />
            </button>
          ) : (
            <span className="region-clip-placeholder" aria-hidden="true" />
          )}
          <button className="region-more" type="button"
            aria-label={`More details for ${option.label}`}
            aria-expanded={
              moreTarget?.kind === "feature" &&
              moreTarget.category === category &&
              moreTarget.id === option.id
            }
            title={`More details for ${option.label}`}
            onClick={(event) => toggleMorePopup({
              kind: "feature",
              category,
              id: option.id,
              selectedRegionIdAtOpen: props.selectedRegionId,
            }, event.currentTarget)}>
            <MoreIcon />
          </button>
        </div>
        {option.custom && (
          <button
            type="button"
            aria-label={`Remove custom peak ${option.label}`}
            title="Remove custom peak"
            onClick={() => props.onRemoveCustomPeak(option.id)}
          >×</button>
        )}
      </div>
    );
  };
  const featureSource = featurePanel ? FEATURE_SOURCES[featurePanel] : null;
  const renderFeatureButtons = (categories: FeatureCategoryButton[]) =>
    categories.map(({ id, label, categories: groupedCategories }) => {
      const optionCategories = groupedCategories ?? [id];
      const options: CategorizedFeatureOption[] = optionCategories.flatMap((category) =>
        props.topographicOptions[category].map((option) => ({ category, option }))
      );
      if (id === "highways") {
        options.sort(compareHighwayFeatureOptions);
      }
      const visibleCount = options.filter(({ category, option }) =>
        props.topographicSelections[category].includes(option.id)
      ).length;
      const previewOptions = options.filter(({ category, option }) =>
        props.topographicSelections[category].includes(option.id) ||
        (isClipFeatureCategory(category) && props.clipSelections[category].includes(option.id))
      );
      const summary = options.length > 0 && visibleCount === options.length
        ? "All visible"
        : previewOptions.length > 0
          ? previewOptions.map(({ option }) => option.label).join(" · ")
          : props.topographicStatus[id].loading ? "Loading features…" : "None enabled";
      return (
        <button
          className={`topographic-button${featurePanel === id ? " is-open" : ""}`}
          type="button"
          key={id}
          aria-expanded={featurePanel === id}
          data-feature-menu-button
          onClick={(event) => openTopographicPanel(id, event.currentTarget)}
        >
          <strong>{label}</strong>
          <small className="topographic-button-summary">{summary}</small>
        </button>
      );
    });
  useEffect(() => {
    if (enableAllRef.current) {
      enableAllRef.current.indeterminate =
        selectedFeatureCount > 0 && selectedFeatureCount < featureOptionCount;
    }
  }, [featureOptionCount, selectedFeatureCount]);
  useEffect(() => {
    if (!featurePanel) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        featurePanelRef.current?.contains(target) ||
        featurePanelButtonRef.current?.contains(target) ||
        morePopupRef.current?.contains(target)
      ) return;
      setFeaturePanel(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFeaturePanel(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [featurePanel]);
  useEffect(() => {
    if (!featurePanel) setFeatureSearchQuery("");
  }, [featurePanel]);
  useEffect(() => {
    if (!pointsEditorRegionId) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        pointsEditorRef.current?.contains(target) ||
        pointsEditorTriggerRef.current?.contains(target)
      ) return;
      closePointsEditor();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePointsEditor();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closePointsEditor, pointsEditorRegionId]);
  useEffect(() => {
    if (pointsEditorRegionId && (
      props.selectedRegionId !== pointsEditorRegionId ||
      !pointsEditorRegion
    )) {
      closePointsEditor();
    }
  }, [closePointsEditor, pointsEditorRegion, pointsEditorRegionId, props.selectedRegionId]);
  useEffect(() => {
    if (pointsEditorRegionId && (
      featurePanel ||
      customPeakDialogOpen ||
      props.placingCustomPoint
    )) {
      closePointsEditor();
    }
  }, [
    closePointsEditor,
    customPeakDialogOpen,
    featurePanel,
    pointsEditorRegionId,
    props.placingCustomPoint,
  ]);
  useEffect(() => {
    if (!moreTarget) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        morePopupRef.current?.contains(target) ||
        moreTriggerRef.current?.contains(target)
      ) return;
      if (
        moreTarget?.kind === "region" &&
        props.activeRegionDragIdRef.current === moreTarget.id
      ) return;
      if (
        morePage === "shift-start" ||
        morePage === "sample" ||
        morePage === "trim" ||
        morePage === "clip" ||
        morePage === "union" ||
        morePage === "intersection" ||
        morePage === "difference"
      ) return;
      setMoreTarget(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreTarget(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [morePage, moreTarget, props.activeRegionDragIdRef]);
  useEffect(() => {
    if (!props.nearbyShapes) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && nearbyShapesRef.current?.contains(target)) return;
      props.onDismissNearbyShapes();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onDismissNearbyShapes();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.nearbyShapes, props.onDismissNearbyShapes]);
  useLayoutEffect(() => {
    if (!props.nearbyShapes || !nearbyShapesRef.current) {
      setNearbyListLeft(null);
      return;
    }
    const width = nearbyShapesRef.current.getBoundingClientRect().width;
    const left = Math.max(
      8,
      Math.min(props.nearbyShapes.clientX + 10, window.innerWidth - width - 8),
    );
    setNearbyListLeft((current) => current === left ? current : left);
  }, [props.nearbyShapes]);
  useEffect(() => {
    if (!moreTarget) return;
    const operationPageIsOpen =
      morePage === "shift-start" ||
      morePage === "sample" ||
      morePage === "trim" ||
      morePage === "clip" ||
      morePage === "union" ||
      morePage === "intersection" ||
      morePage === "difference";
    const selectedTargetRegion = moreTarget.kind === "region" &&
      props.selectedRegionId === moreTarget.id;
    if (
      !operationPageIsOpen &&
      props.selectedRegionId !== moreTarget.selectedRegionIdAtOpen &&
      !selectedTargetRegion
    ) {
      setMoreTarget(null);
      return;
    }
    if (moreTarget.kind === "region") {
      if (!shapeRegions.some((region) => region.id === moreTarget.id)) {
        setMoreTarget(null);
      }
    } else if (
      !props.topographicOptions[moreTarget.category].some((option) => option.id === moreTarget.id)
    ) {
      setMoreTarget(null);
    }
  }, [morePage, moreTarget, props.selectedRegionId, props.topographicOptions, shapeRegions]);
  useEffect(() => {
    setPolygonStartIndex("1");
  }, [moreRegion?.id]);
  useEffect(() => {
    if (moreTarget && (
      customPeakDialogOpen ||
      props.placingCustomPoint ||
      pointsEditorRegionId
    )) {
      setMoreTarget(null);
    }
  }, [
    customPeakDialogOpen,
    moreTarget,
    pointsEditorRegionId,
    props.placingCustomPoint,
  ]);
  useEffect(() => {
    if (!moreTarget) {
      props.onRegionPreviewChange(null);
      return;
    }
    if (morePage === "sample" && samplePosition) {
      props.onRegionPreviewChange({
        lines: [],
        markerPositions: [samplePosition],
        highlightedRegionIds: [],
        hiddenRegionIds: [],
        hiddenHandleIds: [],
        lineColor: "#ffda45",
        lineWidth: 4.5,
      });
      return;
    }
    if (
      morePage === "shift-start" &&
      moreTarget.kind === "region" &&
      moreRegion?.type === "polygon" &&
      polygonStartPreviewPosition
    ) {
      props.onRegionPreviewChange({
        lines: [],
        markerPositions: [polygonStartPreviewPosition],
        highlightedRegionIds: [],
        hiddenRegionIds: [],
        hiddenHandleIds: [],
        lineColor: "#ffda45",
        lineWidth: 4.5,
      });
      return;
    }
    if (moreTarget.kind !== "region" || !moreRegion) {
      props.onRegionPreviewChange(null);
      return;
    }
    if (morePage === "trim" && moreRegion.type === "polyline" && props.center) {
      try {
        props.onRegionPreviewChange({
          lines: trimStartMeters === 0 && trimEndMeters === 0
            ? []
            : [trimPolyline(moreRegion.points, trimStartMeters, trimEndMeters, props.center)],
          markerPositions: [],
          highlightedRegionIds: [],
          hiddenRegionIds: trimStartMeters === 0 && trimEndMeters === 0 ? [] : [moreRegion.id],
          hiddenHandleIds: [moreRegion.id],
          lineColor: "#21918c",
          lineWidth: props.selectedRegionId === moreRegion.id ? 3.5 : 2.5,
        });
      } catch (error) {
        setMoreActionError(
          error instanceof Error ? error.message : "Could not preview the trimmed polyline.",
        );
        props.onRegionPreviewChange(null);
      }
      return;
    }
    if (morePage === "connect" && moreRegion.type === "polyline" && selectedConnectRegion) {
      const currentEndpoint = polylineEndPosition(moreRegion.points, connectEnds.current);
      const otherEndpoint = polylineEndPosition(selectedConnectRegion.points, connectEnds.other);
      if (!currentEndpoint || !otherEndpoint) {
        props.onRegionPreviewChange(null);
        return;
      }
      props.onRegionPreviewChange({
        lines: [[currentEndpoint, otherEndpoint]],
        markerPositions: [currentEndpoint, otherEndpoint],
        highlightedRegionIds: [],
        hiddenRegionIds: [],
        hiddenHandleIds: [moreRegion.id, selectedConnectRegion.id],
        lineColor: "#ffda45",
        lineWidth: 4.5,
      });
      return;
    }
    if (
      (morePage === "union" || morePage === "intersection" || morePage === "difference") &&
      selectedCombineRegion
    ) {
      props.onRegionPreviewChange({
        lines: [],
        markerPositions: [],
        highlightedRegionIds: [moreRegion.id, selectedCombineRegion.id],
        hiddenRegionIds: [],
        hiddenHandleIds: [],
        lineColor: "#d58cff",
        lineWidth: 5,
      });
      return;
    }
    props.onRegionPreviewChange(null);
  }, [
    connectEnds,
    morePage,
    moreRegion,
    moreTarget,
    props.center,
    props.onRegionPreviewChange,
    props.selectedRegionId,
    polygonStartPreviewPosition,
    samplePosition,
    selectedCombineRegion,
    selectedConnectRegion,
    trimEndMeters,
    trimStartMeters,
  ]);
  useEffect(() => {
    if (morePage !== "sample" || !samplePosition) {
      sampleRequestRef.current += 1;
      setSampleLoading(false);
      setSampleElevationMeters(null);
      return;
    }
    const request = ++sampleRequestRef.current;
    setSampleLoading(true);
    setSampleElevationMeters(null);
    setMoreActionError(null);
    void props.onSampleElevation(samplePosition).then((elevationMeters) => {
      if (request === sampleRequestRef.current) {
        setSampleElevationMeters(elevationMeters);
      }
    }).catch((error: unknown) => {
      if (request === sampleRequestRef.current) {
        setMoreActionError(
          error instanceof Error ? error.message : "Could not sample terrain elevation.",
        );
      }
    }).finally(() => {
      if (request === sampleRequestRef.current) setSampleLoading(false);
    });
    return () => {
      if (request === sampleRequestRef.current) sampleRequestRef.current += 1;
    };
  }, [morePage, props.onSampleElevation, samplePosition]);
  const nearbyListStyle: CSSProperties | undefined = props.nearbyShapes
    ? (() => {
      const top = Math.max(8, Math.min(
        props.nearbyShapes.clientY + 10,
        window.innerHeight - 120,
      ));
      return {
        top,
        left: Math.max(8, Math.min(
          nearbyListLeft ?? props.nearbyShapes.clientX + 10,
          nearbyListLeft ?? window.innerWidth - 316,
        )),
        maxHeight: Math.min(360, Math.max(0, window.innerHeight - top - 8)),
      };
    })()
    : undefined;
  return (
    <aside id="map-controls-sidebar" ref={sidebarRef} className="sidebar controls-sidebar" aria-label="Map controls">
      {props.nearbyShapes && (
        <div
          ref={nearbyShapesRef}
          className="nearby-shapes-list"
          role="dialog"
          aria-label="Nearby map shapes"
          style={nearbyListStyle}>
          <strong>Nearby</strong>
          {props.nearbyShapes.items.map((item) => {
            const key = item.target.kind === "region"
              ? `region:${item.target.id}`
              : `feature:${item.target.category}:${item.target.id}`;
            return (
              <div className="nearby-shape-item" key={key}>
                <span title={item.label}>{item.label}</span>
                <button type="button" aria-label={`Options for ${item.label}`}
                  title={`Options for ${item.label}`}
                  onClick={(event) => {
                    const target: MoreTarget = item.target.kind === "region"
                      ? {
                        kind: "region",
                        id: item.target.id,
                        selectedRegionIdAtOpen: props.selectedRegionId,
                      }
                      : {
                        kind: "feature",
                        category: item.target.category,
                        id: item.target.id,
                        selectedRegionIdAtOpen: props.selectedRegionId,
                      };
                    toggleMorePopup(
                      target,
                      event.currentTarget,
                      true,
                      props.nearbyShapes?.clientY,
                    );
                    props.onDismissNearbyShapes();
                  }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="3" r="1.25" />
                    <circle cx="8" cy="8" r="1.25" />
                    <circle cx="8" cy="13" r="1.25" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="mobile-sidebar-settings">
        <label>
          <span>Vertical exaggeration <strong>{settings.exaggeration.toFixed(1)}×</strong></span>
          <input type="range" aria-label={`Vertical exaggeration ${settings.exaggeration.toFixed(1)}×`}
            min="1" max="10" step="0.1" value={settings.exaggeration}
            onChange={(event) => setSetting("exaggeration", Number(event.target.value))} />
        </label>
        <button type="button"
          aria-label={`Switch to ${settings.measurementSystem === "metric" ? "imperial" : "metric"} units`}
          aria-pressed={settings.measurementSystem === "imperial"}
          onClick={() => setSetting(
            "measurementSystem",
            settings.measurementSystem === "metric" ? "imperial" : "metric",
          )}>
          Units: {settings.measurementSystem === "metric" ? "Metric" : "Imperial"}
        </button>
      </div>
      <details className="control-section" open>
        <summary>Lighting</summary>
        <div className="height-palette-options emissive-palette-options" role="group" aria-label="Terrain emissive color">
          {HEIGHT_PALETTES.map((palette) => (
            <button className="height-palette-button" type="button" key={palette.id}
              style={{ background: palette.gradient }}
              aria-pressed={settings.terrainPalette === palette.id}
              onClick={() => setTerrainPalette(palette.id)}>
              <span className="height-palette-name">{palette.label}</span>
            </button>
          ))}
          <button className="height-palette-button" type="button"
            style={{ background: settings.terrainEmissiveColor }}
            aria-pressed={settings.terrainPalette === "solid"}
            onClick={() => setTerrainPalette("solid")}>
            <span className="height-palette-name">Solid</span>
          </button>
          <button className="height-palette-button" type="button"
            style={{
              background: `linear-gradient(90deg, ${settings.terrainGradientLowColor}, ${settings.terrainGradientHighColor})`,
            }}
            aria-label="Custom gradient"
            aria-pressed={settings.terrainPalette === "custom"}
            onClick={() => setTerrainPalette("custom")}>
            <span className="height-palette-name">Gradient</span>
          </button>
        </div>
        {settings.terrainPalette === "solid" && (
          <label className="control-field">
            <span>Solid emissive color</span>
            <input type="color" aria-label="Solid emissive color" value={settings.terrainEmissiveColor}
              onChange={(event) => setSetting("terrainEmissiveColor", event.target.value)} />
          </label>
        )}
        {settings.terrainPalette === "custom" && (
          <div className="field-pair color-fields">
            <label className="control-field"><span>Low color</span>
              <input type="color" aria-label="Gradient low color" value={settings.terrainGradientLowColor}
                onChange={(event) => setSetting("terrainGradientLowColor", event.target.value)} />
            </label>
            <label className="control-field"><span>High color</span>
              <input type="color" aria-label="Gradient high color" value={settings.terrainGradientHighColor}
                onChange={(event) => setSetting("terrainGradientHighColor", event.target.value)} />
            </label>
          </div>
        )}
        <div className="field-pair color-fields">
          <label className="control-field"><span>Light color</span><input type="color" value={settings.lightColor} onChange={(event) => setSetting("lightColor", event.target.value)} /></label>
          <label className="control-field">
            <span>Ambient light <strong>{settings.ambientLightIntensity.toFixed(2)}</strong></span>
            <input type="range" aria-label="Ambient light intensity" min="0" max="0.3" step="0.01"
              value={settings.ambientLightIntensity}
              onChange={(event) => setSetting("ambientLightIntensity", Number(event.target.value))} />
          </label>
        </div>
        <div className="field-pair">
          <label className="control-field"><span>Sun direction <strong>{settings.sunAzimuth}°</strong></span>
            <input type="range" min="0" max="360" value={settings.sunAzimuth} onChange={(event) => setSetting("sunAzimuth", Number(event.target.value))} />
          </label>
          <label className="control-field"><span>Sun elevation <strong>{settings.sunElevation}°</strong></span>
            <input type="range" min="1" max="90" value={settings.sunElevation} onChange={(event) => setSetting("sunElevation", Number(event.target.value))} />
          </label>
        </div>
      </details>

      <details className="control-section" open>
        <summary>Features</summary>
        <h3 className="feature-subsection-title">Topographical features</h3>
        <div className="topographic-button-grid">{renderFeatureButtons(TOPOGRAPHIC_CATEGORIES)}</div>
        <h3 className="feature-subsection-title">Manmade features</h3>
        <div className="topographic-button-grid">{renderFeatureButtons(MANMADE_CATEGORIES)}</div>
        <h3 className="feature-subsection-title">Custom shapes</h3>
        <div className="feature-add-grid">
          <button type="button" aria-pressed={props.placingCustomPoint}
            disabled={!props.canExportClipRegions}
            onClick={(event) => {
              closePointsEditor();
              setMoreTarget(null);
              if (!props.placingCustomPoint) {
                const bounds = event.currentTarget.getBoundingClientRect();
                setFeaturePanelPosition({
                  top: Math.max(8, Math.min(bounds.top, window.innerHeight - 140)),
                  left: Math.max(8, Math.min(bounds.right + 8, window.innerWidth - 350)),
                });
              }
              props.onStartCustomPointPlacement();
            }}>+ Point</button>
          <button type="button" disabled={!props.canExportClipRegions || currentLocationLoading}
            onClick={() => void addCurrentLocation()}>
            {currentLocationLoading ? "Getting Location…" : "Current Location"}
          </button>
          <button type="button" onClick={() => props.onAdd("ellipse")}>+ Circle</button>
          <button type="button" onClick={() => props.onAdd("rectangle")}>+ Rectangle</button>
          <button type="button" onClick={() => props.onAdd("polygon")}>+ Polygon</button>
          <button type="button" onClick={() => props.onAdd("polyline")}>+ Line</button>
        </div>
        {currentLocationError && (
          <small className="topographic-status is-error" role="alert">
            {currentLocationError}
          </small>
        )}
        {shapeRegions.length > 0 && (
          <div className="region-list">
            <div className="region-list-header" aria-hidden="true">
              <span />
              <span>View</span>
              <span>Cut</span>
              <span>More</span>
              <span>DEL</span>
            </div>
            {shapeRegions.map((region) => {
              const label = regionLabels.get(region.id) ?? "Region";
              return (
                <section className={`region-item${props.selectedRegionId === region.id ? " is-selected" : ""}`}
                  key={region.id}>
                  <div className={`region-heading ${props.selectedRegionId === region.id ? "is-selected" : ""}`}>
                    <button className="region-select" type="button" aria-pressed={props.selectedRegionId === region.id}
                      onClick={() =>
                        props.onSelect(props.selectedRegionId === region.id ? null : region.id)
                      }>{label}</button>
                    <button className="region-visibility" type="button"
                      aria-label={`${region.visible === false ? "Show" : "Hide"} ${label}`}
                      aria-pressed={region.visible !== false}
                      onClick={() => props.onToggleVisibility(region.id)}
                      title={region.visible === false ? "Show region" : "Hide region"}>
                      <VisibilityIcon visible={region.visible !== false} />
                    </button>
                    {region.type === "point" || region.type === "polyline" ? (
                      <span className="region-clip-placeholder" aria-hidden="true" />
                    ) : (
                      <button className="region-clip" type="button"
                        aria-label={`${region.clip === true ? "Remove" : "Add"} ${label} ${region.clip === true ? "from" : "to"} cuts`}
                        aria-pressed={region.clip === true}
                        onClick={() => props.onToggleClip(region.id)}
                        title={region.clip === true ? "Remove from cuts" : "Add to cuts"}>
                        <KnifeIcon />
                      </button>
                    )}
                    <button className="region-more" type="button"
                      aria-label={`More details for ${label}`}
                      aria-expanded={moreTarget?.kind === "region" && moreTarget.id === region.id}
                      title={`More details for ${label}`}
                      onClick={(event) => toggleMorePopup({
                        kind: "region",
                        id: region.id,
                        selectedRegionIdAtOpen: props.selectedRegionId,
                      }, event.currentTarget)}>
                      <MoreIcon />
                    </button>
                    <button className="region-remove" type="button" aria-label={`Remove ${label}`}
                      title="Remove region"
                      onClick={() => props.onRemove(region.id)}>×</button>
                  </div>
                  {(region.type === "polygon" || region.type === "polyline") && (
                    <div className="shape-region-actions"
                      ref={pointsEditorRegionId === region.id ? pointsEditorTriggerRef : null}>
                      <button className="shape-points-toggle" type="button"
                        aria-expanded={pointsEditorRegionId === region.id}
                        onClick={(event) => togglePointsEditor(region, event.currentTarget)}>
                        {region.points.length} points &gt;
                      </button>
                      <button type="button" onClick={() => addShapePoint(region)}>Add point</button>
                    </div>
                  )}
                  {region.type !== "polygon" && region.type !== "polyline" && (
                    <RegionEditor region={region} onUpdate={props.onUpdate}
                      measurementSystem={settings.measurementSystem} />
                  )}
                </section>
              );
            })}
          </div>
        )}
      </details>

      {pointsEditorRegion && (
        <div
          ref={pointsEditorRef}
          className="topographic-popup shape-points-popup"
          role="dialog"
          aria-label={`${pointsEditorRegion.points.length} points for ${regionLabels.get(pointsEditorRegion.id) ?? "shape"}`}
          style={{
            top: pointsEditorPosition.top,
            left: pointsEditorPosition.left,
            maxHeight: `calc(100dvh - ${pointsEditorPosition.top}px - 16px)`,
          }}
        >
          <div className="topographic-popup-header">
            <div>
              <strong>{regionLabels.get(pointsEditorRegion.id) ?? "Shape"}</strong>
              <small>Edit {pointsEditorRegion.type} points</small>
            </div>
            <button type="button" aria-label={`Close ${pointsEditorRegion.type} points`}
              onClick={closePointsEditor}>×</button>
          </div>
          <div className="shape-points-transfer">
            <div className="shape-points-transfer-actions">
              <button type="button" disabled={pointsTransferBusy}
                onClick={downloadShapePoints}>Download CSV</button>
              <button type="button" disabled={pointsTransferBusy}
                onClick={() => void copyShapePoints()}>Copy points</button>
              <button type="button" disabled={pointsTransferBusy}
                onClick={() => void pasteShapePoints()}>Paste points</button>
            </div>
            {pointsTransferFeedback?.regionId === pointsEditorRegion.id && (
              <small
                className={`shape-points-feedback${pointsTransferFeedback.error ? " is-error" : ""}`}
                role={pointsTransferFeedback.error ? "alert" : "status"}
              >{pointsTransferFeedback.message}</small>
            )}
          </div>
          <ShapePointsEditor region={pointsEditorRegion} onUpdate={props.onUpdate} />
        </div>
      )}

      {featurePanel && !inlineFeatureDetail && (
        <FeatureOptionsPopup
          category={featurePanel}
          label={featurePanelLabel}
          position={featurePanelPosition}
          popupRef={featurePanelRef}
          featureListRef={featureListRef}
          enableAllRef={enableAllRef}
          selectedFeatureCount={selectedFeatureCount}
          featureOptionCount={featureOptionCount}
          featureCategories={featurePanelCategories}
          loading={featurePanelLoading}
          errors={featurePanelErrors}
          source={featureSource ?? undefined}
          settings={settings}
          onClose={() => setFeaturePanel(null)}
          onSetAllFeatures={props.onSetAllTopographicFeatures}
          onSetEcoregionMap={setEcoregionMap}
          searchQuery={featureSearchQuery}
          onSearchQueryChange={setFeatureSearchQuery}
          quickAccessOptions={quickAccessOptions}
          filteredFeatureOptions={filteredFeatureOptions}
          renderFeatureOption={renderFeatureOption}
          customPeakStorageError={props.customPeakStorageError}
          customPeaksLoaded={props.customPeaksLoaded}
          onAddCustomPeak={() => {
            setCustomPeakFormError(null);
            closePointsEditor();
            closeMorePopup();
            setFeaturePanel(null);
            setCustomPeakDialogOpen(true);
          }}
        />
      )}

      {moreTarget && moreName && moreType && (
        <MorePopup
          name={moreName}
          type={moreType}
          detail={moreFeatureOption?.moreDetail}
          convertLabel={moreConvertLabel}
          conversionDisabled={moreConversionDisabled}
          conversionHelp={
            moreRegion?.type === "polyline" && moreConversionDisabled
              ? "Add a third distinct point before converting this line to a polygon."
              : undefined
          }
          perimeterMeters={polygonMeasurements?.perimeterMeters}
          areaSquareMeters={polygonMeasurements?.areaSquareMeters}
          lengthMeters={lineLengthMeters}
          prominenceMeters={moreFeatureOption?.prominenceMeters}
          isolationKm={moreFeatureOption?.isolationKm}
          measurementSystem={settings.measurementSystem}
          popupRef={morePopupRef}
          className={inlineFeatureDetail ? "feature-detail-popup" : undefined}
          style={{
            top: inlineFeatureDetail ? featurePanelPosition.top : morePosition.top,
            left: inlineFeatureDetail ? featurePanelPosition.left : morePosition.left,
            maxHeight: `calc(100dvh - ${inlineFeatureDetail ? featurePanelPosition.top : morePosition.top
              }px - 16px)`,
          }}
          showDetails={morePage === null}
          headerActions={moreTarget.kind === "feature" ? (
            <>
              <button className="region-visibility" type="button"
                aria-label={`${props.topographicSelections[moreTarget.category].includes(moreTarget.id)
                  ? "Hide" : "Show"} ${moreName}`}
                aria-pressed={props.topographicSelections[moreTarget.category].includes(moreTarget.id)}
                title={props.topographicSelections[moreTarget.category].includes(moreTarget.id)
                  ? "Hide boundary" : "Show boundary"}
                onClick={() => props.onToggleTopographicFeature(
                  moreTarget.category,
                  moreTarget.id,
                  !props.topographicSelections[moreTarget.category].includes(moreTarget.id),
                )}>
                <VisibilityIcon visible={
                  props.topographicSelections[moreTarget.category].includes(moreTarget.id)
                } />
              </button>
              {moreClipCategory !== null && (
                <button className="region-clip" type="button"
                  aria-label={`${props.clipSelections[moreClipCategory].includes(moreTarget.id)
                    ? "Remove" : "Add"
                    } ${moreName} ${props.clipSelections[moreClipCategory].includes(moreTarget.id)
                      ? "from" : "to"
                    } cuts`}
                  aria-pressed={props.clipSelections[moreClipCategory].includes(moreTarget.id)}
                  title={props.clipSelections[moreClipCategory].includes(moreTarget.id)
                    ? "Remove from cuts" : "Add to cuts"}
                  onClick={() => props.onToggleClipFeature(
                    moreClipCategory,
                    moreTarget.id,
                    !props.clipSelections[moreClipCategory].includes(moreTarget.id),
                  )}>
                  <KnifeIcon />
                </button>
              )}
            </>
          ) : undefined}
          analysisActions={
            (hasPolygonGeometry || moreLineGeometries.length > 0) ? (
              <>
                <button
                  type="button"
                  disabled={extremumLoading !== null}
                  onClick={() => void createElevationPoint("highest")}
                >
                  {extremumLoading === "highest" ? "Finding highest…" : "Find highest point"}
                </button>
                <button
                  type="button"
                  disabled={extremumLoading !== null}
                  onClick={() => void createElevationPoint("lowest")}
                >
                  {extremumLoading === "lowest" ? "Finding lowest…" : "Find lowest point"}
                </button>
                {moreLineGeometries.length > 0 && (
                  <button type="button" onClick={() => void openElevationProfile()}>
                    Elevation profile
                  </button>
                )}
                {extremumLoading && (
                  <small className="more-popup-analysis-status" role="status">
                    Sampling terrain elevations…
                  </small>
                )}
                {moreActionError && morePage === null && (
                  <small className="more-popup-error" role="alert">{moreActionError}</small>
                )}
              </>
            ) : undefined
          }
          viewActions={moreLineGeometries.length > 0 ? (
            <button type="button" disabled={(lineLengthMeters ?? 0) <= 0}
              onClick={openSamplePointPage}>Sample point</button>
          ) : undefined}
          editActions={
            moreRegion?.type === "polyline" ? (
              <>
                <button type="button" onClick={() => {
                  props.onUpdate({
                    ...moreRegion,
                    points: [...moreRegion.points].reverse(),
                  });
                  closeMorePopup();
                }}>Reverse</button>
                <button type="button" onClick={() => openMorePage("trim")}>Trim start/end</button>
                <button type="button" onClick={() => openMorePage("clip")}>Clip to region</button>
                <button type="button" onClick={() => openMorePage("connect")}>Connect polylines</button>
              </>
            ) : moreRegion?.type === "polygon" ? (
              <>
                <button type="button" onClick={() => openMorePage("shift-start")}>
                  Shift start
                </button>
                <button type="button" onClick={() => openMorePage("union")}>Union</button>
                <button type="button" onClick={() => openMorePage("intersection")}>Intersect</button>
                <button type="button" onClick={() => openMorePage("difference")}>Difference</button>
              </>
            ) : moreRegion?.type === "ellipse" || moreRegion?.type === "rectangle" ? (
              <>
                <button type="button" onClick={() => openMorePage("union")}>Union</button>
                <button type="button" onClick={() => openMorePage("intersection")}>Intersect</button>
                <button type="button" onClick={() => openMorePage("difference")}>Difference</button>
              </>
            ) : undefined
          }
          onBack={morePage ? () => {
            setMorePage(null);
            setMoreActionError(null);
          } : undefined}
          onReturnToList={inlineFeatureDetail ? () => {
            closeMorePopup();
            requestAnimationFrame(() => {
              if (featureListRef.current) featureListRef.current.scrollTop = 0;
            });
          } : undefined}
          onClose={inlineFeatureDetail ? () => {
            closeMorePopup();
            setFeaturePanel(null);
          } : closeMorePopup}
          onConvert={() => {
            if (moreTarget.kind === "region") {
              props.onConvertRegion(moreTarget.id);
            } else {
              props.onConvertFeature(moreTarget.category, moreTarget.id);
            }
            closeMorePopup();
          }}
          onFocus={() => {
            if (moreTarget.kind === "region") {
              props.onFocusRegion(moreTarget.id);
            } else {
              props.onFocusFeature(moreTarget.category, moreTarget.id);
            }
            closeMorePopup();
          }}
        >
          {morePage === "shift-start" && moreRegion?.type === "polygon" && (
            <div className="more-popup-tool">
              <strong>Shift polygon start</strong>
              <p>This polygon has {polygonPointCount} points. Choose the vertex index to preview as the new start.</p>
              <label className="more-popup-shift-start">
                <span>Start point index (1–{polygonPointCount})</span>
                <input type="number" min="1" max={polygonPointCount} step="1"
                  value={polygonStartIndex}
                  onChange={(event) => setPolygonStartIndex(event.target.value)} />
              </label>
              {moreActionError && <p className="more-popup-error" role="alert">{moreActionError}</p>}
              <button type="button" className="more-popup-apply"
                disabled={!polygonStartIndexValid || !polygonStartPreviewPosition}
                onClick={applyPolygonStartShift}>Apply shift</button>
            </div>
          )}
          {morePage === "sample" && (
            <div className="more-popup-tool">
              <strong>Sample terrain along line</strong>
              <p>Move the slider to preview a point and its terrain elevation along the line.</p>
              {samplePosition ? (
                <>
                  <label className="more-popup-sample-slider">
                    <span>Sample location</span>
                    <input type="range" aria-label="Sample point along line"
                      min="0" max="100" step="0.1" value={samplePercent}
                      onChange={(event) => setSamplePercent(Number(event.target.value))} />
                    <output>
                      {formatLength(sampleDistanceMeters, settings.measurementSystem)}
                      {" "}({samplePercent.toFixed(1)}%) of {formatLength(
                        lineLengthMeters ?? 0,
                        settings.measurementSystem,
                      )}
                    </output>
                  </label>
                  <p className="more-popup-sample-elevation" role="status">
                    Elevation: {sampleLoading
                      ? "Sampling terrain…"
                      : sampleElevationMeters === null
                        ? "Unavailable at this location."
                        : formatElevation(sampleElevationMeters, settings.measurementSystem)}
                  </p>
                  {moreActionError && (
                    <p className="more-popup-error" role="alert">{moreActionError}</p>
                  )}
                  <button type="button" className="more-popup-apply"
                    disabled={sampleLoading || sampleElevationMeters === null}
                    onClick={applySamplePoint}>Add sample point</button>
                </>
              ) : (
                <p className="more-popup-error" role="alert">
                  Could not find a sample position on this line.
                </p>
              )}
            </div>
          )}
          {morePage === "trim" && moreRegion?.type === "polyline" && (
            <div className="more-popup-tool">
              <strong>Trim polyline ends</strong>
              <p>Trim each end by distance or percent. The slider and both number inputs stay synchronized.</p>
              {(["start", "end"] as const).map((edge) => {
                const meters = edge === "start" ? trimStartMeters : trimEndMeters;
                const maximum = edge === "start" ? trimStartLimit : trimEndLimit;
                const percentage = trimTotalMeters > 0 ? meters / trimTotalMeters * 100 : 0;
                const maximumPercentage = trimTotalMeters > 0
                  ? maximum / trimTotalMeters * 100
                  : 0;
                const displayValue = distanceToDisplay(meters / 1_000, settings.measurementSystem);
                const displayMaximum = distanceToDisplay(maximum / 1_000, settings.measurementSystem);
                return (
                  <fieldset className="more-popup-trim-edge" key={edge}>
                    <legend>Trim {edge}</legend>
                    <input type="range" aria-label={`${edge} trim slider`}
                      min="0" max={maximumPercentage} step="0.1" value={percentage}
                      onChange={(event) => updateTrimDistance(
                        edge,
                        Number(event.target.value) / 100 * trimTotalMeters,
                      )} />
                    <div className="more-popup-trim-inputs">
                      <label>
                        <span>Distance ({distanceUnitLabel})</span>
                        <input type="number" aria-label={`${edge} trim distance`}
                          min="0" max={displayMaximum.toFixed(4)} step="any"
                          value={Number(displayValue.toFixed(4))}
                          onChange={(event) => updateTrimDistance(
                            edge,
                            distanceFromDisplay(Number(event.target.value), settings.measurementSystem) * 1_000,
                          )} />
                      </label>
                      <label>
                        <span>Percent</span>
                        <input type="number" aria-label={`${edge} trim percent`}
                          min="0" max={maximumPercentage.toFixed(2)} step="0.01"
                          value={Number(percentage.toFixed(2))}
                          onChange={(event) => updateTrimDistance(
                            edge,
                            Number(event.target.value) / 100 * trimTotalMeters,
                          )} />
                      </label>
                    </div>
                  </fieldset>
                );
              })}
              <p className="more-popup-tool-summary">
                Remaining line: {formatLength(
                  Math.max(0, trimTotalMeters - trimStartMeters - trimEndMeters),
                  settings.measurementSystem,
                )}
              </p>
              {moreActionError && <p className="more-popup-error" role="alert">{moreActionError}</p>}
              <button type="button" className="more-popup-apply"
                disabled={
                  trimTotalMeters <= 0 ||
                  trimStartMeters + trimEndMeters <= 0 ||
                  trimStartMeters + trimEndMeters >= trimTotalMeters - 0.1
                }
                onClick={applyTrim}>Apply trim</button>
            </div>
          )}
          {morePage === "clip" && moreRegion?.type === "polyline" && (
            <div className="more-popup-tool">
              <strong>Clip polyline to region</strong>
              <p>Keep only the parts of this line inside the selected polygon, circle, or rectangle. Disconnected parts become separate polylines.</p>
              {clipRegionCandidates.length > 0 ? (
                <div className="more-popup-region-options" role="radiogroup"
                  aria-label="Choose a clipping region">
                  {clipRegionCandidates.map((region) => (
                    <label className="more-popup-region-option" key={region.id}>
                      <input type="radio" name="clip-polyline-region" value={region.id}
                        checked={clipRegionId === region.id}
                        onChange={() => {
                          setClipRegionId(region.id);
                          setMoreActionError(null);
                        }} />
                      <span>
                        <strong>{region.name}</strong>
                        <small>{regionTypeLabel(region)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="more-popup-tool-note">
                  Add another polygon, circle, or rectangle region before clipping this line.
                </p>
              )}
              {moreActionError && <p className="more-popup-error" role="alert">{moreActionError}</p>}
              <button type="button" className="more-popup-apply"
                disabled={!selectedClipRegion} onClick={applyPolylineClip}>
                Apply clipping
              </button>
            </div>
          )}
          {morePage === "connect" && moreRegion?.type === "polyline" && (
            <div className="more-popup-tool">
              <strong>Connect another polyline</strong>
              <p>Select the other custom polyline, then choose which endpoints to join. A straight segment bridges any gap.</p>
              {otherPolylineRegions.length > 0 ? (
                <div className="more-popup-region-options" role="radiogroup"
                  aria-label="Choose another custom polyline">
                  {otherPolylineRegions.map((region) => (
                    <label className="more-popup-region-option" key={region.id}>
                      <input type="radio" name="connect-polyline" value={region.id}
                        checked={connectOtherId === region.id}
                        onChange={() => {
                          setConnectOtherId(region.id);
                          setMoreActionError(null);
                        }} />
                      <span><strong>{region.name}</strong><small>{regionTypeLabel(region)}</small></span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="more-popup-tool-note">Add another custom polyline before connecting.</p>
              )}
              {selectedConnectRegion && (
                <div className="more-popup-end-selectors">
                  <label>
                    <span>Current polyline end</span>
                    <select value={connectEnds.current}
                      onChange={(event) => setConnectEnds((current) => ({
                        ...current,
                        current: event.target.value === "start" ? "start" : "end",
                      }))}>
                      <option value="start">Start</option>
                      <option value="end">End</option>
                    </select>
                  </label>
                  <label>
                    <span>Other polyline end</span>
                    <select value={connectEnds.other}
                      onChange={(event) => setConnectEnds((current) => ({
                        ...current,
                        other: event.target.value === "start" ? "start" : "end",
                      }))}>
                      <option value="start">Start</option>
                      <option value="end">End</option>
                    </select>
                  </label>
                </div>
              )}
              <p className="more-popup-tool-note">The map shows the proposed joined line before you apply it.</p>
              {moreActionError && <p className="more-popup-error" role="alert">{moreActionError}</p>}
              <button type="button" className="more-popup-apply"
                disabled={!selectedConnectRegion} onClick={applyConnection}>Connect polylines</button>
            </div>
          )}
          {(morePage === "union" || morePage === "intersection" || morePage === "difference") && (
            <div className="more-popup-tool">
              <strong>{morePage === "union" ? "Union" : morePage === "intersection" ? "Intersect" : "Difference"}</strong>
              <p>Only custom regions appear here. Circles, rectangles, and eligible polylines are converted to polygons before applying.</p>
              {morePage === "difference" && (
                <p className="more-popup-tool-note">
                  If the selected region is inside this polygon, a zero-width cut to the boundary will represent the hole.
                </p>
              )}
              {combineRegionCandidates.length > 0 ? (
                <div className="more-popup-region-options" role="radiogroup"
                  aria-label="Choose another custom region">
                  {combineRegionCandidates.map((region) => (
                    <label className="more-popup-region-option" key={region.id}>
                      <input type="radio" name="combine-custom-region" value={region.id}
                        checked={combineOtherId === region.id}
                        onChange={() => {
                          setCombineOtherId(region.id);
                          setMoreActionError(null);
                        }} />
                      <span><strong>{region.name}</strong><small>{regionTypeLabel(region)}</small></span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="more-popup-tool-note">Add another custom region that can be converted to a polygon.</p>
              )}
              <p className="more-popup-tool-note">Both regions are highlighted on the map. Union requires one touching, contiguous result.</p>
              {moreActionError && <p className="more-popup-error" role="alert">{moreActionError}</p>}
              <button type="button" className="more-popup-apply"
                disabled={!selectedCombineRegion}
                onClick={() => applyPolygonOperation(
                  morePage === "union" ? "union" :
                    morePage === "intersection" ? "intersection" : "difference",
                )}>
                Apply {morePage === "intersection" ? "intersect" : morePage}
              </button>
            </div>
          )}
        </MorePopup>
      )}

      {profileDialogOpen && (
        <ElevationProfilePopup
          profile={elevationProfile}
          loading={profileLoading}
          error={profileError}
          name={profileName}
          measurementSystem={settings.measurementSystem}
          onClose={closeElevationProfile}
        />
      )}

      {props.placingCustomPoint && (
        <div
          className="topographic-popup custom-point-placement-popup"
          role="dialog"
          aria-label="Custom point placement"
          aria-describedby="custom-point-placement-instructions"
          style={{
            top: featurePanelPosition.top,
            left: featurePanelPosition.left,
            maxHeight: `calc(100dvh - ${featurePanelPosition.top}px - 16px)`,
          }}
        >
          <div className="topographic-popup-header">
            <div><strong>Place custom point</strong></div>
            <button type="button" aria-label="Cancel custom point placement"
              onClick={props.onStartCustomPointPlacement}>×</button>
          </div>
          <div className="custom-point-placement-copy">
            <p id="custom-point-placement-instructions">Click anywhere on the map to place the point.</p>
            <small>Press Escape or close to cancel.</small>
          </div>
        </div>
      )}

      {customPeakDialogOpen && (
        <div className="county-dialog-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setCustomPeakDialogOpen(false);
        }}>
          <form
            className="county-dialog custom-peak-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-peak-dialog-title"
            onSubmit={submitCustomPeak}
          >
            <h2 id="custom-peak-dialog-title">Add custom mountain peak</h2>
            <label className="control-field">
              <span>Name</span>
              <input required value={customPeakForm.name}
                onChange={(event) => setCustomPeakForm({ ...customPeakForm, name: event.target.value })} />
            </label>
            <label className="control-field">
              <span>Mountain range</span>
              <input required value={customPeakForm.range}
                onChange={(event) => setCustomPeakForm({ ...customPeakForm, range: event.target.value })} />
            </label>
            <div className="custom-peak-coordinate-fields">
              <label className="control-field">
                <span>Latitude</span>
                <input type="number" required min="-85.05112878" max="85.05112878" step="any"
                  value={customPeakForm.latitude}
                  onChange={(event) => setCustomPeakForm({ ...customPeakForm, latitude: event.target.value })} />
              </label>
              <label className="control-field">
                <span>Longitude</span>
                <input type="number" required min="-180" max="180" step="any"
                  value={customPeakForm.longitude}
                  onChange={(event) => setCustomPeakForm({ ...customPeakForm, longitude: event.target.value })} />
              </label>
            </div>
            <label className="control-field">
              <span>Elevation <small>Optional · {elevationUnitLabel}</small></span>
              <input type="number" min="0" max={elevationToDisplay(10000, settings.measurementSystem)}
                step="any" value={customPeakForm.elevation}
                onChange={(event) => setCustomPeakForm({ ...customPeakForm, elevation: event.target.value })} />
            </label>
            <div className="custom-peak-coordinate-fields">
              <label className="control-field">
                <span>Prominence <small>Optional · {elevationUnitLabel}</small></span>
                <input type="number" min="0" max={elevationToDisplay(10000, settings.measurementSystem)}
                  step="any" value={customPeakForm.prominence}
                  onChange={(event) => setCustomPeakForm({ ...customPeakForm, prominence: event.target.value })} />
              </label>
              <label className="control-field">
                <span>Isolation <small>Optional · {distanceUnitLabel}</small></span>
                <input type="number" min="0" max={distanceToDisplay(10000, settings.measurementSystem)}
                  step="any" value={customPeakForm.isolation}
                  onChange={(event) => setCustomPeakForm({ ...customPeakForm, isolation: event.target.value })} />
              </label>
            </div>
            {customPeakFormError && <small className="topographic-status is-error" role="alert">{customPeakFormError}</small>}
            <div className="county-dialog-actions">
              <button type="button" onClick={() => setCustomPeakDialogOpen(false)}>Cancel</button>
              <button type="submit">Add peak</button>
            </div>
          </form>
        </div>
      )}

      <ExportSection {...props} />
    </aside>
  );
});
