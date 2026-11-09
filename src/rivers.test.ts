import { describe, expect, test } from "bun:test";
import shp from "shpjs";
import { getRiverFeatureOptions, parseRiverShapefile } from "./rivers";

describe("river shapefile", () => {
  test("parses the river archive into named line options", async () => {
    const archive = Bun.file(
      new URL("../public/data/features/nhd_major_rivers.zip", import.meta.url),
    );
    const collection = parseRiverShapefile(
      await shp(await archive.arrayBuffer()),
    );
    const options = getRiverFeatureOptions(collection);

    expect(collection.features).toHaveLength(302);
    expect(options).toHaveLength(302);
    expect(options.map((option) => option.id)).toContain("Sacramento River");
    expect(options.every((option) => option.lines?.length)).toBe(true);
    expect(collection.features.reduce((total, feature) =>
      total + (feature.geometry.type === "LineString"
        ? 1
        : feature.geometry.coordinates.length), 0)).toBeGreaterThan(0);
    expect(collection.features.every((feature) =>
      Object.keys(feature.properties).length === 1 &&
      feature.geometry.type === "MultiLineString"
    )).toBe(true);

    const clippedColorado = collection.features.find(
      (feature) => feature.properties.name === "Colorado River",
    );
    const coloradoLatitudes = clippedColorado?.geometry.type === "MultiLineString"
      ? clippedColorado.geometry.coordinates.flatMap((line) =>
        line.map(([, latitude]) => latitude)
      )
      : [];
    expect(Math.max(...coloradoLatitudes)).toBeCloseTo(35.002, 6);
    expect(Math.min(...coloradoLatitudes)).toBeCloseTo(32.718731, 6);
  });

  test("rejects unnamed or invalid river features", () => {
    expect(() => parseRiverShapefile({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[-122, 37]] },
      }],
    })).toThrow("River shapefile feature 1 is missing a name or line geometry.");
  });
});
