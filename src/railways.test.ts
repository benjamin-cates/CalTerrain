import { describe, expect, test } from "bun:test";
import shp from "shpjs";
import { getRailwayFeatureOptions, parseRailwayShapefile } from "./railways";

describe("railway shapefile", () => {
  test("parses the unified railway archive into named line options", async () => {
    const archive = Bun.file(
      new URL("../public/data/features/california_rail_routes.zip", import.meta.url),
    );
    const collection = parseRailwayShapefile(
      await shp(await archive.arrayBuffer()),
    );
    const options = getRailwayFeatureOptions(collection);

    expect(collection.features).toHaveLength(36);
    expect(options).toHaveLength(36);
    expect(options.map((option) => option.id)).toContain("BART: Red Line");
    expect(options.map((option) => option.id)).toContain("LA Metro: A Line");
    expect(options.map((option) => option.id)).toContain("Amtrak: Pacific Surfliner");
    expect(options.map((option) => option.id)).toContain("SDMTS: Blue Line");
    expect(options.map((option) => option.id)).toContain("SDMTS: Green Line");
    expect(options.map((option) => option.id)).toContain("SDMTS: Orange Line");
    expect(options.map((option) => option.id)).toContain("SMART: Main Line");
    expect(options.every((option) => option.lines?.length === 1)).toBe(true);
  });

  test("rejects unnamed or non-line route features", () => {
    expect(() => parseRailwayShapefile({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[-122, 37]] },
      }],
    })).toThrow("Railway shapefile feature 1 is missing a name or line geometry.");
  });
});
