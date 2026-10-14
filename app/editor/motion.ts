// Keyframe interpolation and speed-curve math shared by preview, model and export. Pure.

export type SpeedPoint = { x: number; y: number }; // x: 0..1 of the clip's output length, y: speed multiplier

export const easings: Record<KeyframeEasing, (p: number) => number> = {
  linear: (p) => p,
  "ease-in": (p) => p * p,
  "ease-out": (p) => 1 - (1 - p) * (1 - p),
  "ease-in-out": (p) => (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p)),
  hold: () => 0,
};

/** Value of a keyframed property at clip-local time `t` (matches the exporter's expressions). */
export function evaluateKeyframes(points: KeyframePoint[] | undefined, t: number, fallback: number) {
  if (!points?.length) return fallback;
  const sorted = points.length > 1 && points.some((point, index) => index && point.time < points[index - 1].time) ? [...points].sort((a, b) => a.time - b.time) : points;
  if (t <= sorted[0].time) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (t >= last.time) return last.value;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    if (t < to.time) {
      const span = to.time - from.time;
      const p = span > 0 ? (t - from.time) / span : 1;
      return from.value + (to.value - from.value) * easings[from.easing](p);
    }
  }
  return last.value;
}

const sameTime = (a: number, b: number) => Math.abs(a - b) < 1 / 120;

export function keyframeAt(points: KeyframePoint[] | undefined, t: number) {
  return points?.find((point) => sameTime(point.time, t));
}

/** Adds or updates the keyframe at `t`, keeping points sorted. */
export function setKeyframe(points: KeyframePoint[] | undefined, t: number, value: number, easing?: KeyframeEasing): KeyframePoint[] {
  const existing = keyframeAt(points, t);
  if (existing) return (points ?? []).map((point) => point === existing ? { ...point, value, easing: easing ?? point.easing } : point);
  return [...(points ?? []), { time: t, value, easing: easing ?? "linear" }].sort((a, b) => a.time - b.time);
}

export function removeKeyframe(points: KeyframePoint[] | undefined, t: number) {
  const next = (points ?? []).filter((point) => !sameTime(point.time, t));
  return next.length ? next : undefined;
}

export function shiftKeyframes(points: KeyframePoint[] | undefined, delta: number) {
  return points?.map((point) => ({ ...point, time: point.time + delta }));
}

/* ------------------------------------------------------------ speed curves */

export const speedCurvePresets: Array<{ id: string; label: string; points: SpeedPoint[] }> = [
  { id: "ramp-up", label: "渐快", points: [{ x: 0, y: 0.5 }, { x: 1, y: 2.5 }] },
  { id: "ramp-down", label: "渐慢", points: [{ x: 0, y: 2.5 }, { x: 1, y: 0.5 }] },
  { id: "montage", label: "蒙太奇", points: [{ x: 0, y: 2 }, { x: 0.35, y: 2 }, { x: 0.45, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.7, y: 2 }, { x: 1, y: 2 }] },
  { id: "hero", label: "英雄时刻", points: [{ x: 0, y: 1 }, { x: 0.4, y: 1 }, { x: 0.5, y: 0.25 }, { x: 0.6, y: 1 }, { x: 1, y: 1 }] },
  { id: "bullet", label: "子弹时间", points: [{ x: 0, y: 3 }, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 1, y: 3 }] },
  { id: "flash", label: "闪进闪出", points: [{ x: 0, y: 4 }, { x: 0.2, y: 1 }, { x: 0.8, y: 1 }, { x: 1, y: 4 }] },
];

/** Speed multiplier at fraction x of the output, piecewise linear between points. */
export function curveAt(points: SpeedPoint[], x: number) {
  if (x <= points[0].x) return points[0].y;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (x <= to.x) return to.x === from.x ? to.y : from.y + ((to.y - from.y) * (x - from.x)) / (to.x - from.x);
  }
  return points[points.length - 1].y;
}

/** ∫₀^x curve(u) du (exact for piecewise-linear curves). */
export function curveIntegral(points: SpeedPoint[], x: number) {
  let total = 0;
  let previousX = 0;
  let previousY = curveAt(points, 0);
  for (const point of [...points.filter((item) => item.x > 0 && item.x < x), { x, y: curveAt(points, x) }]) {
    total += ((previousY + point.y) / 2) * (point.x - previousX);
    previousX = point.x;
    previousY = point.y;
  }
  return total;
}

export function meanSpeed(points: SpeedPoint[]) {
  return curveIntegral(points, 1);
}

/** Fraction of output elapsed when the given fraction of the source has played (inverse of the integral). */
export function outputFractionForSource(points: SpeedPoint[], sourceFraction: number) {
  const target = sourceFraction * meanSpeed(points);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (curveIntegral(points, middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Curve restricted to output fractions [from, to], renormalised to 0..1. */
export function sliceCurve(points: SpeedPoint[], from: number, to: number): SpeedPoint[] {
  const inside = points.filter((point) => point.x > from && point.x < to);
  return [{ x: from, y: curveAt(points, from) }, ...inside, { x: to, y: curveAt(points, to) }].map((point) => ({ x: (point.x - from) / (to - from), y: point.y }));
}
