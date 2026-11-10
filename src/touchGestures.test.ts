import { describe, expect, test } from "bun:test";
import {
  classifyPendingPinchGesture,
  PINCH_ZOOM_START_THRESHOLD,
} from "./touchGestures";

describe("pending pinch gesture classification", () => {
  test("waits for a large separation change before starting zoom", () => {
    expect(classifyPendingPinchGesture([10, 0], [-10, 0], 0, 20)).toBeNull();
    expect(classifyPendingPinchGesture(
      [PINCH_ZOOM_START_THRESHOLD / 2, 0],
      [-PINCH_ZOOM_START_THRESHOLD / 2, 0],
      0,
      PINCH_ZOOM_START_THRESHOLD,
    )).toBe("zoom");
  });

  test("still starts panning immediately when both fingers move together", () => {
    expect(classifyPendingPinchGesture([8, 1], [9, 1], 9, 1)).toBe("pan");
  });

  test("waits for the zoom threshold when one finger moves", () => {
    expect(classifyPendingPinchGesture([20, 0], [0, 0], 10, 20)).toBeNull();
  });
});
