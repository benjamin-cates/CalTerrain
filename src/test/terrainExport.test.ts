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
  estimateTerrainTriangleCount,
  formatTerrainExportScale,
  getTerrainImageDimensions,
  getTerrainImageTilePixelBounds,
  getTerrainExportBoundingBoxes,
  getTerrainExportResolution,
  getTerrainExportScaleMeters,
  getTerrainExportScaleStep,
  getTerrainGroundScale,
  TERRAIN_EXPORT_RESOLUTIONS,
  type TerrainExportRegion,
} from "../terrain/terrainExport";

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

describe("terrain export", () => {
  it("maps resolution in the requested coarse-to-fine slider order", () => {
    expect(TERRAIN_EXPORT_RESOLUTIONS).toEqual([240, 120, 60, 30]);
    expect(getTerrainExportResolution(0)).toBe(240);
    expect(getTerrainExportResolution(3)).toBe(30);
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

  it("creates a closed mesh and Draco-compressed GLB with terrain top, bottom, and clipped walls", async () => {
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
            fromLocalRing([[20, 20], [40, 20], [30, 40], [20, 20]], center),
            fromLocalRing([[27, 27], [27, 33], [33, 33], [33, 27], [27, 27]], center),
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
        californiaLatitudeSpanMeters: 1,
        verticalExaggeration: 1,
        onTriangleCount: (count) => {
          totalTriangleCount = count;
        },
      });

      const vertexCount = obj.split("\n").filter((line) => line.startsWith("v ")).length;
      const faceCount = obj.split("\n").filter((line) => line.startsWith("f ")).length;
      const edgeUses = new Map<string, number>();
      for (const line of obj.split("\n")) {
        if (!line.startsWith("f ")) continue;
        const faceVertices = line.slice(2).split(" ").map(Number);
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

      const glb = await createTerrainGlb({
        metadata,
        center,
        californiaPolygons: prepared.californiaPolygons,
        region: prepared.regions[0]!,
        resolutionMeters: 10_000,
        californiaLatitudeSpanMeters: 1,
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
