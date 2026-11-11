#!/usr/bin/env python3
"""Build one connected GeoJSON LineString per California passenger rail route."""

from __future__ import annotations

import argparse
import heapq
import io
import json
import math
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[2]
DATA_SOURCES = ROOT / "data_sources"
FEATURES = ROOT / "public" / "data" / "features"
DEFAULT_OUTPUT = FEATURES / "california_rail_routes.geojson"
EARTH_RADIUS_METERS = 6_371_008.8
REFERENCE_LATITUDE_RADIANS = math.radians(37.7)
NODE_SNAP_METERS = 5.0
SPATIAL_CELL_METERS = 1_000.0
MAX_COMPONENT_GAP_METERS = 1_000.0

Coordinate = tuple[float, float]
RouteKey = tuple[str, str]
Line = list[Coordinate]

METROLINK_ROUTES = {
    "91 Line / Perris Valley Line",
    "Antelope Valley Line",
    "Inland Empire-Orange County Line",
    "Orange County Line",
    "Riverside Line",
    "San Bernardino Line",
    "Ventura County Line",
}


def to_xy(coordinate: Coordinate) -> Coordinate:
    longitude, latitude = coordinate
    return (
        math.radians(longitude)
        * EARTH_RADIUS_METERS
        * math.cos(REFERENCE_LATITUDE_RADIANS),
        math.radians(latitude) * EARTH_RADIUS_METERS,
    )


def from_xy(point: Coordinate) -> Coordinate:
    x, y = point
    return (
        math.degrees(
            x / (EARTH_RADIUS_METERS * math.cos(REFERENCE_LATITUDE_RADIANS))
        ),
        math.degrees(y / EARTH_RADIUS_METERS),
    )


def distance_meters(first: Coordinate, second: Coordinate) -> float:
    first_x, first_y = to_xy(first)
    second_x, second_y = to_xy(second)
    return math.hypot(second_x - first_x, second_y - first_y)


def extract_lines(geometry: dict | None) -> list[Line]:
    if geometry is None:
        return []
    geometry_type = geometry.get("type")
    if geometry_type == "LineString":
        raw_lines = [geometry.get("coordinates", [])]
    elif geometry_type == "MultiLineString":
        raw_lines = geometry.get("coordinates", [])
    else:
        raise ValueError(f"Unsupported rail geometry type: {geometry_type!r}")

    lines: list[Line] = []
    for raw_line in raw_lines:
        line = [(float(point[0]), float(point[1])) for point in raw_line]
        if len(line) >= 2:
            lines.append(line)
    return lines


def normalized_line_key(line: Line) -> tuple[Coordinate, ...]:
    forward = tuple((round(x, 7), round(y, 7)) for x, y in line)
    reverse = tuple(reversed(forward))
    return min(forward, reverse)


def split_repeated_coordinate_loops(line: Line) -> tuple[list[Line], int]:
    fragments: list[Line] = []
    current: Line = []
    positions: dict[Coordinate, int] = {}
    loops_removed = 0

    for coordinate in line:
        key = (round(coordinate[0], 7), round(coordinate[1], 7))
        if current and key == (
            round(current[-1][0], 7),
            round(current[-1][1], 7),
        ):
            continue
        repeated_at = positions.get(key)
        if repeated_at is not None:
            prefix = current[: repeated_at + 1]
            if len(prefix) >= 2:
                fragments.append(prefix)
            current = [coordinate]
            positions = {key: 0}
            loops_removed += 1
            continue
        positions[key] = len(current)
        current.append(coordinate)

    if len(current) >= 2:
        fragments.append(current)
    return fragments, loops_removed


