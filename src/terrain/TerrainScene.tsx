import { useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { Vector3, type Camera } from "three";
import { countyId, featureRings, toLocal } from "../geo";
import { longitudeLatitudeCellId } from "../longitudeLatitudeGrid";
import { RegionOverlay, type TerrainLineLayer } from "../RegionOverlay";
import {
  createHighwayShields,
  getHighwayLines,
  type HighwayFeatureCollection,
} from "../highways";
import type { MountainPeak } from "../mountains";
import type { RailwayFeatureCollection } from "../railways";
import type { TerrainExportBoundingBox } from "./terrainExport";
import type { TerrainRaycast } from "./terrainRaycast";
import {
  boundaryFeatureClipPolygons,
  regionClipPolygons as getRegionClipPolygons,
  type RegionHandle,
} from "../regions";
import { TerrainTiles } from "./Terrain";
import {
  getStateBoundaryClipPolygons,
  intersectStateWithRegions,
} from "./terrainClip";
import { selectTerrainTiles } from "./terrainQuadtree";
import type {
  BoundaryCollection,
  Dataset,
  Position,
  Region,
  RegionOverlayPreview,
  Tile,
  TopographicFeatureSelections,
  ClipFeatureSelections,
  ViewSettings,
  ViewState,
} from "../types";

const EMPTY_BOUNDARIES: BoundaryCollection = { type: "FeatureCollection", features: [] };

function CameraRig({
  onInvalidateReady,
  onCameraReady,
  viewRef,
  topDown,
}: {
  onInvalidateReady: (invalidate: (() => void) | null) => void;
  onCameraReady: (camera: Camera | null) => void;
  viewRef: { current: ViewState };
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
    target.set(view.target[0], 0, view.target[1]);
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
  nationalParks,
  nationalForests,
  longitudeLatitudeLines,
  mountains,
  topographicSelections,
  clipSelections,
  onCameraReady,
  onInvalidateReady,
  onHandlePositions,
  onPointElevationChange,
  onTerrainRaycastReady,
  terrainVisible,
  viewRef,
  settings,
  regions,
  selectedRegionId,
  shapeOperationPreview,
  view,
  imageExportPreview,
  exportBounds,
}: {
  data: Dataset;
  highwayFeatures: HighwayFeatureCollection | null;
  railwayFeatures: RailwayFeatureCollection | null;
  nationalParks: BoundaryCollection | null;
  nationalForests: BoundaryCollection | null;
  longitudeLatitudeLines: BoundaryCollection | null;
  mountains: MountainPeak[];
  topographicSelections: TopographicFeatureSelections;
  clipSelections: ClipFeatureSelections;
  onCameraReady: (camera: Camera | null) => void;
  onInvalidateReady: (invalidate: (() => void) | null) => void;
  onHandlePositions: (handles: RegionHandle[]) => void;
  onPointElevationChange: (id: string, elevationMeters: number) => void;
  onTerrainRaycastReady: (raycast: TerrainRaycast | null) => void;
  terrainVisible: boolean;
  viewRef: { current: ViewState };
  settings: ViewSettings;
  regions: Region[];
  selectedRegionId: string | null;
  shapeOperationPreview: RegionOverlayPreview | null;
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
  const selectedNationalParkIds = useMemo(
    () => new Set(topographicSelections.nationalParks),
    [topographicSelections.nationalParks],
  );
  const selectedNationalForestIds = useMemo(
    () => new Set(topographicSelections.nationalForests),
    [topographicSelections.nationalForests],
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
  const selectedRouteIds = useMemo(
    () => new Set([
      ...topographicSelections.highways.map((number) => `highway/${number}`),
      ...topographicSelections.interstates.map((number) => `interstate/${number}`),
    ]),
    [topographicSelections.highways, topographicSelections.interstates],
  );
  const selectedMountains = useMemo(() => {
    const selected = new Set(topographicSelections.peaks);
    return mountains.filter((peak) => selected.has(peak.id));
  }, [mountains, topographicSelections.peaks]);
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
    ];
  }, [
    clipSelections.longitudeLatitudeLines,
    clipSelections.nationalForests,
    clipSelections.nationalParks,
    counties,
    data.metadata.center,
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
  const terrainClipPolygons = useMemo(
    () => intersectStateWithRegions(stateBorderPolygons, regionClipPolygons),
    [regionClipPolygons, stateBorderPolygons],
  );
  const boundaryLines = useMemo<TerrainLineLayer[]>(() => [
    ...(selectedCountyIds.size > 0
      ? [{
          id: "county-borders",
          lines: counties.features
            .filter((feature) => selectedCountyIds.has(countyId(feature)))
            .flatMap((feature) =>
            featureRings(feature).map((ring) =>
              ring.map((point) => toLocal(point, data.metadata.center))
            )
          ),
          color: "#21918c",
          lineWidth: 1.5,
          opacity: 0.72,
        }]
      : []),
    ...(longitudeLatitudeLines && selectedLongitudeLatitudeCellIds.size > 0
      ? [{
          id: "longitude-latitude-lines",
          lines: longitudeLatitudeLines.features
            .filter((feature) => selectedLongitudeLatitudeCellIds.has(longitudeLatitudeCellId(feature)))
            .flatMap((feature) =>
              featureRings(feature).map((ring) =>
                ring.map((point) => toLocal(point, data.metadata.center))
              )
            ),
          color: "#7fb4c5",
          lineWidth: 1.3,
          opacity: 0.78,
        }]
      : []),
    ...(nationalParks && selectedNationalParkIds.size > 0
      ? [{
          id: "national-park-borders",
          lines: nationalParks.features
            .filter((feature) => selectedNationalParkIds.has(String(feature.properties.UNIT_CODE).trim()))
            .flatMap((feature) =>
              featureRings(feature).map((ring) =>
                ring.map((point) => toLocal(point, data.metadata.center))
              )
            ),
          color: "#b99adc",
          lineWidth: 1.8,
          opacity: 0.9,
        }]
      : []),
    ...(nationalForests && selectedNationalForestIds.size > 0
      ? [{
          id: "national-forest-borders",
          lines: nationalForests.features
            .filter((feature) => selectedNationalForestIds.has(String(feature.properties.forestorgc).trim()))
            .flatMap((feature) =>
              featureRings(feature).map((ring) =>
                ring.map((point) => toLocal(point, data.metadata.center))
              )
            ),
          color: "#80b7a0",
          lineWidth: 1.8,
          opacity: 0.9,
        }]
      : []),
  ], [
    counties.features,
    data.metadata.center,
    longitudeLatitudeLines,
    nationalForests,
    nationalParks,
    selectedCountyIds,
    selectedLongitudeLatitudeCellIds,
    selectedNationalForestIds,
    selectedNationalParkIds,
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
  const railwayLineLayers = useMemo<TerrainLineLayer[]>(() => {
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
  const routeLines = useMemo<TerrainLineLayer[]>(() => [
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
    selectedHighwayNumbers,
    selectedInterstateNumbers,
  ]);
  const exportBoxLines = useMemo<TerrainLineLayer[]>(() => exportBounds.map((box) => ({
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
            clipPolygons={terrainClipPolygons}
            tiles={deferredTiles}
          />
        </Suspense>
      </group>
      <Suspense fallback={null}>
        <RegionOverlay
          regions={imageExportPreview ? [] : regions}
          selectedId={imageExportPreview ? null : selectedRegionId}
          shapeOperationPreview={imageExportPreview ? null : shapeOperationPreview}
          center={data.metadata.center}
          counties={counties}
          boundaryLines={overlayBoundaryLines}
          routeShields={imageExportPreview ? [] : routeShields}
          mountains={imageExportPreview ? [] : selectedMountains}
          showPeaks={!imageExportPreview && selectedMountains.length > 0}
          viewTarget={view.target}
          showHighways={!imageExportPreview && selectedHighwayNumbers.size > 0}
          showInterstates={!imageExportPreview && selectedInterstateNumbers.size > 0}
          distance={view.distance}
          exaggeration={settings.exaggeration}
          measurementSystem={settings.measurementSystem}
          tiles={deferredTiles}
          onHandlePositions={onHandlePositions}
          onPointElevationChange={onPointElevationChange}
          onTerrainRaycastReady={onTerrainRaycastReady}
        />
      </Suspense>
      <CameraRig onCameraReady={onCameraReady} onInvalidateReady={onInvalidateReady}
        viewRef={viewRef} topDown={imageExportPreview} />
    </>
  );
}
