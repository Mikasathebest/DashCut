// Smart reframe: turns tracked subject positions into a cover-fit scale and horizontal keyframes. Pure.

export type SubjectSample = { time: number; center: number | null }; // clip-local seconds, subject centre 0..1 across the media width

export type ReframeOptions = {
  mediaAspect: number; // width / height of the (cropped) media
  canvasAspect: number; // width / height of the canvas
  tracking: number; // 0 = calm, slow pans … 1 = follows quickly
};

/** Scale that makes the media cover the canvas (contain-fit is the 1× baseline). */
export function coverScale(mediaAspect: number, canvasAspect: number) {
  return Math.max(mediaAspect / canvasAspect, canvasAspect / mediaAspect);
}

/** Ramer–Douglas–Peucker on (time, value) so a steady shot keeps only a few keyframes. */
function simplify(points: Array<{ time: number; value: number }>, epsilon: number): Array<{ time: number; value: number }> {
  if (points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  let worst = 0;
  let index = 0;
  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const point = points[cursor];
    const ratio = (point.time - first.time) / (last.time - first.time || 1);
    const distance = Math.abs(point.value - (first.value + (last.value - first.value) * ratio));
    if (distance > worst) {
      worst = distance;
      index = cursor;
    }
  }
  if (worst <= epsilon) return [first, last];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}

export function computeReframe(samples: SubjectSample[], options: ReframeOptions) {
  const scale = coverScale(options.mediaAspect, options.canvasAspect);
  // Width of the media box in canvas widths after covering, and how far it may slide.
  const boxWidth = Math.min(1, options.mediaAspect / options.canvasAspect) * scale;
  const limit = Math.max(0, (boxWidth - 1) / 2);
  const target = (center: number) => Math.max(-limit, Math.min(limit, -(center - 0.5) * boxWidth));
  const alpha = 0.12 + 0.6 * options.tracking;
  const maxSpeed = (0.15 + 0.85 * options.tracking) * boxWidth; // canvas widths per second
  const smoothed: Array<{ time: number; value: number }> = [];
  const firstSeen = samples.find((sample) => sample.center !== null)?.center ?? 0.5;
  let value = target(firstSeen);
  let previousTime = samples[0]?.time ?? 0;
  for (const sample of samples) {
    // Missing detections hold the last framing instead of snapping back to the centre.
    const wanted = sample.center === null ? value : target(sample.center);
    const eased = value + (wanted - value) * alpha;
    const step = maxSpeed * Math.max(0, sample.time - previousTime);
    value = Math.max(value - step, Math.min(value + step, eased));
    previousTime = sample.time;
    smoothed.push({ time: sample.time, value });
  }
  const keyframes: KeyframePoint[] = simplify(smoothed, 0.004).map((point) => ({ time: Number(point.time.toFixed(3)), value: Number(point.value.toFixed(4)), easing: "linear" }));
  return { scale: Number(scale.toFixed(4)), keyframes, detected: samples.filter((sample) => sample.center !== null).length };
}

/** Picks the subject to follow: the face nearest the previous one, else the largest. */
export function chooseSubject(faces: Array<{ center: number; size: number }>, previous: number | null) {
  if (!faces.length) return null;
  if (previous !== null) return faces.reduce((best, face) => Math.abs(face.center - previous) < Math.abs(best.center - previous) ? face : best).center;
  return faces.reduce((best, face) => face.size > best.size ? face : best).center;
}
