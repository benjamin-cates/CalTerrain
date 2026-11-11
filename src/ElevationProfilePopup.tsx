import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  elevationToDisplay,
  elevationUnit,
  formatElevation,
  formatLength,
} from "./units";
import type { ElevationProfile, ElevationProfilePoint } from "./terrain/elevationAnalysis";
import type { MeasurementSystem } from "./types";

type Props = {
  profile: ElevationProfile | null;
  loading: boolean;
  error: string | null;
  name: string;
  measurementSystem: MeasurementSystem;
  onClose: () => void;
};

type ProfileLabel = {
  id: number;
  point: ElevationProfilePoint;
};

const WIDTH = 920;
const HEIGHT = 500;
const MARGIN = { top: 42, right: 28, bottom: 76, left: 88 };
const MAX_GRID_LINES = 10;
const METERS_PER_MILE = 1_609.344;
const METERS_PER_FOOT = 0.3048;
let nextLabelId = 0;

function axisPrecision(step: number): number {
  return Math.max(0, Math.min(3, -Math.floor(Math.log10(step))));
}

function formatAxisTick(value: number, step: number): string {
  return Number(value.toFixed(axisPrecision(step))).toLocaleString("en-US", {
    maximumFractionDigits: axisPrecision(step),
  });
}

type NiceAxisGrid = {
  minimum: number;
  maximum: number;
  step: number;
  ticks: number[];
};

