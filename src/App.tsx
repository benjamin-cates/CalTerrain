import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Camera, Plane, Raycaster, Vector2, Vector3 } from "three";
import {
  countyId,
  countyName,
  formatCoordinates,
  fromLocal,
  mercatorToGeographic,
  toLocal,
} from "./geo";
import {
  extendPolylineEnd,
  moveRegionHandle,
  regionsForSelectedCounties,
  type RegionHandle,
} from "./regions";
import {
  customRegionGeometries,
  featureGeometryPositions,
  linePiecesFromGeometries,
  polygonPiecesFromGeometries,
} from "./featureAnalysis";
import { distanceToLineSegments, geometryContainsPosition } from "./nearbyShapes";
import { combineCustomRegions, type PolygonOperation } from "./customRegionOperations";
import {
  COMBINED_IMAGE_PREVIEW_ID,
  INITIAL_SETTINGS,
  INITIAL_CLIP_FEATURE_SELECTIONS,
  INITIAL_TOPOGRAPHIC_FEATURE_SELECTIONS,
  INITIAL_VIEW,
  type Dataset,
  type FeatureGeometry,
  type ClipFeatureCategory,
  type ClipFeatureSelections,
  type Position,
  type Region,
  type RegionOverlayPreview,
  type NearbyShapes,
  type TopographicFeatureCategory,
  type TopographicFeatureOption,
  type TopographicFeatureSelections,
  type ViewSettings,
  type ViewState,
} from "./types";
import { useTerrainData } from "./terrain/useTerrainData";
import { useBoundaryFeatureData } from "./terrain/useBoundaryFeatureData";
import { getHighwayRouteLines, getHighwayRouteNumbers } from "./highways";
import { useHighwayData } from "./terrain/useHighwayData";
import { getRailwayFeatureOptions } from "./railways";
import { useRailwayData } from "./terrain/useRailwayData";
import { getRiverFeatureOptions, mergeRiverLinePaths } from "./rivers";
import { useRiverData } from "./terrain/useRiverData";
import { useMountainData } from "./terrain/useMountainData";
import { useCustomMountainPeaks } from "./terrain/useCustomMountainPeaks";
import {
  createTerrainElevationProfile,
  createTerrainElevationSampler,
  findTerrainElevationExtremum,
  type ElevationExtremum,
} from "./terrain/elevationAnalysis";
import {
  MOUNTAIN_PEAK_VISIBILITY_DISTANCE_KM,
  type MountainPeak,
} from "./mountains";
import { MapDisplay } from "./MapDisplay";
import { Sidebar } from "./Sidebar";
import {
  clipFeatureExportRegionId,
  createRegionBoundaryExport,
} from "./regionExport";
import { longitudeLatitudeCellId } from "./longitudeLatitudeGrid";
import {
  combineTerrainExportRegions,
  createStoreZip,
  createTerrainImageCanvas,
  createTerrainExportRegions,
  createTerrainGlb,
  getTerrainImageDimensions,
  getTerrainGroundScale,
  terrainExportFilename,
  MAX_TERRAIN_IMAGE_PIXELS,
  TERRAIN_EXPORT_RESOLUTIONS,
  type TerrainExportRegion,
  type TerrainExportTriangleReport,
  type TerrainExportProgress,
} from "./terrain/terrainExport";
import type { TerrainRay, TerrainRaycast } from "./terrain/terrainRaycast";
import type { TerrainHeightPalette } from "./terrain/terrainHeightPalette";
import { formatDistance, formatElevation, formatLength } from "./units";
import "./style/index.css";

type Gesture = {
  pointerId: number;
  button: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  placingPoint: boolean;
  handle?: RegionHandle;
};

type PinchGesture = {
  pointerIds: [number, number];
  distance: number;
  center: Position;
  startCenter: Position;
  startDistance: number;
  startPositions: [Position, Position];
  mode: "pan" | "zoom" | null;
};

type MapPoint = { position: Position; elevationKm: number };

const PINCH_ZOOM_SENSITIVITY = 2.625;

function createPieceRegions(
  name: string,
  type: "polygon" | "polyline",
  pieces: Position[][],
): Region[] {
  return pieces.map((points, index) => ({
    id: crypto.randomUUID(),
    name: pieces.length === 1 ? name : `${name} ${index + 1}`,
    type,
    points,
    isConverted: true,
  }));
}

function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the terrain canvas as a PNG."));
    }, "image/png");
  });
}

const TerrainImagePreview = memo(function TerrainImagePreview({
  metadata,
  center,
  region,
  resolutionMeters,
  palette,
  measurementSystem,
}: {
  metadata: Dataset["metadata"];
  center: Position;
  region: TerrainExportRegion | null;
  resolutionMeters: number;
  palette: TerrainHeightPalette;
  measurementSystem: ViewSettings["measurementSystem"];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const dimensions = useMemo(() => {
    if (!region) return null;
    try {
      return getTerrainImageDimensions(region, resolutionMeters, getTerrainGroundScale(center));
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not size the image." };
    }
  }, [center, region, resolutionMeters]);
  const imageIsTooLarge = dimensions && "width" in dimensions &&
    dimensions.width * dimensions.height > MAX_TERRAIN_IMAGE_PIXELS;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !region) return;
    let active = true;
    setRenderError(null);
    void createTerrainImageCanvas({
      metadata,
      center,
      region,
      resolutionMeters,
      palette,
    }, canvas).catch((error: unknown) => {
      if (active) {
        setRenderError(error instanceof Error ? error.message : "Could not render the image preview.");
      }
    });
    return () => {
      active = false;
    };
  }, [center, metadata, palette, region, resolutionMeters]);

  return (
    <section className="map-panel image-output-panel" aria-label="Terrain image export preview">
      <header className="image-output-header">
        <strong>{region?.name ?? "No region selected"}</strong>
        {dimensions && "width" in dimensions && (
          <span>
            {dimensions.width.toLocaleString("en-US")} × {dimensions.height.toLocaleString("en-US")} px · {formatLength(resolutionMeters, measurementSystem)}/px
            {imageIsTooLarge ? " · exceeds browser canvas limit" : ""}
          </span>
        )}
      </header>
      <div className="image-output-stage">
        {region && <canvas ref={canvasRef} aria-label={`${region.name} terrain image preview`} />}
        {(!region || renderError || dimensions && "error" in dimensions || imageIsTooLarge) && (
          <p className="topographic-status is-error" role="alert">
            {!region
              ? "Select a region to preview its image."
              : imageIsTooLarge
                ? "This image exceeds the browser canvas limit. Choose a coarser resolution or smaller region."
                : renderError ?? (dimensions && "error" in dimensions ? dimensions.error : null)}
          </p>
        )}
      </div>
    </section>
  );
});

