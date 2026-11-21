import { describe, expect, it } from "bun:test";
import { createDecoderModule } from "draco3d";
import { fromLocal, geographicToMercator } from "../geo";
import type { BoundaryCollection, Position, TerrainMetadata } from "../types";
import {
  CALIFORNIA_LATITUDE_SPAN_METERS,
  MAX_TERRAIN_EXPORT_FACES,
  createStoreZip,
  createTerrainExportRegions,
  createTerrainGlb,
  createTerrainObj,
  createTerrainModelGlb,
  createTerrainModelStl,
  estimateTerrainTriangleCount,
  formatTerrainExportScale,
  getTerrainImageDimensions,
  getTerrainImageTilePixelBounds,
  getTerrainExportBoundingBoxes,
  getTerrainExportResolution,
  getTerrainExportZoom,
  getTerrainExportScaleMeters,
  getTerrainExportScaleStep,
  getTerrainGroundScale,
  TERRAIN_EXPORT_RESOLUTIONS,
  type TerrainExportRegion,
} from "../terrain/terrainExport";
import {
  getTerrainAccessoryBaseOverlapMm,
  type TerrainModelOptions,
} from "../terrain/terrainOrnament";

function polygonFeature(points: Position[], center: Position, name: string) {
  const ring = [...points, points[0] ?? points[points.length - 1] ?? [0, 0]]
    .map((point) => fromLocal(point, center));
  return {
    type: "Feature" as const,
    properties: { id: name, name, category: "Custom shape" },
    geometry: { type: "Polygon" as const, coordinates: [ring] },
  };
}

function fromLocalRing(points: Position[], center: Position): Position[] {
  return points.map((point) => fromLocal(point, center));
}

