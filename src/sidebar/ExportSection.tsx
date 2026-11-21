import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_TERRAIN_EXPORT_FACES,
  estimateTerrainTriangleCount,
  getTerrainExportResolution,
  type TerrainModelFileFormat,
  type TerrainExportRegion,
  type TerrainExportTriangleReport,
} from "../terrain/terrainExport";
import type {
  TerrainAccessory,
  TerrainAccessoryType,
  TerrainModelOptions,
} from "../terrain/terrainOrnament";
import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";
import type { ViewSettings } from "../types";
import { formatLength } from "../units";
import { HEIGHT_PALETTES } from "./heightPalettes";

type ExportFormat = "image" | "model" | "outline" | null;

type ExportSectionProps = {
  settings: ViewSettings;
  terrainExportBusy: boolean;
  terrainExportStatus: string | null;
  terrainExportError: string | null;
  terrainExportRegions: TerrainExportRegion[];
  terrainExportGroundScale: number;
  terrainExportTriangleReport: TerrainExportTriangleReport | null;
  canExport: boolean;
  onExportModel: (
    format: TerrainModelFileFormat,
    regionId: string,
    resolutionMeters: number,
    model: TerrainModelOptions,
  ) => void;
  onExportImage: (regionId: string, resolutionMeters: number) => void;
  onExportOutline: (regionId: string) => void;
  onExportOutlineSvg: (regionId: string) => void;
  exportFormat: ExportFormat;
  onSetExportFormat: (format: ExportFormat) => void;
  resolutionIndex: number;
  onSetResolutionIndex: (index: number) => void;
  latitudeSpanMm: number;
  onSetLatitudeSpanMm: (millimeters: number) => void;
  selectedExportRegionId: string | null;
  onSelectExportRegion: (regionId: string) => void;
  baseThicknessMm: number;
  onSetBaseThicknessMm: (thickness: number) => void;
  accessories: TerrainAccessory[];
  onAddAccessory: (type: TerrainAccessoryType) => void;
  onUpdateAccessory: (id: string, changes: Partial<TerrainAccessory>) => void;
  onRemoveAccessory: (id: string) => void;
  heightPalette: TerrainHeightPalette;
  onSetHeightPalette: (palette: TerrainHeightPalette) => void;
};

function accessoryLabel(type: TerrainAccessoryType): string {
  return type[0]!.toUpperCase() + type.slice(1);
}

