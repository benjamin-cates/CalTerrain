import { describe, expect, it } from "bun:test";
import { WORLD_METERS } from "../geo";
import { selectTerrainTiles } from "../terrain/terrainQuadtree";
import type { TerrainMetadata, ViewState } from "../types";

const center: [number, number] = [0, 0];

function metadata(tiles: string[]): TerrainMetadata {
  return {
    bounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    center,
    tiles,
    zoomLevels: [8, 9, 10, 11],
  };
}

function tileCenterTarget(z: number, x: number, y: number): [number, number] {
  const tileSizeKm = WORLD_METERS / 2 ** z / 1_000;
  return [
    (x + 0.5) * tileSizeKm - WORLD_METERS / 2_000 - center[0] / 1_000,
    (y + 0.5) * tileSizeKm - WORLD_METERS / 2_000 + center[1] / 1_000,
  ];
}

function view(target: [number, number], distance: number): ViewState {
  return { target, distance, azimuth: 0, polar: 1 };
}

const parent = "8/128/128";
const children = [
  "9/256/256",
  "9/257/256",
  "9/256/257",
  "9/257/257",
];
const grandchildren = children.flatMap((key) => {
  const [, xValue, yValue] = key.split("/");
  const x = Number(xValue);
  const y = Number(yValue);
  return [
    `10/${x * 2}/${y * 2}`,
    `10/${x * 2 + 1}/${y * 2}`,
    `10/${x * 2}/${y * 2 + 1}`,
    `10/${x * 2 + 1}/${y * 2 + 1}`,
  ];
});
const greatGrandchildren = grandchildren.flatMap((key) => {
  const [, xValue, yValue] = key.split("/");
  const x = Number(xValue);
  const y = Number(yValue);
  return [
    `11/${x * 2}/${y * 2}`,
    `11/${x * 2 + 1}/${y * 2}`,
    `11/${x * 2}/${y * 2 + 1}`,
    `11/${x * 2 + 1}/${y * 2 + 1}`,
  ];
});

describe("terrain quadtree tile selection", () => {
  it("keeps every available tile at or above the zoom-8 minimum", () => {
    const selected = selectTerrainTiles(
      view([0, 0], 1_850),
      metadata([parent, ...children]),
    );

    expect(selected).toEqual([{ z: 8, x: 128, y: 128 }]);
  });

  it("splits a close tile into all four children", () => {
    const selected = selectTerrainTiles(
      view(tileCenterTarget(8, 128, 128), 30),
      metadata([parent, ...children]),
    );

    expect(selected.map(({ z, x, y }) => `${z}/${x}/${y}`)).toEqual(children);
  });

  it("keeps an extra zoom level at moderate camera distances", () => {
    const selected = selectTerrainTiles(
      view(tileCenterTarget(8, 128, 128), 100),
      metadata([parent, ...children, ...grandchildren]),
    );

    expect(selected).toHaveLength(16);
    expect(selected.every((tile) => tile.z === 10)).toBe(true);
  });

  it("shows a finer level at closer zoom distances", () => {
    const terrain = metadata([parent, ...children, ...grandchildren, ...greatGrandchildren]);
    const target = tileCenterTarget(8, 128, 128);
    const selected = selectTerrainTiles(view(target, 55), terrain);

    expect(selected.length).toBeGreaterThan(16);
    expect(selected.some((tile) => tile.z === 11)).toBe(true);
  });

  it("uses separate cutoffs when increasing and reducing tile resolution", () => {
    const terrain = metadata([parent, ...children, ...grandchildren]);
    const target = tileCenterTarget(8, 128, 128);
    const detailedTiles = selectTerrainTiles(view(target, 100), terrain);
    const continuedDetail = selectTerrainTiles(view(target, 180), terrain, detailedTiles);
    const freshSelection = selectTerrainTiles(view(target, 180), terrain);

    expect(detailedTiles.every((tile) => tile.z === 10)).toBe(true);
    expect(continuedDetail.every((tile) => tile.z === 10)).toBe(true);
    expect(freshSelection.every((tile) => tile.z === 9)).toBe(true);
  });

  it("keeps the finer level until the camera is zoomed farther out", () => {
    const terrain = metadata([parent, ...children, ...grandchildren, ...greatGrandchildren]);
    const target = tileCenterTarget(8, 128, 128);
    const detailedTiles = selectTerrainTiles(view(target, 55), terrain);
    const retainedDetail = selectTerrainTiles(view(target, 140), terrain, detailedTiles);
    const downgraded = selectTerrainTiles(view(target, 160), terrain, detailedTiles);

    expect(detailedTiles.some((tile) => tile.z === 11)).toBe(true);
    expect(retainedDetail.some((tile) => tile.z === 11)).toBe(true);
    expect(downgraded.every((tile) => tile.z === 10)).toBe(true);
  });

  it("refines available children when other quadrants have no terrain", () => {
    const selected = selectTerrainTiles(
      view(tileCenterTarget(8, 128, 128), 30),
      metadata([parent, ...children.slice(0, 3)]),
    );

    expect(selected.map(({ z, x, y }) => `${z}/${x}/${y}`)).toEqual(children.slice(0, 3));
  });

  it("keeps nearby areas detailed while merging distant areas", () => {
    const distantParent = "8/129/128";
    const selected = selectTerrainTiles(
      view(tileCenterTarget(8, 128, 128), 30),
      metadata([parent, distantParent, ...children]),
    );

    expect(selected.some((tile) => tile.z === 9)).toBe(true);
    expect(selected).toContainEqual({ z: 8, x: 129, y: 128 });
  });
});
