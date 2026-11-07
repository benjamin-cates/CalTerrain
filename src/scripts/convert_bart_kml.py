#!/usr/bin/env python3
"""Convert the dissolved BART KML track layer into service-route GeoJSON."""

from __future__ import annotations

import argparse
import heapq
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "data_sources" / "bart.kml"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "features" / "bart_routes.geojson"
KML_NAMESPACE = "{http://www.opengis.net/kml/2.2}"
EARTH_RADIUS_METERS = 6_371_008.8
REFERENCE_LATITUDE_RADIANS = math.radians(37.7)
NODE_SNAP_METERS = 1.5
MAX_STATION_SNAP_METERS = 300

Coordinate = tuple[float, float]
Route = tuple[str, str, str, str]
ROUTES: tuple[Route, ...] = (
    ("Red Line", "Richmond", "Millbrae", "#ed1c24"),
    (
        "Orange Line",
        "Richmond",
        "Berryessa/North San José",
        "#f7941d",
    ),
    (
        "Yellow Line",
        "Antioch",
        "San Francisco International Airport",
        "#f4d11c",
    ),
    ("Green Line", "Daly City", "Berryessa/North San José", "#009b3a"),
    ("Blue Line", "Daly City", "Dublin/Pleasanton", "#0072bc"),
)


def to_xy(coordinate: Coordinate) -> Coordinate:
    longitude, latitude = coordinate
    return (
        math.radians(longitude)
        * EARTH_RADIUS_METERS
        * math.cos(REFERENCE_LATITUDE_RADIANS),
        math.radians(latitude) * EARTH_RADIUS_METERS,
    )


def distance_meters(first: Coordinate, second: Coordinate) -> float:
    first_x, first_y = to_xy(first)
    second_x, second_y = to_xy(second)
    return math.hypot(second_x - first_x, second_y - first_y)


def parse_coordinate_text(text: str, minimum_points: int = 2) -> list[Coordinate]:
    coordinates: list[Coordinate] = []
    for token in text.split():
        parts = token.split(",")
        if len(parts) < 2:
            raise ValueError(f"Invalid KML coordinate: {token!r}")
        coordinates.append((float(parts[0]), float(parts[1])))
    if len(coordinates) < minimum_points:
        raise ValueError(
            f"KML geometry has fewer than {minimum_points} coordinate(s)."
        )
    return coordinates


def read_tracks_and_stations(
    input_path: Path,
) -> tuple[list[list[Coordinate]], dict[str, Coordinate]]:
    root = ET.parse(input_path).getroot()
    track_folder = next(
        (
            folder
            for folder in root.iter(f"{KML_NAMESPACE}Folder")
            if (name := folder.findtext(f"{KML_NAMESPACE}name")) == "BART Track Centerline"
        ),
        None,
    )
    if track_folder is None:
        raise ValueError("Could not find the 'BART Track Centerline' KML folder.")

    tracks = [
        parse_coordinate_text(coordinates.text or "")
        for coordinates in track_folder.iter(f"{KML_NAMESPACE}coordinates")
        if coordinates.text and coordinates.text.strip()
    ]
    if not tracks:
        raise ValueError("The BART track folder contains no LineString coordinates.")

    required_stations = {
        station
        for _, terminal_a, terminal_b, _ in ROUTES
        for station in (terminal_a, terminal_b)
    }
    stations: dict[str, Coordinate] = {}
    for placemark in root.iter(f"{KML_NAMESPACE}Placemark"):
        name = placemark.findtext(f"{KML_NAMESPACE}name")
        if name not in required_stations:
            continue
        coordinates = placemark.find(
            f".//{KML_NAMESPACE}Point/{KML_NAMESPACE}coordinates"
        )
        if coordinates is None or not coordinates.text:
            continue
        stations[name] = parse_coordinate_text(coordinates.text, minimum_points=1)[0]

    missing_stations = sorted(required_stations - stations.keys())
    if missing_stations:
        raise ValueError(
            "Could not find terminal station placemarks: "
            + ", ".join(missing_stations)
        )
    return tracks, stations


def project_onto_tracks(
    station: Coordinate,
    tracks: list[list[Coordinate]],
) -> tuple[int, float, Coordinate, float]:
    station_x, station_y = to_xy(station)
    nearest: tuple[int, float, Coordinate, float] | None = None
    nearest_distance = math.inf

    for track_index, track in enumerate(tracks):
        for segment_index, (start, end) in enumerate(zip(track, track[1:])):
            start_x, start_y = to_xy(start)
            end_x, end_y = to_xy(end)
            dx = end_x - start_x
            dy = end_y - start_y
            length_squared = dx * dx + dy * dy
            if length_squared == 0:
                continue
            fraction = max(
                0.0,
                min(
                    1.0,
                    ((station_x - start_x) * dx + (station_y - start_y) * dy)
                    / length_squared,
                ),
            )
            projected = (
                start[0] + fraction * (end[0] - start[0]),
                start[1] + fraction * (end[1] - start[1]),
            )
            projected_x, projected_y = to_xy(projected)
            distance = math.hypot(
                station_x - projected_x, station_y - projected_y
            )
            if distance < nearest_distance:
                nearest = (track_index, segment_index + fraction, projected, distance)
                nearest_distance = distance

    if nearest is None:
        raise ValueError("Could not project a terminal station onto the BART tracks.")
    if nearest[3] > MAX_STATION_SNAP_METERS:
        raise ValueError(
            f"Terminal station is {nearest[3]:.1f} m from the nearest track; "
            f"maximum allowed is {MAX_STATION_SNAP_METERS} m."
        )
    return nearest


