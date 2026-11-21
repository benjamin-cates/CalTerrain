import type { TerrainExportRegion } from "./terrainExport";

export const TERRAIN_OUTLINE_SVG_HEIGHT = 100;

export type TerrainOutlineSvgGeometry = {
  width: number;
  height: number;
  pathData: string;
};

function formatSvgNumber(value: number): string {
  return Number(value.toPrecision(10)).toString();
}

export function getTerrainOutlineSvgGeometry(
  region: TerrainExportRegion,
): TerrainOutlineSvgGeometry {
  const points = region.polygons.flat(2);
  if (points.length === 0) {
    throw new Error("The selected element has no outline to export.");
  }
  const bounds = points.reduce((result, [x, z]) => ({
    minX: Math.min(result.minX, x),
    minZ: Math.min(result.minZ, z),
    maxX: Math.max(result.maxX, x),
    maxZ: Math.max(result.maxZ, z),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  if (!Number.isFinite(spanX) || !Number.isFinite(spanZ) || spanZ <= 0) {
    throw new Error("Could not calculate the selected element's SVG outline bounds.");
  }
  const scale = TERRAIN_OUTLINE_SVG_HEIGHT / spanZ;
  const width = Math.max(spanX * scale, Number.EPSILON);
  const pathData = region.polygons.flatMap((polygon) =>
    polygon.flatMap((ring) => {
      const first = ring[0];
      if (!first) return [];
      const firstX = (first[0] - bounds.minX) * scale;
      const firstY = (first[1] - bounds.minZ) * scale;
      const commands = [`M${formatSvgNumber(firstX)} ${formatSvgNumber(firstY)}`];
      for (const [x, z] of ring.slice(1)) {
        commands.push(
          `L${formatSvgNumber((x - bounds.minX) * scale)} ` +
          `${formatSvgNumber((z - bounds.minZ) * scale)}`,
        );
      }
      commands.push("Z");
      return [commands.join("")];
    })
  ).join("");
  return { width, height: TERRAIN_OUTLINE_SVG_HEIGHT, pathData };
}

export function createTerrainOutlineSvg(region: TerrainExportRegion): string {
  const { width, height, pathData } = getTerrainOutlineSvgGeometry(region);
  const formattedWidth = formatSvgNumber(width);
  const formattedHeight = formatSvgNumber(height);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formattedWidth}px" ` +
    `height="${formattedHeight}px" viewBox="0 0 ${formattedWidth} ${formattedHeight}">`,
    `<rect width="${formattedWidth}" height="${formattedHeight}" fill="#fff"/>`,
    `<path d="${pathData}" fill="none" stroke="#246e69" stroke-width="0.5" ` +
    'stroke-linejoin="round"/>',
    "</svg>",
  ].join("\n");
}
