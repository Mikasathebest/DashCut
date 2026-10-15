// Pre-publish health check rules. Pure: measurement and analysis results are passed in.
import { captionLines } from "./captions.ts";
import type { SubtitleMode, SubtitleStyle } from "./captions.ts";
import type { Subtitle } from "./model.ts";
import { t } from "../i18n/index.ts";

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
      if (width > canvas.width * 0.9) issues.push({ id: `wide-${item.id}-${line.lang}`, severity: "warning", title: t("字幕过长 {time}", { time: clock(item.start) }), detail: t("「{text}…」超出画面宽度，会被折成多行", { text: line.text.slice(0, 24) }), ...at });
    }
    const zhRate = item.zh.replace(/\s/g, "").length / Math.max(0.1, length);
    const enRate = item.en.length / Math.max(0.1, length);
    if ((mode !== "en" && zhRate > 12) || (mode !== "zh" && enRate > 22)) {
      issues.push({ id: `fast-${item.id}`, severity: "warning", title: t("字幕读不完 {time}", { time: clock(item.start) }), detail: mode !== "en" && zhRate > 12 ? t("只显示 {seconds} 秒，中文每秒 {rate} 字（建议 ≤ 12）", { seconds: length.toFixed(1), rate: zhRate.toFixed(0) }) : t("只显示 {seconds} 秒，英文每秒 {rate} 字符（建议 ≤ 22）", { seconds: length.toFixed(1), rate: enRate.toFixed(0) }), ...at });
    } else if (length < 0.6) {
      issues.push({ id: `short-${item.id}`, severity: "info", title: t("字幕一闪而过 {time}", { time: clock(item.start) }), detail: t("仅显示 {seconds} 秒", { seconds: length.toFixed(2) }), ...at });
    }
    const next = sorted[index + 1];
    if (next && next.start < item.end - 0.05) issues.push({ id: `overlap-${item.id}`, severity: "warning", title: t("字幕重叠 {time}", { time: clock(next.start) }), detail: t("两条字幕同时出现，会互相遮挡"), ...at });
    if (!item.zh.trim() && !item.en.trim()) issues.push({ id: `empty-${item.id}`, severity: "info", title: t("空字幕 {time}", { time: clock(item.start) }), detail: t("这条字幕没有文字"), ...at });
  });
  return issues;
}

/** Loudness, black frames and long silences from the rendered analysis. */
export function analysisIssues(analysis: CompositionAnalysis, loudnessTarget: number | null): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const target = loudnessTarget ?? -14;
  if (analysis.integratedLufs === null) {
    issues.push({ id: "silent", severity: "warning", title: t("成片没有声音"), detail: t("检测不到任何音频，确认是否静音了轨道或片段") });
  } else if (loudnessTarget === null && Math.abs(analysis.integratedLufs - target) > 2) {
    issues.push({ id: "loudness", severity: "warning", title: t("响度 {value} LUFS", { value: analysis.integratedLufs.toFixed(1) }), detail: analysis.integratedLufs < target ? t("平台推荐约 {target} LUFS；成片偏小声，观众需要调大音量。开启响度标准化可自动修正", { target }) : t("平台推荐约 {target} LUFS；成片偏大声，平台会压低音量。开启响度标准化可自动修正", { target }), fix: "loudness" });
  } else if (loudnessTarget !== null) {
    issues.push({ id: "loudness-ok", severity: "info", title: t("响度 {value} LUFS", { value: analysis.integratedLufs.toFixed(1) }), detail: t("导出时会标准化到 {target} LUFS", { target: loudnessTarget }) });
  }
  if (analysis.truePeak !== null && analysis.truePeak > -1 && loudnessTarget === null) {
    issues.push({ id: "peak", severity: "warning", title: t("峰值 {value} dBTP", { value: analysis.truePeak.toFixed(1) }), detail: t("接近削波，部分播放器可能出现破音；开启响度标准化会限制峰值"), fix: "loudness" });
  }
  for (const black of analysis.blackFrames) {
    issues.push({ id: `black-${black.start}`, severity: black.end - black.start > 1.5 ? "error" : "warning", title: t("黑屏 {time}", { time: clock(black.start) }), detail: t("{seconds} 秒画面全黑，检查时间轴是否有空隙", { seconds: (black.end - black.start).toFixed(1) }), time: black.start });
  }
  for (const silence of analysis.silences) {
    if (silence.end - silence.start >= 3) issues.push({ id: `silence-${silence.start}`, severity: "info", title: t("长时间无声 {time}", { time: clock(silence.start) }), detail: t("{seconds} 秒没有声音", { seconds: (silence.end - silence.start).toFixed(1) }), time: silence.start });
  }
  return issues;
}

export const severityOrder = { error: 0, warning: 1, info: 2 } as const;
