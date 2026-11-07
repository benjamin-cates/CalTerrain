export type NiceAxisGrid = {
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