function niceStepAtLeast(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

export function createNiceAxisGrid(
  minimum: number,
  maximum: number,
  maxLineCount = 10,
): NiceAxisGrid {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  const lineLimit = Math.max(2, Math.floor(maxLineCount));
  const extent = upper > lower
    ? upper - lower
    : Math.max(1, Math.abs(lower) * 0.02);
  const halfExtent = upper > lower ? 0 : extent / 2;
  let step = niceStepAtLeast(extent / (lineLimit - 1));

  while (true) {
    const axisMinimum = Math.floor((lower - halfExtent) / step) * step;
    const axisMaximum = Math.ceil((upper + halfExtent) / step) * step;
    const count = Math.round((axisMaximum - axisMinimum) / step) + 1;
    if (count <= lineLimit) {
      return {
        minimum: axisMinimum,
        maximum: axisMaximum,
        step,
        ticks: Array.from({ length: count }, (_, index) => axisMinimum + index * step),
      };
    }
    step = niceStepAtLeast(step * 1.01);
  }
}

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

export function ElevationProfilePopup({
  profile,
  loading,
  error,
  name,
  measurementSystem,
  onClose,
}: Props) {
  const [reversed, setReversed] = useState(false);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const samples = useMemo(() => profile?.series.flat() ?? [], [profile]);
  const totalDistance = profile?.totalDistanceMeters ?? 0;
  const distanceAxisUnit = measurementSystem === "metric"
    ? totalDistance >= 1_000 ? "km" : totalDistance < 1 ? "cm" : "m"
    : totalDistance >= METERS_PER_MILE ? "mi" : "ft";
  const distanceMetersPerUnit = distanceAxisUnit === "km"
    ? 1_000
    : distanceAxisUnit === "cm"
      ? 0.01
    : distanceAxisUnit === "mi"
      ? METERS_PER_MILE
      : distanceAxisUnit === "ft"
        ? METERS_PER_FOOT
        : 1;
  const totalDistanceAxisUnits = totalDistance / distanceMetersPerUnit;
  const distanceGrid = createNiceAxisGrid(0, totalDistanceAxisUnits, MAX_GRID_LINES);
  const elevationAxisValues = samples.map((sample) =>
    elevationToDisplay(sample.elevationMeters, measurementSystem)
  );
  const minimumElevation = elevationAxisValues.length > 0
    ? Math.min(...elevationAxisValues)
    : 0;
  const maximumElevation = elevationAxisValues.length > 0
    ? Math.max(...elevationAxisValues)
    : 1;
  const elevationGrid = createNiceAxisGrid(
    minimumElevation,
    maximumElevation,
    MAX_GRID_LINES,
  );
  const x = (distanceMeters: number) => {
    const distanceFromStart = reversed ? totalDistance - distanceMeters : distanceMeters;
    const displayedDistance = distanceFromStart / distanceMetersPerUnit;
    return MARGIN.left + displayedDistance / distanceGrid.maximum * plotWidth;
  };
  const y = (elevationMeters: number) => {
    const displayedElevation = elevationToDisplay(elevationMeters, measurementSystem);
    return MARGIN.top + (elevationGrid.maximum - displayedElevation) /
      (elevationGrid.maximum - elevationGrid.minimum) * plotHeight;
  };
  const paths = (profile?.series ?? []).map((series) =>
    series.map((sample, index) =>
      `${index === 0 ? "M" : "L"} ${x(sample.distanceMeters).toFixed(2)} ${y(sample.elevationMeters).toFixed(2)}`
    ).join(" ")
  );
  const elevationTicks = elevationGrid.ticks;
  const distanceTicks = distanceGrid.ticks;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const addElevationLabel = (event: MouseEvent<SVGSVGElement>) => {
    if (!profile || samples.length === 0 || totalDistance <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewX = (event.clientX - bounds.left) / bounds.width * WIDTH;
    const viewY = (event.clientY - bounds.top) / bounds.height * HEIGHT;
    if (
      viewX < MARGIN.left ||
      viewX > WIDTH - MARGIN.right ||
      viewY < MARGIN.top ||
      viewY > HEIGHT - MARGIN.bottom
    ) return;
    const existingLabel = labels.find(({ point }) =>
      Math.hypot(viewX - x(point.distanceMeters), viewY - y(point.elevationMeters)) <= 10
    );
    if (existingLabel) {
      setLabels((current) => current.filter((label) => label.id !== existingLabel.id));
      return;
    }
    const displayDistanceAxisUnits = Math.max(
      0,
      Math.min(distanceGrid.maximum, (viewX - MARGIN.left) / plotWidth * distanceGrid.maximum),
    );
    const displayDistance = Math.min(
      totalDistanceAxisUnits,
      displayDistanceAxisUnits,
    ) * distanceMetersPerUnit;
    const distance = reversed ? totalDistance - displayDistance : displayDistance;
    const nearest = samples.reduce((best, sample) =>
      Math.abs(sample.distanceMeters - distance) < Math.abs(best.distanceMeters - distance)
        ? sample
        : best
    );
    setLabels((current) => [...current, { id: nextLabelId++, point: nearest }]);
  };

  const exportCsv = () => {
    if (!profile) return;
    const metersPerElevationUnit = measurementSystem === "metric" ? 1 : METERS_PER_FOOT;
    const csv = buildElevationProfileCsv(
      profile,
      distanceAxisUnit,
      elevationUnit(measurementSystem),
      distanceMetersPerUnit,
      metersPerElevationUnit,
      reversed,
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      "elevation-profile";
    link.href = url;
    link.download = `${fileName}-elevation-profile.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div
      className="elevation-profile-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="elevation-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} elevation profile`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="elevation-profile-header">
          <div>
            <h2>Elevation profile</h2>
            <p>{name}{profile ? ` · ${formatLength(totalDistance, measurementSystem)}` : ""}</p>
          </div>
          <div className="elevation-profile-actions">
            {profile && (
              <button
                type="button"
                aria-pressed={reversed}
                onClick={() => setReversed((current) => !current)}
              >Reverse graph</button>
            )}
            {profile && (
              <button type="button" onClick={exportCsv}>Export CSV</button>
            )}
            <button type="button" aria-label="Close elevation profile" onClick={onClose}>×</button>
          </div>
        </header>
        {loading && <p className="elevation-profile-status" role="status">Sampling terrain elevations…</p>}
        {error && <p className="elevation-profile-status is-error" role="alert">{error}</p>}
        {profile && samples.length > 0 && (
          <>
            <svg
              className="elevation-profile-chart"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label="Elevation across route distance. Click the graph to add or remove a sample label."
              onClick={addElevationLabel}
            >
              {elevationTicks.map((tick, index) => {
                const tickY = MARGIN.top + (elevationGrid.maximum - tick) /
                  (elevationGrid.maximum - elevationGrid.minimum) * plotHeight;
                return (
                  <g key={`elevation-${index}`}>
                    <line x1={MARGIN.left} y1={tickY} x2={WIDTH - MARGIN.right} y2={tickY}
                      className="elevation-profile-grid" />
                    <text x={MARGIN.left - 10} y={tickY + 4} textAnchor="end"
                      className="elevation-profile-tick">
                      {formatAxisTick(tick, elevationGrid.step)}
                    </text>
                  </g>
                );
              })}
              {distanceTicks.map((tick, index) => {
                const tickX = MARGIN.left + plotWidth * tick / distanceGrid.maximum;
                return (
                  <g key={`distance-${index}`}>
                    <line x1={tickX} y1={MARGIN.top} x2={tickX} y2={HEIGHT - MARGIN.bottom}
                      className="elevation-profile-grid" />
                    <text x={tickX} y={HEIGHT - MARGIN.bottom + 24} textAnchor="middle"
                      className="elevation-profile-tick">
                      {formatAxisTick(tick, distanceGrid.step)}
                    </text>
                  </g>
                );
              })}
              {paths.map((path, index) => (
                <path key={`profile-${index}`} d={path} className="elevation-profile-line" />
              ))}
              {labels.map(({ id, point }) => {
                const labelX = x(point.distanceMeters);
                const labelY = y(point.elevationMeters);
                const anchor = labelX > WIDTH - 190 ? "end" : "start";
                const textX = anchor === "end" ? labelX - 8 : labelX + 8;
                const displayDistance = reversed
                  ? totalDistance - point.distanceMeters
                  : point.distanceMeters;
                return (
                  <g key={id} className="elevation-profile-label"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLabels((current) => current.filter((label) => label.id !== id));
                    }}>
                    <circle cx={labelX} cy={labelY} r="5" />
                    <text x={textX} y={labelY - 10} textAnchor={anchor}>
                      {formatAxisTick(displayDistance / distanceMetersPerUnit, distanceGrid.step)} {distanceAxisUnit}
                    </text>
                    <text x={textX} y={labelY + 17} textAnchor={anchor}>
                      {formatElevation(point.elevationMeters, measurementSystem)}
                    </text>
                  </g>
                );
              })}
              <text x={MARGIN.left + plotWidth / 2} y={HEIGHT - 18} textAnchor="middle"
                className="elevation-profile-axis-label">Distance ({distanceAxisUnit})</text>
              <text transform={`translate(22 ${MARGIN.top + plotHeight / 2}) rotate(-90)`}
                textAnchor="middle" className="elevation-profile-axis-label">
                Elevation ({elevationUnit(measurementSystem)})
              </text>
            </svg>
            <p className="elevation-profile-hint">Click the graph to mark a sampled distance and elevation.</p>
          </>
        )}
      </section>
    </div>
  );
}