function pointInRing([x, z]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const current = ring[index];
    const previous = ring[previousIndex];
    if (!current || !previous) continue;
    if ((current[1] > z) !== (previous[1] > z) &&
      x < (previous[0] - current[0]) * (z - current[1]) /
        (previous[1] - current[1]) + current[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function hasOutwardWallFaces(
  obj: string,
  region: TerrainExportRegion,
  horizontalScale: number,
): boolean {
  const vertices = obj.split("\n")
    .filter((line) => line.startsWith("v "))
    .map((line) => line.slice(2).split(" ").map(Number) as [number, number, number]);
  const bottomY = Math.min(...vertices.map(([, y]) => y));
  const wallFaces = obj.split("\n").filter((line) => line.startsWith("f "));
  let wallFaceCount = 0;
  for (const face of wallFaces) {
    const triangle = face.slice(2).split(" ").map((index) => vertices[Number(index) - 1]);
    if (triangle.length !== 3 || triangle.some((vertex) => !vertex)) continue;
    const [a, b, c] = triangle as [[number, number, number], [number, number, number], [number, number, number]];
    if ([a, b, c].filter(([, y]) => Math.abs(y - bottomY) < 1e-8).length !== 2) continue;
    wallFaceCount += 1;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normalX = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const normalZ = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    const normalLength = Math.hypot(normalX, normalZ);
    if (normalLength === 0) return false;
    const probe: Position = [
      ((a[0] + b[0] + c[0]) / 3 + normalX / normalLength * horizontalScale) /
        (1_000 * horizontalScale),
      ((a[2] + b[2] + c[2]) / 3 + normalZ / normalLength * horizontalScale) /
        (1_000 * horizontalScale),
    ];
    const isInside = region.polygons.some(([outer, ...holes]) =>
      outer !== undefined &&
      pointInRing(probe, outer) &&
      !holes.some((hole) => pointInRing(probe, hole))
    );
    if (isInside) return false;
  }
  return wallFaceCount > 0;
}

describe("terrain export", () => {
  it("maps resolution in the requested coarse-to-fine slider order", () => {
    expect(TERRAIN_EXPORT_RESOLUTIONS).toEqual([1_920, 960, 480, 240, 120, 60, 30]);
    expect(getTerrainExportResolution(0)).toBe(1_920);
    expect(getTerrainExportResolution(1)).toBe(960);
    expect(getTerrainExportResolution(2)).toBe(480);
    expect(getTerrainExportResolution(3)).toBe(240);
    expect(getTerrainExportResolution(6)).toBe(30);
  });

  it("uses the coarsest available tiles for coarse exports", () => {
    const metadata: TerrainMetadata = {
      center: [0, 0],
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      zoomLevels: [8, 9, 10, 11],
      tiles: [],
    };

    expect(getTerrainExportZoom(metadata, 1_920)).toBe(8);
    expect(getTerrainExportZoom(metadata, 960)).toBe(8);
    expect(getTerrainExportZoom(metadata, 480)).toBe(8);
    expect(getTerrainExportZoom(metadata, 240)).not.toBe(8);
  });

  it("raises the browser triangle ceiling for compressed exports", () => {
    expect(MAX_TERRAIN_EXPORT_FACES).toBe(20_000_000);
  });

  it("calculates north-up image dimensions from the selected output resolution", () => {
    const region: TerrainExportRegion = {
      id: "image-region",
      name: "Image Region",
      polygons: [[[
        [0, 0], [4, 0], [4, 2], [0, 2], [0, 0],
      ]]],
    };

    expect(getTerrainImageDimensions(region, 1_000)).toMatchObject({
      width: 4,
      height: 2,
      pixelCount: 8,
    });
  });

  it("snaps neighboring image tiles to the same output-pixel boundary", () => {
    const center: Position = [0, 0];
    const bounds = { minX: -10, minZ: -10, maxX: 10, maxZ: 10 };
    const west = getTerrainImageTilePixelBounds(
      { x: 512, y: 512, z: 10 },
      center,
      bounds,
      4.123,
    );
    const east = getTerrainImageTilePixelBounds(
      { x: 513, y: 512, z: 10 },
      center,
      bounds,
      4.123,
    );
    const north = getTerrainImageTilePixelBounds(
      { x: 512, y: 512, z: 10 },
      center,
      bounds,
      4.123,
    );
    const south = getTerrainImageTilePixelBounds(
      { x: 512, y: 513, z: 10 },
      center,
      bounds,
      4.123,
    );

    expect(west.right).toBe(east.left);
    expect(north.bottom).toBe(south.top);
  });

  it("maps the logarithmic latitude span with a one-meter default", () => {
    const defaultStep = getTerrainExportScaleStep(1);
    expect(getTerrainExportScaleMeters(defaultStep)).toBeCloseTo(1);
    expect(getTerrainExportScaleMeters(0)).toBe(0.01);
    expect(getTerrainExportScaleMeters(1_000)).toBe(CALIFORNIA_LATITUDE_SPAN_METERS);
    expect(formatTerrainExportScale(0.01)).toBe("1 cm");
  });

  it("clips selected export regions to the simplified California boundary", () => {
    const center: Position = [0, 0];
    const state: BoundaryCollection = {
      type: "FeatureCollection",
      features: [polygonFeature([
        [0, 0], [10, 0], [10, 10], [0, 10],
      ], center, "California")],
    };
    const selected: BoundaryCollection = {
      type: "FeatureCollection",
      features: [polygonFeature([
        [5, 5], [15, 5], [15, 15], [5, 15],
      ], center, "cross-border")],
    };

    const result = createTerrainExportRegions(selected, state, center);
    const bounds = result.regions[0]?.polygons.flat(2) ?? [];
    const xCoordinates = bounds.map(([x]) => x);
    const zCoordinates = bounds.map(([, z]) => z);

    expect(result.regions).toHaveLength(1);
    expect(Math.max(...xCoordinates)).toBeCloseTo(10, 3);
    expect(Math.max(...zCoordinates)).toBeCloseTo(10, 3);
    expect(Math.min(...xCoordinates)).toBeCloseTo(5, 3);
  });

  it("creates a closed local-coordinate bounding box for each clipped export piece", () => {
    const boxes = getTerrainExportBoundingBoxes([{
      id: "region-1",
      name: "Region 1",
      polygons: [[[
        [2, 8], [7, 3], [5, 9], [2, 8],
      ]]],
    }]);

    expect(boxes).toEqual([{
      id: "region-1",
      name: "Region 1",
      outline: [[2, 3], [7, 3], [7, 9], [2, 9], [2, 3]],
    }]);
  });

  it("estimates total triangles from area, resolution, and boundary sides", () => {
    const region: TerrainExportRegion = {
      id: "square",
      name: "Square",
      polygons: [[[
        [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
      ]]],
    };

    expect(estimateTerrainTriangleCount(region, 1_000)).toBe(320);
    expect(estimateTerrainTriangleCount(region, 100)).toBe(21_200);
  });

  it("uses the export center latitude when estimating triangle counts", () => {
    const region: TerrainExportRegion = {
      id: "square",
      name: "Square",
      polygons: [[[
        [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
      ]]],
    };
    const centerY = geographicToMercator(0, 37.419)[1];
    const groundScale = getTerrainGroundScale([0, centerY]);

    expect(groundScale).toBeCloseTo(Math.cos(37.419 * Math.PI / 180), 10);
    expect(estimateTerrainTriangleCount(region, 100, groundScale))
      .toBeLessThan(estimateTerrainTriangleCount(region, 100));
  });

  it("creates watertight terrain and 3D model meshes with clipped walls and a Draco GLB", async () => {
    const center: Position = [0, 0];
    const state: BoundaryCollection = {
      type: "FeatureCollection",
      features: [polygonFeature([
        [10, 10], [50, 10], [50, 50], [10, 50],
      ], center, "California")],
    };
    const selected: BoundaryCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { id: "test-region", name: "Test region", category: "Custom shape" },
        geometry: {
          type: "Polygon",
          coordinates: [
            fromLocalRing([
              [20, 20], [40, 20], [38, 27], [34, 28],
              [35, 33], [30, 40], [20, 35], [20, 20],
            ], center),
            fromLocalRing([[26, 26], [26, 28], [28, 28], [28, 26], [26, 26]], center),
          ],
        },
      }],
    };
    const prepared = createTerrainExportRegions(selected, state, center);
    const pixels = new Uint8ClampedArray(259 * 259 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 128;
      pixels[offset + 1] = 100;
      pixels[offset + 3] = 255;
    }
    const descriptors = new Map(
      ["document", "window", "createImageBitmap"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    const originalFetch = globalThis.fetch;
    try {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: () => { },
              getImageData: () => ({ data: pixels }),
            }),
          }),
        },
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout },
      });
      Object.defineProperty(globalThis, "createImageBitmap", {
        configurable: true,
        value: async () => ({ width: 259, height: 259, close: () => { } }),
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: async () => ({
          ok: true,
          status: 200,
          blob: async () => new Blob(),
        }) as Response,
      });

      const metadata: TerrainMetadata = {
        center,
        bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        zoomLevels: [8],
        tiles: ["8/128/128"],
      };
      let totalTriangleCount = 0;
      const obj = await createTerrainObj({
        metadata,
        center,
        californiaPolygons: prepared.californiaPolygons,
        region: prepared.regions[0]!,
        resolutionMeters: 10_000,
        californiaLatitudeSpanMeters: 40_000,
        verticalExaggeration: 1,
        onTriangleCount: (count) => {
          totalTriangleCount = count;
        },
      });

      const vertexCount = obj.split("\n").filter((line) => line.startsWith("v ")).length;
      const faceCount = obj.split("\n").filter((line) => line.startsWith("f ")).length;
      const vertices = obj.split("\n")
        .filter((line) => line.startsWith("v "))
        .map((line) => line.slice(2).split(" ").map(Number) as [number, number, number]);
      const bottomY = Math.min(...vertices.map(([, y]) => y));
      const skirtBottomVertices = new Set<number>();
      const bottomFaceVertices = new Set<number>();
      const edgeUses = new Map<string, number>();
      for (const line of obj.split("\n")) {
        if (!line.startsWith("f ")) continue;
        const faceVertices = line.slice(2).split(" ").map(Number);
        const bottomFaceIndices = faceVertices
          .filter((index) => Math.abs((vertices[index - 1]?.[1] ?? Infinity) - bottomY) < 1e-7)
          .map((index) => index - 1);
        if (bottomFaceIndices.length === 2) {
          for (const index of bottomFaceIndices) skirtBottomVertices.add(index);
        } else if (bottomFaceIndices.length === 3) {
          for (const index of bottomFaceIndices) bottomFaceVertices.add(index);
        }
        for (let index = 0; index < faceVertices.length; index += 1) {
          const first = faceVertices[index];
          const second = faceVertices[(index + 1) % faceVertices.length];
          if (first === undefined || second === undefined) continue;
          const edge = first < second ? `${first}:${second}` : `${second}:${first}`;
          edgeUses.set(edge, (edgeUses.get(edge) ?? 0) + 1);
        }
      }

      expect(vertexCount).toBeGreaterThan(0);
      expect(totalTriangleCount).toBe(faceCount);
      expect(edgeUses.size).toBeGreaterThan(0);
      expect([...edgeUses.values()].every((count) => count === 2)).toBe(true);
      expect(skirtBottomVertices.size).toBeGreaterThan(0);
      expect([...skirtBottomVertices].every((index) => bottomFaceVertices.has(index))).toBe(true);
      const stateZs = prepared.californiaPolygons.flat(2).map(([, z]) => z);
      const horizontalScale = 40_000 /
        ((Math.max(...stateZs) - Math.min(...stateZs)) * 1_000);
      expect(hasOutwardWallFaces(obj, prepared.regions[0]!, horizontalScale)).toBe(true);

      const glb = await createTerrainGlb({
        metadata,
        center,
        californiaPolygons: prepared.californiaPolygons,
        region: prepared.regions[0]!,
        resolutionMeters: 10_000,
        californiaLatitudeSpanMeters: 40_000,
        verticalExaggeration: 1,
      }, 8);
      const glbView = new DataView(glb);
      expect(glbView.getUint32(0, true)).toBe(0x46546c67);
      expect(glbView.getUint32(4, true)).toBe(2);
      expect(glbView.getUint32(8, true)).toBe(glb.byteLength);
      const jsonLength = glbView.getUint32(12, true);
      const json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)).trim(),
      ) as {
        extensionsRequired: string[];
        meshes: {
          primitives: {
            attributes: { POSITION: number };
            indices: number;
            extensions: { KHR_draco_mesh_compression: { bufferView: number } };
          }[];
        }[];
        accessors: { count: number }[];
        bufferViews: { byteOffset: number; byteLength: number }[];
      };
      expect(json.extensionsRequired).toContain("KHR_draco_mesh_compression");
      expect(json.meshes[0]?.primitives.length).toBeGreaterThan(1);
      const binaryHeaderOffset = 20 + jsonLength;
      const binaryLength = glbView.getUint32(binaryHeaderOffset, true);
      expect(binaryLength).toBe(glb.byteLength - binaryHeaderOffset - 8);
      const draco = await createDecoderModule();
      const decoder = new draco.Decoder();
      try {
        const primitives = json.meshes[0]?.primitives ?? [];
        let decodedFaceCount = 0;
        for (const primitive of primitives) {
          const compressedBufferView = json.bufferViews[
            primitive.extensions.KHR_draco_mesh_compression.bufferView
          ];
          if (!compressedBufferView) throw new Error("Missing compressed GLB buffer view.");
          const compressedGeometry = new Int8Array(
            glb,
            binaryHeaderOffset + 8 + compressedBufferView.byteOffset,
            compressedBufferView.byteLength,
          );
          const decoderBuffer = new draco.DecoderBuffer();
          const decodedMesh = new draco.Mesh();
          try {
            decoderBuffer.Init(compressedGeometry, compressedGeometry.byteLength);
            const status = decoder.DecodeBufferToMesh(decoderBuffer, decodedMesh);
            const indexAccessor = json.accessors[primitive.indices];
            const positionAccessor = json.accessors[primitive.attributes.POSITION];
            if (!indexAccessor || !positionAccessor) throw new Error("Missing GLB accessors.");
            expect(status.ok()).toBe(true);
            expect(decodedMesh.num_faces()).toBe(indexAccessor.count / 3);
            expect(decodedMesh.num_points()).toBe(positionAccessor.count);
            expect(decoder.GetAttributeId(decodedMesh, draco.POSITION)).toBe(0);
            decodedFaceCount += decodedMesh.num_faces();
          } finally {
            draco.destroy(decodedMesh);
            draco.destroy(decoderBuffer);
          }
        }
        expect(decodedFaceCount).toBe(totalTriangleCount);

        for (let offset = 0; offset < pixels.length; offset += 4) {
          pixels[offset] = 129;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
          pixels[offset + 3] = 255;
        }
        const modelObj = await createTerrainObj({
          metadata,
          center,
          californiaPolygons: prepared.californiaPolygons,
          region: prepared.regions[0]!,
          resolutionMeters: 10_000,
          californiaLatitudeSpanMeters: 40_000,
          verticalExaggeration: 1,
        }, {
          baseThicknessMm: 3,
          latitudeSpanMm: 10,
          accessories: [{
            id: "handle",
            type: "handle",
            position: fromLocal([30, 30], center),
            sizeMm: 1,
            rotationDegrees: 0,
          }, {
            id: "heart",
            type: "heart",
            position: fromLocal([26, 30], center),
            sizeMm: 1,
            rotationDegrees: 15,
            thicknessMm: 3,
          }, {
            id: "star",
            type: "star",
            position: fromLocal([34, 30], center),
            sizeMm: 1,
            rotationDegrees: -10,
            thicknessMm: 5,
          }],
        });
        const modelFaces = modelObj.split("\n")
          .filter((line) => line.startsWith("f "))
          .map((line) => line.slice(2).split(" ").map(Number));
        const modelVertices = modelObj.split("\n")
          .filter((line) => line.startsWith("v "))
          .map((line) => line.slice(2).split(" ").map(Number) as [number, number, number]);
        const modelEdges = new Map<string, number>();
        const orientedModelEdges = new Map<string, { count: number; direction: number }>();
        const vertexLinks = new Map<number, Map<number, Set<number>>>();
        for (const face of modelFaces) {
          if (face.length !== 3) continue;
          const [a, b, c] = face;
          const first = modelVertices[(a ?? 0) - 1];
          const second = modelVertices[(b ?? 0) - 1];
          const third = modelVertices[(c ?? 0) - 1];
          if (!first || !second || !third) continue;
          const indices = [a!, b!, c!];
          for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
            const start = indices[edgeIndex]!;
            const end = indices[(edgeIndex + 1) % 3]!;
            const edge = start < end ? `${start}:${end}` : `${end}:${start}`;
            const occurrence = orientedModelEdges.get(edge) ?? { count: 0, direction: 0 };
            occurrence.count += 1;
            occurrence.direction += start < end ? 1 : -1;
            orientedModelEdges.set(edge, occurrence);
          }
          for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
            const vertex = indices[vertexIndex]!;
            const firstNeighbor = indices[(vertexIndex + 1) % 3]!;
            const secondNeighbor = indices[(vertexIndex + 2) % 3]!;
            let link = vertexLinks.get(vertex);
            if (!link) {
              link = new Map();
              vertexLinks.set(vertex, link);
            }
            for (const neighbor of [firstNeighbor, secondNeighbor]) {
              let neighbors = link.get(neighbor);
              if (!neighbors) {
                neighbors = new Set();
                link.set(neighbor, neighbors);
              }
              neighbors.add(neighbor === firstNeighbor ? secondNeighbor : firstNeighbor);
            }
          }
          for (let edgeIndex = 0; edgeIndex < face.length; edgeIndex += 1) {
            const first = face[edgeIndex];
            const second = face[(edgeIndex + 1) % face.length];
            if (first === undefined || second === undefined) continue;
            const edge = first < second ? `${first}:${second}` : `${second}:${first}`;
            modelEdges.set(edge, (modelEdges.get(edge) ?? 0) + 1);
          }
        }
        expect(modelFaces.length).toBeGreaterThan(0);
        expect(modelEdges.size).toBeGreaterThan(0);
        expect([...modelEdges.values()].every((count) => count === 2)).toBe(true);
        expect([...orientedModelEdges.values()].every((edge) =>
          edge.count === 2 && edge.direction === 0
        )).toBe(true);
        expect([...vertexLinks.values()].every((link) => {
          if (![...link.values()].every((neighbors) => neighbors.size === 2)) return false;
          const first = link.keys().next().value;
          if (first === undefined) return false;
          const visited = new Set([first]);
          const pending = [first];
          while (pending.length > 0) {
            const vertex = pending.pop();
            if (vertex === undefined) continue;
            for (const neighbor of link.get(vertex) ?? []) {
              if (visited.has(neighbor)) continue;
              visited.add(neighbor);
              pending.push(neighbor);
            }
          }
          return visited.size === link.size;
        })).toBe(true);
        expect(Math.min(...modelVertices.map(([, y]) => y))).toBeCloseTo(-0.003, 5);
        expect(Math.max(...modelVertices.map(([, y]) => y))).toBeGreaterThan(0);
        expect(Math.max(...modelVertices.map(([, , z]) => z)) -
          Math.min(...modelVertices.map(([, , z]) => z))).toBeCloseTo(0.01, 5);
        const modelRegionSpanKm = Math.max(
          ...prepared.regions[0]!.polygons.flat(2).map(([, z]) => z),
        ) - Math.min(...prepared.regions[0]!.polygons.flat(2).map(([, z]) => z));
        const modelMetersPerKm = 0.01 / modelRegionSpanKm;
        expect(modelVertices.some(([, y]) =>
          Math.abs(y + getTerrainAccessoryBaseOverlapMm(3) / 1_000) < 1e-7
        )).toBe(true);
        const handleCenterX = 30 * modelMetersPerKm;
        const handleCenterZ = 30 * modelMetersPerKm;
        const handleInnerRadiusMeters = 0.4 * 1 / 1_000;
        const handleSkirtEdges: [number, number][] = [];
        for (const face of modelFaces) {
          for (let edgeIndex = 0; edgeIndex < face.length; edgeIndex += 1) {
            const first = modelVertices[(face[edgeIndex] ?? 0) - 1];
            const second = modelVertices[(face[(edgeIndex + 1) % face.length] ?? 0) - 1];
            if (!first || !second) continue;
            const [firstX, firstY, firstZ] = first;
            const [secondX, secondY, secondZ] = second;
            if (
              firstX === undefined || firstY === undefined || firstZ === undefined ||
              secondX === undefined || secondY === undefined || secondZ === undefined
            ) continue;
            const planDistance = Math.hypot(firstX - secondX, firstZ - secondZ);
            const radius = Math.hypot(firstX - handleCenterX, firstZ - handleCenterZ);
            if (
              planDistance < 1e-8 &&
              Math.abs(radius - handleInnerRadiusMeters) < 1e-6 &&
              Math.abs(firstY - secondY) > 1e-6
            ) {
              handleSkirtEdges.push([firstY, secondY]);
            }
          }
        }
        expect(handleSkirtEdges.length).toBeGreaterThan(0);
        expect(Math.max(...handleSkirtEdges.flat())).toBeGreaterThan(0);
        expect(Math.min(...handleSkirtEdges.flat())).toBeCloseTo(-0.003, 5);
        const modelExportOptions = {
          metadata,
          center,
          californiaPolygons: prepared.californiaPolygons,
          region: prepared.regions[0]!,
          resolutionMeters: 10_000,
          verticalExaggeration: 1,
        };
        const modelOptions: TerrainModelOptions = {
          baseThicknessMm: 3,
          latitudeSpanMm: 10,
          accessories: [
            {
              id: "handle",
              type: "handle",
              position: fromLocal([30, 30], center),
              sizeMm: 1,
              rotationDegrees: 0,
            },
            {
              id: "heart",
              type: "heart",
              position: fromLocal([26, 30], center),
              sizeMm: 1,
              rotationDegrees: 15,
              thicknessMm: 3,
            },
            {
              id: "star",
              type: "star",
              position: fromLocal([34, 30], center),
              sizeMm: 1,
              rotationDegrees: -10,
              thicknessMm: 5,
            },
          ],
        };
        const modelGlb = await createTerrainModelGlb(
          modelExportOptions,
          modelOptions,
          100_000,
        );
        expect(new DataView(modelGlb).getUint32(0, true)).toBe(0x46546c67);
        let modelTriangleCount = 0;
        const modelStl = await createTerrainModelStl({
          ...modelExportOptions,
          onTriangleCount: (count) => {
            modelTriangleCount = count;
          },
        }, modelOptions);
        const stlView = new DataView(modelStl);
        const stlTriangleCount = stlView.getUint32(80, true);
        expect(new TextDecoder().decode(new Uint8Array(modelStl, 0, 80)))
          .toContain("CalTerrain binary STL");
        expect(stlTriangleCount).toBe(modelTriangleCount);
        expect(modelStl.byteLength).toBe(84 + stlTriangleCount * 50);
        const stlBounds = {
          minX: Infinity,
          maxX: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
        };
        for (let facetOffset = 84; facetOffset < modelStl.byteLength; facetOffset += 50) {
          for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
            const vertexOffset = facetOffset + 12 + vertexIndex * 12;
            const x = stlView.getFloat32(vertexOffset, true);
            const y = stlView.getFloat32(vertexOffset + 4, true);
            const z = stlView.getFloat32(vertexOffset + 8, true);
            stlBounds.minX = Math.min(stlBounds.minX, x);
            stlBounds.maxX = Math.max(stlBounds.maxX, x);
            stlBounds.minY = Math.min(stlBounds.minY, y);
            stlBounds.maxY = Math.max(stlBounds.maxY, y);
            stlBounds.minZ = Math.min(stlBounds.minZ, z);
            stlBounds.maxZ = Math.max(stlBounds.maxZ, z);
          }
        }
        expect(stlBounds.minX).toBeCloseTo(Math.min(...modelVertices.map(([x]) => x)), 5);
        expect(stlBounds.maxX).toBeCloseTo(Math.max(...modelVertices.map(([x]) => x)), 5);
        expect(stlBounds.minY).toBeCloseTo(-Math.max(...modelVertices.map(([, , z]) => z)), 5);
        expect(stlBounds.maxY).toBeCloseTo(-Math.min(...modelVertices.map(([, , z]) => z)), 5);
        expect(stlBounds.minZ).toBeCloseTo(Math.min(...modelVertices.map(([, y]) => y)), 5);
        expect(stlBounds.maxZ).toBeCloseTo(Math.max(...modelVertices.map(([, y]) => y)), 5);
        const unclippedHandleStl = await createTerrainModelStl(modelExportOptions, {
          baseThicknessMm: 3,
          latitudeSpanMm: 10,
          accessories: [{
            id: "handle",
            type: "handle",
            position: fromLocal([30, 30], center),
            sizeMm: 1,
            rotationDegrees: 0,
            clipTerrain: false,
          }],
        });
        const unclippedHandleView = new DataView(unclippedHandleStl);
        expect(unclippedHandleView.getUint32(80, true)).toBeGreaterThan(0);
      } finally {
        draco.destroy(decoder);
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("writes a valid store-only ZIP container for text and binary files", async () => {
    const archive = await createStoreZip([
      { name: "region.glb", content: new Uint8Array([0x67, 0x6c, 0x54, 0x46]) },
      { name: "notes.txt", content: "terrain" },
    ]).arrayBuffer();
    const view = new DataView(archive);
    const firstNameLength = view.getUint16(26, true);
    const firstContentOffset = 30 + firstNameLength;
    const firstContentLength = view.getUint32(18, true);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(archive.byteLength - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(archive.byteLength - 14, true)).toBe(2);
    expect([...new Uint8Array(archive, firstContentOffset, firstContentLength)]).toEqual([
      0x67, 0x6c, 0x54, 0x46,
    ]);
  });
});