def split_at_nearby_endpoints(lines: list[Line]) -> list[Line]:
    projected_lines = [[to_xy(point) for point in line] for line in lines]
    segment_grid: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for line_index, projected in enumerate(projected_lines):
        for segment_index, (start, end) in enumerate(zip(projected, projected[1:])):
            min_x = min(start[0], end[0]) - NODE_SNAP_METERS
            max_x = max(start[0], end[0]) + NODE_SNAP_METERS
            min_y = min(start[1], end[1]) - NODE_SNAP_METERS
            max_y = max(start[1], end[1]) + NODE_SNAP_METERS
            for cell_x in range(
                math.floor(min_x / SPATIAL_CELL_METERS),
                math.floor(max_x / SPATIAL_CELL_METERS) + 1,
            ):
                for cell_y in range(
                    math.floor(min_y / SPATIAL_CELL_METERS),
                    math.floor(max_y / SPATIAL_CELL_METERS) + 1,
                ):
                    segment_grid.setdefault((cell_x, cell_y), []).append(
                        (line_index, segment_index)
                    )

    cuts: list[dict[float, Coordinate]] = []
    for line in lines:
        cuts.append({0.0: line[0], float(len(line) - 1): line[-1]})

    for line in lines:
        for endpoint in (line[0], line[-1]):
            endpoint_x, endpoint_y = to_xy(endpoint)
            cell = (
                math.floor(endpoint_x / SPATIAL_CELL_METERS),
                math.floor(endpoint_y / SPATIAL_CELL_METERS),
            )
            for line_index, segment_index in segment_grid.get(cell, []):
                start = projected_lines[line_index][segment_index]
                end = projected_lines[line_index][segment_index + 1]
                dx = end[0] - start[0]
                dy = end[1] - start[1]
                length_squared = dx * dx + dy * dy
                if length_squared == 0:
                    continue
                fraction = max(
                    0.0,
                    min(
                        1.0,
                        (
                            (endpoint_x - start[0]) * dx
                            + (endpoint_y - start[1]) * dy
                        )
                        / length_squared,
                    ),
                )
                projected_x = start[0] + fraction * dx
                projected_y = start[1] + fraction * dy
                if math.hypot(endpoint_x - projected_x, endpoint_y - projected_y) > NODE_SNAP_METERS:
                    continue
                if fraction < 1e-8:
                    position = float(segment_index)
                    coordinate = lines[line_index][segment_index]
                elif fraction > 1 - 1e-8:
                    position = float(segment_index + 1)
                    coordinate = lines[line_index][segment_index + 1]
                else:
                    position = segment_index + fraction
                    coordinate = from_xy((projected_x, projected_y))
                cuts[line_index][round(position, 9)] = coordinate

    split_lines: list[Line] = []
    for line, line_cuts in zip(lines, cuts):
        breakpoints = sorted(line_cuts.items())
        for (start_position, start_coordinate), (
            end_position,
            end_coordinate,
        ) in zip(breakpoints, breakpoints[1:]):
            interior = [
                line[vertex_index]
                for vertex_index in range(
                    math.floor(start_position) + 1,
                    math.ceil(end_position),
                )
                if start_position < vertex_index < end_position
            ]
            piece = [start_coordinate, *interior, end_coordinate]
            if len(piece) >= 2 and line_length(piece) > 0:
                split_lines.append(piece)
    return split_lines


def add_lines(
    route_lines: dict[RouteKey, list[Line]],
    agency: str,
    route_name: str,
    lines: list[Line],
) -> None:
    if not route_name.strip():
        return
    route_lines.setdefault((agency, route_name.strip()), []).extend(lines)


