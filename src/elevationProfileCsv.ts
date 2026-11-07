import type { ElevationProfile } from "./terrain/elevationAnalysis";

export function buildElevationProfileCsv(
  profile: ElevationProfile,
  distanceUnit: string,
  elevationUnit: string,
  metersPerDistanceUnit: number,
  metersPerElevationUnit: number,
  reversed = false,
): string {
  const series = reversed
    ? [...profile.series].reverse().map((line) => [...line].reverse())
    : profile.series;
  const rows = [
    `segment,distance_${distanceUnit},elevation_${elevationUnit}`,
    ...series.flatMap((line, index) => line.map((sample) => {
      const distance = (reversed
        ? profile.totalDistanceMeters - sample.distanceMeters
        : sample.distanceMeters) / metersPerDistanceUnit;
      const elevation = sample.elevationMeters / metersPerElevationUnit;
      return `${index + 1},${distance.toFixed(3)},${elevation.toFixed(2)}`;
    })),
  ];
  return rows.join("\r\n");
}
