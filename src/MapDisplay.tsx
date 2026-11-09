import { Canvas } from "@react-three/fiber";
import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { Camera } from "three";
import { TerrainScene } from "./terrain/TerrainScene";
import type { RegionHandle } from "./regions";
import type { HighwayFeatureCollection } from "./highways";
import type { RailwayFeatureCollection } from "./railways";
import type { RiverFeatureCollection } from "./rivers";
import type { MountainPeak } from "./mountains";
import type { TerrainExportBoundingBox } from "./terrain/terrainExport";
import type { TerrainRaycast } from "./terrain/terrainRaycast";
import type {
  Dataset,
  BoundaryCollection,
  ClipFeatureSelections,
  Position,
  Region,
  RegionOverlayPreview,
  TopographicFeatureSelections,
  ViewSettings,
  ViewState,
} from "./types";
import { formatDistance } from "./units";

type Props = {
  dataset: Dataset | null;
  highwayFeatures: HighwayFeatureCollection | null;
  railwayFeatures: RailwayFeatureCollection | null;
  riverFeatures: RiverFeatureCollection | null;
  nationalParks: BoundaryCollection | null;
  nationalForests: BoundaryCollection | null;
  longitudeLatitudeLines: BoundaryCollection | null;
  mountains: MountainPeak[];
  topographicSelections: TopographicFeatureSelections;
  clipSelections: ClipFeatureSelections;
  dataError: string | null;
  terrainVisible: boolean;
  welcomeOpen: boolean;
  onDismissWelcome: () => void;
  onToggleTerrain: () => void;
  stageRef: RefObject<HTMLDivElement | null>;
  viewRef: RefObject<ViewState>;
  view: ViewState;
  settings: ViewSettings;
  regions: Region[];
  selectedRegionId: string | null;
  shapeOperationPreview: RegionOverlayPreview | null;
  onCameraReady: (camera: Camera | null) => void;
  onInvalidateReady: (invalidate: (() => void) | null) => void;
  onHandlePositions: (handles: RegionHandle[]) => void;
  onTerrainRaycastReady: (raycast: TerrainRaycast | null) => void;
  isPlacingCustomPoint: boolean;
  isRightPanning: boolean;
  centerTerrainElevationRef: { current: number | null };
  onPointElevationChange: (id: string, elevationMeters: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
  coordinates: string;
  scaleKm: number;
  scalePixels: number;
  imageExportPreview: boolean;
  exportBounds: TerrainExportBoundingBox[];
};

export function MapDisplay(props: Props) {
  const welcomePanelRef = useRef<HTMLDivElement>(null);
  const {
    dataset,
    settings,
    view,
    viewRef,
    regions,
    selectedRegionId,
    highwayFeatures,
    railwayFeatures,
    riverFeatures,
    nationalParks,
    nationalForests,
    longitudeLatitudeLines,
    mountains,
    topographicSelections,
    clipSelections,
  } = props;
  useEffect(() => {
    if (!props.welcomeOpen) return;
    const dismissOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && welcomePanelRef.current?.contains(target)) return;
      props.onDismissWelcome();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onDismissWelcome();
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePointer);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [props.onDismissWelcome, props.welcomeOpen]);

  return (
    <section className="map-panel" aria-label="Interactive California terrain map">
      <div ref={props.stageRef}
        className={`terrain-stage${props.isPlacingCustomPoint ? " is-placing-point" : ""}`}
        onPointerDown={props.onPointerDown}
        onContextMenu={(event) => event.preventDefault()} onWheel={props.onWheel}>
        {dataset ? (
          <Canvas camera={{ position: [0, 1_200, 1_850], fov: 40, near: 0.1, far: 20_000 }}
            dpr={[1, 1.75]} frameloop="demand" gl={{ antialias: true, alpha: false }}>
            <TerrainScene
              data={dataset}
              highwayFeatures={highwayFeatures}
              railwayFeatures={railwayFeatures}
              riverFeatures={riverFeatures}
              nationalParks={nationalParks}
              nationalForests={nationalForests}
              longitudeLatitudeLines={longitudeLatitudeLines}
              mountains={mountains}
              topographicSelections={topographicSelections}
              clipSelections={clipSelections}
              imageExportPreview={props.imageExportPreview}
              exportBounds={props.exportBounds}
              settings={settings} regions={regions}
              selectedRegionId={selectedRegionId}
              shapeOperationPreview={props.shapeOperationPreview}
              terrainVisible={props.terrainVisible}
              onCameraReady={props.onCameraReady} onInvalidateReady={props.onInvalidateReady}
              onHandlePositions={props.onHandlePositions}
              onPointElevationChange={props.onPointElevationChange}
              onTerrainRaycastReady={props.onTerrainRaycastReady}
              centerTerrainElevationRef={props.centerTerrainElevationRef}
              viewRef={viewRef} view={view} />
          </Canvas>
        ) : (
          <div className="empty-state">
            <span className="empty-kicker">THE LAND IS WAITING</span>
            <h2>Prepare your terrain data</h2>
            <p>Generate the compact, state-clipped viewer tiles to begin exploring.</p>
            <code>bun run process:terrain</code>
            <span className="empty-note">{props.dataError}</span>
          </div>
        )}
        {props.isRightPanning && <div className="map-center-crosshair" aria-hidden="true" />}
        <div className="map-controls">
          <button type="button" aria-pressed={!props.terrainVisible && !props.imageExportPreview}
            aria-label={props.imageExportPreview
              ? "Terrain stays visible in image preview"
              : props.terrainVisible ? "Hide terrain map" : "Show terrain map"}
            title={props.imageExportPreview
              ? "Terrain stays visible in image preview"
              : props.terrainVisible ? "Hide terrain map" : "Show terrain map"}
            disabled={props.imageExportPreview}
            onClick={props.onToggleTerrain}>
            {props.terrainVisible || props.imageExportPreview ? (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5Z" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 3l14 14M8.2 5.2A9.9 9.9 0 0 1 10 5c4.5 0 7.5 5 7.5 5a13 13 0 0 1-2.1 2.6M6.1 6.1C4.1 7.3 2.5 10 2.5 10s1 1.8 2.8 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <span className="control-divider" />
          <button type="button" aria-label="Zoom in" onClick={() => props.onZoom(0.72)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => props.onZoom(1.38)}>−</button>
          <span className="control-divider" />
          <button type="button" aria-label="Reset view" onClick={props.onReset}>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3.3 8A7 7 0 1 1 3 11m.3-7v4h4" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
        <div className="scale-bar"><span style={{ width: `${props.scalePixels}px` }} />
          <small>{formatDistance(props.scaleKm, settings.measurementSystem)} (map)</small></div>
        <div className="map-coordinates"><span>◎</span> {props.coordinates}</div>
        {props.welcomeOpen && (
          <div className="map-welcome-backdrop"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) props.onDismissWelcome();
              event.stopPropagation();
            }}>
            <section ref={welcomePanelRef} className="map-welcome-dialog"
              role="dialog" aria-modal="false" aria-labelledby="map-welcome-title"
              onPointerDown={(event) => event.stopPropagation()}>
              <button className="map-welcome-close" type="button"
                aria-label="Close welcome message" onClick={props.onDismissWelcome}>×</button>
              <h2 id="map-welcome-title">Welcome to CalTerrain</h2>
              <ol>
                <li><p>Style the map in the Lighting section.</p></li>
                <li><p>Embellish the map with custom, topological, or manmade features. Use "Cut" on regions to make it available for export.</p></li>
                <li><p>Export the map as either GLB (3D model) or PNG (image).</p></li>
              </ol>
              <p>Disclaimer: Data may not be complete or up-to-date. Many features are simplified lossily to improve performance. Elevation data is averaged over 30 m quadrants, so maximum or minimum elevations are not accurate.</p>
              <small>Click outside or press Escape to dismiss.</small>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
