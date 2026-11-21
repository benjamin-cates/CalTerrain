import { ShapeUtils, Vector2 } from "three";
import type { Position } from "../types";
import type { TerrainClipSegment } from "./terrainClipIndex";

type SurfaceTriangle = [Position, Position, Position];

export type TerrainSurfaceWallEdge = {
  start: Position;
  end: Position;
  boundarySegment: TerrainClipSegment;
};

export type TerrainSurfaceSplit = {
  triangles: SurfaceTriangle[];
  walls: TerrainSurfaceWallEdge[];
};

type PrimitiveEdge = {
  start: Position;
  end: Position;
  boundarySegment?: TerrainClipSegment;
};

type GraphEdge = {
  first: string;
  second: string;
  boundarySegment?: TerrainClipSegment;
};

const POSITION_TOLERANCE_KM = 0.000001;

function positionKey([x, z]: Position): string {
  return `${x.toFixed(7)},${z.toFixed(7)}`;
}

function edgeKey(first: string, second: string): string {
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function signedArea(points: Position[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current && next) area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function clipSegmentToTriangle(
  segment: TerrainClipSegment,
  triangle: SurfaceTriangle,
): [Position, Position] | null {
  const orientation = signedArea(triangle) >= 0 ? 1 : -1;
  let minimum = 0;
  let maximum = 1;
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
    const edgeStart = triangle[edgeIndex];
    const edgeEnd = triangle[(edgeIndex + 1) % 3];
    if (!edgeStart || !edgeEnd) continue;
    const edgeX = edgeEnd[0] - edgeStart[0];
    const edgeZ = edgeEnd[1] - edgeStart[1];
    const edgeLength = Math.hypot(edgeX, edgeZ);
    if (edgeLength === 0) continue;
    const signedDistance = (point: Position) => orientation * (
      edgeX * (point[1] - edgeStart[1]) -
      edgeZ * (point[0] - edgeStart[0])
    ) / edgeLength;
    const startDistance = signedDistance(segment.start);
    const endDistance = signedDistance(segment.end);
    if (startDistance < 0 && endDistance < 0) return null;
    if ((startDistance < 0) !== (endDistance < 0)) {
      const ratio = startDistance / (startDistance - endDistance);
      if (startDistance < 0) minimum = Math.max(minimum, ratio);
      else maximum = Math.min(maximum, ratio);
      if (minimum > maximum) return null;
    }
  }

  const deltaX = segment.end[0] - segment.start[0];
  const deltaZ = segment.end[1] - segment.start[1];
  const clipped: [Position, Position] = [
    [segment.start[0] + deltaX * minimum, segment.start[1] + deltaZ * minimum],
    [segment.start[0] + deltaX * maximum, segment.start[1] + deltaZ * maximum],
  ];
  return Math.hypot(
    clipped[1][0] - clipped[0][0],
    clipped[1][1] - clipped[0][1],
  ) > POSITION_TOLERANCE_KM
    ? clipped
    : null;
}

function projectOnSegment(
  point: Position,
  start: Position,
  end: Position,
): number | null {
  const edgeX = end[0] - start[0];
  const edgeZ = end[1] - start[1];
  const lengthSquared = edgeX * edgeX + edgeZ * edgeZ;
  if (lengthSquared === 0) return null;
  const amount = ((point[0] - start[0]) * edgeX + (point[1] - start[1]) * edgeZ) /
    lengthSquared;
  if (amount < -POSITION_TOLERANCE_KM || amount > 1 + POSITION_TOLERANCE_KM) {
    return null;
  }
  const projectedX = start[0] + amount * edgeX;
  const projectedZ = start[1] + amount * edgeZ;
  return Math.hypot(point[0] - projectedX, point[1] - projectedZ) <=
      POSITION_TOLERANCE_KM
    ? Math.max(0, Math.min(1, amount))
    : null;
}

function triangulateFace(points: Position[], holes: Position[][]): SurfaceTriangle[] {
  const contour = points.map(([x, z]) => new Vector2(x, z));
  const holeContours = holes.map((hole) => hole.map(([x, z]) => new Vector2(x, z)));
  const faces = ShapeUtils.triangulateShape(contour, holeContours);
  const vertices = [...points, ...holes.flat()];
  return faces.flatMap((face) => {
    const first = vertices[face[0] ?? -1];
    const second = vertices[face[1] ?? -1];
    const third = vertices[face[2] ?? -1];
    return first && second && third ? [[first, second, third] as SurfaceTriangle] : [];
  });
}

function containsPoint(point: Position, polygon: Position[]): boolean {
  let contains = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (!current || !previous) continue;
    if (
      (current[1] > point[1]) !== (previous[1] > point[1]) &&
      point[0] < (previous[0] - current[0]) * (point[1] - current[1]) /
          (previous[1] - current[1]) + current[0]
    ) {
      contains = !contains;
    }
  }
  return contains;
}

function triangulateFacesWithHoles(faces: Position[][]): SurfaceTriangle[] {
  const parents = faces.map((face, index) => {
    const point = face[0];
    if (!point) return -1;
    let parentIndex = -1;
    let parentArea = Infinity;
    const area = Math.abs(signedArea(face));
    for (let candidateIndex = 0; candidateIndex < faces.length; candidateIndex += 1) {
      const candidate = faces[candidateIndex];
      if (!candidate || candidateIndex === index) continue;
      const candidateArea = Math.abs(signedArea(candidate));
      if (
        candidateArea > area &&
        candidateArea < parentArea &&
        containsPoint(point, candidate)
      ) {
        parentIndex = candidateIndex;
        parentArea = candidateArea;
      }
    }
    return parentIndex;
  });
  return faces.flatMap((face, index) => {
    const holes = faces.filter((_, holeIndex) => parents[holeIndex] === index);
    return triangulateFace(face, holes);
  });
}