def read_geojson(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def add_bart_routes(route_lines: dict[RouteKey, list[Line]]) -> None:
    data = read_geojson(FEATURES / "bart_routes.geojson")
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        route_name = properties.get("name")
        if not route_name:
            raise ValueError("A BART route feature is missing its name property.")
        add_lines(
            route_lines,
            "BART",
            str(route_name),
            extract_lines(feature.get("geometry")),
        )


def property_value(properties: dict, key: str) -> object:
    for property_name, value in properties.items():
        if property_name.casefold() == key.casefold():
            return value
    return None


def add_la_metro_routes(route_lines: dict[RouteKey, list[Line]]) -> None:
    data = read_geojson(DATA_SOURCES / "LA_metro lines.geojson")
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        label = property_value(properties, "label")
        if not isinstance(label, str) or not label.strip():
            raise ValueError("An LA Metro feature is missing its label property.")

        modern_label = label.strip()
        if modern_label.startswith("Metro "):
            modern_label = modern_label[len("Metro ") :]
        if modern_label.endswith(" Line"):
            modern_label = modern_label[: -len(" Line")]
        line_labels = [part.strip() for part in modern_label.split("&")]
        lines = extract_lines(feature.get("geometry"))
        for line_label in line_labels:
            if not line_label:
                raise ValueError(f"Invalid LA Metro label: {label!r}")
            add_lines(route_lines, "LA Metro", f"{line_label} Line", lines)


def add_sacrt_routes(route_lines: dict[RouteKey, list[Line]]) -> None:
    archive_path = DATA_SOURCES / "sacrt_routes.zip"
    with zipfile.ZipFile(archive_path) as outer_archive:
        inner_member = next(
            (
                name
                for name in outer_archive.namelist()
                if name.lower().endswith(".zip")
            ),
            None,
        )
        if inner_member is None:
            raise ValueError(f"No nested shapefile ZIP found in {archive_path}.")
        inner_bytes = outer_archive.read(inner_member)

    with tempfile.TemporaryDirectory(prefix="calterrain-sacrt-") as temp_dir:
        with zipfile.ZipFile(io.BytesIO(inner_bytes)) as inner_archive:
            shapefile_member = next(
                (
                    name
                    for name in inner_archive.namelist()
                    if name.lower().endswith(".shp")
                ),
                None,
            )
            if shapefile_member is None:
                raise ValueError("The SACRT archive contains no shapefile.")
            for name in inner_archive.namelist():
                suffix = Path(name).suffix.lower()
                if suffix not in {".cpg", ".dbf", ".prj", ".shp", ".shx"}:
                    continue
                target = Path(temp_dir) / Path(name).name
                target.write_bytes(inner_archive.read(name))

        shapefile_path = Path(temp_dir) / Path(shapefile_member).name
        result = subprocess.run(
            [
                "ogr2ogr",
                "-f",
                "GeoJSON",
                "/vsistdout/",
                str(shapefile_path),
                "-t_srs",
                "EPSG:4326",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(
                "Could not convert the SACRT shapefile with ogr2ogr: "
                + result.stderr.strip()
            )
        data = json.loads(result.stdout)

    routes: dict[str, list[dict]] = {}
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        route_name = properties.get("line_name")
        if not isinstance(route_name, str) or not route_name.strip():
            raise ValueError("A SACRT feature is missing its line_name property.")
        routes.setdefault(route_name.strip(), []).append(feature)

    for route_name, features in routes.items():
        inbound = [
            feature
            for feature in features
            if str((feature.get("properties") or {}).get("dir_name", ""))
            .strip()
            .casefold()
            == "inbound"
        ]
        selected = inbound or features[:1]
        for feature in selected:
            add_lines(
                route_lines,
                "SacRT",
                route_name,
                extract_lines(feature.get("geometry")),
            )


def add_mts_routes(route_lines: dict[RouteKey, list[Line]]) -> None:
    data = read_geojson(DATA_SOURCES / "mts_trolley_routes.geojson")
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        route_name = properties.get("route_shor")
        if not isinstance(route_name, str) or not route_name.strip():
            raise ValueError("An MTS trolley feature is missing its route_shor property.")
        route_name = route_name.strip()
        if route_name == "UC San Diego Blue Line":
            route_name = "Blue Line"
        add_lines(
            route_lines,
            "SDMTS",
            route_name,
            extract_lines(feature.get("geometry")),
        )


def add_smart_route(route_lines: dict[RouteKey, list[Line]]) -> None:
    data = read_geojson(DATA_SOURCES / "SMART.geojson")
    matching_features = 0
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        owner = property_value(properties, "ROW_OWNER")
        subdivision = property_value(properties, "SUBDIVISIO")
        if (
            not isinstance(owner, str)
            or owner.strip().casefold() != "smart"
            or not isinstance(subdivision, str)
            or subdivision.strip().casefold() != "main line"
        ):
            continue
        add_lines(
            route_lines,
            "SMART",
            "Main Line",
            extract_lines(feature.get("geometry")),
        )
        matching_features += 1

    if matching_features == 0:
        raise ValueError("SMART.geojson contains no SMART Main Line features.")


def add_network_routes(
    route_lines: dict[RouteKey, list[Line]],
    filename: str,
    route_property: str,
    agency_for_route: Callable[[str], tuple[str, str] | None],
) -> None:
    data = read_geojson(DATA_SOURCES / filename)
    for feature in data.get("features", []):
        properties = feature.get("properties") or {}
        value = property_value(properties, route_property)
        if not isinstance(value, str):
            continue
        lines = extract_lines(feature.get("geometry"))
        for route_name in {token.strip() for token in value.split(",") if token.strip()}:
            route = agency_for_route(route_name)
            if route is None:
                continue
            agency, display_name = route
            add_lines(route_lines, agency, display_name, lines)


def amtrak_agency(route_name: str) -> tuple[str, str]:
    return "Amtrak", route_name


def other_rail_agency(route_name: str) -> tuple[str, str] | None:
    if route_name in METROLINK_ROUTES:
        return "Metrolink", route_name
    if route_name == "ACE":
        return "ACE", route_name
    if route_name == "Caltrain":
        return "Caltrain", route_name
    if route_name == "Coaster":
        return "NCTD", route_name
    if route_name.startswith("San Diego Light Rail Trolley (") and route_name.endswith(
        ")"
    ):
        return None
    return route_name, route_name


def line_length(line: Line) -> float:
    return sum(
        distance_meters(first, second)
        for first, second in zip(line, line[1:])
    )


def connected_components(
    node_count: int,
    edges: list[tuple[int, int, Line, float]],
) -> list[set[int]]:
    adjacency: list[list[int]] = [[] for _ in range(node_count)]
    for edge_index, (start, end, _, _) in enumerate(edges):
        if start == end:
            continue
        adjacency[start].append(edge_index)
        adjacency[end].append(edge_index)

    components: list[set[int]] = []
    visited: set[int] = set()
    for node in range(node_count):
        if node in visited or not adjacency[node]:
            continue
        component: set[int] = set()
        stack = [node]
        visited.add(node)
        while stack:
            current = stack.pop()
            component.add(current)
            for edge_index in adjacency[current]:
                start, end, _, _ = edges[edge_index]
                neighbor = end if start == current else start
                if neighbor not in visited:
                    visited.add(neighbor)
                    stack.append(neighbor)
        components.append(component)
    return components


def dijkstra(
    adjacency: list[list[tuple[int, int, float]]],
    start: int,
) -> tuple[list[float], list[tuple[int, int] | None]]:
    distances = [math.inf] * len(adjacency)
    previous: list[tuple[int, int] | None] = [None] * len(adjacency)
    distances[start] = 0.0
    queue = [(0.0, start)]
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances[node]:
            continue
        for neighbor, edge_index, length in adjacency[node]:
            candidate = distance + length
            if candidate < distances[neighbor]:
                distances[neighbor] = candidate
                previous[neighbor] = (node, edge_index)
                heapq.heappush(queue, (candidate, neighbor))
    return distances, previous


def graph_diameter_path(
    node_count: int,
    edges: list[tuple[int, int, Line, float]],
    component: set[int],
) -> tuple[Line, float]:
    adjacency: list[list[tuple[int, int, float]]] = [
        [] for _ in range(node_count)
    ]
    degree = [0] * node_count
    for edge_index, (start, end, _, length) in enumerate(edges):
        if start not in component or end not in component or start == end:
            continue
        adjacency[start].append((end, edge_index, length))
        adjacency[end].append((start, edge_index, length))
        degree[start] += 1
        degree[end] += 1

    terminals = [node for node in component if degree[node] == 1]
    if len(terminals) < 2:
        first_distances, _ = dijkstra(adjacency, min(component))
        first = max(component, key=lambda node: first_distances[node])
        first_distances, _ = dijkstra(adjacency, first)
        second = max(component, key=lambda node: first_distances[node])
        terminals = [first, second]

    best: tuple[float, int, int] | None = None
    best_previous: list[tuple[int, int] | None] | None = None
    for start_index, start in enumerate(terminals):
        distances, previous = dijkstra(adjacency, start)
        for end in terminals[start_index + 1 :]:
            distance = distances[end]
            if math.isfinite(distance) and (best is None or distance > best[0]):
                best = (distance, start, end)
                best_previous = previous

    if best is None or best_previous is None:
        raise ValueError("Could not find a continuous path through a rail route.")

    distance, start, end = best
    steps: list[tuple[int, int, int]] = []
    current = end
    while current != start:
        previous_step = best_previous[current]
        if previous_step is None:
            raise RuntimeError("Could not reconstruct a continuous rail route.")
        previous_node, edge_index = previous_step
        steps.append((previous_node, current, edge_index))
        current = previous_node
    steps.reverse()

    coordinates: Line = []
    for from_node, to_node, edge_index in steps:
        edge_start, edge_end, edge_coordinates, _ = edges[edge_index]
        oriented = (
            edge_coordinates
            if (edge_start, edge_end) == (from_node, to_node)
            else list(reversed(edge_coordinates))
        )
        coordinates.extend(oriented if not coordinates else oriented[1:])
    if len(coordinates) < 2:
        raise ValueError("A rail route path has fewer than two coordinates.")
    return coordinates, distance


def assemble_route(lines: list[Line]) -> tuple[Line, float, int, int, int]:
    split_lines: list[Line] = []
    loops_removed = 0
    for line in lines:
        fragments, removed = split_repeated_coordinate_loops(line)
        split_lines.extend(fragments)
        loops_removed += removed

    unique_lines: list[Line] = []
    seen_lines: set[tuple[Coordinate, ...]] = set()
    for line in split_lines:
        key = normalized_line_key(line)
        if key not in seen_lines:
            seen_lines.add(key)
            unique_lines.append(line)
    if not unique_lines:
        raise ValueError("A route has no usable LineString segments.")

    graph_lines = split_at_nearby_endpoints(unique_lines)
    endpoints: list[Coordinate] = []
    for line in graph_lines:
        endpoints.extend((line[0], line[-1]))

    parent = list(range(len(endpoints)))

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

    endpoint_xy = [to_xy(point) for point in endpoints]
    buckets: dict[tuple[int, int], list[int]] = {}
    for index, (x, y) in enumerate(endpoint_xy):
        cell = (
            math.floor(x / NODE_SNAP_METERS),
            math.floor(y / NODE_SNAP_METERS),
        )
        for bucket_x in range(cell[0] - 1, cell[0] + 2):
            for bucket_y in range(cell[1] - 1, cell[1] + 2):
                for other in buckets.get((bucket_x, bucket_y), []):
                    other_x, other_y = endpoint_xy[other]
                    if math.hypot(x - other_x, y - other_y) <= NODE_SNAP_METERS:
                        union(index, other)
        buckets.setdefault(cell, []).append(index)

    root_to_node: dict[int, int] = {}
    node_sums: list[tuple[float, float, int]] = []
    endpoint_nodes: list[int] = []
    for index in range(len(endpoints)):
        root = find(index)
        if root not in root_to_node:
            root_to_node[root] = len(root_to_node)
            node_sums.append((0.0, 0.0, 0))
        node = root_to_node[root]
        x_sum, y_sum, count = node_sums[node]
        x, y = endpoint_xy[index]
        node_sums[node] = (x_sum + x, y_sum + y, count + 1)
        endpoint_nodes.append(node)
    node_coordinates = [
        from_xy((x_sum / count, y_sum / count))
        for x_sum, y_sum, count in node_sums
    ]

    edges: list[tuple[int, int, Line, float]] = []
    for line_index, line in enumerate(graph_lines):
        start_node = endpoint_nodes[line_index * 2]
        end_node = endpoint_nodes[line_index * 2 + 1]
        if start_node == end_node:
            continue
        coordinates = list(line)
        coordinates[0] = node_coordinates[start_node]
        coordinates[-1] = node_coordinates[end_node]
        length = line_length(coordinates)
        if length > 0:
            edges.append((start_node, end_node, coordinates, length))
    if not edges:
        raise ValueError("A route's track segments collapse to zero length.")

    connector_count = 0
    components = connected_components(len(node_coordinates), edges)
    while len(components) > 1:
        node_component = {
            node: component_index
            for component_index, component in enumerate(components)
            for node in component
        }
        degrees = [0] * len(node_coordinates)
        for start, end, _, _ in edges:
            if start != end:
                degrees[start] += 1
                degrees[end] += 1
        candidates: list[list[int]] = []
        for component in components:
            leaves = [node for node in component if degrees[node] == 1]
            candidates.append(leaves or list(component))

        closest: tuple[float, int, int] | None = None
        for first_component in range(len(components)):
            for second_component in range(first_component + 1, len(components)):
                for first in candidates[first_component]:
                    for second in candidates[second_component]:
                        gap = distance_meters(
                            node_coordinates[first], node_coordinates[second]
                        )
                        if closest is None or gap < closest[0]:
                            closest = (gap, first, second)
        if closest is None or closest[0] > MAX_COMPONENT_GAP_METERS:
            break
        gap, first, second = closest
        edges.append(
            (
                first,
                second,
                [node_coordinates[first], node_coordinates[second]],
                gap,
            )
        )
        connector_count += 1
        components = connected_components(len(node_coordinates), edges)

    if len(components) > 1:
        component_lengths = [
            sum(
                length
                for start, end, _, length in edges
                if start in component and end in component
            )
            for component in components
        ]
        main_component = components[max(range(len(components)), key=component_lengths.__getitem__)]
        components_omitted = len(components) - 1
    else:
        main_component = components[0]
        components_omitted = 0

    coordinates, route_length = graph_diameter_path(
        len(node_coordinates), edges, main_component
    )
    return (
        coordinates,
        route_length,
        connector_count,
        components_omitted,
        loops_removed,
    )


def write_shapefile_archive(geojson_path: Path) -> Path:
    archive_path = geojson_path.with_suffix(".zip")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="calterrain-railways-", dir=archive_path.parent
    ) as temp_dir:
        temp_path = Path(temp_dir)
        shapefile_dir = temp_path / "shapefile"
        shapefile_dir.mkdir()
        result = subprocess.run(
            [
                "ogr2ogr",
                "-f",
                "ESRI Shapefile",
                "-nln",
                geojson_path.stem,
                str(shapefile_dir),
                str(geojson_path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(
                "Could not create the railway shapefile with ogr2ogr: "
                + result.stderr.strip()
            )

        shapefile_path = shapefile_dir / f"{geojson_path.stem}.shp"
        if not shapefile_path.exists():
            raise RuntimeError(
                f"ogr2ogr did not create the expected shapefile: {shapefile_path}"
            )
        temporary_archive = temp_path / archive_path.name
        with zipfile.ZipFile(
            temporary_archive, "w", compression=zipfile.ZIP_DEFLATED
        ) as archive:
            for sidecar in sorted(shapefile_dir.glob(f"{geojson_path.stem}.*")):
                archive.write(sidecar, arcname=sidecar.name)
        temporary_archive.replace(archive_path)

    return archive_path


def build_feature_collection(output_path: Path) -> None:
    route_lines: dict[RouteKey, list[Line]] = {}
    add_bart_routes(route_lines)
    add_la_metro_routes(route_lines)
    add_sacrt_routes(route_lines)
    add_network_routes(
        route_lines, "Amtrak.geojson", "PASS_NETWO", amtrak_agency
    )
    add_network_routes(
        route_lines, "ca_rail_other.geojson", "COMM_NETWO", other_rail_agency
    )
    add_mts_routes(route_lines)
    add_smart_route(route_lines)

    features = []
    agency_order = {
        "BART": 0,
        "LA Metro": 1,
        "SacRT": 2,
        "Amtrak": 3,
        "Metrolink": 4,
        "ACE": 5,
        "Caltrain": 6,
        "NCTD": 7,
        "SDMTS": 8,
        "SMART": 9,
    }
    for agency, route_name in sorted(
        route_lines,
        key=lambda route: (agency_order.get(route[0], 99), route[0], route[1]),
    ):
        coordinates, length, connectors, omitted, loops_removed = assemble_route(
            route_lines[(agency, route_name)]
        )
        if omitted:
            print(
                f"Warning: {agency}: {route_name} has {omitted} disconnected "
                "component(s) beyond the allowed gap; using its longest connected path.",
                file=sys.stderr,
            )
        features.append(
            {
                "type": "Feature",
                "properties": {"name": f"{agency}: {route_name}"},
                "geometry": {
                    "type": "LineString",
                    "coordinates": coordinates,
                },
            }
        )
        print(
            f"{agency}: {route_name} — {length / 1000:.2f} km, "
            f"{len(coordinates)} points, {connectors} gap connector(s), "
            f"{loops_removed} loop(s) removed"
        )

    names = [feature["properties"]["name"] for feature in features]
    if len(names) != len(set(names)):
        raise ValueError("The output contains duplicate route names.")
    if not features or any(
        feature["geometry"]["type"] != "LineString"
        or len(feature["geometry"]["coordinates"]) < 2
        for feature in features
    ):
        raise ValueError("Every output feature must be a non-empty LineString.")

    collection = {
        "type": "FeatureCollection",
        "name": "California passenger rail routes",
        "features": features,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(collection, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(features)} routes to {output_path}")
    archive_path = write_shapefile_archive(output_path)
    print(f"Wrote shapefile archive to {archive_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    build_feature_collection(args.output)


if __name__ == "__main__":
    main()
