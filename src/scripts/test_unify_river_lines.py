import unittest

from src.scripts.unify_river_lines import (
    endpoint_distance_meters,
    merge_line_paths,
    order_lines_by_elevation,
    split_named_river,
)


class MergeLinePathsTests(unittest.TestCase):
    def test_merges_nearby_endpoints_and_reverses_as_needed(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-122.0, 36.0], [-121.0002, 36.0]],
        ]

        merged = merge_line_paths(lines)

        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]), 4)
        self.assertLessEqual(
            endpoint_distance_meters(merged[0][1], merged[0][2]),
            30,
        )

    def test_keeps_endpoints_more_than_30_meters_apart_separate(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-121.0004, 36.0], [-122.0, 36.0]],
        ]

        self.assertEqual(len(merge_line_paths(lines)), 2)

    def test_second_pass_joins_only_gaps_over_30_meters_and_under_1_km(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-121.002, 36.0], [-122.0, 36.0]],
        ]

        self.assertEqual(len(merge_line_paths(lines)), 2)
        self.assertEqual(len(merge_line_paths(lines, 1_000)), 1)

    def test_keeps_ambiguous_branch_endpoints_separate(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-121.0, 36.0], [-122.0, 36.0]],
            [[-121.0, 36.0], [-121.0, 37.0]],
        ]

        self.assertEqual(len(merge_line_paths(lines)), 3)

    def test_prefers_unique_nearest_endpoint_in_a_nearby_cluster(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-121.0001, 36.0], [-122.0, 36.0]],
            [[-121.0003, 36.0], [-123.0, 36.0]],
        ]

        self.assertEqual(len(merge_line_paths(lines)), 2)

    def test_keeps_disconnected_components_separate(self) -> None:
        lines = [
            [[-120.0, 36.0], [-121.0, 36.0]],
            [[-123.0, 36.0], [-124.0, 36.0]],
        ]

        self.assertEqual(len(merge_line_paths(lines)), 2)

    def test_splits_tule_and_roaring_rivers_by_region(self) -> None:
        tule_groups = split_named_river(
            "Tule River",
            [
                [[-119.0, 36.0], [-119.1, 36.0]],
                [[-121.4, 41.0], [-121.5, 41.0]],
            ],
        )
        roaring_groups = split_named_river(
            "Roaring River",
            [
                [[-118.0, 36.0], [-118.1, 36.0]],
                [[-122.0, 40.0], [-122.1, 40.0]],
            ],
        )

        self.assertEqual(
            [name for name, _ in tule_groups],
            ["Tule River (Tulare County)", "Tule River (Shasta County)"],
        )
        self.assertEqual(
            [name for name, _ in roaring_groups],
            ["Roaring River (Kings)", "Roaring River (Cottonwood)"],
        )

    def test_orients_and_sorts_lines_from_high_to_low(self) -> None:
        elevations = {
            (0.0, 0.0): 10,
            (1.0, 0.0): 5,
            (2.0, 0.0): 5,
            (3.0, 0.0): 20,
        }
        lines = [
            [[0.0, 0.0], [1.0, 0.0]],
            [[2.0, 0.0], [3.0, 0.0]],
        ]

        self.assertEqual(
            order_lines_by_elevation(lines, lambda point: elevations[tuple(point)]),
            [
                [[3.0, 0.0], [2.0, 0.0]],
                [[0.0, 0.0], [1.0, 0.0]],
            ],
        )


if __name__ == "__main__":
    unittest.main()
