import { describe, expect, it } from "bun:test";
import {
  formatLatitudeLongitudePoints,
  parseLatitudeLongitudePoints,
} from "./shapePointList";

describe("shape point list", () => {
  it("formats points as latitude,longitude pairs in original order", () => {
    expect(formatLatitudeLongitudePoints([
      [-120.5, 37.7],
      [-121, 38],
    ])).toBe("37.7,-120.5\n38,-121");
  });

  it("parses CRLF and trailing newlines into longitude,latitude positions", () => {
    expect(parseLatitudeLongitudePoints("37.7, -120.5\r\n38,-121\r\n")).toEqual({
      valid: true,
      points: [[-120.5, 37.7], [-121, 38]],
    });
  });

  it("reports the line with an invalid coordinate pair", () => {
    expect(parseLatitudeLongitudePoints("37.7,-120.5\n38,-121,0")).toEqual({
      valid: false,
      error: "Line 2 must be a latitude,longitude pair.",
    });
  });

  it("rejects coordinates outside the map's supported range", () => {
    expect(parseLatitudeLongitudePoints("90,-120")).toEqual({
      valid: false,
      error: "Line 1 latitude must be between -85.051128 and 85.051128.",
    });
    expect(parseLatitudeLongitudePoints("37.7,-181")).toEqual({
      valid: false,
      error: "Line 1 longitude must be between -180 and 180.",
    });
  });
});
