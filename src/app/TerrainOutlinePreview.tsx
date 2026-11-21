import { useMemo } from "react";
import type { TerrainExportRegion } from "../terrain/terrainExport";
import {
  getTerrainOutlineSvgGeometry,
  TERRAIN_OUTLINE_SVG_HEIGHT,
} from "../terrain/terrainOutline";

export function TerrainOutlinePreview({ region }: { region: TerrainExportRegion | null }) {
  const outline = useMemo(
    () => region ? getTerrainOutlineSvgGeometry(region) : null,
    [region],
  );

  return (
    <section className="map-panel image-output-panel" aria-label="Outline preview">
      <header className="image-output-header">
        <strong>{region?.name ?? "No element selected"}</strong>
        <span>GeoJSON and SVG boundary outline</span>
      </header>
      <div className="image-output-stage">
        {region && outline
          ? <svg className="outline-preview-svg"
            viewBox={`0 0 ${outline.width} ${TERRAIN_OUTLINE_SVG_HEIGHT}`}
            role="img"
            aria-label={`${region.name} outline preview`}
            preserveAspectRatio="xMidYMid meet">
            <rect width={outline.width} height={outline.height} fill="#fff" />
            <path d={outline.pathData} fill="none" stroke="#246e69"
              strokeWidth="0.5" strokeLinejoin="round" />
          </svg>
          : <p className="topographic-status">Select a cut element to preview its outline.</p>}
      </div>
    </section>
  );
}
