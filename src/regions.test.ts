import { describe, expect, test } from "bun:test";
import { fromLocal, toLocal } from "./geo";
import {
  bisectPolygonClosingEdge,
  extendPolylineEnd,
  moveRegionHandle,
  regionClipPolygons,
  regionClipRings,
  regionGeometry,
  regionsForSelectedCounties,
} from "./regions";
import type { BoundaryCollection, Region } from "./types";

const center: [number, number] = [-13_500_000, 4_500_000];
const counties: BoundaryCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: { CENSUS_GEO: "06001" },
    geometry: {
      type: "Polygon",
      coordinates: [[[-121, 37], [-120, 37], [-120, 38], [-121, 37]]],
    },
  }],
};

describe("region geometry and editing", () => {
  test("selected counties are regions and participate in clipping", () => {
    const selected = regionsForSelectedCounties(["06001"], counties);

    expect(selected).toEqual([{
      id: "county:06001",
      name: "06001",
      type: "county",
      countyId: "06001",
    }]);
    expect(regionClipPolygons(selected, center, counties)).toHaveLength(0);
    const clipped = regionsForSelectedCounties([], counties, ["06001"]);
    expect(clipped[0]).toMatchObject({ visible: false, clip: true });
    expect(regionClipPolygons(clipped, center, counties)).toHaveLength(1);
    expect(regionsForSelectedCounties([], counties)).toEqual([]);
  });

  test("custom points have no shape geometry and cannot create cuts", () => {
    const point: Region = {
      id: "point-1",
      name: "Point 1",
      type: "point",
      position: [-121, 37],
      clip: true,
    };

    expect(regionGeometry(point, center, counties)).toEqual({ lines: [], handles: [] });
    expect(regionClipRings([point], center, counties)).toEqual([]);
    expect(regionClipPolygons([point], center, counties)).toEqual([]);
  });

  test("rectangle and ellipse have closed outlines and editable handles", () => {
    for (const type of ["rectangle", "ellipse"] as const) {
      const region: Region = {
        id: type, name: type, type, center: fromLocal([12, 4], center), width: 20, height: 10,
      };
      const { lines, handles } = regionGeometry(region, center, counties);
      const line = lines[0];
      expect(line).toBeDefined();
      expect(line?.[0]?.[0]).toBeCloseTo(line?.[line.length - 1]?.[0] ?? 0, 8);
      expect(line?.[0]?.[1]).toBeCloseTo(line?.[line.length - 1]?.[1] ?? 0, 8);
      if (type === "rectangle") {
        expect(handles.map((handle) => handle.kind)).toEqual(["center", "size", "rotation"]);
        const sizeHandle = handles[1];
        if (!sizeHandle) throw new Error("Missing size handle");
        const resized = moveRegionHandle(region, sizeHandle, [27, 14], center);
        if (resized.type !== "rectangle") throw new Error("Unexpected region type");
        expect(resized.width).toBeCloseTo(30);
        expect(resized.height).toBeCloseTo(20);
      } else {
        expect(handles.map((handle) => handle.kind)).toEqual(["center", "axis-width", "axis-height"]);
        const widthHandle = handles[1];
        if (!widthHandle) throw new Error("Missing width-axis handle");
        const resized = moveRegionHandle(region, widthHandle, [27, 14], center);
        if (resized.type !== "ellipse") throw new Error("Unexpected region type");
        expect(resized.width).toBeCloseTo(2 * Math.hypot(15, 10));
        expect(resized.rotation).toBeCloseTo(Math.atan2(10, 15) * 180 / Math.PI);
      }
    }
  });

  test("rectangle rotation handle rotates the outline around its center", () => {
    const region: Region = {
      id: "r", name: "R", type: "rectangle", center: fromLocal([12, 4], center),
      width: 20, height: 10, rotation: 0,
    };
    const geometry = regionGeometry(region, center, counties);
    const rotationHandle = geometry.handles.find((handle) => handle.kind === "rotation");
    const origin = toLocal(region.center, center);
    if (!rotationHandle) throw new Error("Missing rotation handle");

    expect(rotationHandle.position[0]).toBeCloseTo(origin[0]);
    expect(rotationHandle.position[1]).toBeLessThan(origin[1] - region.height / 2);

    const rotated = moveRegionHandle(region, rotationHandle, [origin[0] + 5, origin[1] - 5], center);
    if (rotated.type !== "rectangle") throw new Error("Unexpected region type");
    expect(rotated.rotation).toBeCloseTo(45);

    const rotatedGeometry = regionGeometry(rotated, center, counties);
    const rotatedLines = rotatedGeometry.lines[0];
    const angle = Math.PI / 4;
    expect(rotatedLines?.[0]?.[0]).toBeCloseTo(origin[0] - 10 * Math.cos(angle) + 5 * Math.sin(angle));
    expect(rotatedLines?.[0]?.[1]).toBeCloseTo(origin[1] - 10 * Math.sin(angle) - 5 * Math.cos(angle));

    const sizeHandle = rotatedGeometry.handles.find((handle) => handle.kind === "size");
    if (!sizeHandle) throw new Error("Missing rotated size handle");
    const resizePoint: [number, number] = [
      origin[0] + 15 * Math.cos(angle) - 10 * Math.sin(angle),
      origin[1] + 15 * Math.sin(angle) + 10 * Math.cos(angle),
    ];
    const resized = moveRegionHandle(rotated, sizeHandle, resizePoint, center);
    if (resized.type !== "rectangle") throw new Error("Unexpected region type");
    expect(resized.width).toBeCloseTo(30);
    expect(resized.height).toBeCloseTo(20);
  });

  test("ellipse axis handles independently resize and rotate their axes", () => {
    const region: Region = {
      id: "e", name: "E", type: "ellipse", center: fromLocal([0, 0], center),
      width: 20, height: 10, rotation: 0,
    };
    const handles = regionGeometry(region, center, counties).handles;
    expect(handles[1]?.position[0]).toBeCloseTo(10);
    expect(handles[1]?.position[1]).toBeCloseTo(0);
    expect(handles[2]?.position[0]).toBeCloseTo(0);
    expect(handles[2]?.position[1]).toBeCloseTo(5);

    const widthHandle = handles[1];
    const heightHandle = handles[2];
    if (!widthHandle || !heightHandle) throw new Error("Missing ellipse axis handles");
    const widthChanged = moveRegionHandle(region, widthHandle, [0, 15], center);
    const heightChanged = moveRegionHandle(region, heightHandle, [-12, 0], center);
    if (widthChanged.type !== "ellipse" || heightChanged.type !== "ellipse") {
      throw new Error("Unexpected region type");
    }
    expect(widthChanged.width).toBeCloseTo(30);
    expect(widthChanged.rotation).toBeCloseTo(90);
    expect(heightChanged.height).toBeCloseTo(24);
    expect(heightChanged.rotation).toBeCloseTo(90);
  });

  test("center handle moves a shape without resizing it", () => {
    const region: Region = { id: "1", name: "R", type: "rectangle", center: fromLocal([0, 0], center), width: 20, height: 10 };
    const handle = regionGeometry(region, center, counties).handles[0];
    if (!handle) throw new Error("Missing center handle");
    const moved = moveRegionHandle(region, handle, [5, -6], center);
    if (moved.type !== "rectangle") throw new Error("Unexpected region type");
    expect(toLocal(moved.center, center)[0]).toBeCloseTo(5);
    expect(toLocal(moved.center, center)[1]).toBeCloseTo(-6);
    expect([moved.width, moved.height]).toEqual([20, 10]);
  });

  test("polygons are closed and expose a center handle and editable vertices", () => {
    const points = [fromLocal([0, 0], center), fromLocal([10, 0], center), fromLocal([10, 10], center)];
    const region: Region = { id: "p", name: "P", type: "polygon", points };
    const { lines, handles } = regionGeometry(region, center, counties);
    expect(lines[0]).toHaveLength(4);
    expect(lines[0]?.[0]).toEqual(lines[0]?.[3]);
    expect(handles.map((handle) => handle.kind)).toEqual(["center", "vertex", "vertex", "vertex"]);
    const handle = handles[2];
    if (!handle) throw new Error("Missing vertex handle");
    const moved = moveRegionHandle(region, handle, [5, 6], center);
    if (moved.type !== "polygon") throw new Error("Unexpected region type");
    expect(moved.points[0]).toEqual(points[0]);
    expect(moved.points[1]).not.toEqual(points[1]);
    expect(moved.points[2]).toEqual(points[2]);
    const point = moved.points[1];
    if (!point) throw new Error("Missing moved point");
    expect(toLocal(point, center)[0]).toBeCloseTo(5);
    expect(toLocal(point, center)[1]).toBeCloseTo(6);
  });

  test("polylines remain open and expose editable vertices", () => {
    const points = [
      fromLocal([0, 0], center),
      fromLocal([10, 0], center),
      fromLocal([10, 10], center),
    ];
    const region: Region = { id: "line", name: "Line", type: "polyline", points };
    const { lines, handles } = regionGeometry(region, center, counties);
    expect(lines[0]).toHaveLength(points.length);
    expect(lines[0]?.[0]).not.toEqual(lines[0]?.[lines[0].length - 1]);
    expect(handles.map((handle) => handle.kind)).toEqual(["center", "vertex", "vertex", "vertex"]);

    const vertexHandle = handles[2];
    if (!vertexHandle) throw new Error("Missing vertex handle");
    const moved = moveRegionHandle(region, vertexHandle, [5, 6], center);
    if (moved.type !== "polyline") throw new Error("Unexpected region type");
    const movedPoint = moved.points[1];
    if (!movedPoint) throw new Error("Missing moved point");
    expect(toLocal(movedPoint, center)[0]).toBeCloseTo(5);
    expect(toLocal(movedPoint, center)[1]).toBeCloseTo(6);
  });

  test("polyline additions continue the last segment by the requested zoom spacing", () => {
    const points = [fromLocal([0, 0], center), fromLocal([3, 4], center)];
    const nextPoint = extendPolylineEnd(points, center, 10);
    expect(nextPoint && toLocal(nextPoint, center)[0]).toBeCloseTo(9);
    expect(nextPoint && toLocal(nextPoint, center)[1]).toBeCloseTo(12);
    expect(extendPolylineEnd(points.slice(0, 1), center, 10)).toBeNull();
  });

  test("polylines do not create clipping areas", () => {
    const polyline: Region = {
      id: "line",
      name: "Line",
      type: "polyline",
      clip: true,
      points: [
        fromLocal([0, 0], center),
        fromLocal([10, 0], center),
        fromLocal([10, 10], center),
        fromLocal([20, 10], center),
      ],
    };

    expect(regionClipRings([polyline], center, counties)).toEqual([]);
    expect(regionClipPolygons([polyline], center, counties)).toEqual([]);
  });

  test("moving a polygon center translates all vertices without changing its shape", () => {
    const points = [fromLocal([0, 0], center), fromLocal([10, 0], center), fromLocal([10, 10], center)];
    const region: Region = { id: "p", name: "P", type: "polygon", points };
    const handle = regionGeometry(region, center, counties).handles[0];
    if (!handle) throw new Error("Missing center handle");

    const moved = moveRegionHandle(
      region,
      handle,
      [handle.position[0] + 5, handle.position[1] - 6],
      center,
    );
    if (moved.type !== "polygon") throw new Error("Unexpected region type");
    const movedPoints = moved.points.map((point) => toLocal(point, center));
    expect(movedPoints[0]?.[0]).toBeCloseTo(5);
    expect(movedPoints[0]?.[1]).toBeCloseTo(-6);
    expect(movedPoints[1]?.[0]).toBeCloseTo(15);
    expect(movedPoints[1]?.[1]).toBeCloseTo(-6);
    expect(movedPoints[2]?.[0]).toBeCloseTo(15);
    expect(movedPoints[2]?.[1]).toBeCloseTo(4);
  });

  test("adding a polygon point bisects its closing edge", () => {
    const points = [fromLocal([0, 0], center), fromLocal([10, 0], center), fromLocal([10, 10], center)];
    const midpoint = bisectPolygonClosingEdge(points);
    expect(midpoint && toLocal(midpoint, center)[0]).toBeCloseTo(5);
    expect(midpoint && toLocal(midpoint, center)[1]).toBeCloseTo(5);
    expect(bisectPolygonClosingEdge(points.slice(0, 2))).toBeNull();
  });

  test("clip membership is independent of region visibility", () => {
    const polygon: Region = {
      id: "p",
      name: "P",
      type: "polygon",
      clip: true,
      points: [fromLocal([0, 0], center), fromLocal([10, 0], center), fromLocal([10, 10], center)],
    };
    const visibleOnly: Region = {
      id: "hidden",
      name: "Visible only",
      type: "rectangle",
      visible: true,
      center: fromLocal([0, 0], center),
      width: 10,
      height: 10,
    };
    const clipRegions = regionClipRings([polygon, visibleOnly], center, counties);
    const ring = clipRegions[0]?.[0];

    expect(clipRegions).toHaveLength(1);
    expect(ring).toHaveLength(4);
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1]);
  });

  test("county outlines use the selected fixed county", () => {
    const region: Region = { id: "c", name: "C", type: "county", countyId: "06001" };
    const geometry = regionGeometry(region, center, counties);
    expect(geometry.lines[0]).toHaveLength(4);
    expect(geometry.handles).toHaveLength(0);
    expect(regionGeometry({ ...region, countyId: "" }, center, counties).lines).toHaveLength(0);
  });

  test("county clip polygons preserve multipolygon islands and holes", () => {
    const multiCounty: BoundaryCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { CENSUS_GEO: "06003" },
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
    const clipPolygons = regionClipPolygons(
      [{ id: "county", name: "County", type: "county", countyId: "06003", clip: true }],
      center,
      multiCounty,
    );

    expect(clipPolygons).toHaveLength(1);
    expect(clipPolygons[0]).toHaveLength(2);
    expect(clipPolygons[0]?.[0]).toHaveLength(2);
  });
});
