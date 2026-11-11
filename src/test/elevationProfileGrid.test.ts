import { describe, expect, it } from "bun:test";
import { createNiceAxisGrid } from "../ElevationProfilePopup";

describe("elevation profile grid", () => {
  it("uses aligned nice-number ticks and stays within the requested line limit", () => {
    const minimum = -120.2;
    const maximum = 850.7;
    const grid = createNiceAxisGrid(minimum, maximum, 10);

    expect(grid.ticks.length).toBeLessThanOrEqual(10);
    expect(grid.minimum).toBeLessThanOrEqual(minimum);
    expect(grid.maximum).toBeGreaterThanOrEqual(maximum);
    for (const tick of grid.ticks) {
      expect(tick / grid.step).toBeCloseTo(Math.round(tick / grid.step), 8);
    }
  });

  it("creates a centered grid when every elevation sample is the same", () => {
    const grid = createNiceAxisGrid(4_000, 4_000, 10);

    expect(grid.ticks.length).toBeLessThanOrEqual(10);
    expect(grid.minimum).toBeLessThan(4_000);
    expect(grid.maximum).toBeGreaterThan(4_000);
    expect(grid.ticks.every((tick) => tick % grid.step === 0)).toBe(true);
  });
});
