// Pre-publish health check rules. Pure: measurement and analysis results are passed in.
import { captionLines } from "./captions.ts";
import type { SubtitleMode, SubtitleStyle } from "./captions.ts";
import type { Subtitle } from "./model.ts";

export type HealthIssue = {
  id: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  time?: number;
  fix?: "loudness" | "relink" | "caption";
  captionId?: number;
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Captions that will not fit, read too fast, flash by or overlap. `measure` returns width in px at a font size. */
export function captionIssues(subtitles: Subtitle[], style: SubtitleStyle, mode: SubtitleMode, canvas: { width: number; height: number }, measure: (text: string, fontPx: number) => number): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const scale = canvas.height / 1080;
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  sorted.forEach((item, index) => {
    const at = { time: item.start, captionId: item.id, fix: "caption" as const };
    const length = item.end - item.start;
    for (const [lineIndex, line] of captionLines(item, mode, style).entries()) {
      const fontPx = style.fontSize * scale * (lineIndex === 0 || mode !== "both" ? 1 : style.enScale / 100);
      const width = measure(line.text, fontPx);
      if (width > canvas.width * 0.9) issues.push({ id: `wide-${item.id}-${line.lang}`, severity: "warning", title: `字幕过长 ${clock(item.start)}`, detail: `「${line.text.slice(0, 24)}…」超出画面宽度，会被折成多行`, ...at });
    }
    const zhRate = item.zh.replace(/\s/g, "").length / Math.max(0.1, length);
    const enRate = item.en.length / Math.max(0.1, length);
    if ((mode !== "en" && zhRate > 12) || (mode !== "zh" && enRate > 22)) {
      issues.push({ id: `fast-${item.id}`, severity: "warning", title: `字幕读不完 ${clock(item.start)}`, detail: `只显示 ${length.toFixed(1)} 秒，${mode !== "en" && zhRate > 12 ? `中文每秒 ${zhRate.toFixed(0)} 字（建议 ≤ 12）` : `英文每秒 ${enRate.toFixed(0)} 字符（建议 ≤ 22）`}`, ...at });
    } else if (length < 0.6) {
      issues.push({ id: `short-${item.id}`, severity: "info", title: `字幕一闪而过 ${clock(item.start)}`, detail: `仅显示 ${length.toFixed(2)} 秒`, ...at });
    }
    const next = sorted[index + 1];
    if (next && next.start < item.end - 0.05) issues.push({ id: `overlap-${item.id}`, severity: "warning", title: `字幕重叠 ${clock(next.start)}`, detail: "两条字幕同时出现，会互相遮挡", ...at });
    if (!item.zh.trim() && !item.en.trim()) issues.push({ id: `empty-${item.id}`, severity: "info", title: `空字幕 ${clock(item.start)}`, detail: "这条字幕没有文字", ...at });
  });
  return issues;
}

/** Loudness, black frames and long silences from the rendered analysis. */
export function analysisIssues(analysis: CompositionAnalysis, loudnessTarget: number | null): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const target = loudnessTarget ?? -14;
  if (analysis.integratedLufs === null) {
    issues.push({ id: "silent", severity: "warning", title: "成片没有声音", detail: "检测不到任何音频，确认是否静音了轨道或片段" });
  } else if (loudnessTarget === null && Math.abs(analysis.integratedLufs - target) > 2) {
    issues.push({ id: "loudness", severity: "warning", title: `响度 ${analysis.integratedLufs.toFixed(1)} LUFS`, detail: `平台推荐约 ${target} LUFS；${analysis.integratedLufs < target ? "成片偏小声，观众需要调大音量" : "成片偏大声，平台会压低音量"}。开启响度标准化可自动修正`, fix: "loudness" });
  } else if (loudnessTarget !== null) {
    issues.push({ id: "loudness-ok", severity: "info", title: `响度 ${analysis.integratedLufs.toFixed(1)} LUFS`, detail: `导出时会标准化到 ${loudnessTarget} LUFS` });
  }
  if (analysis.truePeak !== null && analysis.truePeak > -1 && loudnessTarget === null) {
    issues.push({ id: "peak", severity: "warning", title: `峰值 ${analysis.truePeak.toFixed(1)} dBTP`, detail: "接近削波，部分播放器可能出现破音；开启响度标准化会限制峰值", fix: "loudness" });
  }
  for (const black of analysis.blackFrames) {
    issues.push({ id: `black-${black.start}`, severity: black.end - black.start > 1.5 ? "error" : "warning", title: `黑屏 ${clock(black.start)}`, detail: `${(black.end - black.start).toFixed(1)} 秒画面全黑，检查时间轴是否有空隙`, time: black.start });
  }
  for (const silence of analysis.silences) {
    if (silence.end - silence.start >= 3) issues.push({ id: `silence-${silence.start}`, severity: "info", title: `长时间无声 ${clock(silence.start)}`, detail: `${(silence.end - silence.start).toFixed(1)} 秒没有声音`, time: silence.start });
  }
  return issues;
}

export const severityOrder = { error: 0, warning: 1, info: 2 } as const;
