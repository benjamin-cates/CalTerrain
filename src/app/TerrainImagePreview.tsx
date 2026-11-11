import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset, Position, ViewSettings } from "../types";
import {
  createTerrainImageCanvas,
  getTerrainGroundScale,
  getTerrainImageDimensions,
  MAX_TERRAIN_IMAGE_PIXELS,
  type TerrainExportRegion,
} from "../terrain/terrainExport";
import type { TerrainHeightPalette } from "../terrain/terrainHeightPalette";
import { formatLength } from "../units";

export const TerrainImagePreview = memo(function TerrainImagePreview({
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