def interpolate_track_position(
    track: list[Coordinate], position: float
) -> Coordinate:
    nearest_vertex = round(position)
    if abs(position - nearest_vertex) < 1e-8:
        return track[nearest_vertex]
    segment_index = math.floor(position)
    fraction = position - segment_index
    start = track[segment_index]
    end = track[segment_index + 1]
    return (
        start[0] + fraction * (end[0] - start[0]),
        start[1] + fraction * (end[1] - start[1]),
    )


def build_graph(
    tracks: list[list[Coordinate]],
    projections: dict[str, tuple[int, float, Coordinate, float]],
) -> tuple[
    list[Coordinate],
    list[tuple[int, int, list[Coordinate], float]],
    dict[str, int],
]:
    cuts_by_track: dict[int, list[tuple[float, str, Coordinate]]] = {}
    for station_name, (track_index, position, coordinate, _) in projections.items():
        cuts_by_track.setdefault(track_index, []).append(
            (position, station_name, coordinate)
        )

    occurrences: list[Coordinate] = []
    edges: list[tuple[int, int, list[Coordinate], float]] = []
    station_occurrences: dict[str, int] = {}

    for track_index, track in enumerate(tracks):
        grouped_cuts: list[tuple[float, Coordinate, list[str]]] = []
        for position, station_name, coordinate in sorted(
            cuts_by_track.get(track_index, []), key=lambda cut: cut[0]
        ):
            if grouped_cuts and abs(grouped_cuts[-1][0] - position) < 1e-8:
                grouped_cuts[-1][2].append(station_name)
            else:
                grouped_cuts.append((position, coordinate, [station_name]))

        breakpoints: list[tuple[float, Coordinate, list[str]]] = [
            (0.0, track[0], [])
        ]
        breakpoints.extend(grouped_cuts)
        breakpoints.append((float(len(track) - 1), track[-1], []))
        breakpoints.sort(key=lambda point: point[0])

        point_occurrences: list[int] = []
        for position, coordinate, station_names in breakpoints:
            occurrence = len(occurrences)
            occurrences.append(coordinate)
            point_occurrences.append(occurrence)
            for station_name in station_names:
                station_occurrences[station_name] = occurrence

        for index, (start, end) in enumerate(zip(breakpoints, breakpoints[1:])):
            start_position, start_coordinate, _ = start
            end_position, end_coordinate, _ = end
            interior = [
                track[vertex_index]
                for vertex_index in range(
                    math.floor(start_position) + 1,
                    math.ceil(end_position),
                )
                if start_position < vertex_index < end_position
            ]
            coordinates = [start_coordinate, *interior, end_coordinate]
            start_node = point_occurrences[index]
            end_node = point_occurrences[index + 1]
            length = sum(
                distance_meters(first, second)
                for first, second in zip(coordinates, coordinates[1:])
            )
            if length > 0:
                edges.append((start_node, end_node, coordinates, length))

    parent = list(range(len(occurrences)))

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(first: int, second: int) -> None:
        first_root = find(first)
        second_root = find(second)
        if first_root != second_root:
            parent[second_root] = first_root

    projected_occurrences = [to_xy(point) for point in occurrences]
    buckets: dict[tuple[int, int], list[int]] = {}
    for occurrence, (x, y) in enumerate(projected_occurrences):
        cell = (
            math.floor(x / NODE_SNAP_METERS),
            math.floor(y / NODE_SNAP_METERS),
        )
        for bucket_x in range(cell[0] - 1, cell[0] + 2):
            for bucket_y in range(cell[1] - 1, cell[1] + 2):
                for other in buckets.get((bucket_x, bucket_y), []):
                    other_x, other_y = projected_occurrences[other]
                    if math.hypot(x - other_x, y - other_y) <= NODE_SNAP_METERS:
                        union(occurrence, other)
        buckets.setdefault(cell, []).append(occurrence)

    roots: dict[int, int] = {}
    node_coordinates: list[Coordinate] = []
    cluster_sums: list[tuple[float, float, int]] = []
    occurrence_nodes: list[int] = []
    for occurrence, root in enumerate(find(index) for index in range(len(parent))):
        if root not in roots:
            roots[root] = len(roots)
            cluster_sums.append((0.0, 0.0, 0))
        node = roots[root]
        x_sum, y_sum, count = cluster_sums[node]
        x, y = projected_occurrences[occurrence]
        cluster_sums[node] = (x_sum + x, y_sum + y, count + 1)
        occurrence_nodes.append(node)

    for x_sum, y_sum, count in cluster_sums:
        node_coordinates.append(
            (
                math.degrees((x_sum / count) / (EARTH_RADIUS_METERS * math.cos(REFERENCE_LATITUDE_RADIANS))),
                math.degrees((y_sum / count) / EARTH_RADIUS_METERS),
            )
        )

    graph_edges: list[tuple[int, int, list[Coordinate], float]] = []
    for start_occurrence, end_occurrence, coordinates, length in edges:
        start_node = occurrence_nodes[start_occurrence]
        end_node = occurrence_nodes[end_occurrence]
        if start_node == end_node:
            continue
        routed_coordinates = list(coordinates)
        routed_coordinates[0] = node_coordinates[start_node]
        routed_coordinates[-1] = node_coordinates[end_node]
        graph_edges.append((start_node, end_node, routed_coordinates, length))

    station_nodes = {
        name: occurrence_nodes[occurrence]
        for name, occurrence in station_occurrences.items()
    }
    return node_coordinates, graph_edges, station_nodes


