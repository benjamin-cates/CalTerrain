import type { MeasurementSystem } from "./types";

const KILOMETERS_PER_MILE = 1.609344;
const METERS_PER_FOOT = 0.3048;
const SQUARE_METERS_PER_SQUARE_MILE = 2_589_988.110336;

export function distanceUnit(measurementSystem: MeasurementSystem): "km" | "mi" {
  return measurementSystem === "metric" ? "km" : "mi";
}

export function elevationUnit(measurementSystem: MeasurementSystem): "m" | "ft" {
  return measurementSystem === "metric" ? "m" : "ft";
}

export function distanceToDisplay(kilometers: number, measurementSystem: MeasurementSystem): number {
  return measurementSystem === "metric" ? kilometers : kilometers / KILOMETERS_PER_MILE;
}

export function distanceFromDisplay(value: number, measurementSystem: MeasurementSystem): number {
  return measurementSystem === "metric" ? value : value * KILOMETERS_PER_MILE;
}

export function elevationToDisplay(meters: number, measurementSystem: MeasurementSystem): number {
  return measurementSystem === "metric" ? meters : meters / METERS_PER_FOOT;
}

export function elevationFromDisplay(value: number, measurementSystem: MeasurementSystem): number {
  return measurementSystem === "metric" ? value : value * METERS_PER_FOOT;
}

export function formatDistance(kilometers: number, measurementSystem: MeasurementSystem): string {
  const value = distanceToDisplay(kilometers, measurementSystem);
  const maximumFractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString("en-US", { maximumFractionDigits })} ${distanceUnit(measurementSystem)}`;
}

export function formatElevation(meters: number, measurementSystem: MeasurementSystem): string {
  return `${Math.round(elevationToDisplay(meters, measurementSystem)).toLocaleString("en-US")} ${elevationUnit(measurementSystem)}`;
}

export function formatLength(meters: number, measurementSystem: MeasurementSystem): string {
  if (measurementSystem === "imperial") {
    const feet = meters / METERS_PER_FOOT;
    if (feet >= 5_280) {
      return `${(feet / 5_280).toLocaleString("en-US", { maximumFractionDigits: 2 })} mi`;
    }
    return `${feet.toLocaleString("en-US", { maximumFractionDigits: 2 })} ft`;
  }
  if (meters >= 1_000) {
    return `${(meters / 1_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km`;
  }
  if (meters < 1) {
    return `${(meters * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} cm`;
  }
  return `${meters.toLocaleString("en-US", { maximumFractionDigits: 2 })} m`;
}

export function formatArea(squareMeters: number, measurementSystem: MeasurementSystem): string {
  if (measurementSystem === "imperial") {
    const squareFeet = squareMeters / METERS_PER_FOOT ** 2;
    if (squareFeet >= 27_878_400) {
      return `${(squareMeters / SQUARE_METERS_PER_SQUARE_MILE).toLocaleString("en-US", { maximumFractionDigits: 2 })} mi²`;
    }
    return `${squareFeet.toLocaleString("en-US", { maximumFractionDigits: 2 })} ft²`;
  }
  if (squareMeters >= 1_000_000) {
    return `${(squareMeters / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km²`;
  }
  return `${squareMeters.toLocaleString("en-US", { maximumFractionDigits: 2 })} m²`;
}
