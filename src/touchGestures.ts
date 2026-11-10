export type PinchGestureMode = "pan" | "zoom";

type Point = readonly [number, number];

export const PINCH_ZOOM_START_THRESHOLD = 32;

export function classifyPendingPinchGesture(
  firstDelta: Point,
  secondDelta: Point,
  centerTravel: number,
  distanceChange: number,
): PinchGestureMode | null {
  const firstTravel = Math.hypot(...firstDelta);
  const secondTravel = Math.hypot(...secondDelta);
  let mode: PinchGestureMode | null = null;

  if (firstTravel > 4 && secondTravel > 4) {
    const movementAgreement =
      firstDelta[0] * secondDelta[0] + firstDelta[1] * secondDelta[1];
    mode = movementAgreement === 0
      ? (centerTravel >= distanceChange ? "pan" : "zoom")
      : movementAgreement > 0 ? "pan" : "zoom";
  } else if (Math.max(firstTravel, secondTravel) > 12) {
    mode = centerTravel >= distanceChange ? "pan" : "zoom";
  }

  if (mode === "zoom" && distanceChange < PINCH_ZOOM_START_THRESHOLD) {
    return null;
  }
  return mode;
}
