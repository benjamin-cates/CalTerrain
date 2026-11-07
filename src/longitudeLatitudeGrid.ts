import type { BoundaryCollection, BoundaryFeature, Position } from "./types";

type CellBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

function pointInRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index];
    const second = ring[(index + 1) % ring.length];
    if (!first || !second) continue;
    const [firstX, firstY] = first;
    const [secondX, secondY] = second;
    const cross = (x - firstX) * (secondY - firstY) -
      (y - firstY) * (secondX - firstX);
    if (
      Math.abs(cross) < 1e-12 &&
      x >= Math.min(firstX, secondX) && x <= Math.max(firstX, secondX) &&
      y >= Math.min(firstY, secondY) && y <= Math.max(firstY, secondY)
    ) {
      return false;
    }
    if ((firstY > y) !== (secondY > y)) {
      const crossingX = firstX + ((y - firstY) * (secondX - firstX)) / (secondY - firstY);
      if (x < crossingX) inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Position[][]): boolean {
  const [exterior, ...holes] = polygon;
  return exterior !== undefined &&
    pointInRing(point, exterior) &&
    !holes.some((hole) => pointInRing(point, hole));
}

function segmentCrossesCellInterior(
  [x1, y1]: Position,
  [x2, y2]: Position,
  { west, south, east, north }: CellBounds,
): boolean {
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  let enter = 0;
  let exit = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const ratio = q / p;
    if (p < 0) {
      if (ratio > exit) return false;
      enter = Math.max(enter, ratio);
    } else {
      if (ratio < enter) return false;
      exit = Math.min(exit, ratio);
    }
    return true;
  };
  if (
    !clip(-deltaX, x1 - west) ||
    !clip(deltaX, east - x1) ||
    !clip(-deltaY, y1 - south) ||
    !clip(deltaY, north - y1) ||
    enter >= exit
  ) {
    return false;
  }
  const midpoint = (enter + exit) / 2;
  const x = x1 + midpoint * deltaX;
  const y = y1 + midpoint * deltaY;
  return x > west && x < east && y > south && y < north;
}

function cellIntersectsPolygons(cell: CellBounds, polygons: Position[][][]): boolean {
  const { west, south, east, north } = cell;
  const samples: Position[] = [
    [(west + east) / 2, (south + north) / 2],
    [west + 0.001, south + 0.001],
    [east - 0.001, south + 0.001],
    [east - 0.001, north - 0.001],
    [west + 0.001, north - 0.001],
  ];
  for (const polygon of polygons) {
    if (samples.some((sample) => pointInPolygon(sample, polygon))) return true;
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const first = ring[index];
        const second = ring[(index + 1) % ring.length];
        if (
          first && second &&
          segmentCrossesCellInterior(first, second, cell)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function createLongitudeLatitudeGrid(
  californiaBoundary: BoundaryCollection | null,
): BoundaryCollection {
  if (!californiaBoundary || californiaBoundary.features.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }

  const californiaPolygons: Position[][][] = californiaBoundary.features.flatMap((feature) =>
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates
  );
  let minLongitude = Infinity;
  let minLatitude = Infinity;
  let maxLongitude = -Infinity;
  let maxLatitude = -Infinity;
  for (const polygon of californiaPolygons) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        minLongitude = Math.min(minLongitude, longitude);
        minLatitude = Math.min(minLatitude, latitude);
        maxLongitude = Math.max(maxLongitude, longitude);
        maxLatitude = Math.max(maxLatitude, latitude);
      }
    }
  }

  if (![minLongitude, minLatitude, maxLongitude, maxLatitude].every(Number.isFinite)) {
    return { type: "FeatureCollection", features: [] };
  }

  const features: BoundaryFeature[] = [];
  for (let west = Math.floor(minLongitude); west < Math.ceil(maxLongitude); west += 1) {
    for (let south = Math.floor(minLatitude); south < Math.ceil(maxLatitude); south += 1) {
      const east = west + 1;
      const north = south + 1;
      const ring: Position[] = [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ];
      if (!cellIntersectsPolygons({ west, south, east, north }, californiaPolygons)) continue;

      const id = longitudeLatitudeCellIdForBounds(west, south);
      features.push({
        type: "Feature",
        properties: {
          cellId: id,
          name: `${east}° to ${west}° W; ${south}° to ${north}° N`,
        },
        geometry: { type: "Polygon", coordinates: [ring] },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

export function longitudeLatitudeCellId(feature: BoundaryFeature): string {
  return String(feature.properties.cellId ?? "");
}

function longitudeLatitudeCellIdForBounds(west: number, south: number): string {
  return `lonlat-${west}-${south}`;
}
