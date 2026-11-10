import { describe, expect, test } from "bun:test";
import shp from "shpjs";
import {
  getRiverFeatureOptions,
  mergeRiverLinePaths,
  parseRiverShapefile,
} from "./rivers";

describe("river shapefile", () => {
  test("parses the river archive into named line options", async () => {
    const archive = Bun.file(
      new URL("../public/data/features/nhd_major_rivers.zip", import.meta.url),
    );
    const collection = parseRiverShapefile(
      await shp(await archive.arrayBuffer()),
    );
    const options = getRiverFeatureOptions(collection);

    expect(collection.features).toHaveLength(304);
    expect(options).toHaveLength(304);
    expect(options.map((option) => option.id)).toContain("Sacramento River");
    expect(options.map((option) => option.id)).toContain("Tule River (Tulare County)");
    expect(options.map((option) => option.id)).toContain("Tule River (Shasta County)");
    expect(options.map((option) => option.id)).toContain("Roaring River (Cottonwood)");
    expect(options.map((option) => option.id)).toContain("Roaring River (Kings)");
    expect(options.every((option) => option.lines?.length)).toBe(true);
    expect(collection.features.reduce((total, feature) =>
      total + (feature.geometry.type === "LineString"
        ? 1
        : feature.geometry.coordinates.length), 0)).toBeGreaterThan(0);
    expect(collection.features.every((feature) =>
      Object.keys(feature.properties).length === 1 &&
      (feature.geometry.type === "LineString" ||
        feature.geometry.type === "MultiLineString")
    )).toBe(true);
    const kernRiver = options.find((option) => option.id === "Kern River");
    expect(kernRiver?.lines).toHaveLength(1);
    expect(mergeRiverLinePaths(kernRiver?.lines ?? [])).toHaveLength(1);
    expect(options.find((option) => option.id === "Tule River (Tulare County)")?.lines)
      .toHaveLength(2);
    expect(options.find((option) => option.id === "Tule River (Shasta County)")?.lines)
      .toHaveLength(1);
    expect(options.find((option) => option.id === "Roaring River (Kings)")?.lines)
      .toHaveLength(1);
    expect(options.find((option) => option.id === "Roaring River (Cottonwood)")?.lines)
      .toHaveLength(1);

    const clippedColorado = collection.features.find(
      (feature) => feature.properties.name === "Colorado River",
    );
    const coloradoLines = clippedColorado?.geometry.type === "LineString"
      ? [clippedColorado.geometry.coordinates]
      : clippedColorado?.geometry.type === "MultiLineString"
        ? clippedColorado.geometry.coordinates
        : [];
    const coloradoLatitudes = coloradoLines.flatMap((line) =>
      line.map(([, latitude]) => latitude)
    );
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

  test("joins unambiguous shared endpoints while keeping separate paths and branches", () => {
    const joined = mergeRiverLinePaths([
      [[-120, 36], [-121, 36]],
      [[-122, 36], [-121, 36]],
      [[-123, 36], [-124, 36]],
    ]);
    expect(joined).toEqual([
      [[-120, 36], [-121, 36], [-122, 36]],
      [[-123, 36], [-124, 36]],
    ]);

    expect(mergeRiverLinePaths([
      [[-120, 36], [-121, 36]],
      [[-121, 36], [-122, 36]],
      [[-121, 36], [-121, 37]],
    ])).toHaveLength(3);
  });
});
