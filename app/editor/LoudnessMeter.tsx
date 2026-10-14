"use client";

import { useEffect, useState } from "react";
import { readLoudness } from "./Preview";

/** Live momentary loudness while the preview plays, with the export target marked. */
export function LoudnessMeter({ active, target }: { active: boolean; target: number | null }) {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let smoothed: number | null = null;
    let last = 0;
    const tick = (now: number) => {
      const reading = readLoudness();
      if (reading !== null) smoothed = smoothed === null ? reading : smoothed * 0.85 + reading * 0.15;
      // Text updates a few times a second so the number stays readable.
      if (now - last > 150) {
        last = now;
        setValue(smoothed);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  const shown = active ? value : null;
  const fraction = shown === null ? 0 : Math.max(0, Math.min(1, (shown + 40) / 40));
  const goal = target ?? -14;
  const tone = shown === null ? "" : shown > goal + 3 ? " loud" : shown < goal - 6 ? " quiet" : " good";
  return <div className={`loudness-meter${tone}`} title={`瞬时响度（预览近似值）；目标 ${goal} LUFS`}>
    <i style={{ width: `${fraction * 100}%` }} />
    <em style={{ left: `${((goal + 40) / 40) * 100}%` }} />
    <span>{shown === null || shown <= -60 ? "— LUFS" : `${shown.toFixed(1)} LUFS`}</span>
  </div>;
}
