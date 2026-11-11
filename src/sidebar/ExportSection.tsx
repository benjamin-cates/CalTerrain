import { useMemo, useState } from "react";
import {
  MAX_TERRAIN_EXPORT_FACES,
  estimateTerrainTriangleCount,
  getTerrainExportResolution,
  getTerrainExportScaleMeters,
  getTerrainExportScaleStep,
  type TerrainExportRegion,
  type TerrainExportTriangleReport,
} from "../terrain/terrainExport";
import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";
import { COMBINED_IMAGE_PREVIEW_ID, type ViewSettings } from "../types";
import { formatLength } from "../units";
import { HEIGHT_PALETTES } from "./heightPalettes";

type ExportSectionProps = {
  settings: ViewSettings;
  onSettingsChange: (settings: ViewSettings) => void;
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
};

export function ExportSection(props: ExportSectionProps) {
  const { settings } = props;
  const [scaleStep, setScaleStep] = useState(() => getTerrainExportScaleStep(1));
  const resolution = getTerrainExportResolution(props.resolutionIndex);
  const latitudeSpan = getTerrainExportScaleMeters(scaleStep);
  const triangleEstimates = useMemo(
    () => props.terrainExportRegions.map((region) => ({
      id: region.id,
      name: region.name,
      count: estimateTerrainTriangleCount(
        region,
        resolution,
        props.terrainExportGroundScale,
      ),
    })),
    [props.terrainExportGroundScale, props.terrainExportRegions, resolution],
  );
  const triangleEstimateById = new Map(
    triangleEstimates.map((estimate) => [estimate.id, estimate.count]),
  );
  const totalEstimatedTriangles = triangleEstimates.reduce(
    (total, estimate) => total + estimate.count,
    0,
  );
  const totalEstimateExceedsLimit = totalEstimatedTriangles > MAX_TERRAIN_EXPORT_FACES;

  return (
    <details className="control-section" open>
      <summary>Export</summary>
      <div className="export-format-options" role="group" aria-label="Export format">
        <button type="button" aria-pressed={props.exportFormat === "image"}
          disabled={props.clipExportRegions.length === 0}
          onClick={() => props.onSetExportFormat("image")}>Image</button>
        <button type="button" aria-pressed={props.exportFormat === "model"}
          onClick={() => props.onSetExportFormat("model")}>3D model</button>
      </div>
      {props.exportFormat === "model" && (
        <label className="control-toggle">
          <span>Preview cuts</span>
          <input type="checkbox" checked={settings.clip}
            onChange={(event) => props.onSettingsChange({
              ...settings,
              clip: event.target.checked,
            })} />
        </label>
      )}
      <small className="control-note">
        Regions selected with the "CUT" operation can be exported.
      </small>
      {props.exportFormat === "image" && (
        <>
          <small className="control-note">
            Preview and download the exact PNG output at the selected resolution. Outside the region is transparent.
          </small>
          <label className="control-field">
            <span>Preview region</span>
            <select aria-label="Image preview region" value={props.selectedImageRegionId ?? ""}
              onChange={(event) => props.onSelectImageRegion(event.target.value)}>
              {props.terrainExportRegions.length > 1 && (
                <option value={COMBINED_IMAGE_PREVIEW_ID}>Combined image of all cut regions</option>
              )}
              {props.terrainExportRegions.map((region) => (
                <option value={region.id} key={region.id}>{region.name}</option>
              ))}
            </select>
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
          {props.terrainExportRegions.map((region) => (
            <div className="image-export-region-row" key={region.id}>
              <span>{region.name}</span>
              <button type="button"
                disabled={!props.canExportClipRegions || props.terrainExportBusy}
                onClick={() => props.onExportImageRegion(region.id, resolution)}>
                Download PNG
              </button>
            </div>
          ))}
          {props.terrainExportRegions.length > 1 && (
            <div className="image-export-region-row">
              <span>Combined cut regions</span>
              <button type="button"
                disabled={!props.canExportClipRegions || props.terrainExportBusy}
                onClick={() => props.onExportImageCombined(resolution)}>
                Download combined PNG
              </button>
            </div>
          )}
          {props.terrainExportRegions.length > 1 && (
            <button type="button"
              disabled={!props.canExportClipRegions || props.terrainExportBusy}
              onClick={() => props.onExportImageZip(resolution)}>
              Download PNG ZIP
            </button>
          )}
        </>
      )}
      {props.exportFormat === "model" && <>
        <h3 className="feature-subsection-title">Cutting boundaries</h3>
        {props.clipExportRegions.length === 0 ? (
          <small className="control-note">No regions are selected for clipping.</small>
        ) : (
          <ul className="clip-region-export-list">
            {props.clipExportRegions.map((region) => <li key={region.id}>{region.name}</li>)}
          </ul>
        )}
        {!props.canExportClipRegions && props.clipExportRegions.length > 0 && (
          <small className="control-note">Load terrain data before exporting selected boundaries.</small>
        )}
        <button type="button"
          disabled={!props.canExportClipRegions || props.clipExportRegions.length === 0}
          onClick={props.onExportClipRegions}>Export boundaries as GeoJSON</button>
      </>}
      <div className={`terrain-export-controls${props.exportFormat === "model" ? " is-model" : ""}`}>
        <label className="control-field">
          <span>Resolution <strong>{formatLength(resolution, settings.measurementSystem)}</strong></span>
          <input type="range" aria-label="Export resolution" min="0" max="3" step="1"
            value={props.resolutionIndex}
            onChange={(event) => props.onSetResolutionIndex(Number(event.target.value))} />
          <small>Move right for finer terrain.</small>
        </label>
        {props.exportFormat === "model" && (
          <label className="control-field">
            <span>Latitude span <strong>{formatLength(latitudeSpan, settings.measurementSystem)}</strong></span>
            <input type="range" aria-label="California export latitude span" min="0" max="1000" step="any"
              value={scaleStep}
              onChange={(event) => setScaleStep(Number(event.target.value))} />
            <small>Controls the scale based on the height of the whole state.</small>
          </label>
        )}
      </div>
      {props.exportFormat === "model" && <>
        {props.clipExportRegions.length > 0 && (
          <ul className="terrain-export-region-list">
            {props.clipExportRegions.map((region) => (
              <li key={region.id}>
                <span>
                  {region.name}
                  {triangleEstimateById.has(region.id) && (
                    <small>
                      {triangleEstimateById.get(region.id)?.toLocaleString("en-US")} estimated triangles
                    </small>
                  )}
                </span>
                <button
                  type="button"
                  disabled={
                    !props.canExportClipRegions ||
                    props.terrainExportBusy ||
                    (triangleEstimateById.get(region.id) ?? 0) > MAX_TERRAIN_EXPORT_FACES
                  }
                  title={
                    (triangleEstimateById.get(region.id) ?? 0) > MAX_TERRAIN_EXPORT_FACES
                      ? "Estimated triangle count exceeds the 20 million export limit."
                      : undefined
                  }
                  onClick={() => props.onExportTerrainRegion(region.id, resolution, latitudeSpan)}>
                  Download GLB
                </button>
              </li>
            ))}
          </ul>
        )}
        {triangleEstimates.length > 0 && (
          <div className="terrain-triangle-summary">
            <span>Estimated total triangles</span>
            <strong>Combined total: {totalEstimatedTriangles.toLocaleString("en-US")}</strong>
          </div>
        )}
        {props.clipExportRegions.length > 1 && (
          <div className="terrain-export-batch-actions">
            <button type="button"
              disabled={!props.canExportClipRegions || props.terrainExportBusy || totalEstimateExceedsLimit}
              title={totalEstimateExceedsLimit
                ? "Estimated triangle count exceeds the 20 million export limit."
                : undefined}
              onClick={() => props.onExportTerrainZip(resolution, latitudeSpan)}>
              Download ZIP
            </button>
            <button type="button"
              disabled={!props.canExportClipRegions || props.terrainExportBusy || totalEstimateExceedsLimit}
              title={totalEstimateExceedsLimit
                ? "Estimated triangle count exceeds the 20 million export limit."
                : undefined}
              onClick={() => props.onExportTerrainCombined(resolution, latitudeSpan)}>
              Download combined
            </button>
          </div>
        )}
        {props.terrainExportTriangleReport && (
          <div className="terrain-triangle-report" role="status">
            <strong>Last export · total triangles</strong>
            {props.terrainExportTriangleReport.pieces.map((piece) => (
              <span key={piece.id}>
                {piece.name}: {piece.count.toLocaleString("en-US")}
              </span>
            ))}
            <strong>
              Combined total: {props.terrainExportTriangleReport.total.toLocaleString("en-US")}
            </strong>
          </div>
        )}
      </>}
      {props.terrainExportStatus && (
        <small className="topographic-status" role="status">{props.terrainExportStatus}</small>
      )}
      {props.terrainExportError && (
        <small className="topographic-status is-error" role="alert">{props.terrainExportError}</small>
      )}
    </details>
  );
}
