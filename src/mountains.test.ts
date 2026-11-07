import { describe, expect, it } from "bun:test";
import { parseCustomMountainPeaks, parseMountainTsv } from "./mountains";

describe("mountain TSV parsing", () => {
  it("parses elevations and converts latitude/longitude to map coordinates", () => {
    const peaks = parseMountainTsv([
      "Name\tMountain range\tElevation (m)\tProminence (m)\tIsolation (km)\tLat\tLong",
      "Mount Whitney\tSierra Nevada\t4,421.00\t3,072.00\t2,649.00\t36.5786\t-118.2920",
    ].join("\n"));

    expect(peaks).toEqual([{
      id: "Mount Whitney/36.5786/-118.292",
      name: "Mount Whitney",
      range: "Sierra Nevada",
      elevationMeters: 4421,
      prominenceMeters: 3072,
      isolationKm: 2649,
      position: [-118.292, 36.5786],
    }]);
  });

  it("deduplicates identical peak records", () => {
    const row = "Mount Eddy\tKlamath Mountains\t2,754.60\t1,562.00\t23.50\t41.3196\t-122.4790";
    const peaks = parseMountainTsv([
      "Name\tMountain range\tElevation (m)\tProminence (m)\tIsolation (km)\tLat\tLong",
      row,
      row,
    ].join("\n"));

    expect(peaks).toHaveLength(1);
  });

  it("rejects malformed rows instead of silently omitting peaks", () => {
    expect(() => parseMountainTsv([
      "Name\tMountain range\tElevation (m)\tLat\tLong",
      "Mount Whitney\tSierra Nevada\tnot-a-number\t36.5786\t-118.2920",
    ].join("\n"))).toThrow("Mountain TSV row 2 has invalid peak data.");
  });

  it("parses and validates persisted custom peaks with optional metadata", () => {
    const peaks = parseCustomMountainPeaks(JSON.stringify([{
      id: "custom-peak-1",
      name: "Test Peak",
      range: "Test Range",
      position: [-121.5, 37.2],
      custom: true,
    }]));

    expect(peaks).toEqual([{
      id: "custom-peak-1",
      name: "Test Peak",
      range: "Test Range",
      position: [-121.5, 37.2],
      custom: true,
    }]);
  });
});