export function App() {
  const { dataset, dataError, countiesLoading, countiesError, loadCounties } = useTerrainData();
  const elevationSampler = useMemo(
    () => dataset ? createTerrainElevationSampler(dataset.metadata) : null,
    [dataset?.metadata],
  );
  const nationalParkData = useBoundaryFeatureData(
    "/data/boundaries/national_parks.zip",
    "National park",
    "UNIT_CODE",
    "UNIT_NAME",
  );
  const nationalForestData = useBoundaryFeatureData(
    "/data/boundaries/national_forests.zip",
    "National forest",
    "forestorgc",
    "forestname",
  );
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const dismissWelcome = useCallback(() => setWelcomeOpen(false), []);
  const [topographicSelections, setTopographicSelections] =
    useState<TopographicFeatureSelections>(INITIAL_TOPOGRAPHIC_FEATURE_SELECTIONS);
  const [clipSelections, setClipSelections] =
    useState<ClipFeatureSelections>(INITIAL_CLIP_FEATURE_SELECTIONS);
  const [terrainExportBusy, setTerrainExportBusy] = useState(false);
  const [terrainExportStatus, setTerrainExportStatus] = useState<string | null>(null);
  const [terrainExportError, setTerrainExportError] = useState<string | null>(null);
  const [terrainExportTriangleReport, setTerrainExportTriangleReport] =
    useState<TerrainExportTriangleReport | null>(null);
  const [exportFormat, setExportFormat] = useState<"image" | "model">("model");
  const [resolutionIndex, setResolutionIndex] = useState(1);
  const [selectedImageRegionId, setSelectedImageRegionId] = useState<string | null>(null);
  const [heightPalette, setHeightPalette] = useState<TerrainHeightPalette>("grayscale");
  const [highwayDataRequested, setHighwayDataRequested] = useState(false);
  const [railwayDataRequested, setRailwayDataRequested] = useState(false);
  const [riverDataRequested, setRiverDataRequested] = useState(false);
  const [mountainDataRequested, setMountainDataRequested] = useState(false);
  const { features: highwayFeatures, loading: highwayLoading, error: highwayError } =
    useHighwayData(
      highwayDataRequested ||
      topographicSelections.highways.length > 0 ||
      topographicSelections.interstates.length > 0,
    );
  const { features: railwayFeatures, loading: railwayLoading, error: railwayError } =
    useRailwayData(
      railwayDataRequested || topographicSelections.railways.length > 0,
    );
  const { features: riverFeatures, loading: riverLoading, error: riverError } =
    useRiverData(
      riverDataRequested || topographicSelections.rivers.length > 0,
    );
  const { peaks, loading: mountainLoading, error: mountainError } =
    useMountainData(mountainDataRequested || topographicSelections.peaks.length > 0);
  const customMountainData = useCustomMountainPeaks();
  const allMountainPeaks = useMemo(
    () => [...peaks, ...customMountainData.peaks],
    [customMountainData.peaks, peaks],
  );
  const longitudeLatitudeGrid = dataset?.longitudeLatitudeGrid ?? null;
  const topographicOptions = useMemo<Record<TopographicFeatureCategory, TopographicFeatureOption[]>>(() => {
    const routeOptions = (routeType: "highways" | "interstates") => {
      const options = highwayFeatures
        ? getHighwayRouteNumbers(
          highwayFeatures,
          routeType === "highways" ? "highway" : "interstate",
        )
        : [];
      return options.map((number) => ({
        id: number,
        label: routeType === "highways" ? `CA ${number}` : `I-${number}`,
        lines: highwayFeatures
          ? getHighwayRouteLines(
            highwayFeatures,
            routeType === "highways" ? "highway" : "interstate",
            number,
          )
          : [],
      }));
    };
    const countyOptions = dataset?.counties?.features.map((feature) => ({
      id: countyId(feature),
      label: countyName(feature),
      geometry: feature.geometry,
    })) ?? [];
    countyOptions.sort((left, right) => left.label.localeCompare(right.label));
    return {
      highways: routeOptions("highways"),
      interstates: routeOptions("interstates"),
      counties: countyOptions,
      peaks: allMountainPeaks.map((peak) => ({
        id: peak.id,
        label: peak.name,
        detail: [
          peak.range,
          peak.elevationMeters === undefined
            ? "Elevation unknown"
            : formatElevation(peak.elevationMeters, settings.measurementSystem),
        ].filter(Boolean).join(" · "),
        custom: peak.custom,
        position: peak.position,
        elevationMeters: peak.elevationMeters,
        prominenceMeters: peak.prominenceMeters,
        isolationKm: peak.isolationKm,
      })),
      nationalParks: nationalParkData.options,
      nationalForests: nationalForestData.options,
      longitudeLatitudeLines: (longitudeLatitudeGrid?.features ?? []).map((feature) => ({
        id: longitudeLatitudeCellId(feature),
        label: String(feature.properties.name ?? ""),
        geometry: feature.geometry,
      })),
      railways: railwayFeatures ? getRailwayFeatureOptions(railwayFeatures) : [],
      rivers: riverFeatures ? getRiverFeatureOptions(riverFeatures) : [],
    };
  }, [
    allMountainPeaks,
    dataset,
    highwayFeatures,
    longitudeLatitudeGrid,
    nationalForestData.options,
    nationalParkData.options,
    railwayFeatures,
    riverFeatures,
    settings.measurementSystem,
  ]);
  const topographicStatus = useMemo(() => ({
    highways: { loading: highwayLoading, error: highwayError },
    interstates: { loading: highwayLoading, error: highwayError },
    counties: { loading: countiesLoading, error: countiesError },
    peaks: { loading: mountainLoading, error: mountainError },
    nationalParks: { loading: nationalParkData.loading, error: nationalParkData.error },
    nationalForests: { loading: nationalForestData.loading, error: nationalForestData.error },
    longitudeLatitudeLines: { loading: !dataset, error: dataError },
    railways: { loading: railwayLoading, error: railwayError },
    rivers: { loading: riverLoading, error: riverError },
  }), [
    countiesError,
    countiesLoading,
    dataError,
    dataset,
    highwayError,
    highwayLoading,
    mountainError,
    mountainLoading,
    nationalForestData.error,
    nationalForestData.loading,
    nationalParkData.error,
    nationalParkData.loading,
    railwayError,
    railwayLoading,
    riverError,
    riverLoading,
  ]);
  const [regions, setRegions] = useState<Region[]>([]);
  const displayRegions = useMemo(
    () => [
      ...regions,
      ...regionsForSelectedCounties(
        topographicSelections.counties,
        dataset?.counties ?? null,
        clipSelections.counties,
      ),
    ],
    [clipSelections.counties, dataset?.counties, regions, topographicSelections.counties],
  );
  const clipExportRegions = useMemo(() => {
    const items = regions
      .filter((region) =>
        region.type !== "county" &&
        region.type !== "point" &&
        region.type !== "polyline" &&
        region.clip === true
      )
      .map((region) => ({ id: region.id, name: region.name }));
    const categories: { id: ClipFeatureCategory; prefix: string }[] = [
      { id: "counties", prefix: "County" },
      { id: "nationalParks", prefix: "National park" },
      { id: "nationalForests", prefix: "National forest" },
      { id: "longitudeLatitudeLines", prefix: "Grid cell" },
    ];
    for (const { id, prefix } of categories) {
      for (const selectedId of clipSelections[id]) {
        const option = topographicOptions[id].find((item) => item.id === selectedId);
        if (option) {
          items.push({
            id: clipFeatureExportRegionId(id, selectedId),
            name: `${prefix}: ${option.label}`,
          });
        }
      }
    }
    return items;
  }, [clipSelections, regions, topographicOptions]);
  const preparedTerrainExportData = useMemo(() => {
    if (!dataset) return { regions: [], californiaPolygons: [] };
    const boundaryCollection = createRegionBoundaryExport(
      regions,
      clipSelections,
      dataset.metadata.center,
      dataset.counties,
      nationalParkData.features,
      nationalForestData.features,
      longitudeLatitudeGrid,
    );
    return createTerrainExportRegions(
      boundaryCollection,
      dataset.state,
      dataset.metadata.center,
    );
  }, [
    clipSelections,
    dataset,
    nationalForestData.features,
    nationalParkData.features,
    longitudeLatitudeGrid,
    regions,
  ]);
  const preparedTerrainExportRegions = preparedTerrainExportData.regions;
  const combinedImageRegion = useMemo(
    () => preparedTerrainExportRegions.length > 1
      ? combineTerrainExportRegions(
        preparedTerrainExportRegions,
        preparedTerrainExportData.californiaPolygons,
      )
      : null,
    [preparedTerrainExportData.californiaPolygons, preparedTerrainExportRegions],
  );
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [shapeOperationPreview, setShapeOperationPreview] =
    useState<RegionOverlayPreview | null>(null);
  const updateShapeOperationPreview = useCallback((preview: RegionOverlayPreview | null) => {
    setShapeOperationPreview((current) => {
      if (current === null || preview === null) return current === preview ? current : preview;
      const sameIds = current.highlightedRegionIds.length === preview.highlightedRegionIds.length &&
        current.highlightedRegionIds.every((id, index) => id === preview.highlightedRegionIds[index]);
      const sameHiddenRegions = current.hiddenRegionIds.length === preview.hiddenRegionIds.length &&
        current.hiddenRegionIds.every((id, index) => id === preview.hiddenRegionIds[index]);
      const sameHiddenHandles = current.hiddenHandleIds.length === preview.hiddenHandleIds.length &&
        current.hiddenHandleIds.every((id, index) => id === preview.hiddenHandleIds[index]);
      const sameMarkers = current.markerPositions.length === preview.markerPositions.length &&
        current.markerPositions.every((position, index) => {
          const nextPosition = preview.markerPositions[index];
          return !!nextPosition &&
            position[0] === nextPosition[0] &&
            position[1] === nextPosition[1];
        });
      const sameLines = current.lines.length === preview.lines.length &&
        current.lines.every((line, lineIndex) => {
          const nextLine = preview.lines[lineIndex];
          return !!nextLine && line.length === nextLine.length &&
            line.every((position, pointIndex) => {
              const nextPosition = nextLine[pointIndex];
              return !!nextPosition &&
                position[0] === nextPosition[0] &&
                position[1] === nextPosition[1];
            });
        });
      return sameIds &&
        sameHiddenRegions &&
        sameHiddenHandles &&
        sameMarkers &&
        sameLines &&
        current.lineColor === preview.lineColor &&
        current.lineWidth === preview.lineWidth
        ? current
        : preview;
    });
  }, []);
  const [placingCustomPoint, setPlacingCustomPoint] = useState(false);
  const [nearbyShapes, setNearbyShapes] = useState<NearbyShapes | null>(null);
  const [isRightPanning, setIsRightPanning] = useState(false);
  const [terrainVisible, setTerrainVisible] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [canvasAspect, setCanvasAspect] = useState(1.5);
  const [canvasWidth, setCanvasWidth] = useState(1);
  const viewRef = useRef<ViewState>(INITIAL_VIEW);
  const invalidateRef = useRef<(() => void) | null>(null);
  const lastViewSyncRef = useRef(0);
  const wheelSyncTimerRef = useRef<number | null>(null);
  const focusAnimationRef = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera | null>(null);
  const centerTerrainElevationRef = useRef<number | null>(null);
  const datasetRef = useRef(dataset);
  const regionsRef = useRef(regions);
  const regionHandlesRef = useRef<RegionHandle[]>([]);
  const gestureRef = useRef<Gesture | null>(null);
  const activeRegionDragIdRef = useRef<string | null>(null);
  const touchPointersRef = useRef(new Map<number, Position>());
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const didDragRef = useRef(false);
  const placingCustomPointRef = useRef(false);
  const terrainRaycastRef = useRef<TerrainRaycast | null>(null);
  const selectMapPointRef = useRef<(
    mercatorPoint: Position,
    clientX: number,
    clientY: number,
    surfaceElevationKm: number,
  ) => void>(() => { });
  const placeCustomPointRef = useRef<(position: Position) => void>(() => { });
  const mapRaycaster = useMemo(() => new Raycaster(), []);
  const mapPointer = useMemo(() => new Vector2(), []);
  const centerRaycaster = useMemo(() => new Raycaster(), []);
  const centerScreenPointer = useMemo(() => new Vector2(0, 0), []);
  const mapPlane = useMemo(() => new Plane(new Vector3(0, 1, 0), -0.1), []);
  const mapIntersection = useMemo(() => new Vector3(), []);
  datasetRef.current = dataset;
  regionsRef.current = regions;
  const syncView = useCallback((nextView: ViewState, force = false) => {
    viewRef.current = nextView;
    invalidateRef.current?.();
    const now = performance.now();
    if (force || now - lastViewSyncRef.current >= 120) {
      lastViewSyncRef.current = now;
      setView(nextView);
    }
  }, []);
  useEffect(() => () => {
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
    }
  }, []);
  const registerInvalidate = useCallback((invalidate: (() => void) | null) => {
    invalidateRef.current = invalidate;
  }, []);
  const registerCamera = useCallback((camera: Camera | null) => {
    cameraRef.current = camera;
  }, []);
  const registerRegionHandles = useCallback((handles: RegionHandle[]) => {
    regionHandlesRef.current = handles;
  }, []);
  const registerTerrainRaycast = useCallback(
    (raycast: TerrainRaycast | null) => {
      terrainRaycastRef.current = raycast;
    },
    [],
  );
  useEffect(() => {
    if (
      selectedImageRegionId === COMBINED_IMAGE_PREVIEW_ID &&
      combinedImageRegion
    ) return;
    if (preparedTerrainExportRegions.some((region) => region.id === selectedImageRegionId)) return;
    setSelectedImageRegionId(preparedTerrainExportRegions[0]?.id ?? null);
  }, [combinedImageRegion, preparedTerrainExportRegions, selectedImageRegionId]);
  const requestTopographicData = useCallback((category: TopographicFeatureCategory) => {
    if (category === "highways" || category === "interstates") {
      setHighwayDataRequested(true);
    } else if (category === "counties") {
      void loadCounties();
    } else if (category === "peaks") {
      setMountainDataRequested(true);
    } else if (category === "nationalParks") {
      void nationalParkData.load();
    } else if (category === "nationalForests") {
      void nationalForestData.load();
    } else if (category === "railways") {
      setRailwayDataRequested(true);
    } else if (category === "rivers") {
      setRiverDataRequested(true);
    }
  }, [loadCounties, nationalForestData.load, nationalParkData.load]);
  const toggleTopographicFeature = useCallback((
    category: TopographicFeatureCategory,
    id: string,
    enabled: boolean,
  ) => {
    setTopographicSelections((current) => {
      const selected = current[category];
      const next = enabled
        ? [...new Set([...selected, id])]
        : selected.filter((item) => item !== id);
      return { ...current, [category]: next };
    });
    if (category === "counties" && !enabled) {
      setSelectedRegionId((current) => current === `county:${id}` ? null : current);
    }
  }, []);
  const toggleClipFeature = useCallback((
    category: ClipFeatureCategory,
    id: string,
    enabled: boolean,
  ) => {
    setClipSelections((current) => {
      const selected = current[category];
      const next = enabled
        ? [...new Set([...selected, id])]
        : selected.filter((item) => item !== id);
      return { ...current, [category]: next };
    });
  }, []);
  const setAllTopographicFeatures = useCallback((
    category: TopographicFeatureCategory,
    enabled: boolean,
  ) => {
    setTopographicSelections((current) => ({
      ...current,
      [category]: enabled ? topographicOptions[category].map((option) => option.id) : [],
    }));
    if (category === "counties" && !enabled) {
      setSelectedRegionId((current) => current?.startsWith("county:") ? null : current);
    }
  }, [topographicOptions]);
  const addCustomPeak = useCallback((peak: Omit<MountainPeak, "id" | "custom">) => {
    const savedPeak = customMountainData.addPeak(peak);
    setTopographicSelections((current) => ({
      ...current,
      peaks: [...new Set([...current.peaks, savedPeak.id])],
    }));
  }, [customMountainData.addPeak]);
  const removeCustomPeak = useCallback((id: string) => {
    customMountainData.removePeak(id);
    setTopographicSelections((current) => ({
      ...current,
      peaks: current.peaks.filter((peakId) => peakId !== id),
    }));
  }, [customMountainData.removePeak]);

  const pointOnMap = useCallback((
    clientX: number,
    clientY: number,
    matchTerrain = false,
    requireTerrainHit = false,
  ): MapPoint | null => {
    const stage = stageRef.current;
    const camera = cameraRef.current;
    if (!stage || !camera) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    camera.updateMatrixWorld();
    mapPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((clientY - rect.top) / rect.height) * 2,
    );
    mapRaycaster.setFromCamera(mapPointer, camera);
    const intersection = mapRaycaster.ray.intersectPlane(mapPlane, mapIntersection);
    if (!matchTerrain) {
      return intersection
        ? { position: [intersection.x, intersection.z], elevationKm: 0.1 }
        : null;
    }

    const { origin, direction } = mapRaycaster.ray;
    const terrainRay: TerrainRay = {
      origin: [origin.x, origin.y, origin.z],
      direction: [direction.x, direction.y, direction.z],
    };
    const terrainHit = terrainRaycastRef.current?.(terrainRay, settings.exaggeration) ?? null;
    if (terrainHit) {
      return { position: terrainHit.position, elevationKm: terrainHit.elevationKm };
    }
    if (requireTerrainHit) return null;
    return intersection
      ? { position: [intersection.x, intersection.z], elevationKm: 0.1 }
      : null;
  }, [mapIntersection, mapPlane, mapPointer, mapRaycaster, settings.exaggeration]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setCanvasAspect(entry.contentRect.width / Math.max(1, entry.contentRect.height));
        setCanvasWidth(entry.contentRect.width);
      }
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (exportFormat === "image") return;
    const stage = stageRef.current;
    if (!stage) return;
    const preventTrackpadPageZoom = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    stage.addEventListener("wheel", preventTrackpadPageZoom, { passive: false });
    return () => stage.removeEventListener("wheel", preventTrackpadPageZoom);
  }, [exportFormat]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touchPointersRef.current.set(event.pointerId, [event.clientX, event.clientY]);
      }
      const pinch = pinchGestureRef.current;
      if (pinch?.pointerIds.includes(event.pointerId)) {
        const first = touchPointersRef.current.get(pinch.pointerIds[0]);
        const second = touchPointersRef.current.get(pinch.pointerIds[1]);
        if (first && second) {
          const nextCenter: Position = [
            (first[0] + second[0]) / 2,
            (first[1] + second[1]) / 2,
          ];
          const nextDistance = Math.max(
            1,
            Math.hypot(second[0] - first[0], second[1] - first[1]),
          );
          const wasPending = pinch.mode === null;
          if (wasPending) {
            const firstDelta: Position = [
              first[0] - pinch.startPositions[0][0],
              first[1] - pinch.startPositions[0][1],
            ];
            const secondDelta: Position = [
              second[0] - pinch.startPositions[1][0],
              second[1] - pinch.startPositions[1][1],
            ];
            const firstTravel = Math.hypot(...firstDelta);
            const secondTravel = Math.hypot(...secondDelta);
            const centerTravel = Math.hypot(
              nextCenter[0] - pinch.startCenter[0],
              nextCenter[1] - pinch.startCenter[1],
            );
            const distanceChange = Math.abs(nextDistance - pinch.startDistance);

            if (firstTravel > 4 && secondTravel > 4) {
              const movementAgreement =
                firstDelta[0] * secondDelta[0] + firstDelta[1] * secondDelta[1];
              pinch.mode = movementAgreement === 0
                ? (centerTravel >= distanceChange ? "pan" : "zoom")
                : movementAgreement > 0 ? "pan" : "zoom";
            } else if (Math.max(firstTravel, secondTravel) > 12) {
              pinch.mode = centerTravel >= distanceChange ? "pan" : "zoom";
            }
          }

          if (pinch.mode === "pan") {
            const deltaX = nextCenter[0] -
              (wasPending ? pinch.startCenter[0] : pinch.center[0]);
            const deltaY = nextCenter[1] -
              (wasPending ? pinch.startCenter[1] : pinch.center[1]);
            const current = viewRef.current;
            syncView({
              ...current,
              azimuth: current.azimuth - deltaX * 0.005,
              polar: Math.max(0, Math.min(1.42, current.polar - deltaY * 0.004)),
            });
            if (Math.hypot(
              nextCenter[0] - pinch.startCenter[0],
              nextCenter[1] - pinch.startCenter[1],
            ) > 4) {
              setIsRightPanning(true);
            }
          } else if (pinch.mode === "zoom") {
            const previousDistance = wasPending ? pinch.startDistance : pinch.distance;
            const current = viewRef.current;
            syncView({
              ...current,
              distance: Math.max(
                10,
                Math.min(
                  4_000,
                  current.distance *
                  (previousDistance / nextDistance) ** PINCH_ZOOM_SENSITIVITY,
                ),
              ),
            });
          }
          pinch.distance = nextDistance;
          pinch.center = nextCenter;
          didDragRef.current = true;
        }
        return;
      }
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4) {
        didDragRef.current = true;
        if (gesture.button === 2) setIsRightPanning(true);
      }

      if (gesture.handle) {
        const position = pointOnMap(event.clientX, event.clientY, true);
        const data = datasetRef.current;
        if (position && data) {
          const handle = gesture.handle;
          setRegions((current) => current.map((region) =>
            moveRegionHandle(region, handle, position.position, data.metadata.center),
          ));
        }
        return;
      }

      if (gesture.button === 2) {
        const current = viewRef.current;
        syncView({
          ...current,
          azimuth: current.azimuth - dx * 0.005,
          polar: Math.max(0, Math.min(1.42, current.polar - dy * 0.004)),
        });
        return;
      }

      const height = stageRef.current?.clientHeight ?? 900;
      const current = viewRef.current;
      const unitsPerPixel =
        (2 * current.distance * Math.tan((40 * Math.PI) / 360)) / height;
      const cosAzimuth = Math.cos(current.azimuth);
      const sinAzimuth = Math.sin(current.azimuth);
      const cosPolar = Math.cos(current.polar);
      const verticalPanScale = unitsPerPixel / Math.max(0.15, cosPolar);

      syncView({
        ...current,
        target: [
          current.target[0] +
          (-dx * cosAzimuth * unitsPerPixel - dy * sinAzimuth * verticalPanScale),
          current.target[1] +
          (dx * sinAzimuth * unitsPerPixel - dy * cosAzimuth * verticalPanScale),
        ],
      });
    };

    const endPointerGesture = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        touchPointersRef.current.delete(event.pointerId);
      }
      const pinch = pinchGestureRef.current;
      if (pinch?.pointerIds.includes(event.pointerId)) {
        pinchGestureRef.current = null;
        gestureRef.current = null;
        activeRegionDragIdRef.current = null;
        setIsRightPanning(false);
        didDragRef.current = true;
        syncView(viewRef.current, true);
        return;
      }
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        activeRegionDragIdRef.current = null;
        return;
      }
      if (gesture.button === 2) setIsRightPanning(false);
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 4) {
        didDragRef.current = true;
      }
      if (event.type === "pointerup" && gesture.button === 0 && !gesture.handle && !didDragRef.current) {
        const position = pointOnMap(
          event.clientX,
          event.clientY,
          true,
          !gesture.placingPoint,
        );
        if (gesture.placingPoint) {
          if (position && placingCustomPointRef.current) {
            placeCustomPointRef.current(position.position);
            placingCustomPointRef.current = false;
            setPlacingCustomPoint(false);
          }
        } else if (position) {
          const data = datasetRef.current;
          if (data) {
            selectMapPointRef.current([
              data.metadata.center[0] + position.position[0] * 1_000,
              data.metadata.center[1] - position.position[1] * 1_000,
            ], event.clientX, event.clientY, position.elevationKm);
          }
        }
      }
      gestureRef.current = null;
      activeRegionDragIdRef.current = null;
      syncView(viewRef.current, true);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endPointerGesture);
    window.addEventListener("pointercancel", endPointerGesture);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", endPointerGesture);
      window.removeEventListener("pointercancel", endPointerGesture);
      touchPointersRef.current.clear();
      pinchGestureRef.current = null;
      gestureRef.current = null;
      activeRegionDragIdRef.current = null;
      if (wheelSyncTimerRef.current !== null) {
        window.clearTimeout(wheelSyncTimerRef.current);
        wheelSyncTimerRef.current = null;
      }
    };
  }, [pointOnMap, syncView]);

  const selectMapPoint = useCallback((
    mercatorPoint: Position,
    clientX: number,
    clientY: number,
    surfaceElevationKm: number,
  ) => {
    if (!dataset || didDragRef.current) return;
    const camera = cameraRef.current;
    const stage = stageRef.current;
    if (!camera || !stage) {
      setNearbyShapes(null);
      return;
    }

    const clickPosition = mercatorToGeographic(mercatorPoint[0], mercatorPoint[1]);
    const rect = stage.getBoundingClientRect();
    camera.updateMatrixWorld();
    const worldPosition = new Vector3();
    const projectPosition = (
      position: Position,
      heightKm = surfaceElevationKm + 0.01,
    ): Position | null => {
      const [x, z] = toLocal(position, dataset.metadata.center);
      worldPosition.set(x, heightKm, z).project(camera);
      if (worldPosition.z < -1 || worldPosition.z > 1) return null;
      return [
        rect.left + (worldPosition.x + 1) * rect.width / 2,
        rect.top + (1 - worldPosition.y) * rect.height / 2,
      ];
    };
    const projectLines = (lines: Position[][]): Position[][] => {
      const result: Position[][] = [];
      for (const line of lines) {
        let projectedLine: Position[] = [];
        for (const position of line) {
          const projected = projectPosition(position);
          if (projected) {
            projectedLine.push(projected);
          } else {
            if (projectedLine.length > 1) result.push(projectedLine);
            projectedLine = [];
          }
        }
        if (projectedLine.length > 1) result.push(projectedLine);
      }
      return result;
    };
    const hits: { label: string; target: NearbyShapes["items"][number]["target"]; distance: number }[] = [];
    const seen = new Set<string>();
    const addCandidate = (
      label: string,
      target: NearbyShapes["items"][number]["target"],
      geometry: FeatureGeometry | undefined,
      lines: Position[][],
      marker?: { position: Position; heightKm: number },
    ) => {
      const key = target.kind === "region"
        ? `region:${target.id}`
        : `feature:${target.category}:${target.id}`;
      if (seen.has(key)) return;
      let distance = Infinity;
      if (geometry && geometryContainsPosition(geometry, clickPosition)) {
        distance = 0;
      } else if (marker) {
        const projected = projectPosition(marker.position, marker.heightKm);
        if (projected) {
          distance = Math.hypot(projected[0] - clientX, projected[1] - clientY);
        }
      } else if (lines.length > 0) {
        distance = distanceToLineSegments(
          [clientX, clientY],
          projectLines(lines),
        );
      }
      if (distance <= 12) {
        seen.add(key);
        hits.push({ label, target, distance });
      }
    };

    for (const region of displayRegions) {
      if (region.visible === false || region.type === "county") continue;
      if (region.type === "point") {
        const heightKm = region.elevationMeters === undefined
          ? surfaceElevationKm + 0.01
          : region.elevationMeters * settings.exaggeration / 1_000 + 0.01;
        addCandidate(
          region.name,
          { kind: "region", id: region.id },
          undefined,
          [],
          { position: region.position, heightKm },
        );
        continue;
      }
      const geometries = customRegionGeometries(region, dataset.metadata.center);
      const geometry = geometries.find((item) =>
        item.type === "Polygon" || item.type === "MultiPolygon"
      );
      const lines = region.type === "polyline" ? [region.points] : [];
      addCandidate(region.name, { kind: "region", id: region.id }, geometry, lines);
    }

    const visibleCategories: TopographicFeatureCategory[] = [
      "highways",
      "interstates",
      "rivers",
      "railways",
      "peaks",
      "counties",
      "nationalParks",
      "nationalForests",
      "longitudeLatitudeLines",
    ];
    for (const category of visibleCategories) {
      for (const id of topographicSelections[category]) {
        const option = topographicOptions[category].find((item) => item.id === id);
        if (!option) continue;
        if (category === "peaks") {
          if (!option.position) continue;
          const currentView = viewRef.current;
          if (currentView.distance > MOUNTAIN_PEAK_VISIBILITY_DISTANCE_KM) continue;
          const localPosition = toLocal(option.position, dataset.metadata.center);
          if (Math.hypot(
            localPosition[0] - currentView.target[0],
            localPosition[1] - currentView.target[1],
          ) > currentView.distance * 0.6) continue;
          const heightKm = option.elevationMeters === undefined
            ? surfaceElevationKm + 0.1
            : option.elevationMeters * settings.exaggeration / 1_000 + 0.1;
          addCandidate(
            option.label,
            { kind: "feature", category, id },
            undefined,
            [],
            { position: option.position, heightKm },
          );
          continue;
        }
        const isPolygon = option.geometry?.type === "Polygon" ||
          option.geometry?.type === "MultiPolygon";
        const lines = isPolygon
          ? []
          : option.lines ?? (
            option.geometry ? linePiecesFromGeometries([option.geometry]) : []
          );
        addCandidate(
          option.label,
          { kind: "feature", category, id },
          option.geometry,
          lines,
        );
      }
    }

    hits.sort((left, right) =>
      left.distance - right.distance || left.label.localeCompare(right.label)
    );
    setNearbyShapes(hits.length > 0 ? { clientX, clientY, items: hits } : null);
  }, [dataset, displayRegions, settings.exaggeration, topographicOptions, topographicSelections]);
  selectMapPointRef.current = selectMapPoint;
  const dismissNearbyShapes = useCallback(() => setNearbyShapes(null), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 2) return;
    if (event.target instanceof Element && event.target.closest("button, input, select")) return;
    if (event.pointerType === "touch") {
      touchPointersRef.current.set(event.pointerId, [event.clientX, event.clientY]);
      if (touchPointersRef.current.size >= 2) {
        const pointerIds = [...touchPointersRef.current.keys()].slice(0, 2);
        const first = touchPointersRef.current.get(pointerIds[0] ?? -1);
        const second = touchPointersRef.current.get(pointerIds[1] ?? -1);
        if (pointerIds.length === 2 && first && second) {
          const center: Position = [
            (first[0] + second[0]) / 2,
            (first[1] + second[1]) / 2,
          ];
          const startPositions: [Position, Position] = [
            [first[0], first[1]],
            [second[0], second[1]],
          ];
          const distance = Math.max(
            1,
            Math.hypot(second[0] - first[0], second[1] - first[1]),
          );
          gestureRef.current = null;
          pinchGestureRef.current = {
            pointerIds: [pointerIds[0]!, pointerIds[1]!],
            distance,
            center,
            startCenter: center,
            startDistance: distance,
            startPositions,
            mode: null,
          };
          didDragRef.current = true;
          event.preventDefault();
          return;
        }
      }
    }
    didDragRef.current = false;
    let handle: RegionHandle | undefined;
    const region = regions.find((item) => item.id === selectedRegionId);
    const camera = cameraRef.current;
    const stage = stageRef.current;
    if (
      event.button === 0 &&
      !placingCustomPointRef.current &&
      region &&
      region.visible !== false &&
      dataset &&
      camera &&
      stage
    ) {
      const rect = stage.getBoundingClientRect();
      camera.updateMatrixWorld();
      const handles = regionHandlesRef.current.filter((item) => item.id === region.id);
      const projectedHandles = handles.map((item) => {
        const projected = new Vector3(item.position[0], item.height ?? 0.1, item.position[1]).project(camera);
        return {
          handle: item,
          distance: Math.hypot(
            rect.left + (projected.x + 1) * rect.width / 2 - event.clientX,
            rect.top + (1 - projected.y) * rect.height / 2 - event.clientY,
          ),
          visible: projected.z >= -1 && projected.z <= 1,
        };
      });
      handle = projectedHandles.filter((item) => item.visible && item.distance <= 22)
        .sort((a, b) => a.distance - b.distance)[0]?.handle;
    }
    gestureRef.current = {
      pointerId: event.pointerId,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      placingPoint: placingCustomPointRef.current,
      handle,
    };
    activeRegionDragIdRef.current = handle?.id ?? null;
    if (event.button === 2 && !handle) {
      const camera = cameraRef.current;
      const terrainRaycast = terrainRaycastRef.current;
      if (camera && terrainRaycast) {
        camera.updateMatrixWorld();
        centerRaycaster.setFromCamera(centerScreenPointer, camera);
        const ray = centerRaycaster.ray;
        const hit = terrainRaycast({
          origin: [ray.origin.x, ray.origin.y, ray.origin.z],
          direction: [ray.direction.x, ray.direction.y, ray.direction.z],
        }, settings.exaggeration);
        if (hit) {
          const dx = camera.position.x - hit.position[0];
          const dy = camera.position.y - hit.elevationKm;
          const dz = camera.position.z - hit.position[1];
          const distance = Math.hypot(dx, dy, dz);
          if (distance > 0) {
            centerTerrainElevationRef.current = hit.elevationKm;
            syncView({
              ...viewRef.current,
              target: [hit.position[0], hit.position[1]],
              distance,
              azimuth: Math.atan2(dx, dz),
              polar: Math.acos(Math.max(-1, Math.min(1, dy / distance))),
            }, true);
          }
        }
      }
    }
    if (handle) {
      event.preventDefault();
      didDragRef.current = true;
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const current = viewRef.current;
    syncView({
      ...current,
      distance: Math.max(
        10,
        Math.min(
          4_000,
          current.distance * Math.exp(event.deltaY * (event.ctrlKey ? 0.002625 : 0.001)),
        ),
      ),
    });
    if (wheelSyncTimerRef.current !== null) window.clearTimeout(wheelSyncTimerRef.current);
    wheelSyncTimerRef.current = window.setTimeout(() => {
      syncView(viewRef.current, true);
      wheelSyncTimerRef.current = null;
    }, 120);
  };

  const changeZoom = (factor: number) => {
    const current = viewRef.current;
    syncView({
      ...current,
      distance: Math.max(10, Math.min(4_000, current.distance * factor)),
    }, true);
  };

  const addRegion = useCallback((type: Exclude<Region["type"], "county" | "point">) => {
    if (!dataset) return;
    const id = crypto.randomUUID();
    const index = regions.filter((region) => region.type === type).length + 1;
    const name = `${type[0]?.toUpperCase()}${type.slice(1)} ${index}`;
    const target = viewRef.current.target;
    const size = Math.max(2, Math.min(100, viewRef.current.distance / 4));
    let region: Region;
    if (type === "polygon") {
      region = {
        id, name, type,
        points: [
          fromLocal([target[0] - size / 2, target[1] - size / 3], dataset.metadata.center),
          fromLocal([target[0] + size / 2, target[1] - size / 3], dataset.metadata.center),
          fromLocal([target[0], target[1] + 2 * size / 3], dataset.metadata.center),
        ],
      };
    } else if (type === "polyline") {
      region = {
        id, name, type,
        points: [
          fromLocal([target[0] - size / 2, target[1]], dataset.metadata.center),
          fromLocal([target[0] + size / 2, target[1]], dataset.metadata.center),
        ],
      };
    } else {
      region = {
        id, name, type,
        center: fromLocal(target, dataset.metadata.center),
        width: size, height: size,
        rotation: 0,
      };
    }
    setRegions((current) => [...current, region]);
    setSelectedRegionId(id);
  }, [dataset, regions]);
  const appendPolylinePoint = useCallback((regionId: string) => {
    if (!dataset) return;
    const segmentLength = Math.max(2, Math.min(100, viewRef.current.distance / 4));
    setRegions((current) => current.map((region) => {
      if (region.id !== regionId || region.type !== "polyline") return region;
      const point = extendPolylineEnd(region.points, dataset.metadata.center, segmentLength);
      return point ? { ...region, points: [...region.points, point] } : region;
    }));
  }, [dataset]);
  const placeCustomPoint = useCallback((localPosition: Position) => {
    const data = datasetRef.current;
    if (!data) return;
    const index = regionsRef.current.filter((region) => region.type === "point").length + 1;
    const region: Region = {
      id: crypto.randomUUID(),
      name: `Point ${index}`,
      type: "point",
      position: fromLocal(localPosition, data.metadata.center),
    };
    setRegions((current) => [...current, region]);
    setSelectedRegionId(region.id);
  }, []);
  placeCustomPointRef.current = placeCustomPoint;
  const toggleCustomPointPlacement = useCallback(() => {
    const next = !placingCustomPointRef.current;
    placingCustomPointRef.current = next;
    setPlacingCustomPoint(next);
  }, []);
  useEffect(() => {
    if (!placingCustomPoint) return;
    const cancelPlacement = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      placingCustomPointRef.current = false;
      setPlacingCustomPoint(false);
    };
    window.addEventListener("keydown", cancelPlacement);
    return () => window.removeEventListener("keydown", cancelPlacement);
  }, [placingCustomPoint]);
  const updatePointElevation = useCallback((id: string, elevationMeters: number) => {
    setRegions((current) => {
      const currentPoint = current.find((region) => region.id === id);
      if (
        !currentPoint ||
        currentPoint.type !== "point" ||
        currentPoint.elevationMeters === elevationMeters
      ) return current;
      return current.map((region) => region.id === id && region.type === "point"
        ? { ...region, elevationMeters }
        : region);
    });
  }, []);
  const updateRegion = useCallback((updated: Region) => {
    setRegions((current) => current.map((region) => region.id === updated.id ? updated : region));
  }, []);
  const trimPolylineRegion = useCallback((regionId: string, points: Position[]) => {
    setRegions((current) => current.map((region) =>
      region.id === regionId && region.type === "polyline"
        ? { ...region, points }
        : region
    ));
  }, []);
  const clipPolylineRegion = useCallback((regionId: string, lines: Position[][]) => {
    const source = regions.find((region) => region.id === regionId);
    if (source?.type !== "polyline" || lines.length === 0) return;
    const replacements = lines.map((points, index): Region => ({
      ...source,
      id: index === 0 ? source.id : crypto.randomUUID(),
      name: index === 0 ? source.name : `${source.name} (${index + 1})`,
      points,
    }));
    setRegions((current) => {
      const sourceIndex = current.findIndex((region) => region.id === regionId);
      if (sourceIndex < 0 || current[sourceIndex]?.type !== "polyline") return current;
      return [
        ...current.slice(0, sourceIndex),
        ...replacements,
        ...current.slice(sourceIndex + 1),
      ];
    });
    setSelectedRegionId(regionId);
  }, [regions]);
  const connectPolylineRegions = useCallback((
    regionId: string,
    otherRegionId: string,
    points: Position[],
  ) => {
    setRegions((current) => {
      const source = current.find((region) => region.id === regionId);
      const other = current.find((region) => region.id === otherRegionId);
      if (source?.type !== "polyline" || other?.type !== "polyline") return current;
      return [
        ...current.filter((region) => region.id !== otherRegionId && region.id !== regionId),
        { ...source, points },
      ];
    });
    setSelectedRegionId(regionId);
  }, []);
  const combineRegions = useCallback((
    regionId: string,
    otherRegionId: string,
    operation: PolygonOperation,
  ): string | null => {
    const source = regions.find((region) => region.id === regionId);
    const other = regions.find((region) => region.id === otherRegionId);
    if (!dataset || !source || !other) {
      return "One of the selected custom regions is no longer available.";
    }
    let points: Position[];
    try {
      points = combineCustomRegions(source, other, operation, dataset.metadata.center);
    } catch (error) {
      return error instanceof Error ? error.message : "Could not combine the selected regions.";
    }
    const combined: Region = {
      id: source.id,
      name: source.name,
      type: "polygon",
      points,
      ...(source.visible === undefined ? {} : { visible: source.visible }),
      ...(source.clip === undefined ? {} : { clip: source.clip }),
    };
    setRegions((current) => [
      ...current.filter((region) => region.id !== regionId && region.id !== otherRegionId),
      combined,
    ]);
    setSelectedRegionId(regionId);
    return null;
  }, [dataset, regions]);
  const removeRegion = useCallback((id: string) => {
    if (id.startsWith("county:")) {
      const selectedCountyId = id.slice("county:".length);
      setTopographicSelections((current) => ({
        ...current,
        counties: current.counties.filter((countyId) => countyId !== selectedCountyId),
      }));
    } else {
      setRegions((current) => current.filter((region) => region.id !== id));
    }
    setSelectedRegionId((current) => current === id ? null : current);
  }, []);
  const toggleRegionVisibility = useCallback((id: string) => {
    setRegions((current) => current.map((item) => item.id === id
      ? { ...item, visible: item.visible === false }
      : item));
  }, []);
  const toggleRegionClip = useCallback((id: string) => {
    setRegions((current) => current.map((item) => item.id === id
      ? { ...item, clip: item.clip !== true }
      : item));
  }, []);
  const focusPositions = useCallback((positions: Position[]) => {
    if (!dataset || positions.length === 0) return;
    const localPositions = positions.map((position) => toLocal(position, dataset.metadata.center));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of localPositions) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const target: Position = [(minX + maxX) / 2, (minY + maxY) / 2];
    const halfWidth = Math.max(10, (maxX - minX) / 2);
    const halfHeight = Math.max(10, (maxY - minY) / 2);
    const stage = stageRef.current;
    const aspect = Math.max(0.2, stage
      ? stage.clientWidth / Math.max(1, stage.clientHeight)
      : canvasAspect);
    const verticalFovTangent = Math.tan(20 * Math.PI / 180);
    const foreshortening = Math.max(0.35, Math.cos(viewRef.current.polar));
    const distance = Math.min(4_000, Math.max(
      10,
      Math.max(
        halfHeight / (verticalFovTangent * foreshortening),
        halfWidth / (verticalFovTangent * aspect * foreshortening),
      ) * 1.25,
    ));
    if (focusAnimationRef.current !== null) {
      window.cancelAnimationFrame(focusAnimationRef.current);
    }
    const start = viewRef.current;
    let startTime: number | null = null;
    const animate = (time: number) => {
      startTime ??= time;
      const progress = Math.min(1, (time - startTime) / 700);
      const eased = 1 - (1 - progress) ** 3;
      syncView({
        ...start,
        target: [
          start.target[0] + (target[0] - start.target[0]) * eased,
          start.target[1] + (target[1] - start.target[1]) * eased,
        ],
        distance: start.distance + (distance - start.distance) * eased,
      }, progress === 1);
      if (progress < 1) {
        focusAnimationRef.current = window.requestAnimationFrame(animate);
      } else {
        focusAnimationRef.current = null;
      }
    };
    focusAnimationRef.current = window.requestAnimationFrame(animate);
  }, [canvasAspect, dataset, syncView]);
  const addCurrentLocationPoint = useCallback((position: Position) => {
    const region: Region = {
      id: crypto.randomUUID(),
      name: "Current Location",
      type: "point",
      position,
    };
    setRegions((current) => [...current, region]);
    setSelectedRegionId(region.id);
    focusPositions([position]);
  }, [focusPositions]);
  const addElevationExtremumPoint = useCallback(async (
    geometries: FeatureGeometry[],
    lines: Position[][],
    extremum: ElevationExtremum,
    sourceName: string,
  ) => {
    if (!dataset || !elevationSampler) {
      throw new Error("Terrain data is not available for elevation analysis.");
    }
    const sample = await findTerrainElevationExtremum(
      geometries,
      lines,
      dataset.state.features.map((feature) => feature.geometry),
      dataset.metadata.center,
      Math.max(0, ...dataset.metadata.zoomLevels),
      extremum,
      elevationSampler,
    );
    const point: Region = {
      id: crypto.randomUUID(),
      name: `${extremum === "highest" ? "Highest" : "Lowest"} - ${sourceName}`,
      type: "point",
      position: sample.position,
      elevationMeters: sample.elevationMeters,
    };
    setRegions((current) => [...current, point]);
    setSelectedRegionId(point.id);
    focusPositions([sample.position]);
  }, [dataset, elevationSampler, focusPositions]);
  const getElevationProfile = useCallback(async (lines: Position[][]) => {
    if (!dataset || !elevationSampler) {
      throw new Error("Terrain data is not available for elevation analysis.");
    }
    return createTerrainElevationProfile(
      lines,
      dataset.metadata.center,
      elevationSampler,
    );
  }, [dataset, elevationSampler]);
  const sampleTerrainElevation = useCallback((position: Position) => {
    if (!elevationSampler) {
      return Promise.reject(new Error("Terrain data is not available for elevation sampling."));
    }
    return elevationSampler(position);
  }, [elevationSampler]);
  const addSampledElevationPoint = useCallback((
    position: Position,
    elevationMeters: number,
    sourceName: string,
  ) => {
    const point: Region = {
      id: crypto.randomUUID(),
      name: `Sample - ${sourceName}`,
      type: "point",
      position,
      elevationMeters,
    };
    setRegions((current) => [...current, point]);
    setSelectedRegionId(point.id);
    focusPositions([position]);
  }, [focusPositions]);
  const focusRegion = useCallback((regionId: string) => {
    const region = displayRegions.find((item) => item.id === regionId);
    if (!region || !dataset) return;
    if (region.type === "point") {
      focusPositions([region.position]);
    } else if (region.type === "county") {
      const feature = dataset.counties?.features.find((item) => countyId(item) === region.countyId);
      focusPositions(feature ? featureGeometryPositions([feature.geometry]) : []);
    } else {
      focusPositions(featureGeometryPositions(
        customRegionGeometries(region, dataset.metadata.center),
      ));
    }
  }, [dataset, displayRegions, focusPositions]);
  const focusFeature = useCallback((category: TopographicFeatureCategory, id: string) => {
    const option = topographicOptions[category].find((item) => item.id === id);
    if (!option) return;
    const positions = option.position
      ? [option.position]
      : option.lines && option.lines.length > 0
        ? option.lines.flat()
        : option.geometry
          ? featureGeometryPositions([option.geometry])
          : [];
    focusPositions(positions);
  }, [focusPositions, topographicOptions]);
  const convertRegion = useCallback((regionId: string) => {
    const region = regions.find((item) => item.id === regionId);
    if (!region || !dataset || region.type === "point" || region.type === "county") return;
    let converted: Region[] = [];
    if (region.type === "polygon") {
      const points = region.points[0]?.[0] === region.points.at(-1)?.[0] &&
        region.points[0]?.[1] === region.points.at(-1)?.[1]
        ? region.points.slice(0, -1)
        : region.points;
      converted = createPieceRegions(region.name, "polyline", points.length >= 2 ? [points] : []);
    } else if (region.type === "polyline") {
      const uniquePoints = new Set(region.points.map(([longitude, latitude]) => `${longitude},${latitude}`));
      converted = createPieceRegions(region.name, "polygon", uniquePoints.size >= 3 ? [region.points] : []);
    } else {
      converted = createPieceRegions(
        region.name,
        "polygon",
        polygonPiecesFromGeometries(customRegionGeometries(region, dataset.metadata.center)),
      );
    }
    if (converted.length === 0) return;
    setRegions((current) => [...current.filter((item) => item.id !== regionId), ...converted]);
    setSelectedRegionId(converted[0]?.id ?? null);
  }, [dataset, regions]);
  const convertFeature = useCallback((
    category: TopographicFeatureCategory,
    id: string,
  ) => {
    const option = topographicOptions[category].find((item) => item.id === id);
    if (!option) return;
    let converted: Region[] = [];
    if (category === "peaks" && option.position) {
      converted = [{
        id: crypto.randomUUID(),
        name: option.label,
        type: "point",
        position: option.position,
        isConverted: true,
      }];
    } else if (option.geometry) {
      converted = createPieceRegions(
        option.label,
        "polygon",
        polygonPiecesFromGeometries([option.geometry]),
      );
    } else if (option.lines) {
      const lines = option.lines.filter((line) => line.length >= 2);
      converted = createPieceRegions(
        option.label,
        "polyline",
        category === "rivers" ? mergeRiverLinePaths(lines) : lines,
      );
    }
    if (converted.length === 0) return;
    setRegions((current) => [...current, ...converted]);
    setSelectedRegionId(converted[0]?.id ?? null);
    setTopographicSelections((current) => ({
      ...current,
      [category]: current[category].filter((featureId) => featureId !== id),
    }));
  }, [topographicOptions]);
  const exportClipRegions = useCallback(() => {
    if (!dataset) return;
    const collection = createRegionBoundaryExport(
      regions,
      clipSelections,
      dataset.metadata.center,
      dataset.counties,
      nationalParkData.features,
      nationalForestData.features,
      longitudeLatitudeGrid,
    );
    const blob = new Blob([JSON.stringify(collection, null, 2)], {
      type: "application/geo+json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "california-region-boundaries.geojson";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [
    clipSelections,
    dataset,
    nationalForestData.features,
    nationalParkData.features,
    longitudeLatitudeGrid,
    regions,
  ]);

  const exportTerrain = useCallback(async (
    mode: "region" | "zip" | "combined",
    regionId: string | null,
    resolutionMeters: number,
    californiaLatitudeSpanMeters: number,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus("Preparing clipped terrain…");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      const boundaryCollection = createRegionBoundaryExport(
        regions,
        clipSelections,
        dataset.metadata.center,
        dataset.counties,
        nationalParkData.features,
        nationalForestData.features,
        longitudeLatitudeGrid,
      );
      const { regions: exportRegions, californiaPolygons } = createTerrainExportRegions(
        boundaryCollection,
        dataset.state,
        dataset.metadata.center,
      );
      if (exportRegions.length === 0) {
        throw new Error("No selected regions intersect California.");
      }
      const reportProgress = ({ tileIndex, tileCount, regionName }: TerrainExportProgress) => {
        setTerrainExportStatus(
          `Exporting ${regionName} · tile ${tileIndex.toLocaleString("en-US")} of ${tileCount.toLocaleString("en-US")}`,
        );
      };
      const triangleCounts: TerrainExportTriangleReport["pieces"] = [];
      const createGlb = (region: (typeof exportRegions)[number]) => createTerrainGlb({
        metadata: dataset.metadata,
        center: dataset.metadata.center,
        californiaPolygons,
        region,
        resolutionMeters,
        californiaLatitudeSpanMeters,
        verticalExaggeration: settings.exaggeration,
        onProgress: reportProgress,
        onTriangleCount: (count) =>
          triangleCounts.push({ id: region.id, name: region.name, count }),
      });

      if (mode === "region") {
        const region = regionId === null
          ? undefined
          : exportRegions.find((item) => item.id === regionId);
        if (!region) throw new Error("The requested export region is no longer selected.");
        setTerrainExportStatus(`Exporting ${region.name}…`);
        const glb = await createGlb(region);
        downloadFile(
          new Blob([glb], { type: "model/gltf-binary" }),
          terrainExportFilename(region.name),
        );
      } else if (mode === "combined") {
        const combined = combineTerrainExportRegions(exportRegions, californiaPolygons);
        const glb = await createGlb(combined);
        downloadFile(
          new Blob([glb], { type: "model/gltf-binary" }),
          "california-combined-regions.glb",
        );
      } else {
        const entries: { name: string; content: Uint8Array<ArrayBuffer> }[] = [];
        const usedNames = new Set<string>();
        for (let index = 0; index < exportRegions.length; index += 1) {
          const region = exportRegions[index];
          if (!region) continue;
          const glb = new Uint8Array(await createGlb(region));
          const filename = terrainExportFilename(region.name);
          let uniqueFilename = filename;
          let suffix = 2;
          while (usedNames.has(uniqueFilename)) {
            uniqueFilename = filename.replace(/\.glb$/, `-${suffix}.glb`);
            suffix += 1;
          }
          usedNames.add(uniqueFilename);
          entries.push({ name: uniqueFilename, content: glb });
        }
        setTerrainExportStatus("Packaging GLB files…");
        const archive = createStoreZip(entries);
        downloadFile(archive, "california-region-exports.zip");
      }
      setTerrainExportTriangleReport({
        pieces: triangleCounts,
        total: triangleCounts.reduce((total, piece) => total + piece.count, 0),
      });
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the selected terrain.",
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    clipSelections,
    dataset,
    nationalForestData.features,
    nationalParkData.features,
    regions,
    settings.exaggeration,
    terrainExportBusy,
  ]);

  const exportImage = useCallback(async (
    mode: "region" | "zip" | "combined",
    regionId: string | null,
    resolutionMeters: number,
  ) => {
    if (!dataset || terrainExportBusy) return;
    setTerrainExportBusy(true);
    setTerrainExportError(null);
    setTerrainExportTriangleReport(null);
    setTerrainExportStatus("Preparing terrain image…");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      if (preparedTerrainExportRegions.length === 0) {
        throw new Error("No selected regions intersect California.");
      }
      const reportProgress = ({ tileIndex, tileCount, regionName }: TerrainExportProgress) => {
        setTerrainExportStatus(
          `Rendering ${regionName} · tile ${tileIndex.toLocaleString("en-US")} of ${tileCount.toLocaleString("en-US")}`,
        );
      };
      const optionsForRegion = (region: TerrainExportRegion) => ({
        metadata: dataset.metadata,
        center: dataset.metadata.center,
        region,
        resolutionMeters,
        palette: heightPalette,
        onProgress: reportProgress,
      });
      if (mode === "combined") {
        if (!combinedImageRegion) {
          throw new Error("At least two cut regions are required for a combined image.");
        }
        const canvas = await createTerrainImageCanvas(optionsForRegion(combinedImageRegion));
        const blob = await canvasToPng(canvas);
        downloadFile(blob, "california-combined-regions.png");
      } else if (mode === "region") {
        const region = regionId === null
          ? undefined
          : preparedTerrainExportRegions.find((item) => item.id === regionId);
        if (!region) throw new Error("The requested export region is no longer selected.");
        const canvas = await createTerrainImageCanvas(optionsForRegion(region));
        const blob = await canvasToPng(canvas);
        downloadFile(blob, terrainExportFilename(region.name).replace(/\.glb$/, ".png"));
      } else {
        const entries: { name: string; content: Uint8Array<ArrayBuffer> }[] = [];
        const usedNames = new Set<string>();
        for (const region of preparedTerrainExportRegions) {
          const canvas = await createTerrainImageCanvas(optionsForRegion(region));
          const blob = await canvasToPng(canvas);
          const filename = terrainExportFilename(region.name).replace(/\.glb$/, ".png");
          let uniqueFilename = filename;
          let suffix = 2;
          while (usedNames.has(uniqueFilename)) {
            uniqueFilename = filename.replace(/\.png$/, `-${suffix}.png`);
            suffix += 1;
          }
          usedNames.add(uniqueFilename);
          entries.push({
            name: uniqueFilename,
            content: new Uint8Array(await blob.arrayBuffer()),
          });
        }
        setTerrainExportStatus("Packaging PNG files…");
        downloadFile(createStoreZip(entries), "california-region-images.zip");
      }
    } catch (error) {
      setTerrainExportError(
        error instanceof Error ? error.message : "Could not export the selected terrain image.",
      );
    } finally {
      setTerrainExportBusy(false);
      setTerrainExportStatus(null);
    }
  }, [
    combinedImageRegion,
    dataset,
    heightPalette,
    preparedTerrainExportRegions,
    terrainExportBusy,
  ]);

  const currentCoordinates = dataset
    ? formatCoordinates([
      dataset.metadata.center[0] + view.target[0] * 1_000,
      dataset.metadata.center[1] - view.target[1] * 1_000,
    ])
    : "—";
  const exportResolution = TERRAIN_EXPORT_RESOLUTIONS[resolutionIndex] ?? TERRAIN_EXPORT_RESOLUTIONS[1];
  const selectedImageRegion = selectedImageRegionId === COMBINED_IMAGE_PREVIEW_ID
    ? combinedImageRegion
    : preparedTerrainExportRegions.find((region) => region.id === selectedImageRegionId) ?? null;
  const selectedImageRegionGeometry = useMemo(
    () => JSON.stringify(selectedImageRegion?.polygons ?? null),
    [selectedImageRegion?.polygons],
  );
  const stableImagePreviewRegion = useMemo(
    () => selectedImageRegion,
    [
      selectedImageRegion?.id,
      selectedImageRegion?.name,
      selectedImageRegionGeometry,
    ],
  );
  const horizontalViewKm = 2 * view.distance * Math.tan((40 * Math.PI) / 360) * canvasAspect;
  const scaleKm = Math.max(1, Math.pow(10, Math.floor(Math.log10(horizontalViewKm / 4))));
  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CalTerrain home">
          <img className="brand-logo" src="/favicon.svg" alt="" aria-hidden="true" />
          <strong>CalTerrain</strong>
        </a>
        <label className="topbar-exaggeration">
          <span>Vertical exaggeration <strong>{settings.exaggeration.toFixed(1)}×</strong></span>
          <input type="range" aria-label={`Vertical exaggeration ${settings.exaggeration.toFixed(1)}×`}
            min="1" max="10" step="0.1" value={settings.exaggeration}
            onChange={(event) => setSettings((current) => ({
              ...current,
              exaggeration: Number(event.target.value),
            }))} />
        </label>
        <button type="button" className="topbar-unit-toggle"
          aria-pressed={settings.measurementSystem === "imperial"}
          aria-label={`Switch to ${settings.measurementSystem === "metric" ? "imperial" : "metric"} units`}
          onClick={() => setSettings((current) => ({
            ...current,
            measurementSystem: current.measurementSystem === "metric" ? "imperial" : "metric",
          }))}>
          Units: {settings.measurementSystem === "metric" ? "Metric" : "Imperial"}
        </button>
        <button type="button" className="mobile-sidebar-toggle"
          aria-label={mobileSidebarOpen ? "Hide map controls" : "Show map controls"}
          aria-controls="map-controls-sidebar"
          aria-expanded={mobileSidebarOpen}
          onClick={() => setMobileSidebarOpen((open) => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </header>

      <section className={`workspace${mobileSidebarOpen ? " is-mobile-sidebar-open" : ""}`}>
        <Sidebar settings={settings} onSettingsChange={setSettings}
          regions={displayRegions} center={dataset?.metadata.center ?? null}
          selectedId={selectedRegionId}
          clipExportRegions={clipExportRegions} canExportClipRegions={dataset !== null}
          onExportClipRegions={exportClipRegions}
          terrainExportBusy={terrainExportBusy}
          terrainExportStatus={terrainExportStatus}
          terrainExportError={terrainExportError}
          terrainExportRegions={preparedTerrainExportRegions}
          terrainExportGroundScale={dataset ? getTerrainGroundScale(dataset.metadata.center) : 1}
          terrainExportTriangleReport={terrainExportTriangleReport}
          onExportTerrainRegion={(id, resolution, latitudeSpan) =>
            void exportTerrain("region", id, resolution, latitudeSpan)}
          onExportTerrainZip={(resolution, latitudeSpan) =>
            void exportTerrain("zip", null, resolution, latitudeSpan)}
          onExportTerrainCombined={(resolution, latitudeSpan) =>
            void exportTerrain("combined", null, resolution, latitudeSpan)}
          onExportImageRegion={(id, resolution) => void exportImage("region", id, resolution)}
          onExportImageCombined={(resolution) => void exportImage("combined", null, resolution)}
          onExportImageZip={(resolution) => void exportImage("zip", null, resolution)}
          exportFormat={exportFormat}
          onSetExportFormat={setExportFormat}
          resolutionIndex={resolutionIndex}
          onSetResolutionIndex={setResolutionIndex}
          selectedImageRegionId={selectedImageRegionId}
          onSelectImageRegion={setSelectedImageRegionId}
          heightPalette={heightPalette}
          onSetHeightPalette={setHeightPalette}
          topographicOptions={topographicOptions}
          topographicSelections={topographicSelections}
          clipSelections={clipSelections}
          topographicStatus={topographicStatus}
          customPeaksLoaded={customMountainData.storageLoaded}
          customPeakStorageError={customMountainData.storageError}
          onRequestTopographicData={requestTopographicData}
          onToggleTopographicFeature={toggleTopographicFeature}
          onToggleClipFeature={toggleClipFeature}
          onSetAllTopographicFeatures={setAllTopographicFeatures}
          onAddCustomPeak={addCustomPeak}
          onRemoveCustomPeak={removeCustomPeak}
          onAdd={addRegion} onAppendPolylinePoint={appendPolylinePoint}
          onConvertRegion={convertRegion}
          onConvertFeature={convertFeature}
          onTrimPolyline={trimPolylineRegion}
          onClipPolyline={clipPolylineRegion}
          onConnectPolylines={connectPolylineRegions}
          onCombineRegions={combineRegions}
          onShapePreviewChange={updateShapeOperationPreview}
          onFocusRegion={focusRegion}
          onFocusFeature={focusFeature}
          nearbyShapes={nearbyShapes}
          onDismissNearbyShapes={dismissNearbyShapes}
          activeRegionDragIdRef={activeRegionDragIdRef}
          onCreateElevationPoint={addElevationExtremumPoint}
          onCreateElevationProfile={getElevationProfile}
          onSampleElevation={sampleTerrainElevation}
          onAddSamplePoint={addSampledElevationPoint}
          onSelect={setSelectedRegionId}
          placingCustomPoint={placingCustomPoint}
          onStartCustomPointPlacement={toggleCustomPointPlacement}
          onAddCurrentLocation={addCurrentLocationPoint}
          onUpdate={updateRegion} onRemove={removeRegion}
          onToggleVisibility={toggleRegionVisibility} onToggleClip={toggleRegionClip}
        />
        {exportFormat === "image" && dataset ? (
          <TerrainImagePreview metadata={dataset.metadata} center={dataset.metadata.center}
            region={stableImagePreviewRegion} resolutionMeters={exportResolution} palette={heightPalette}
            measurementSystem={settings.measurementSystem} />
        ) : (
          <MapDisplay dataset={dataset} dataError={dataError} terrainVisible={terrainVisible}
            welcomeOpen={welcomeOpen} onDismissWelcome={dismissWelcome}
            highwayFeatures={highwayFeatures}
            railwayFeatures={railwayFeatures}
            riverFeatures={riverFeatures}
            nationalParks={nationalParkData.features}
            nationalForests={nationalForestData.features}
            longitudeLatitudeLines={longitudeLatitudeGrid}
            mountains={allMountainPeaks}
            topographicSelections={topographicSelections}
            clipSelections={clipSelections}
            imageExportPreview={false}
            exportBounds={[]}
            onToggleTerrain={() => setTerrainVisible((visible) => !visible)}
            stageRef={stageRef} viewRef={viewRef}
            view={view} settings={settings} regions={displayRegions} selectedRegionId={selectedRegionId}
            shapeOperationPreview={shapeOperationPreview}
            onCameraReady={registerCamera} onInvalidateReady={registerInvalidate}
            onHandlePositions={registerRegionHandles}
            onTerrainRaycastReady={registerTerrainRaycast}
            isPlacingCustomPoint={placingCustomPoint}
            isRightPanning={isRightPanning}
            centerTerrainElevationRef={centerTerrainElevationRef}
            onPointElevationChange={updatePointElevation}
            onPointerDown={handlePointerDown} onWheel={handleWheel}
            onZoom={changeZoom} onReset={() => syncView(INITIAL_VIEW, true)}
            coordinates={currentCoordinates} scaleKm={scaleKm}
            scalePixels={canvasWidth * scaleKm / horizontalViewKm} />
        )}
      </section>
    </main>
  );
}

export default App;
