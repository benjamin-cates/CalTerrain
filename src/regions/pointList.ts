import type { Position } from "../types";

const MAX_WEB_MERCATOR_LATITUDE = 85.051128;

export type LatitudeLongitudeParseResult =
  | { valid: true; points: Position[] }
  | { valid: false; error: string };

export function formatLatitudeLongitudePoints(points: Position[]): string {
  return points.map(([longitude, latitude]) => `${latitude},${longitude}`).join("\n");
}

export function parseLatitudeLongitudePoints(text: string): LatitudeLongitudeParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0) {
    return { valid: false, error: "The clipboard does not contain any points." };
  }

  const points: Position[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      return { valid: false, error: `Line ${index + 1} is blank.` };
    }
    const values = line.split(",");
    if (values.length !== 2 || values.some((value) => value.trim() === "")) {
      return {
        valid: false,
        error: `Line ${index + 1} must be a latitude,longitude pair.`,
      };
    }

    const latitude = Number(values[0]);
    const longitude = Number(values[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return {
        valid: false,
        error: `Line ${index + 1} must contain numeric latitude and longitude values.`,
      };
    }
    if (latitude < -MAX_WEB_MERCATOR_LATITUDE || latitude > MAX_WEB_MERCATOR_LATITUDE) {
      return {
        valid: false,
        error: `Line ${index + 1} latitude must be between -${MAX_WEB_MERCATOR_LATITUDE} and ${MAX_WEB_MERCATOR_LATITUDE}.`,
      };
    }
    if (longitude < -180 || longitude > 180) {
      return {
        valid: false,
        error: `Line ${index + 1} longitude must be between -180 and 180.`,
      };
    }
    points.push([longitude, latitude]);
  }
  return { valid: true, points };
}
