import { describe, expect, it } from "bun:test";
import { buildElevationProfileCsv } from "../ElevationProfilePopup";
import type { ElevationProfile } from "../terrain/elevationAnalysis";

const profile: ElevationProfile = {
  totalDistanceMeters: 3_000,
  series: [
    [
      { position: [0, 0], distanceMeters: 0, elevationMeters: 100 },
      { position: [0.01, 0], distanceMeters: 1_000, elevationMeters: 200 },
    ],
    [
      { position: [0.02, 0], distanceMeters: 2_000, elevationMeters: 300 },
      { position: [0.03, 0], distanceMeters: 3_000, elevationMeters: 400 },
    ],
  ],
};

describe("elevation profile CSV", () => {
  it("exports each sampled point with selected distance and elevation units", () => {
    expect(buildElevationProfileCsv(profile, "km", "m", 1_000, 1)).toBe([
      "segment,distance_km,elevation_m",
      "1,0.000,100.00",
      "1,1.000,200.00",
      "2,2.000,300.00",
      "2,3.000,400.00",
    ].join("\r\n"));
  });

  it("orders segments and distances from the reversed direction when requested", () => {
    expect(buildElevationProfileCsv(profile, "mi", "ft", 1_609.344, 0.3048, true)).toBe([
      "segment,distance_mi,elevation_ft",
      "1,0.000,1312.34",
      "1,0.621,984.25",
      "2,1.243,656.17",
      "2,1.864,328.08",
    ].join("\r\n"));
  });
});
