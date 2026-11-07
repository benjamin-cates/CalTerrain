import { describe, expect, test } from "bun:test";
import { fromLocal, toLocal } from "./geo";
import { boundaryFeatureClipPolygons } from "./regions";
import {
  clipFeatureExportRegionId,
  createRegionBoundaryExport,
} from "./regionExport";
import type { BoundaryCollection, Region } from "./types";

const center: [number, number] = [-13_500_000, 4_500_000];
const parkBoundaries: BoundaryCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { UNIT_CODE: "PARK1", UNIT_NAME: "Example Park" },
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [[-121, 37], [-120, 37], [-120, 38], [-121, 37]],
          [[-120.8, 37.2], [-120.7, 37.2], [-120.7, 37.3], [-120.8, 37.2]],
        ],
        [[[-119, 37], [-118.9, 37], [-118.9, 37.1], [-119, 37]]],
      ],
    },
  }],
};
const longitudeLatitudeLines: BoundaryCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {
      cellId: "lonlat--125-40",
      name: "-124° to -125° W; 40° to 41° N",
    },
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-125, 40],
        [-124, 40],
        [-124, 41],
        [-125, 41],
        [-125, 40],
      ]],
    },
  }],
};

describe("region boundary export and clipping", () => {
  test("returns an empty feature collection when nothing is selected for clipping", () => {
    expect(createRegionBoundaryExport(
      [],
      {
        counties: [],
        nationalParks: [],
        nationalForests: [],
        longitudeLatitudeLines: [],
      },
      center,
      null,
      null,
      null,
      null,
    )).toEqual({ type: "FeatureCollection", features: [] });
  });

  test("selected boundary features preserve polygon islands and holes for clipping", () => {
    const polygons = boundaryFeatureClipPolygons(
      parkBoundaries,
      ["PARK1"],
      (feature) => String(feature.properties.UNIT_CODE ?? ""),
      center,
    );

    expect(polygons).toHaveLength(1);
    expect(polygons[0]).toHaveLength(2);
    expect(polygons[0]?.[0]?.[0]?.[0]).toEqual(toLocal([-121, 37], center));
    expect(boundaryFeatureClipPolygons(parkBoundaries, [], () => "", center)).toEqual([]);
  });

  test("exports only clipped custom shapes and selected boundary features as GeoJSON", () => {
    const regions: Region[] = [
      {
        id: "shape-1",
        name: "Circle 1",
        type: "ellipse",
        clip: true,
        visible: false,
        center: fromLocal([0, 0], center),
        width: 10,
        height: 8,
      },
      {
        id: "shape-2",
        name: "Polygon 1",
        type: "polygon",
        visible: true,
        points: [fromLocal([0, 0], center), fromLocal([10, 0], center), fromLocal([10, 10], center)],
      },
      {
        id: "shape-3",
        name: "Polyline 1",
        type: "polyline",
        clip: true,
        points: [fromLocal([0, 0], center), fromLocal([10, 0], center)],
      },
      {
        id: "point-1",
        name: "Point 1",
        type: "point",
        position: fromLocal([5, 5], center),
        clip: true,
      },
    ];
    const result = createRegionBoundaryExport(
      regions,
      {
        counties: [],
        nationalParks: ["PARK1"],
        nationalForests: [],
        longitudeLatitudeLines: [],
      },
      center,
      null,
      parkBoundaries,
      null,
      null,
    );

    expect(result.type).toBe("FeatureCollection");
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.properties).toMatchObject({
      name: "Circle 1",
      category: "Custom shape",
    });
    expect(result.features[1]?.properties).toMatchObject({
      id: "National park:PARK1",
      name: "Example Park",
      category: "National park",
    });
    expect(result.features[0]?.geometry.type).toBe("Polygon");
    expect(result.features[1]?.geometry).toEqual(parkBoundaries.features[0]?.geometry);
  });

  test("exports a selected longitude and latitude grid cell", () => {
    const result = createRegionBoundaryExport(
      [],
      {
        counties: [],
        nationalParks: [],
        nationalForests: [],
        longitudeLatitudeLines: ["lonlat--125-40"],
      },
      center,
      null,
      null,
      null,
      longitudeLatitudeLines,
    );

    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties).toMatchObject({
      id: "Longitude and latitude cell:lonlat--125-40",
      name: "-124° to -125° W; 40° to 41° N",
      category: "Longitude and latitude cell",
    });
    expect(clipFeatureExportRegionId("longitudeLatitudeLines", "lonlat--125-40"))
      .toBe(String(result.features[0]?.properties.id));
    expect(result.features[0]?.geometry).toEqual(longitudeLatitudeLines.features[0]?.geometry);
  });
});
