import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { Vector3, type Camera, type Texture } from "three";
import { countyId, featureRings, toLocal } from "../geo";
import { longitudeLatitudeCellId } from "../longitudeLatitudeGrid";
import { TerrainOverlays, type TerrainDrapedLineLayer } from "../TerrainOverlays";
import {
  createHighwayShields,
  getHighwayLines,
  type HighwayFeatureCollection,
} from "../features/highways";
import type { MountainPeak } from "../features/mountains";
import type { RailwayFeatureCollection } from "../features/railways";
import type { RiverFeatureCollection } from "../features/rivers";
import type { TerrainExportBoundingBox } from "./terrainExport";
import type { TerrainRaycast } from "./terrainRaycast";
import type { EcoregionMapMetadata } from "../features/ecoregions";
import {
  boundaryFeatureClipPolygons,
  regionClipPolygons as getRegionClipPolygons,
  type RegionHandle,
} from "../regions/geometry";
import { TerrainTiles } from "./Terrain";
import {
  getStateBoundaryClipPolygons,
  intersectStateWithRegions,
} from "./terrainClip";
import { selectTerrainTiles } from "./terrainQuadtree";
import type {
  BoundaryCollection,
  BoundaryFeature,
  Dataset,
  Position,
  Region,
  RegionOperationPreview,
  Tile,
  TopographicFeatureSelections,
  ClipFeatureSelections,
  ViewSettings,
  ViewState,
} from "../types";

const EMPTY_BOUNDARIES: BoundaryCollection = { type: "FeatureCollection", features: [] };

function createBoundaryLineLayerCache(
  category: string,
  center: Position,
  color: string,
  lineWidth: number,
  opacity: number,
): (feature: BoundaryFeature, featureId: string) => TerrainDrapedLineLayer {
  const cache = new WeakMap<BoundaryFeature, TerrainDrapedLineLayer>();
  return (feature, featureId) => {
    const cached = cache.get(feature);
    if (cached) return cached;
    const layer = {
      id: `${category}:${featureId}`,
      lines: featureRings(feature).map((ring) =>
        ring.map((position) => toLocal(position, center))
      ),
      color,
      lineWidth,
      opacity,
    };
    cache.set(feature, layer);
    return layer;
  };
}

function selectBoundaryLineLayers(
  collection: BoundaryCollection,
  selectedIds: ReadonlySet<string>,
  getId: (feature: BoundaryFeature) => string,
  getLayer: (feature: BoundaryFeature, id: string) => TerrainDrapedLineLayer,
): TerrainDrapedLineLayer[] {
  return collection.features.flatMap((feature) => {
    const id = getId(feature);
    return selectedIds.has(id) ? [getLayer(feature, id)] : [];
  });
}

function combineBoundaryLineLayers(
  id: string,
  layers: TerrainDrapedLineLayer[],
  color: string,
  lineWidth: number,
  opacity: number,
): TerrainDrapedLineLayer[] {
  const lines = layers.flatMap((layer) => layer.lines);
  return lines.length > 0 ? [{ id, lines, color, lineWidth, opacity }] : [];
}