function splitEdgeIntoGraph(
  primitive: PrimitiveEdge,
  points: Map<string, Position>,
  edges: Map<string, GraphEdge>,
): void {
  const ordered = [...points.entries()]
    .flatMap(([key, point]) => {
      const amount = projectOnSegment(point, primitive.start, primitive.end);
      return amount === null ? [] : [{ key, amount }];
    })
    .sort((first, second) => first.amount - second.amount);

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const first = ordered[index];
    const second = ordered[index + 1];
    if (!first || !second || first.key === second.key) continue;
    const key = edgeKey(first.key, second.key);
    const existing = edges.get(key);
    if (existing) {
      if (primitive.boundarySegment) existing.boundarySegment = primitive.boundarySegment;
      continue;
    }
    edges.set(key, {
      first: first.key,
      second: second.key,
      ...(primitive.boundarySegment && { boundarySegment: primitive.boundarySegment }),
    });
  }
}

function getBoundedFaces(
  edges: Map<string, GraphEdge>,
  points: Map<string, Position>,
): Position[][] {
  const neighbors = new Map<string, Set<string>>();
  for (const { first, second } of edges.values()) {
    const firstNeighbors = neighbors.get(first) ?? new Set<string>();
    firstNeighbors.add(second);
    neighbors.set(first, firstNeighbors);
    const secondNeighbors = neighbors.get(second) ?? new Set<string>();
    secondNeighbors.add(first);
    neighbors.set(second, secondNeighbors);
  }
  const orderedNeighbors = new Map<string, string[]>();
  for (const [key, adjacent] of neighbors) {
    const point = points.get(key);
    if (!point) continue;
    orderedNeighbors.set(key, [...adjacent].sort((first, second) => {
      const firstPoint = points.get(first);
      const secondPoint = points.get(second);
      if (!firstPoint || !secondPoint) return 0;
      return Math.atan2(firstPoint[1] - point[1], firstPoint[0] - point[0]) -
        Math.atan2(secondPoint[1] - point[1], secondPoint[0] - point[0]);
    }));
  }

  const visited = new Set<string>();
  const faces: Position[][] = [];
  for (const { first, second } of edges.values()) {
    const directions: [string, string][] = [[first, second], [second, first]];
    for (const [start, next] of directions) {
      const initialKey = `${start}>${next}`;
      if (visited.has(initialKey)) continue;
      const cycle: Position[] = [];
      let from = start;
      let to = next;
      for (let step = 0; step <= edges.size * 2; step += 1) {
        const directedKey = `${from}>${to}`;
        if (visited.has(directedKey)) break;
        visited.add(directedKey);
        const point = points.get(from);
        const adjacent = orderedNeighbors.get(to);
        if (!point || !adjacent) break;
        cycle.push(point);
        const reverseIndex = adjacent.indexOf(from);
        if (reverseIndex < 0 || adjacent.length < 2) break;
        const following = adjacent[(reverseIndex - 1 + adjacent.length) % adjacent.length];
        if (!following) break;
        from = to;
        to = following;
        if (from === start && to === next) {
          if (cycle.length >= 3 && signedArea(cycle) > 1e-12) faces.push(cycle);
          break;
        }
      }
    }
  }
  return faces;
}

export function splitSurfaceTriangleByBoundary(
  triangle: SurfaceTriangle,
  boundarySegments: TerrainClipSegment[],
  isInside: (point: Position) => boolean,
): TerrainSurfaceSplit {
  const boundaryPieces = boundarySegments.flatMap((segment) => {
    const clipped = clipSegmentToTriangle(segment, triangle);
    return clipped ? [{ start: clipped[0], end: clipped[1], boundarySegment: segment }] : [];
  });
  if (boundaryPieces.length === 0) {
    const centroid: Position = [
      (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
      (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
    ];
    return {
      triangles: isInside(centroid) ? [triangle] : [],
      walls: [],
    };
  }

  const points = new Map<string, Position>();
  const addPoint = (point: Position) => {
    const key = positionKey(point);
    if (!points.has(key)) points.set(key, point);
    return key;
  };
  const primitiveEdges: PrimitiveEdge[] = [];
  for (let index = 0; index < 3; index += 1) {
    const start = triangle[index];
    const end = triangle[(index + 1) % 3];
    if (start && end) {
      addPoint(start);
      addPoint(end);
      primitiveEdges.push({ start, end });
    }
  }
  for (const piece of boundaryPieces) {
    addPoint(piece.start);
    addPoint(piece.end);
    primitiveEdges.push(piece);
  }

  const edges = new Map<string, GraphEdge>();
  for (const primitive of primitiveEdges) {
    splitEdgeIntoGraph(primitive, points, edges);
  }

  const triangles = triangulateFacesWithHoles(getBoundedFaces(edges, points)).filter((part) =>
    isInside([
      (part[0][0] + part[1][0] + part[2][0]) / 3,
      (part[0][1] + part[1][1] + part[2][1]) / 3,
    ])
  );
  const walls: TerrainSurfaceWallEdge[] = [];
  for (const { first, second, boundarySegment } of edges.values()) {
    if (!boundarySegment) continue;
    const start = points.get(first);
    const end = points.get(second);
    if (start && end) walls.push({ start, end, boundarySegment });
  }
  return { triangles, walls };
}