function accessoryIcon(type: TerrainAccessoryType) {
  if (type === "handle") {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="5" />
    </svg>;
  }
  if (type === "heart") {
    return <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21S3 15.4 3 9.3A4.8 4.8 0 0 1 12 7a4.8 4.8 0 0 1 9 2.3C21 15.4 12 21 12 21Z" />
    </svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m12 2.5 2.8 6.2 6.7.7-5 4.5 1.4 6.6-5.9-3.4-5.9 3.4 1.4-6.6-5-4.5 6.7-.7L12 2.5Z" />
  </svg>;
}

function MoreIcon() {
  return <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <circle cx="10" cy="4" r="1.5" />
    <circle cx="10" cy="10" r="1.5" />
    <circle cx="10" cy="16" r="1.5" />
  </svg>;
}

export function ExportSection(props: ExportSectionProps) {
  const [accessoryPopupId, setAccessoryPopupId] = useState<string | null>(null);
  const [accessoryPopupPosition, setAccessoryPopupPosition] = useState({ top: 8, left: 8 });
  const accessoryPopupRef = useRef<HTMLDivElement>(null);
  const accessoryButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const resolution = getTerrainExportResolution(props.resolutionIndex);
  const hasExportRegions = props.terrainExportRegions.length > 0;
  const exportRegionLabel = hasExportRegions
    ? "Element to export"
    : 'Element to export (Add pieces by selecting "cut")';
  const selectedRegion = props.terrainExportRegions.find(
    (region) => region.id === props.selectedExportRegionId,
  ) ?? null;
  const estimatedTriangles = useMemo(
    () => selectedRegion
      ? estimateTerrainTriangleCount(
        selectedRegion,
        resolution,
        props.terrainExportGroundScale,
      )
      : 0,
    [props.terrainExportGroundScale, resolution, selectedRegion],
  );
  const modelOptions: TerrainModelOptions = {
    baseThicknessMm: props.baseThicknessMm,
    latitudeSpanMm: props.latitudeSpanMm,
    accessories: props.accessories,
  };
  const canDownload = props.canExport &&
    !!selectedRegion &&
    !props.terrainExportBusy;
  const canDownloadModel = canDownload;
  const activeAccessory = props.accessories.find(
    (accessory) => accessory.id === accessoryPopupId,
  ) ?? null;

  useEffect(() => {
    if (!accessoryPopupId) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        accessoryPopupRef.current?.contains(event.target) ||
        accessoryButtonRefs.current.get(accessoryPopupId)?.contains(event.target)
      ) return;
      setAccessoryPopupId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccessoryPopupId(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accessoryPopupId]);

  const toggleAccessoryPopup = (accessoryId: string, button: HTMLButtonElement) => {
    if (accessoryPopupId === accessoryId) {
      setAccessoryPopupId(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    setAccessoryPopupPosition({
      top: Math.max(8, Math.min(bounds.top, window.innerHeight - 360)),
      left: Math.max(8, Math.min(bounds.right + 8, window.innerWidth - 356)),
    });
    setAccessoryPopupId(accessoryId);
  };

  return (
    <details className="control-section" open>
      <summary>Export</summary>
      <div className="terrain-export-region-select">
        <label className="control-field">
          <span>{exportRegionLabel}</span>
          <select aria-label={exportRegionLabel}
            disabled={!hasExportRegions}
            value={props.selectedExportRegionId ?? ""}
            onChange={(event) => props.onSelectExportRegion(event.target.value)}>
            {props.terrainExportRegions.map((region) => (
              <option value={region.id} key={region.id}>{region.name}</option>
            ))}
          </select>
        </label>
      </div>
      {props.exportFormat !== null && (
        <button className="export-preview-cancel" type="button"
          onClick={() => props.onSetExportFormat(null)}>
          Cancel preview
        </button>
      )}
      <div className="export-format-options" role="group" aria-label="Export preview">
        <button type="button" aria-pressed={props.exportFormat === "model"}
          disabled={!selectedRegion}
          onClick={() => props.onSetExportFormat("model")}>3D model</button>
        <button type="button" aria-pressed={props.exportFormat === "image"}
          disabled={!selectedRegion}
          onClick={() => props.onSetExportFormat("image")}>Image</button>
        <button type="button" aria-pressed={props.exportFormat === "outline"}
          disabled={!selectedRegion}
          onClick={() => props.onSetExportFormat("outline")}>Outline</button>
      </div>
      {props.terrainExportRegions.length === 0 ? (
        <small className="control-note">Select a cut region before choosing an export preview.</small>
      ) : (
        <small className="control-note">
          Choose a preview type, then download the selected element.
        </small>
      )}

      {props.exportFormat === "model" && (
        <section className="terrain-model-controls" aria-label="3D model export controls">
          <label className="control-field">
            <span>Resolution <strong>{formatLength(resolution, props.settings.measurementSystem)}</strong></span>
            <input type="range" aria-label="Export resolution" min="0" max="6" step="1"
              value={props.resolutionIndex}
              onChange={(event) => props.onSetResolutionIndex(Number(event.target.value))} />
            <small>Move right for finer terrain.</small>
          </label>
          <label className="control-field">
            <span>Latitude span <strong>{props.latitudeSpanMm} mm</strong></span>
            <input type="range" aria-label="Model latitude span in millimeters"
              min="10" max="500" step="1" value={props.latitudeSpanMm}
              onChange={(event) => props.onSetLatitudeSpanMm(Number(event.target.value))} />
            <small>Sets the north–south size of the selected element.</small>
          </label>
          <label className="control-field">
            <span>Base thickness <strong>{props.baseThicknessMm} mm</strong></span>
            <input type="range" aria-label="Model base thickness in millimeters"
              min="0.1" max="100" step="0.1" value={props.baseThicknessMm}
              onChange={(event) => props.onSetBaseThicknessMm(Number(event.target.value))} />
          </label>
          <section className="terrain-accessories" aria-label="Accessories">
            <h3 className="feature-subsection-title">Accessories</h3>
            <div className="terrain-accessory-add-buttons">
              {(["handle", "heart", "star"] as const).map((type) => (
                <button type="button" key={type}
                  aria-label={`Add ${type} accessory`}
                  onClick={() => props.onAddAccessory(type)}>
                  {accessoryIcon(type)}
                  <span>{accessoryLabel(type)}</span>
                </button>
              ))}
            </div>
            {props.accessories.length === 0 ? (
              <small className="control-note">No accessories added.</small>
            ) : (
              <ul className="terrain-accessory-list">
                {props.accessories.map((accessory, index) => (
                  <li key={accessory.id} className="terrain-accessory">
                    <div className="terrain-accessory-heading">
                      <strong>{accessoryLabel(accessory.type)} {index + 1}</strong>
                      <div className="terrain-accessory-actions">
                        <button type="button"
                          aria-label={`Delete ${accessoryLabel(accessory.type)} ${index + 1}`}
                          onClick={() => {
                            if (accessoryPopupId === accessory.id) setAccessoryPopupId(null);
                            props.onRemoveAccessory(accessory.id);
                          }}>
                          Delete
                        </button>
                        <button type="button" className="terrain-accessory-more"
                          aria-label={`More properties for ${accessoryLabel(accessory.type)} ${index + 1}`}
                          title="More"
                          ref={(button) => {
                            if (button) accessoryButtonRefs.current.set(accessory.id, button);
                            else accessoryButtonRefs.current.delete(accessory.id);
                          }}
                          onClick={(event) =>
                            toggleAccessoryPopup(accessory.id, event.currentTarget)
                          }>
                          <MoreIcon />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {activeAccessory && (
              <div ref={accessoryPopupRef}
                className="topographic-popup terrain-accessory-popup"
                role="dialog"
                aria-label={`${accessoryLabel(activeAccessory.type)} properties`}
                style={accessoryPopupPosition}>
                <div className="topographic-popup-header">
                  <strong>{accessoryLabel(activeAccessory.type)} properties</strong>
                  <button type="button" aria-label="Close accessory properties"
                    onClick={() => setAccessoryPopupId(null)}>×</button>
                </div>
                <div className="terrain-accessory-properties">
                  <div className="terrain-accessory-coordinates">
                    <label className="control-field">
                      <span>Latitude</span>
                      <input type="number" step="any"
                        aria-label={`${accessoryLabel(activeAccessory.type)} latitude`}
                        value={activeAccessory.position[1].toFixed(5)}
                        onChange={(event) => {
                          if (event.target.value === "") return;
                          const latitude = Number(event.target.value);
                          if (Number.isFinite(latitude)) {
                            props.onUpdateAccessory(activeAccessory.id, {
                              position: [activeAccessory.position[0], latitude],
                            });
                          }
                        }} />
                    </label>
                    <label className="control-field">
                      <span>Longitude</span>
                      <input type="number" step="any"
                        aria-label={`${accessoryLabel(activeAccessory.type)} longitude`}
                        value={activeAccessory.position[0].toFixed(5)}
                        onChange={(event) => {
                          if (event.target.value === "") return;
                          const longitude = Number(event.target.value);
                          if (Number.isFinite(longitude)) {
                            props.onUpdateAccessory(activeAccessory.id, {
                              position: [longitude, activeAccessory.position[1]],
                            });
                          }
                        }} />
                    </label>
                  </div>
                  <div className="terrain-accessory-sizing">
                    <label className="control-field">
                      <span>Size <strong>{activeAccessory.sizeMm} mm</strong></span>
                      <input type="range" min="1" max="500" step="1"
                        aria-label={`${accessoryLabel(activeAccessory.type)} size in millimeters`}
                        value={activeAccessory.sizeMm}
                        onChange={(event) => props.onUpdateAccessory(activeAccessory.id, {
                          sizeMm: Number(event.target.value),
                        })} />
                    </label>
                    <label className="control-field">
                      <span>Rotation <strong>{activeAccessory.rotationDegrees}°</strong></span>
                      <input type="range" min="0" max="360" step="1"
                        aria-label={`${accessoryLabel(activeAccessory.type)} rotation`}
                        value={activeAccessory.rotationDegrees}
                        onChange={(event) => props.onUpdateAccessory(activeAccessory.id, {
                          rotationDegrees: Number(event.target.value),
                        })} />
                    </label>
                  </div>
                  {activeAccessory.type === "handle" && (
                    <button type="button"
                        aria-pressed={activeAccessory.clipTerrain !== false}
                        onClick={() => props.onUpdateAccessory(activeAccessory.id, {
                          clipTerrain: activeAccessory.clipTerrain === false,
                        })}>
                        Terrain clipping: {activeAccessory.clipTerrain === false ? "Off" : "On"}
                    </button>
                  )}
                  {activeAccessory.type !== "handle" && (
                    <label className="control-field">
                      <span>Thickness <strong>{activeAccessory.thicknessMm} mm</strong></span>
                      <input type="range" min="1" max="10" step="0.5"
                        aria-label={`${accessoryLabel(activeAccessory.type)} thickness in millimeters`}
                        value={activeAccessory.thicknessMm ?? 3}
                        onChange={(event) => props.onUpdateAccessory(activeAccessory.id, {
                          thicknessMm: Number(event.target.value),
                        })} />
                    </label>
                  )}
                </div>
              </div>
            )}
            {props.accessories.length > 0 && (
              <small className="control-note">Drag the orange markers in the preview to move accessories.</small>
            )}
          </section>
          {estimatedTriangles > 0 && (
            <small className="control-note">
              Approximately {estimatedTriangles.toLocaleString("en-US")} terrain triangles
              {estimatedTriangles > MAX_TERRAIN_EXPORT_FACES ? " · exceeds the export limit" : ""}
            </small>
          )}
          {(["glb", "stl"] as const).map((format) => (
            <button type="button" key={format}
              disabled={!canDownloadModel || estimatedTriangles > MAX_TERRAIN_EXPORT_FACES}
              onClick={() => selectedRegion && props.onExportModel(
                format,
                selectedRegion.id,
                resolution,
                modelOptions,
              )}>
              Download {format.toUpperCase()} Model
            </button>
          ))}
        </section>
      )}

      {props.exportFormat === "image" && (
        <section className="terrain-image-controls" aria-label="Image export controls">
          <label className="control-field">
            <span>Resolution <strong>{formatLength(resolution, props.settings.measurementSystem)}</strong></span>
            <input type="range" aria-label="Export resolution" min="0" max="6" step="1"
              value={props.resolutionIndex}
              onChange={(event) => props.onSetResolutionIndex(Number(event.target.value))} />
            <small>Move right for finer terrain.</small>
          </label>
          <div className="height-palette-options" role="group" aria-label="Height color scale">
            {HEIGHT_PALETTES.map((palette) => (
              <button className="height-palette-button" type="button" key={palette.id}
                style={{ background: palette.gradient }}
                aria-pressed={props.heightPalette === palette.id}
                onClick={() => props.onSetHeightPalette(palette.id)}>
                <span className="height-palette-name">{palette.label}</span>
              </button>
            ))}
          </div>
          <button type="button" disabled={!canDownload}
            onClick={() => selectedRegion && props.onExportImage(selectedRegion.id, resolution)}>
            Download PNG
          </button>
        </section>
      )}

      {props.exportFormat === "outline" && (
        <section className="terrain-outline-controls" aria-label="Outline export controls">
          <small className="control-note">
            Export the selected boundary as GeoJSON or a 100 px-high SVG, including holes and disconnected pieces.
          </small>
          <button type="button" disabled={!canDownload}
            onClick={() => selectedRegion && props.onExportOutline(selectedRegion.id)}>
            Download GeoJSON
          </button>
          <button type="button" disabled={!canDownload}
            onClick={() => selectedRegion && props.onExportOutlineSvg(selectedRegion.id)}>
            Download SVG
          </button>
        </section>
      )}

      {props.terrainExportTriangleReport && (
        <div className="terrain-triangle-report" role="status">
          <strong>Last export · total triangles: {props.terrainExportTriangleReport.total.toLocaleString("en-US")}</strong>
        </div>
      )}
      {props.terrainExportStatus && (
        <small className="topographic-status" role="status">{props.terrainExportStatus}</small>
      )}
      {props.terrainExportError && (
        <small className="topographic-status is-error" role="alert">{props.terrainExportError}</small>
      )}
    </details>
  );
}