function CameraRig({
  onInvalidateReady,
  onCameraReady,
  viewRef,
  centerTerrainElevationRef,
  topDown,
}: {
  onInvalidateReady: (invalidate: (() => void) | null) => void;
  onCameraReady: (camera: Camera | null) => void;
  viewRef: { current: ViewState };
  centerTerrainElevationRef: { current: number | null };
  topDown: boolean;
}) {
  const { camera, invalidate } = useThree();
  const target = useMemo(() => new Vector3(), []);
  const position = useMemo(() => new Vector3(), []);

  useEffect(() => {
    onInvalidateReady(invalidate);
    onCameraReady(camera);
    invalidate();
    return () => {
      onInvalidateReady(null);
      onCameraReady(null);
    };
  }, [camera, invalidate, onCameraReady, onInvalidateReady]);

  useEffect(() => {
    invalidate();
  }, [invalidate, topDown]);

  useFrame(() => {
    const view = viewRef.current;
    target.set(
      view.target[0],
      topDown ? 0 : centerTerrainElevationRef.current ?? 0,
      view.target[1],
    );
    if (topDown) {
      position.set(target.x, target.y + view.distance, target.z);
    } else {
      const sinPolar = Math.sin(view.polar);
      position.set(
        target.x + Math.sin(view.azimuth) * sinPolar * view.distance,
        target.y + Math.cos(view.polar) * view.distance,
        target.z + Math.cos(view.azimuth) * sinPolar * view.distance,
      );
    }
    camera.position.copy(position);
    if (topDown) {
      camera.up.set(0, 0, -1);
    } else if (view.polar <= 0.001) {
      camera.up.set(-Math.sin(view.azimuth), 0, -Math.cos(view.azimuth));
    } else {
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(target);
  }, 0);

  return null;
}

export function TerrainScene({
  data,
  highwayFeatures,
  railwayFeatures,
  riverFeatures,
  lakes,
  ecoregions,
  ecoregionMapMetadata,
  ecoregionMapTexture,
  nationalParks,
  nationalForests,
  longitudeLatitudeLines,
  mountainPeaks,
  topographicSelections,
  clipSelections,
  onCameraReady,
  onInvalidateReady,
  onRegionHandlesChange,
  onRegionPointElevationChange,
  onTerrainRaycastReady,
  terrainVisible,
  viewRef,
  centerTerrainElevationRef,
  settings,
  regions,
  selectedRegionId,
  regionOperationPreview,
  view,
  imageExportPreview,
  exportBounds,
}: {
  data: Dataset;
  highwayFeatures: HighwayFeatureCollection | null;
  railwayFeatures: RailwayFeatureCollection | null;
  riverFeatures: RiverFeatureCollection | null;
  lakes: BoundaryCollection | null;
  ecoregions: BoundaryCollection | null;
  ecoregionMapMetadata: EcoregionMapMetadata | null;
  ecoregionMapTexture: Texture | null;
  nationalParks: BoundaryCollection | null;
  nationalForests: BoundaryCollection | null;
  longitudeLatitudeLines: BoundaryCollection | null;
  mountainPeaks: MountainPeak[];
  topographicSelections: TopographicFeatureSelections;
  clipSelections: ClipFeatureSelections;
  onCameraReady: (camera: Camera | null) => void;
  onInvalidateReady: (invalidate: (() => void) | null) => void;
  onRegionHandlesChange: (handles: RegionHandle[]) => void;
  onRegionPointElevationChange: (id: string, elevationMeters: number) => void;
  onTerrainRaycastReady: (raycast: TerrainRaycast | null) => void;
  terrainVisible: boolean;
  viewRef: { current: ViewState };
  centerTerrainElevationRef: { current: number | null };
  settings: ViewSettings;
  regions: Region[];
  selectedRegionId: string | null;
  regionOperationPreview: RegionOperationPreview | null;
  view: ViewState;
  imageExportPreview: boolean;
  exportBounds: TerrainExportBoundingBox[];
}) {
  const { invalidate } = useThree();
  const previousTilesRef = useRef<Tile[]>([]);
  const candidateTiles = useMemo(
    () => selectTerrainTiles(view, data.metadata, previousTilesRef.current),
    [data.metadata, view],
  );
  const tileSignature = candidateTiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`).join("|");
  const tiles = useMemo(() => candidateTiles, [tileSignature]);
  const deferredTiles = useDeferredValue(tiles);
  const counties = data.counties ?? EMPTY_BOUNDARIES;
  const selectedCountyIds = useMemo(
    () => new Set(topographicSelections.counties),
    [topographicSelections.counties],
  );
  const selectedLakeIds = useMemo(
    () => new Set(topographicSelections.lakes),
    [topographicSelections.lakes],
  );
  const selectedNationalParkIds = useMemo(
    () => new Set(topographicSelections.nationalParks),
    [topographicSelections.nationalParks],
  );
  const selectedNationalForestIds = useMemo(
    () => new Set(topographicSelections.nationalForests),
    [topographicSelections.nationalForests],
  );
  const selectedEcoregionIds = useMemo(
    () => new Set(topographicSelections.ecoregions),
    [topographicSelections.ecoregions],
  );
  const selectedLongitudeLatitudeCellIds = useMemo(
    () => new Set(topographicSelections.longitudeLatitudeLines),
    [topographicSelections.longitudeLatitudeLines],
  );
  const selectedHighwayNumbers = useMemo(
    () => new Set(topographicSelections.highways),
    [topographicSelections.highways],
  );
  const selectedInterstateNumbers = useMemo(
    () => new Set(topographicSelections.interstates),
    [topographicSelections.interstates],
  );
  const selectedRailwayNames = useMemo(
    () => new Set(topographicSelections.railways),
    [topographicSelections.railways],
  );
  const selectedRiverNames = useMemo(
    () => new Set(topographicSelections.rivers),
    [topographicSelections.rivers],
  );
  const countyBoundaryLineLayer = useMemo(
    () => createBoundaryLineLayerCache("county", data.metadata.center, "#21918c", 1.5, 0.72),
    [data.metadata.center],
  );
  const countyBoundaryLines = useMemo(
    () => combineBoundaryLineLayers(
      "county-borders",
      selectBoundaryLineLayers(
        counties,
        selectedCountyIds,
        countyId,
        countyBoundaryLineLayer,
      ),
      "#21918c",
      1.5,
      0.72,
    ),
    [counties, countyBoundaryLineLayer, selectedCountyIds],
  );
  const longitudeLatitudeLineLayer = useMemo(
    () => createBoundaryLineLayerCache(
      "longitude-latitude",
      data.metadata.center,
      "#7fb4c5",
      1.3,
      0.78,
    ),
    [data.metadata.center],
  );
  const longitudeLatitudeBoundaryLines = useMemo(
    () => longitudeLatitudeLines
      ? combineBoundaryLineLayers(
        "longitude-latitude-lines",
        selectBoundaryLineLayers(
        longitudeLatitudeLines,
        selectedLongitudeLatitudeCellIds,
        longitudeLatitudeCellId,
        longitudeLatitudeLineLayer,
        ),
        "#7fb4c5",
        1.3,
        0.78,
      )
      : [],
    [
      longitudeLatitudeLineLayer,
      longitudeLatitudeLines,
      selectedLongitudeLatitudeCellIds,
    ],
  );
  const nationalParkLineLayer = useMemo(
    () => createBoundaryLineLayerCache("national-park", data.metadata.center, "#b99adc", 1.8, 0.9),
    [data.metadata.center],
  );
  const nationalParkBoundaryLines = useMemo(
    () => nationalParks
      ? combineBoundaryLineLayers(
        "national-park-borders",
        selectBoundaryLineLayers(
          nationalParks,
          selectedNationalParkIds,
          (feature) => String(feature.properties.UNIT_CODE).trim(),
          nationalParkLineLayer,
        ),
        "#b99adc",
        1.8,
        0.9,
      )
      : [],
    [nationalParkLineLayer, nationalParks, selectedNationalParkIds],
  );
  const nationalForestLineLayer = useMemo(
    () => createBoundaryLineLayerCache("national-forest", data.metadata.center, "#80b7a0", 1.8, 0.9),
    [data.metadata.center],
  );
  const nationalForestBoundaryLines = useMemo(
    () => nationalForests
      ? combineBoundaryLineLayers(
        "national-forest-borders",
        selectBoundaryLineLayers(
          nationalForests,
          selectedNationalForestIds,
          (feature) => String(feature.properties.forestorgc).trim(),
          nationalForestLineLayer,
        ),
        "#80b7a0",
        1.8,
        0.9,
      )
      : [],
    [nationalForestLineLayer, nationalForests, selectedNationalForestIds],
  );
  const ecoregionLineLayer = useMemo(
    () => createBoundaryLineLayerCache("ecoregion", data.metadata.center, "#d8bd68", 1.8, 0.9),
    [data.metadata.center],
  );
  const ecoregionBoundaryLines = useMemo(
    () => ecoregions
      ? combineBoundaryLineLayers(
        "ecoregion-borders",
        selectBoundaryLineLayers(
          ecoregions,
          selectedEcoregionIds,
          (feature) => String(feature.properties.US_L4CODE).trim(),
          ecoregionLineLayer,
        ),
        "#d8bd68",
        1.8,
        0.9,
      )
      : [],
    [ecoregionLineLayer, ecoregions, selectedEcoregionIds],
  );
  const selectedRouteIds = useMemo(
    () => new Set([
      ...topographicSelections.highways.map((number) => `highway/${number}`),
      ...topographicSelections.interstates.map((number) => `interstate/${number}`),
    ]),
    [topographicSelections.highways, topographicSelections.interstates],
  );
  const selectedMountainPeaks = useMemo(() => {
    const selected = new Set(topographicSelections.peaks);
    return mountainPeaks.filter((peak) => selected.has(peak.id));
  }, [mountainPeaks, topographicSelections.peaks]);
  const regionClipPolygons = useMemo(() => {
    if (!settings.clip && !imageExportPreview) return null;
    return [
      ...getRegionClipPolygons(regions, data.metadata.center, counties),
      ...boundaryFeatureClipPolygons(
        nationalParks,
        clipSelections.nationalParks,
        (feature) => String(feature.properties.UNIT_CODE ?? "").trim(),
        data.metadata.center,
      ),
      ...boundaryFeatureClipPolygons(
        nationalForests,
        clipSelections.nationalForests,
        (feature) => String(feature.properties.forestorgc ?? "").trim(),
        data.metadata.center,
      ),
      ...boundaryFeatureClipPolygons(
        longitudeLatitudeLines,
        clipSelections.longitudeLatitudeLines,
        longitudeLatitudeCellId,
        data.metadata.center,
      ),
      ...boundaryFeatureClipPolygons(
        ecoregions,
        clipSelections.ecoregions,
        (feature) => String(feature.properties.US_L4CODE ?? "").trim(),
        data.metadata.center,
      ),
    ];
  }, [
    clipSelections.ecoregions,
    clipSelections.longitudeLatitudeLines,
    clipSelections.nationalForests,
    clipSelections.nationalParks,
    counties,
    data.metadata.center,
    ecoregions,
    nationalForests,
    nationalParks,
    longitudeLatitudeLines,
    regions,
    settings.clip,
    imageExportPreview,
  ]);
  const stateBorderPolygons = useMemo(
    () => getStateBoundaryClipPolygons(data.state, data.metadata.center),
    [data.metadata.center, data.state.features],
  );
  const terrainClipPolygons = useMemo(() => {
    if (regionClipPolygons === null) return stateBorderPolygons;
    if (regionClipPolygons.length === 0 || stateBorderPolygons.length === 0) return [];
    return intersectStateWithRegions(stateBorderPolygons, regionClipPolygons);
  },
    [regionClipPolygons, stateBorderPolygons],
  );
  const lakeMaskPolygons = useMemo(() => {
    if (!lakes || selectedLakeIds.size === 0) return [];
    return lakes.features.flatMap((feature) => {
      if (!selectedLakeIds.has(String(feature.properties.GlobalID ?? "").trim())) return [];
      const rings = featureRings(feature).map((ring) =>
        ring.map((point) => toLocal(point, data.metadata.center))
      );
      return rings.length > 0 ? [rings] : [];
    });
  }, [data.metadata.center, lakes, selectedLakeIds]);
  const boundaryLines = useMemo<TerrainDrapedLineLayer[]>(() => [
    ...countyBoundaryLines,
    ...longitudeLatitudeBoundaryLines,
    ...nationalParkBoundaryLines,
    ...nationalForestBoundaryLines,
    ...ecoregionBoundaryLines,
  ], [
    countyBoundaryLines,
    ecoregionBoundaryLines,
    longitudeLatitudeBoundaryLines,
    nationalForestBoundaryLines,
    nationalParkBoundaryLines,
  ]);
  const highwayLines = useMemo(
    () => highwayFeatures
      ? getHighwayLines(
        highwayFeatures,
        data.metadata.center,
        "highway",
        selectedHighwayNumbers,
      )
      : [],
    [data.metadata.center, highwayFeatures, selectedHighwayNumbers],
  );
  const interstateLines = useMemo(
    () => highwayFeatures
      ? getHighwayLines(
        highwayFeatures,
        data.metadata.center,
        "interstate",
        selectedInterstateNumbers,
      )
      : [],
    [data.metadata.center, highwayFeatures, selectedInterstateNumbers],
  );
  const railwayLineLayers = useMemo<TerrainDrapedLineLayer[]>(() => {
    if (!railwayFeatures || selectedRailwayNames.size === 0) return [];
    const lines = railwayFeatures.features
      .filter((feature) => selectedRailwayNames.has(feature.properties.name))
      .flatMap((feature) =>
        feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates
      )
      .map((line) => line.map((position) => toLocal(position, data.metadata.center)));
    return lines.length > 0
      ? [{
        id: "railways",
        lines,
        color: "#d3a94a",
        lineWidth: 2,
        opacity: 0.9,
      }]
      : [];
  }, [data.metadata.center, railwayFeatures, selectedRailwayNames]);
  const riverLineLayers = useMemo<TerrainDrapedLineLayer[]>(() => {
    if (!riverFeatures || selectedRiverNames.size === 0) return [];
    const lines = riverFeatures.features
      .filter((feature) => selectedRiverNames.has(feature.properties.name))
      .flatMap((feature) =>
        feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates
      )
      .map((line) => line.map((position) => toLocal(position, data.metadata.center)));
    return lines.length > 0
      ? [{
        id: "rivers",
        lines,
        color: "#56a8c8",
        lineWidth: 1.8,
        opacity: 0.9,
      }]
      : [];
  }, [data.metadata.center, riverFeatures, selectedRiverNames]);
  const routeLines = useMemo<TerrainDrapedLineLayer[]>(() => [
    ...riverLineLayers,
    ...railwayLineLayers,
    ...(selectedHighwayNumbers.size > 0
      ? [{
        id: "california-highways",
        lines: highwayLines,
        color: "#77b887",
        lineWidth: 1.8,
        opacity: 0.9,
      }]
      : []),
    ...(selectedInterstateNumbers.size > 0
      ? [{
        id: "interstates",
        lines: interstateLines,
        color: "#d97770",
        lineWidth: 2.2,
        opacity: 0.95,
      }]
      : []),
  ], [
    highwayLines,
    interstateLines,
    railwayLineLayers,
    riverLineLayers,
    selectedHighwayNumbers,
    selectedInterstateNumbers,
  ]);
  const exportBoxLines = useMemo<TerrainDrapedLineLayer[]>(() => exportBounds.map((box) => ({
    id: `export-bounds-${box.id}`,
    lines: [box.outline],
    color: "#f5f2e8",
    lineWidth: 2.5,
    opacity: 0.96,
  })), [exportBounds]);
  const overlayBoundaryLines = useMemo(
    () => imageExportPreview ? exportBoxLines : [...boundaryLines, ...routeLines],
    [boundaryLines, exportBoxLines, imageExportPreview, routeLines],
  );
  const routeShields = useMemo(
    () => highwayFeatures
      ? createHighwayShields(highwayFeatures, data.metadata.center, selectedRouteIds)
      : [],
    [data.metadata.center, highwayFeatures, selectedRouteIds],
  );

  useEffect(() => {
    previousTilesRef.current = tiles;
  }, [tiles]);

  useEffect(() => {
    invalidate();
  }, [
    invalidate,
    settings.terrainEmissiveColor,
    settings.terrainGradientHighColor,
    settings.terrainGradientLowColor,
    settings.terrainPalette,
  ]);

  const azimuth = settings.sunAzimuth * Math.PI / 180;
  const elevation = settings.sunElevation * Math.PI / 180;
  const sunDistance = 1_800;

  return (
    <>
      <color attach="background" args={["#111a19"]} />
      <ambientLight intensity={settings.ambientLightIntensity} />
      <directionalLight
        position={[
          Math.sin(azimuth) * Math.cos(elevation) * sunDistance,
          Math.sin(elevation) * sunDistance,
          Math.cos(azimuth) * Math.cos(elevation) * sunDistance,
        ]}
        color={settings.lightColor}
        intensity={1.1}
      />
      <group visible={terrainVisible || imageExportPreview}>
        <Suspense fallback={null}>
          <TerrainTiles
            center={data.metadata.center}
            exaggeration={settings.exaggeration}
            heightPalette={settings.terrainPalette}
            terrainEmissiveColor={settings.terrainEmissiveColor}
            terrainGradientLowColor={settings.terrainGradientLowColor}
            terrainGradientHighColor={settings.terrainGradientHighColor}
            regionMap={ecoregionMapMetadata ? settings.regionMap : "none"}
            regionMapMetadata={ecoregionMapMetadata}
            regionMapTexture={ecoregionMapTexture}
            clipPolygons={terrainClipPolygons}
            lakeMaskPolygons={lakeMaskPolygons}
            tiles={deferredTiles}
          />
        </Suspense>
      </group>
      <Suspense fallback={null}>
        <TerrainOverlays
          mapRegions={imageExportPreview ? [] : regions}
          selectedRegionId={imageExportPreview ? null : selectedRegionId}
          regionOperationPreview={imageExportPreview ? null : regionOperationPreview}
          center={data.metadata.center}
          countyBoundaries={counties}
          drapedLineLayers={overlayBoundaryLines}
          lakes={lakes}
          selectedLakeIds={topographicSelections.lakes}
          highwayRouteShields={imageExportPreview ? [] : routeShields}
          mountainPeaks={imageExportPreview ? [] : selectedMountainPeaks}
          showMountainPeaks={!imageExportPreview && selectedMountainPeaks.length > 0}
          cameraTarget={view.target}
          showHighways={!imageExportPreview && selectedHighwayNumbers.size > 0}
          showInterstates={!imageExportPreview && selectedInterstateNumbers.size > 0}
          cameraDistance={view.distance}
          verticalExaggeration={settings.exaggeration}
          measurementSystem={settings.measurementSystem}
          terrainTiles={deferredTiles}
          onRegionHandlesChange={onRegionHandlesChange}
          onRegionPointElevationChange={onRegionPointElevationChange}
          onTerrainRaycastReady={onTerrainRaycastReady}
        />
      </Suspense>
      <CameraRig onCameraReady={onCameraReady} onInvalidateReady={onInvalidateReady}
        viewRef={viewRef} centerTerrainElevationRef={centerTerrainElevationRef}
        topDown={imageExportPreview} />
    </>
  );
}