def shortest_path(
    node_count: int,
    edges: list[tuple[int, int, list[Coordinate], float]],
    start: int,
    end: int,
) -> tuple[list[Coordinate], float]:
    adjacency: list[list[tuple[int, int, float]]] = [
        [] for _ in range(node_count)
    ]
    for edge_index, (first, second, _, length) in enumerate(edges):
        adjacency[first].append((second, edge_index, length))
        adjacency[second].append((first, edge_index, length))

    distances = [math.inf] * node_count
    previous: list[tuple[int, int] | None] = [None] * node_count
    distances[start] = 0.0
    queue = [(0.0, start)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances[node]:
            continue
        if node == end:
            break
        for neighbor, edge_index, length in adjacency[node]:
            candidate = distance + length
            if candidate < distances[neighbor]:
                distances[neighbor] = candidate
                previous[neighbor] = (node, edge_index)
                heapq.heappush(queue, (candidate, neighbor))

    if not math.isfinite(distances[end]):
        raise ValueError(
            "The track network does not connect the requested terminal stations."
        )

    path: list[tuple[int, int, int]] = []
    node = end
    while node != start:
        previous_step = previous[node]
        if previous_step is None:
            raise RuntimeError("Could not reconstruct a connected route path.")
        previous_node, edge_index = previous_step
        path.append((previous_node, node, edge_index))
        node = previous_node
    path.reverse()

    coordinates: list[Coordinate] = []
    for from_node, to_node, edge_index in path:
        edge_start, edge_end, edge_coordinates, _ = edges[edge_index]
        oriented = (
            edge_coordinates
            if (edge_start, edge_end) == (from_node, to_node)
            else list(reversed(edge_coordinates))
        )
        if coordinates:
            coordinates.extend(oriented[1:])
        else:
            coordinates.extend(oriented)
    return coordinates, distances[end]


def convert(input_path: Path, output_path: Path) -> None:
    tracks, stations = read_tracks_and_stations(input_path)
    terminal_names = {
        station
        for _, terminal_a, terminal_b, _ in ROUTES
        for station in (terminal_a, terminal_b)
    }
    projections = {
        name: project_onto_tracks(stations[name], tracks)
        for name in sorted(terminal_names)
    }
    node_coordinates, edges, station_nodes = build_graph(tracks, projections)
    features = []

    for line_name, terminal_a, terminal_b, color in ROUTES:
        coordinates, length = shortest_path(
            len(node_coordinates),
            edges,
            station_nodes[terminal_a],
            station_nodes[terminal_b],
        )
        if len(coordinates) < 2:
            raise ValueError(f"{line_name} produced an invalid route geometry.")
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "name": line_name,
                    "from": terminal_a,
                    "to": terminal_b,
                    "color": color,
                    "length_km": round(length / 1000, 3),
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }
        )

    output = {
        "type": "FeatureCollection",
        "name": "BART service routes",
        "features": features,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {len(features)} routes to {output_path}")
    for feature in features:
        properties = feature["properties"]
        print(
            f"{properties['name']}: {properties['from']} to {properties['to']} "
            f"({properties['length_km']:.3f} km, "
            f"{len(feature['geometry']['coordinates'])} points)"
        )
    for station_name, (_, _, _, snap_distance) in sorted(projections.items()):
        print(f"Snapped {station_name} to track ({snap_distance:.1f} m)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    convert(args.input, args.output)


if __name__ == "__main__":
    main()
