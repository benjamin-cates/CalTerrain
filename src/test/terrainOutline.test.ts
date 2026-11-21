import { describe, expect, it } from "bun:test";
import {
  createTerrainOutlineSvg,
  getTerrainOutlineSvgGeometry,
} from "../terrain/terrainOutline";
import type { TerrainExportRegion } from "../terrain/terrainExport";

describe("terrain outline SVG", () => {
  const region: TerrainExportRegion = {
    id: "outline-test",
    name: "Outline test",
    polygons: [[
      [
        [0, -1],
        [4, -1],
        [4, 1],
        [0, 1],
        [0, -1],
      ],
      [
        [1, -0.5],
        [1, 0.5],
        [3, 0.5],
        [3, -0.5],
        [1, -0.5],
      ],
    ]],
  };

  it("scales the outline bounds to 100 px high and maps north to the top", () => {
    const geometry = getTerrainOutlineSvgGeometry(region);
    expect(geometry.height).toBe(100);
    expect(geometry.width).toBe(200);
    expect(geometry.pathData).toContain("M0 0L200 0L200 100");
    expect(geometry.pathData.match(/M/g)).toHaveLength(2);
  });

  it("exports an SVG with matching dimensions and boundary paths", () => {
    const svg = createTerrainOutlineSvg(region);
    expect(svg).toContain('width="200px" height="100px"');
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain("<path");
  });
});
