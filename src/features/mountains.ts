import type { Position } from "../types";

export type MountainPeak = {
  id: string;
  name: string;
  range: string;
  position: Position;
  elevationMeters?: number;
  prominenceMeters?: number;
  isolationKm?: number;
  custom?: boolean;
};

export const MOUNTAIN_PEAK_VISIBILITY_DISTANCE_KM = 125;

export function parseMountainTsv(contents: string): MountainPeak[] {
  const rows = contents.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = rows[0]?.split("\t").map((header) => header.trim());
  if (!headers) throw new Error("Mountain TSV is empty.");

  const nameColumn = headers.indexOf("Name");
  const rangeColumn = headers.indexOf("Mountain range");
  const elevationColumn = headers.indexOf("Elevation (m)");
  const prominenceColumn = headers.indexOf("Prominence (m)");
  const isolationColumn = headers.indexOf("Isolation (km)");
  const latitudeColumn = headers.indexOf("Lat");
  const longitudeColumn = headers.indexOf("Long");
  if ([nameColumn, rangeColumn, elevationColumn, latitudeColumn, longitudeColumn].some((column) => column < 0)) {
    throw new Error("Mountain TSV is missing a required column.");
  }

  const peaks: MountainPeak[] = [];
  const seen = new Set<string>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.trim()) continue;
    const fields = row.split("\t");
    const name = fields[nameColumn]?.trim();
    const range = fields[rangeColumn]?.trim();
    const elevationMeters = Number(fields[elevationColumn]?.replaceAll(",", "").trim());
    const latitude = Number(fields[latitudeColumn]?.trim());
    const longitude = Number(fields[longitudeColumn]?.trim());
    if (
      !name ||
      !range ||
      !Number.isFinite(elevationMeters) ||
      elevationMeters <= 0 ||
      !Number.isFinite(latitude) ||
      latitude < -85.05112878 ||
      latitude > 85.05112878 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new Error(`Mountain TSV row ${rowIndex + 1} has invalid peak data.`);
    }

    const id = `${name}/${latitude}/${longitude}`;
    if (seen.has(id)) continue;
    seen.add(id);
    peaks.push({
      id,
      name,
      range,
      elevationMeters,
      ...(prominenceColumn >= 0
        ? { prominenceMeters: parseOptionalNumber(fields[prominenceColumn]) }
        : {}),
      ...(isolationColumn >= 0
        ? { isolationKm: parseOptionalNumber(fields[isolationColumn]) }
        : {}),
      position: [longitude, latitude],
    });
  }

  if (peaks.length === 0) throw new Error("Mountain TSV contains no peaks.");
  return peaks;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCustomMountainPeaks(contents: string): MountainPeak[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Saved custom mountain peaks are not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Saved custom mountain peaks must be a list.");
  }

  return parsed.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`Saved custom mountain peak ${index + 1} is invalid.`);
    }
    const position = value.position;
    const optionalNumbers = ["elevationMeters", "prominenceMeters", "isolationKm"] as const;
    const optionalValues = optionalNumbers.map((key) => value[key]);
    if (
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      typeof value.range !== "string" ||
      !value.range.trim() ||
      value.custom !== true ||
      !Array.isArray(position) ||
      position.length !== 2 ||
      typeof position[0] !== "number" ||
      !Number.isFinite(position[0]) ||
      position[0] < -180 ||
      position[0] > 180 ||
      typeof position[1] !== "number" ||
      !Number.isFinite(position[1]) ||
      position[1] < -85.05112878 ||
      position[1] > 85.05112878 ||
      optionalValues.some((item) =>
        item !== undefined && (typeof item !== "number" || !Number.isFinite(item) || item < 0)
      )
    ) {
      throw new Error(`Saved custom mountain peak ${index + 1} is invalid.`);
    }

    return {
      id: value.id,
      name: value.name.trim(),
      range: value.range.trim(),
      position: [position[0], position[1]],
      custom: true,
      ...(typeof value.elevationMeters === "number" ? { elevationMeters: value.elevationMeters } : {}),
      ...(typeof value.prominenceMeters === "number" ? { prominenceMeters: value.prominenceMeters } : {}),
      ...(typeof value.isolationKm === "number" ? { isolationKm: value.isolationKm } : {}),
    };
  });
}
