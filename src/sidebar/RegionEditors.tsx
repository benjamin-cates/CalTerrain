import { useEffect, useState } from "react";
import type { Position, Region, ViewSettings } from "../types";
import {
  distanceFromDisplay,
  distanceToDisplay,
  distanceUnit,
  elevationToDisplay,
  elevationUnit,
} from "../units";

function NumberField({ label, axis, unit, value, min, max, onChange }: {
  label: string;
  axis?: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(Number(value.toFixed(5))));
  useEffect(() => setText(String(Number(value.toFixed(5)))), [value]);
  return (
    <label className="region-number">
      {axis && <span>{axis}</span>}
      <input aria-label={label} type="number" value={text} min={min} max={max} step="any"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        onBlur={() => {
          const number = Number(text);
          if (text.trim() !== "" && Number.isFinite(number) && number >= min && number <= max) {
            onChange(number);
            setText(String(Number(number.toFixed(5))));
          } else {
            setText(String(Number(value.toFixed(5))));
          }
        }} />
      {unit && <span>{unit}</span>}
    </label>
  );
}

function PositionFields({ label, position, onChange, onRemove, removeDisabled }: {
  label: string;
  position: Position;
  onChange: (value: Position) => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  return (
    <div className={`region-field-row${onRemove ? " point-row" : ""}`}>
      <span className="region-field-label">{label}:</span>
      <NumberField label={`${label} x`} value={position[0]} min={-180} max={180}
        onChange={(value) => onChange([value, position[1]])} />
      <NumberField label={`${label} y`} value={position[1]} min={-85.051128} max={85.051128}
        onChange={(value) => onChange([position[0], value])} />
      {onRemove && <button className="point-remove" type="button" aria-label={`Remove ${label}`}
        disabled={removeDisabled} onClick={onRemove}>×</button>}
    </div>
  );
}

function SizeFields({ width, height, measurementSystem, onChange }: {
  width: number;
  height: number;
  onChange: (width: number, height: number) => void;
  measurementSystem: ViewSettings["measurementSystem"];
}) {
  const unit = distanceUnit(measurementSystem);
  return (
    <div className="region-field-row">
      <span className="region-field-label">Size:</span>
      <NumberField label="Width" unit={unit} value={distanceToDisplay(width, measurementSystem)}
        min={distanceToDisplay(0.1, measurementSystem)} max={distanceToDisplay(10000, measurementSystem)}
        onChange={(value) => onChange(distanceFromDisplay(value, measurementSystem), height)} />
      <NumberField label="Height" unit={unit} value={distanceToDisplay(height, measurementSystem)}
        min={distanceToDisplay(0.1, measurementSystem)} max={distanceToDisplay(10000, measurementSystem)}
        onChange={(value) => onChange(width, distanceFromDisplay(value, measurementSystem))} />
    </div>
  );
}

export function RegionEditor({ region, onUpdate, measurementSystem }: {
  region: Exclude<Region, { type: "county" }>;
  onUpdate: (region: Region) => void;
  measurementSystem: ViewSettings["measurementSystem"];
}) {
  return (
    <div className="region-editor">
      {(region.type === "ellipse" || region.type === "rectangle") && (
        <>
          <PositionFields label="Position" position={region.center}
            onChange={(center) => onUpdate({ ...region, center })} />
          <SizeFields width={region.width} height={region.height} measurementSystem={measurementSystem}
            onChange={(width, height) => onUpdate({ ...region, width, height })} />
          <div className="region-field-row rotation-field-row">
            <span className="region-field-label">Rotation:</span>
            <NumberField label="Rotation" unit="°" value={region.rotation ?? 0} min={-360} max={360}
              onChange={(rotation) => onUpdate({ ...region, rotation })} />
          </div>
        </>
      )}
      {region.type === "point" && (
        <>
          <div className="region-field-row">
            <span className="region-field-label">Position:</span>
            <NumberField label="Point longitude" value={region.position[0]}
              min={-180} max={180}
              onChange={(longitude) => onUpdate({
                ...region,
                position: [longitude, region.position[1]],
                elevationMeters: undefined,
              })} />
            <NumberField label="Point latitude" value={region.position[1]}
              min={-85.051128} max={85.051128}
              onChange={(latitude) => onUpdate({
                ...region,
                position: [region.position[0], latitude],
                elevationMeters: undefined,
              })} />
          </div>
          <div className="region-field-row rotation-field-row">
            <span className="region-field-label">Elevation:</span>
            <div className="region-number">
              <input type="text" aria-label="Point elevation" readOnly
                value={region.elevationMeters === undefined
                  ? "Loading terrain…"
                  : Math.round(elevationToDisplay(
                    region.elevationMeters,
                    measurementSystem,
                  )).toLocaleString("en-US")} />
              {region.elevationMeters !== undefined && (
                <span>{elevationUnit(measurementSystem)}</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function ShapePointsEditor({ region, onUpdate }: {
  region: Extract<Region, { type: "polygon" | "polyline" }>;
  onUpdate: (region: Region) => void;
}) {
  const minimumPointCount = region.type === "polygon" ? 3 : 2;
  return (
    <div className="shape-point-list">
      {region.points.map((position, index) => (
        <PositionFields key={index} label={`Point ${index + 1}`} position={position}
          removeDisabled={region.points.length <= minimumPointCount}
          onChange={(next) => {
            onUpdate({ ...region, points: region.points.map((item, i) => i === index ? next : item) });
          }}
          onRemove={() => {
            if (region.points.length > minimumPointCount) {
              onUpdate({ ...region, points: region.points.filter((_, i) => i !== index) });
            }
          }} />
      ))}
    </div>
  );
}
