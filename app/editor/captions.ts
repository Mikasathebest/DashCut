import type { Subtitle } from "./model";

export type SubtitleMode = "zh" | "en" | "both";

// Values are strings/numbers only so the style passes through the exporter's Record<string, string | number> contract.
export type SubtitleStyle = {
  fontFamily: string;
  fontSize: number;
  /** Primary (Chinese, or the only line) text color. */
  color: string;
  /** Secondary (English) line color in bilingual mode. */
  enColor: string;
  /** Secondary line size relative to fontSize, in percent. */
  enScale: number;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string;
  /** 0 disables the background box. */
  backgroundOpacity: number;
  position: "bottom" | "middle" | "top";
  /** Distance from the top/bottom edge, in percent of frame height. */
  offset: number;
  order: "zh-first" | "en-first";
};

export const defaultSubtitleStyle: SubtitleStyle = {
  fontFamily: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 34,
  color: "#ffffff",
  enColor: "#ffe45c",
  enScale: 62,
  outlineColor: "#000000",
  outlineWidth: 2,
  backgroundColor: "#000000",
  backgroundOpacity: 0,
  position: "bottom",
  offset: 8,
  order: "zh-first",
};

/** Fills fields missing from styles saved before they existed. */
export function normalizeSubtitleStyle(style: Partial<SubtitleStyle> | undefined): SubtitleStyle {
  return { ...defaultSubtitleStyle, ...style };
}

/** Lines to show for a caption in the given mode, primary line first. */
export function captionLines(subtitle: Pick<Subtitle, "zh" | "en">, mode: SubtitleMode, style: SubtitleStyle) {
  const zh = { text: subtitle.zh.trim(), lang: "zh" as const };
  const en = { text: subtitle.en.trim(), lang: "en" as const };
  const lines = mode === "zh" ? [zh] : mode === "en" ? [en] : style.order === "en-first" ? [en, zh] : [zh, en];
  return lines.filter((line) => line.text);
}

export const subtitlePresets: Array<{ name: string; style: Partial<SubtitleStyle> }> = [
  { name: "经典白字", style: { color: "#ffffff", enColor: "#ffffff", outlineColor: "#000000", outlineWidth: 2, backgroundOpacity: 0 } },
  { name: "黄色英文", style: { color: "#ffffff", enColor: "#ffe45c", outlineColor: "#000000", outlineWidth: 2, backgroundOpacity: 0 } },
  { name: "黑底字幕", style: { color: "#ffffff", enColor: "#d9dee8", outlineWidth: 0, backgroundColor: "#000000", backgroundOpacity: 60 } },
  { name: "综艺描边", style: { color: "#ffe14d", enColor: "#ffffff", outlineColor: "#1b1b1b", outlineWidth: 5, backgroundOpacity: 0 } },
];

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Shifts captions by `delta` seconds: every caption, or `fromId` and everything after it.
 * A backward shift is limited so the first moved caption cannot pass time 0 or the caption before it.
 */
export function shiftSubtitles<T extends Pick<Subtitle, "id" | "start" | "end">>(subtitles: T[], delta: number, fromId?: number | null): T[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  const from = fromId == null ? 0 : Math.max(0, sorted.findIndex((item) => item.id === fromId));
  if (!sorted.length || !Number.isFinite(delta)) return sorted;
  const floor = from > 0 ? sorted[from - 1].end : 0;
  const applied = Math.max(delta, floor - sorted[from].start);
  return sorted.map((item, index) => index < from ? item : { ...item, start: round(item.start + applied), end: round(item.end + applied) });
}

/**
 * Sets one caption's start or end. Changing the start moves the caption and all later ones by the same amount;
 * extending the end pushes later captions only as far as needed to avoid overlap.
 */
export function retimeSubtitle<T extends Pick<Subtitle, "id" | "start" | "end">>(subtitles: T[], id: number, field: "start" | "end", value: number): T[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  const index = sorted.findIndex((item) => item.id === id);
  const target = sorted[index];
  if (!target || !Number.isFinite(value)) return sorted;
  if (field === "start") return shiftSubtitles(sorted, value - target.start, id);
  const end = round(Math.max(target.start + 0.1, value));
  const next = sorted.slice(0, index + 1).map((item) => item.id === id ? { ...item, end } : item);
  const following = sorted.slice(index + 1);
  const overlap = following.length ? end - following[0].start : 0;
  return [...next, ...(overlap > 0 ? following.map((item) => ({ ...item, start: round(item.start + overlap), end: round(item.end + overlap) })) : following)];
}

/** Rank chat models for cloud captions: they must hear audio, so only Gemini models qualify. Higher tier beats newer version. */
export function audioModelScore(id: string, mode = "chat") {
  const name = id.toLowerCase();
  if (!["chat", "unknown", ""].includes(mode) || !name.includes("gemini") || /image|tts|embed|live|vision/.test(name)) return -1;
  const tier = /flash-lite|lite/.test(name) ? 1 : /pro/.test(name) ? 3 : /flash/.test(name) ? 2 : 0;
  const version = Number(name.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  return tier * 10 + Math.min(version, 9.9) - (/preview|exp/.test(name) ? 0.5 : 0);
}

export function bestAudioModel(models: Array<{ id: string; mode: string }>) {
  let best: { id: string; score: number } | null = null;
  for (const model of models) {
    const score = audioModelScore(model.id, model.mode);
    if (score >= 0 && (!best || score > best.score)) best = { id: model.id, score };
  }
  return best?.id ?? null;
}
