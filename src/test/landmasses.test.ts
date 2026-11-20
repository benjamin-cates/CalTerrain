import { describe, expect, test } from "bun:test";
import shp from "shpjs";
import { deriveCaliforniaLandmasses } from "../features/landmasses";
import { filterBoundaryCollection, getBoundaryFeatureOptions } from "../terrain/boundaryShapefile";
import type { BoundaryCollection } from "../types";

describe("California landmasses", () => {
  test("groups mainland, Delta fragments, and each named Channel Island separately", async () => {
    const california = await Bun.file(
      new URL("../../public/data/boundaries/california.geojson", import.meta.url),
    ).json() as BoundaryCollection;
    const landmasses = deriveCaliforniaLandmasses(california);
    const featuresByName = new Map(
      landmasses.features.map((feature) => [feature.properties.name, feature]),
    );

    expect([...featuresByName.keys()]).toEqual([
      "MAINLAND",
      "South Farallon Island",
      "Treasure Island",
      "Angel Island",
      "Anacapa Islands",
      "Santa Barbara Island",
      "Santa Catalina Island",
      "Santa Cruz Island",
      "Santa Rosa Island",
      "San Clemente Island",
      "San Miguel Island",
      "San Nicolas Island",
    ]);
    expect(featuresByName.get("MAINLAND")?.geometry).toMatchObject({
      type: "MultiPolygon",
      coordinates: { length: 7 },
    });
    expect(featuresByName.get("South Farallon Island")?.geometry).toMatchObject({
      type: "MultiPolygon",
      coordinates: { length: 2 },
    });
    expect(featuresByName.get("Anacapa Islands")?.geometry).toMatchObject({
      type: "MultiPolygon",
      coordinates: { length: 3 },
    });
    expect(featuresByName.get("San Miguel Island")?.geometry).toMatchObject({
      type: "MultiPolygon",
      coordinates: { length: 2 },
    });
  });

  test("loads the generated shapefile ZIP as the named landmass options", async () => {
    const archive = Bun.file(
      new URL("../../public/data/boundaries/california_landmasses.zip", import.meta.url),
    );
    const parsed = await shp(await archive.arrayBuffer());
    const landmasses = filterBoundaryCollection(parsed);

    expect(landmasses).not.toBeNull();
    const options = getBoundaryFeatureOptions(landmasses!, "Landmass", "id", "name");
    expect(options).toHaveLength(12);
    expect(options.map((option) => option.label)).toContain("MAINLAND");
    expect(options.map((option) => option.label)).not.toContain("Channel Islands");
  });
});
