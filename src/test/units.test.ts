import { describe, expect, it } from "bun:test";
import {
  distanceFromDisplay,
  distanceToDisplay,
  elevationFromDisplay,
  elevationToDisplay,
  formatArea,
  formatDistance,
  formatElevation,
  formatLength,
} from "../units";

describe("measurement units", () => {
  it("converts distances and elevations to and from imperial units", () => {
    expect(distanceToDisplay(1.609344, "imperial")).toBeCloseTo(1);
    expect(distanceFromDisplay(1, "imperial")).toBeCloseTo(1.609344);
    expect(elevationToDisplay(304.8, "imperial")).toBeCloseTo(1_000);
    expect(elevationFromDisplay(1_000, "imperial")).toBeCloseTo(304.8);
  });

  it("formats map distances, elevations, and export lengths in the selected system", () => {
    expect(formatDistance(10, "metric")).toBe("10 km");
    expect(formatDistance(10, "imperial")).toBe("6.21 mi");
    expect(formatElevation(1_000, "metric")).toBe("1,000 m");
    expect(formatElevation(1_000, "imperial")).toBe("3,281 ft");
    expect(formatLength(120, "metric")).toBe("120 m");
    expect(formatLength(120, "imperial")).toBe("393.7 ft");
    expect(formatArea(500_000, "metric")).toBe("500,000 m²");
    expect(formatArea(2_000_000, "metric")).toBe("2 km²");
    expect(formatArea(1_000, "imperial")).toBe("10,763.91 ft²");
    expect(formatArea(2_589_988.110336, "imperial")).toBe("1 mi²");
  });
});
