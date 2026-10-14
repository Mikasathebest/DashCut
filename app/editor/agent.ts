// Agent-facing view of the project and its typed edit language. Pure; times exposed to the model are milliseconds.
import {
  addTrack, clipDuration, clipEnd, createClip, cutSourceRanges, defaultClipSettings, deleteClips, hasRoom, mainTrack, packMainTrack,
  placeClip, projectDuration, pruneTracks, splitClip, trackClips, updateClip, uid,
} from "./model.ts";
import type { Asset, Clip, EditOptions, Project, Subtitle } from "./model.ts";
import { analyzeCleanCut, defaultCleanCutSettings, normalizeToken, timelineTranscript } from "./transcript.ts";
import type { CleanCutSettings } from "./transcript.ts";

export type AgentContext = {
  project: Project;
  assets: Asset[];
  revision: number;
  title: string;
  ratio: "16:9" | "9:16";
  captionStyle: Record<string, unknown>;
  captionMode: "zh" | "en" | "both";
  options: EditOptions;
};

const ms = (seconds: number) => Math.round(seconds * 1000);
const sec = (milliseconds: number) => milliseconds / 1000;
const visualEffects: VisualEffect[] = ["bw", "vintage", "vignette", "sharpen", "denoise", "beauty", "blur", "chroma-key"];
const animations: AnimationType[] = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "zoom-out"];

/* ------------------------------------------------------------ aliases */

export type Aliases = {
  asset: Map<string, string>; clip: Map<string, string>; track: Map<string, string>;
  assetId: Map<string, string>; clipId: Map<string, string>; trackId: Map<string, string>;
};

/** Short, deterministic names (A1, T1, C1) so the model never sees or invents internal ids. */
export function buildAliases(project: Project, assets: Asset[]): Aliases {
  const aliases: Aliases = { asset: new Map(), clip: new Map(), track: new Map(), assetId: new Map(), clipId: new Map(), trackId: new Map() };
  assets.forEach((asset, index) => { aliases.asset.set(asset.id, `A${index + 1}`); aliases.assetId.set(`A${index + 1}`, asset.id); });
  project.tracks.forEach((track, index) => { aliases.track.set(track.id, `T${index + 1}`); aliases.trackId.set(`T${index + 1}`, track.id); });
  let clipNumber = 0;
  for (const track of project.tracks) {
    for (const clip of trackClips(project, track.id)) {
      clipNumber += 1;
      aliases.clip.set(clip.id, `C${clipNumber}`);
      aliases.clipId.set(`C${clipNumber}`, clip.id);
    }
  }
  return aliases;
}

/* ------------------------------------------------------------ timeline view */

function clipLine(clip: Clip, aliases: Aliases) {
  const defaults = defaultClipSettings();
  const parts = [`${aliases.clip.get(clip.id)} ${aliases.asset.get(clip.assetId)} start=${ms(clip.start)} end=${ms(clipEnd(clip))}`];
  if (clip.text) parts.push(`text=${JSON.stringify(clip.text.content)}`);
  if (clip.transitionOut) parts.push(`transition=${clip.transitionOut.type}:${ms(clip.transitionOut.duration)}`);
  if (clip.speedCurve) parts.push("speedCurve");
  if (clip.keyframes && Object.keys(clip.keyframes).length) parts.push(`keyframes=${Object.keys(clip.keyframes).join(",")}`);
  if (clip.freezeAt !== null) parts.push(`freeze=${ms(clip.freezeAt)}`);
  else parts.push(`src=${ms(clip.in)}-${ms(clip.out)}`);
  if (clip.speed !== 1) parts.push(`speed=${clip.speed}`);
  if (clip.reverse) parts.push("reverse");
  const transform = (Object.keys(defaults.transform) as Array<keyof Clip["transform"]>).filter((key) => clip.transform[key] !== defaults.transform[key]).map((key) => `${key}:${Number(clip.transform[key].toFixed(3))}`);
  if (transform.length) parts.push(`transform=${transform.join(",")}`);
  if (clip.mirror) parts.push("mirror");
  if (clip.rotate90) parts.push(`rotate90=${clip.rotate90}`);
  if (clip.crop.w !== 1 || clip.crop.h !== 1) parts.push(`crop=${[clip.crop.x, clip.crop.y, clip.crop.w, clip.crop.h].map((value) => value.toFixed(2)).join(",")}`);
  const adjust = (Object.keys(defaults.adjust) as Array<keyof Clip["adjust"]>).filter((key) => clip.adjust[key] !== defaults.adjust[key]).map((key) => `${key}:${clip.adjust[key].toFixed(2)}`);
  if (adjust.length) parts.push(`adjust=${adjust.join(",")}`);
  if (clip.effects.length) parts.push(`effects=${clip.effects.join(",")}`);
  if (clip.animationIn.type !== "none" || clip.animationOut.type !== "none") parts.push(`anim=${clip.animationIn.type}/${clip.animationOut.type}`);
  const audio = [clip.audio.volume !== 1 && `volume:${clip.audio.volume.toFixed(2)}`, clip.audio.fadeIn && `fadeIn:${ms(clip.audio.fadeIn)}`, clip.audio.fadeOut && `fadeOut:${ms(clip.audio.fadeOut)}`, clip.audio.muted && "muted"].filter(Boolean);
  if (audio.length) parts.push(`audio=${audio.join(",")}`);
  return parts.join(" ");
}

/** Compact, stable text the model reads instead of the raw project JSON (no thumbnails, peaks or ids). */
export function serializeTimeline(context: AgentContext, captionLimit = 60) {
  const { project, assets } = context;
  const aliases = buildAliases(project, assets);
  const lines = [
    `# DashCut timeline revision=${context.revision}`,
    `title: ${context.title}`,
    `canvas: ${context.ratio} duration=${ms(projectDuration(project))}ms (all times in ms)`,
    "assets:",
    ...assets.map((asset) => `  ${aliases.asset.get(asset.id)} ${asset.kind} "${asset.name}" duration=${ms(asset.duration)}${asset.width ? ` size=${asset.width}x${asset.height}` : ""} audio=${asset.hasAudio ? "yes" : "no"}${project.transcripts?.[asset.id] ? ` transcript=${project.transcripts[asset.id].language || "?"}` : ""}${project.clips.some((clip) => clip.assetId === asset.id) ? "" : " unused"}`),
    "tracks (top to bottom; upper video tracks draw over lower ones):",
  ];
  for (const track of project.tracks) {
    const flags = [track.main && "main", track.kind === "video" && !track.main && "overlay", track.muted && "muted", track.hidden && "hidden", track.locked && "locked"].filter(Boolean).join(" ");
    lines.push(`  ${aliases.track.get(track.id)} ${track.kind} ${flags}`.trimEnd());
    for (const clip of trackClips(project, track.id)) lines.push(`    ${clipLine(clip, aliases)}`);
  }
  lines.push(`captions: ${project.subtitles.length} lines, view=${context.captionMode}`);
  project.subtitles.slice(0, captionLimit).forEach((item, index) => lines.push(`  #${index + 1} ${ms(item.start)}-${ms(item.end)}${item.zh ? ` zh=${JSON.stringify(item.zh)}` : ""}${item.en ? ` en=${JSON.stringify(item.en)}` : ""}`));
  if (project.subtitles.length > captionLimit) lines.push(`  … ${project.subtitles.length - captionLimit} more (use get_captions)`);
  lines.push(`markers: ${project.markers.map((marker) => ms(marker.time)).sort((a, b) => a - b).join(", ") || "none"}`);
  return lines.join("\n");
}

export function getCaptions(context: AgentContext, from = 1, to = context.project.subtitles.length) {
  return context.project.subtitles.slice(Math.max(0, from - 1), to).map((item, index) => ({ index: from + index, start: ms(item.start), end: ms(item.end), zh: item.zh, en: item.en }));
}

/** Transcript sentences on the timeline, optionally limited to a time window (ms). */
export function getTranscript(context: AgentContext, range: { start?: number; end?: number } = {}) {
  const aliases = buildAliases(context.project, context.assets);
  const start = range.start === undefined ? -Infinity : sec(range.start);
  const end = range.end === undefined ? Infinity : sec(range.end);
  const sentences: Array<{ clip: string; start: number; end: number; sourceStart: number; sourceEnd: number; text: string }> = [];
  for (const block of timelineTranscript(context.project)) {
    for (const word of block.words) {
      if (word.end <= start || word.start >= end) continue;
      const last = sentences.at(-1);
      const same = last && last.clip === aliases.clip.get(word.clipId) && (last as { sentence?: number }).sentence === word.sentence;
      if (same) {
        last.end = ms(word.end);
        last.sourceEnd = ms(word.sourceEnd);
        last.text += word.text;
      } else {
        sentences.push(Object.assign({ clip: aliases.clip.get(word.clipId)!, start: ms(word.start), end: ms(word.end), sourceStart: ms(word.sourceStart), sourceEnd: ms(word.sourceEnd), text: word.text }, { sentence: word.sentence }));
      }
    }
  }
  return sentences.map(({ clip, start: s, end: e, sourceStart, sourceEnd, text }) => ({ clip, start: s, end: e, sourceStart, sourceEnd, text: text.trim() }));
}

/** Transcript sentences containing all query terms (case- and punctuation-insensitive). */
export function findSegments(context: AgentContext, query: string) {
  const terms = query.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (!terms.length) return [];
  return getTranscript(context).filter((sentence) => {
    const text = normalizeToken(sentence.text);
    return terms.every((term) => text.includes(term));
  });
}

export function cleanCutCandidates(context: AgentContext, clips?: string[], settings: CleanCutSettings = defaultCleanCutSettings) {
  const aliases = buildAliases(context.project, context.assets);
  const ids = clips?.map((alias) => aliases.clipId.get(alias)).filter((id): id is string => Boolean(id));
  return analyzeCleanCut(context.project, settings, ids?.length ? ids : undefined).map((item) => ({
    clip: aliases.clip.get(item.clipId)!, kind: item.kind, label: item.label, recommended: item.accepted,
    start: ms(item.start), end: ms(item.end), sourceStart: ms(item.sourceStart), sourceEnd: ms(item.sourceEnd),
  }));
}

/* ------------------------------------------------------------ edit operations */

export type AgentOp = { op: string } & Record<string, unknown>;
export type AgentIssue = { index: number; op: string; message: string };
export type AgentResult =
  | { ok: true; project: Project; ratio: "16:9" | "9:16"; captionStyle: Record<string, unknown> | null; captionMode: "zh" | "en" | "both"; changes: string[] }
  | { ok: false; issues: AgentIssue[]; revision: number };

export const agentOpNames = [
  "split", "trim", "delete", "cutRange", "cutSource", "move", "insert", "assembleMain", "speed", "reverse", "transform", "fit",
  "volume", "effect", "adjust", "animation", "addCaption", "editCaption", "deleteCaptions", "captionStyle", "captionView", "canvas", "marker",
] as const;

/** JSON Schema for one operation; providers that dislike oneOf get a flat object validated at apply time. */
export const agentOpSchema = {
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: { type: "string", enum: agentOpNames as unknown as string[] },
    clip: { type: "string", description: "Clip alias such as C3" },
    clips: { type: "array", items: { type: "string" } },
    asset: { type: "string", description: "Asset alias such as A1" },
    track: { type: "string", description: "Track alias (T2), or main | new-overlay | audio" },
    at: { type: "number", description: "Timeline time in ms" },
    start: { type: "number", description: "ms; timeline time except for cutSource (source time)" },
    end: { type: "number", description: "ms; timeline time except for cutSource (source time)" },
    in: { type: "number", description: "Source in-point in ms" },
    out: { type: "number", description: "Source out-point in ms" },
    segments: { type: "array", items: { type: "object", properties: { asset: { type: "string" }, in: { type: "number" }, out: { type: "number" } }, required: ["asset", "in", "out"] } },
    speed: { type: "number" },
    enabled: { type: "boolean" },
    x: { type: "number" }, y: { type: "number" }, scale: { type: "number" }, rotation: { type: "number" }, opacity: { type: "number" },
    mode: { type: "string", description: "fit: contain | cover; captionView: zh | en | both" },
    volume: { type: "number" }, fadeIn: { type: "number" }, fadeOut: { type: "number" }, muted: { type: "boolean" },
    effect: { type: "string", enum: visualEffects as unknown as string[] },
    brightness: { type: "number" }, contrast: { type: "number" }, saturation: { type: "number" }, temperature: { type: "number" },
    animationIn: { type: "string", enum: animations as unknown as string[] }, animationOut: { type: "string", enum: animations as unknown as string[] }, duration: { type: "number" },
    caption: { type: "number", description: "Caption number (#n)" },
    captions: { type: "array", items: { type: "number" } },
    zh: { type: "string" }, en: { type: "string" },
    style: { type: "object", description: "Caption style fields to change" },
    ratio: { type: "string", enum: ["16:9", "9:16"] },
  },
} as const;

class OpError extends Error {}

function num(op: AgentOp, key: string, min: number, max: number, required = true): number | undefined {
  const value = op[key];
  if (value === undefined) {
    if (required) throw new OpError(`缺少 ${key}`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw new OpError(`${key} 必须是数字`);
  if (value < min || value > max) throw new OpError(`${key}=${value} 超出范围 ${min}–${max}`);
  return value;
}

/**
 * Validates and applies a batch of operations to a staged copy. Either every op applies and the
 * caller commits the result as one undo step, or nothing changes and structured issues are returned.
 * Ops refer to aliases of the base revision; clips created by an op in the same batch cannot be targeted.
 */
export function applyAgentEdits(context: AgentContext, request: { baseRevision: number; ops: AgentOp[] }): AgentResult {
  if (request.baseRevision !== context.revision) {
    return { ok: false, revision: context.revision, issues: [{ index: -1, op: "", message: `时间轴已更新到 revision ${context.revision}（你基于 ${request.baseRevision}）。请重新调用 get_timeline 后再编辑。` }] };
  }
  if (!Array.isArray(request.ops) || !request.ops.length) return { ok: false, revision: context.revision, issues: [{ index: -1, op: "", message: "ops 不能为空" }] };
  const aliases = buildAliases(context.project, context.assets);
  const assetById = new Map(context.assets.map((asset) => [asset.id, asset]));
  const options = context.options;
  let project = context.project;
  let ratio = context.ratio;
  let captionMode = context.captionMode;
  let captionStyle: Record<string, unknown> | null = null;
  const changes: string[] = [];
  const issues: AgentIssue[] = [];
  const duration = () => projectDuration(project);

  const clipOf = (op: AgentOp, key = "clip") => {
    const alias = String(op[key] ?? "");
    const id = aliases.clipId.get(alias);
    const clip = id && project.clips.find((item) => item.id === id);
    if (!clip) throw new OpError(`找不到片段 ${alias || "(未指定)"}${id ? "（已在本批次中被删除或替换）" : ""}`);
    if (project.tracks.find((track) => track.id === clip.trackId)?.locked) throw new OpError(`${alias} 所在轨道已锁定`);
    return clip;
  };
  const assetOf = (alias: unknown) => {
    const asset = assetById.get(aliases.assetId.get(String(alias ?? "")) ?? "");
    if (!asset) throw new OpError(`找不到素材 ${String(alias ?? "(未指定)")}`);
    return asset;
  };
  const visualClip = (op: AgentOp) => {
    const clip = clipOf(op);
    if (assetById.get(clip.assetId)?.kind === "audio") throw new OpError(`${op.clip} 是音频片段，没有画面`);
    return clip;
  };
  const captionIndex = (value: unknown) => {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 1 || index > project.subtitles.length) throw new OpError(`字幕 #${String(value)} 不存在`);
    return index - 1;
  };
  const resolveTrack = (target: unknown, kind: "video" | "audio", start: number, length: number) => {
    const value = String(target ?? (kind === "audio" ? "audio" : "main"));
    if (value === "main") return mainTrack(project).id;
    if (value === "new-overlay" || (value === "audio" && kind === "audio")) {
      if (value === "audio") {
        const free = project.tracks.find((track) => track.kind === "audio" && !track.locked && hasRoom(project, track.id, start, length));
        if (free) return free.id;
      }
      const created = addTrack(project, kind, kind === "audio" ? "bottom" : "top");
      project = created.project;
      return created.trackId;
    }
    const id = aliases.trackId.get(value);
    const track = id && project.tracks.find((item) => item.id === id);
    if (!track) throw new OpError(`找不到轨道 ${value}`);
    if (track.kind !== kind) throw new OpError(`${value} 是${track.kind === "audio" ? "音频" : "视频"}轨，不能放这个素材`);
    if (track.locked) throw new OpError(`${value} 已锁定`);
    return track.id;
  };

  request.ops.forEach((op, index) => {
    try {
      if (!op || typeof op !== "object" || !agentOpNames.includes(op.op as typeof agentOpNames[number])) throw new OpError(`未知操作 ${String(op?.op)}`);
      switch (op.op) {
        case "split": {
          const clip = clipOf(op);
          const at = sec(num(op, "at", 0, ms(duration()))!);
          const result = splitClip(project, clip.id, at);
          if (!result.rightId) throw new OpError(`${op.clip} 在 ${op.at}ms 处无法分割（不在片段内或离边缘太近）`);
          project = result.project;
          changes.push(`在 ${op.at}ms 分割 ${op.clip}`);
          break;
        }
        case "trim": {
          const clip = clipOf(op);
          const start = op.start === undefined ? clip.start : sec(num(op, "start", 0, ms(duration()))!);
          const end = op.end === undefined ? clipEnd(clip) : sec(num(op, "end", 0, ms(duration()) + 600_000)!);
          if (end - start < 0.1) throw new OpError("裁剪后片段短于 100ms");
          const asset = assetById.get(clip.assetId);
          const stretch = clip.freezeAt !== null || asset?.kind === "image" || asset?.kind === "gif";
          const newIn = stretch ? clip.in : clip.in + (start - clip.start) * clip.speed;
          const newOut = stretch ? clip.in + (end - start) : clip.in + (end - clip.start) * clip.speed;
          if (!stretch && (newIn < -0.001 || newOut > (asset?.duration ?? Infinity) + 0.001)) throw new OpError(`${op.clip} 的素材不够长，无法延伸到 ${Math.round(end * 1000)}ms`);
          project = updateClip(project, clip.id, { start, in: Math.max(0, newIn), out: newOut }, options);
          changes.push(`裁剪 ${op.clip} 为 ${ms(start)}–${ms(end)}ms`);
          break;
        }
        case "delete": {
          const clips = (Array.isArray(op.clips) ? op.clips : [op.clip]).map((alias) => clipOf({ op: "delete", clip: alias }));
          project = pruneTracks(deleteClips(project, clips.map((clip) => clip.id), options));
          changes.push(`删除 ${clips.map((clip) => aliases.clip.get(clip.id)).join("、")}`);
          break;
        }
        case "cutRange": {
          const start = sec(num(op, "start", 0, ms(duration()))!);
          const end = sec(num(op, "end", 0, ms(duration()))!);
          if (end <= start) throw new OpError("end 必须大于 start");
          const trackId = op.track ? resolveTrack(op.track, "video", start, end - start) : mainTrack(project).id;
          const cuts = trackClips(project, trackId).flatMap((clip) => {
            const from = Math.max(start, clip.start);
            const to = Math.min(end, clipEnd(clip));
            if (to <= from || clip.reverse || clip.freezeAt !== null) return [];
            return [{ clipId: clip.id, start: clip.in + (from - clip.start) * clip.speed, end: clip.in + (to - clip.start) * clip.speed }];
          });
          if (!cuts.length) throw new OpError("该范围内没有可剪的片段");
          project = cutSourceRanges(project, cuts, options);
          changes.push(`剪掉 ${op.start}–${op.end}ms 并合拢`);
          break;
        }
        case "cutSource": {
          const clip = clipOf(op);
          const start = sec(num(op, "start", 0, 86_400_000)!);
          const end = sec(num(op, "end", 0, 86_400_000)!);
          if (end <= start) throw new OpError("end 必须大于 start");
          if (end <= clip.in || start >= clip.out) throw new OpError(`素材时间 ${op.start}–${op.end}ms 不在 ${op.clip} 的范围 ${ms(clip.in)}–${ms(clip.out)}ms 内`);
          project = cutSourceRanges(project, [{ clipId: clip.id, start, end }], options);
          changes.push(`从 ${op.clip} 剪掉素材 ${op.start}–${op.end}ms`);
          break;
        }
        case "move": {
          const clip = clipOf(op);
          const start = sec(num(op, "start", 0, ms(duration()) + 600_000)!);
          const kind = assetById.get(clip.assetId)?.kind === "audio" ? "audio" : "video";
          const trackId = op.track === undefined ? clip.trackId : resolveTrack(op.track, kind, start, clipDuration(clip));
          const track = project.tracks.find((item) => item.id === trackId)!;
          if (!track.main && !hasRoom(project, trackId, start, clipDuration(clip), clip.id)) throw new OpError(`目标位置与 ${aliases.track.get(trackId) ?? "新轨道"} 上的片段重叠`);
          project = pruneTracks(placeClip(project, clip, trackId, start, options));
          changes.push(`移动 ${op.clip} 到 ${op.start}ms`);
          break;
        }
        case "insert": {
          const asset = assetOf(op.asset);
          const start = op.start === undefined ? (op.track === undefined || op.track === "main" ? projectDuration(project) : 0) : sec(num(op, "start", 0, ms(duration()) + 600_000)!);
          const kind = asset.kind === "audio" ? "audio" : "video";
          const sourceIn = op.in === undefined ? 0 : sec(num(op, "in", 0, ms(asset.duration))!);
          const sourceOut = op.out === undefined ? asset.duration : sec(num(op, "out", 0, asset.kind === "video" || asset.kind === "audio" ? ms(asset.duration) : 3_600_000)!);
          if (sourceOut - sourceIn < 0.1) throw new OpError("插入的片段短于 100ms");
          const trackId = resolveTrack(op.track, kind, start, sourceOut - sourceIn);
          const track = project.tracks.find((item) => item.id === trackId)!;
          if (!track.main && !hasRoom(project, trackId, start, sourceOut - sourceIn)) throw new OpError("插入位置与已有片段重叠，可改用 track=new-overlay");
          const clip = { ...createClip(asset, trackId, start), in: sourceIn, out: sourceOut };
          project = placeClip(project, clip, trackId, start, options);
          changes.push(`插入 ${op.asset} 到 ${ms(start)}ms`);
          break;
        }
        case "assembleMain": {
          const segments = Array.isArray(op.segments) ? op.segments as Array<Record<string, unknown>> : [];
          if (!segments.length) throw new OpError("segments 不能为空");
          const main = mainTrack(project).id;
          let cursor = 0;
          const clips = segments.map((segment, position) => {
            const asset = assetOf(segment.asset);
            if (asset.kind === "audio") throw new OpError(`第 ${position + 1} 段：音频素材不能放在主轨`);
            const sourceIn = sec(num({ op: "assembleMain", value: segment.in }, "value", 0, ms(asset.duration))!);
            const limit = asset.kind === "video" ? asset.duration : 3600;
            const sourceOut = sec(num({ op: "assembleMain", value: segment.out }, "value", 0, ms(limit))!);
            if (sourceOut - sourceIn < 0.1) throw new OpError(`第 ${position + 1} 段短于 100ms`);
            const clip = { ...createClip(asset, main, cursor), id: uid("clip"), in: sourceIn, out: sourceOut };
            cursor += sourceOut - sourceIn;
            return clip;
          });
          project = packMainTrack({ ...project, clips: [...project.clips.filter((clip) => clip.trackId !== main), ...clips] });
          changes.push(`用 ${clips.length} 段重新组装主轨，共 ${ms(cursor)}ms`);
          break;
        }
        case "speed": {
          const clip = clipOf(op);
          if (clip.freezeAt !== null || assetById.get(clip.assetId)?.kind === "image") throw new OpError(`${op.clip} 是静态画面，不能变速`);
          project = updateClip(project, clip.id, { speed: num(op, "speed", 0.1, 10)! }, options);
          changes.push(`${op.clip} 变速为 ${op.speed}×`);
          break;
        }
        case "reverse": {
          const clip = clipOf(op);
          if (assetById.get(clip.assetId)?.kind !== "video" || clip.freezeAt !== null) throw new OpError(`${op.clip} 不是视频片段`);
          project = updateClip(project, clip.id, { reverse: op.enabled !== false }, options);
          changes.push(`${op.enabled === false ? "取消倒放" : "倒放"} ${op.clip}`);
          break;
        }
        case "transform": {
          const clip = visualClip(op);
          const transform = {
            x: num(op, "x", -2, 2, false) ?? clip.transform.x,
            y: num(op, "y", -2, 2, false) ?? clip.transform.y,
            scale: num(op, "scale", 0.05, 10, false) ?? clip.transform.scale,
            rotation: num(op, "rotation", -360, 360, false) ?? clip.transform.rotation,
            opacity: num(op, "opacity", 0, 1, false) ?? clip.transform.opacity,
          };
          project = updateClip(project, clip.id, { transform }, options);
          changes.push(`调整 ${op.clip} 的位置/大小`);
          break;
        }
        case "fit": {
          const clip = visualClip(op);
          const asset = assetById.get(clip.assetId)!;
          if (op.mode !== "contain" && op.mode !== "cover") throw new OpError("mode 必须是 contain 或 cover");
          const quarter = clip.rotate90 === 90 || clip.rotate90 === 270;
          const width = asset.width * clip.crop.w;
          const height = asset.height * clip.crop.h;
          const mediaRatio = quarter ? height / width : width / height;
          const canvasRatio = (op.ratio === "9:16" ? "9:16" : ratio) === "16:9" ? 16 / 9 : 9 / 16;
          // The renderer contain-fits first; covering scales up by the ratio mismatch.
          const scale = op.mode === "cover" ? Math.max(mediaRatio / canvasRatio, canvasRatio / mediaRatio) : 1;
          project = updateClip(project, clip.id, { transform: { ...clip.transform, scale: Number(scale.toFixed(4)), x: 0, y: 0 } }, options);
          changes.push(`${op.clip} ${op.mode === "cover" ? "铺满" : "完整显示在"}画布`);
          break;
        }
        case "volume": {
          const clip = clipOf(op);
          const audio = {
            ...clip.audio,
            volume: num(op, "volume", 0, 2, false) ?? clip.audio.volume,
            fadeIn: (num(op, "fadeIn", 0, 60_000, false) ?? ms(clip.audio.fadeIn)) / 1000,
            fadeOut: (num(op, "fadeOut", 0, 60_000, false) ?? ms(clip.audio.fadeOut)) / 1000,
            muted: typeof op.muted === "boolean" ? op.muted : clip.audio.muted,
          };
          project = updateClip(project, clip.id, { audio }, options);
          changes.push(`调整 ${op.clip} 的音量`);
          break;
        }
        case "effect": {
          const clip = visualClip(op);
          const effect = op.effect as VisualEffect;
          if (!visualEffects.includes(effect)) throw new OpError(`未知效果 ${String(op.effect)}`);
          const effects = op.enabled === false ? clip.effects.filter((item) => item !== effect) : [...new Set([...clip.effects, effect])];
          project = updateClip(project, clip.id, { effects }, options);
          changes.push(`${op.enabled === false ? "移除" : "添加"} ${op.clip} 的 ${effect}`);
          break;
        }
        case "adjust": {
          const clip = visualClip(op);
          const adjust = {
            brightness: num(op, "brightness", -1, 1, false) ?? clip.adjust.brightness,
            contrast: num(op, "contrast", 0, 2, false) ?? clip.adjust.contrast,
            saturation: num(op, "saturation", 0, 3, false) ?? clip.adjust.saturation,
            temperature: num(op, "temperature", -1, 1, false) ?? clip.adjust.temperature,
          };
          project = updateClip(project, clip.id, { adjust }, options);
          changes.push(`调整 ${op.clip} 的色彩`);
          break;
        }
        case "animation": {
          const clip = visualClip(op);
          const length = (num(op, "duration", 100, 5000, false) ?? 500) / 1000;
          for (const key of ["animationIn", "animationOut"] as const) {
            if (op[key] !== undefined && !animations.includes(op[key] as AnimationType)) throw new OpError(`未知动画 ${String(op[key])}`);
          }
          project = updateClip(project, clip.id, {
            animationIn: op.animationIn ? { type: op.animationIn as AnimationType, duration: length } : clip.animationIn,
            animationOut: op.animationOut ? { type: op.animationOut as AnimationType, duration: length } : clip.animationOut,
          }, options);
          changes.push(`设置 ${op.clip} 的动画`);
          break;
        }
        case "addCaption": {
          const start = sec(num(op, "start", 0, ms(duration()))!);
          const end = sec(num(op, "end", 0, ms(duration()))!);
          if (end - start < 0.2) throw new OpError("字幕至少 200ms");
          if (!op.zh && !op.en) throw new OpError("需要 zh 或 en 文本");
          const subtitles: Subtitle[] = [...project.subtitles, { id: Math.max(0, ...project.subtitles.map((item) => item.id)) + 1, start, end, zh: String(op.zh ?? ""), en: String(op.en ?? "") }].sort((a, b) => a.start - b.start);
          project = { ...project, subtitles };
          changes.push(`添加字幕 ${op.start}–${op.end}ms`);
          break;
        }
        case "editCaption": {
          const index = captionIndex(op.caption);
          const item = project.subtitles[index];
          const start = op.start === undefined ? item.start : sec(num(op, "start", 0, ms(duration()))!);
          const end = op.end === undefined ? item.end : sec(num(op, "end", 0, ms(duration()))!);
          if (end - start < 0.2) throw new OpError("字幕至少 200ms");
          const next = { ...item, start, end, zh: typeof op.zh === "string" ? op.zh : item.zh, en: typeof op.en === "string" ? op.en : item.en };
          project = { ...project, subtitles: project.subtitles.map((value, position) => position === index ? next : value).sort((a, b) => a.start - b.start) };
          changes.push(`修改字幕 #${op.caption}`);
          break;
        }
        case "deleteCaptions": {
          const indexes = (Array.isArray(op.captions) ? op.captions : []).map(captionIndex);
          if (!indexes.length) throw new OpError("captions 不能为空");
          project = { ...project, subtitles: project.subtitles.filter((_, position) => !indexes.includes(position)) };
          changes.push(`删除 ${indexes.length} 条字幕`);
          break;
        }
        case "captionStyle": {
          const style = op.style && typeof op.style === "object" ? op.style as Record<string, unknown> : null;
          if (!style) throw new OpError("缺少 style");
          const unknown = Object.keys(style).filter((key) => !(key in context.captionStyle));
          if (unknown.length) throw new OpError(`未知的字幕样式字段：${unknown.join(", ")}；可用：${Object.keys(context.captionStyle).join(", ")}`);
          for (const [key, value] of Object.entries(style)) {
            if (typeof value !== typeof context.captionStyle[key]) throw new OpError(`字幕样式 ${key} 应为 ${typeof context.captionStyle[key]}`);
          }
          captionStyle = { ...(captionStyle ?? context.captionStyle), ...style };
          changes.push(`修改字幕样式（${Object.keys(style).join("、")}）`);
          break;
        }
        case "captionView": {
          if (op.mode !== "zh" && op.mode !== "en" && op.mode !== "both") throw new OpError("mode 必须是 zh、en 或 both");
          captionMode = op.mode;
          changes.push(`字幕显示改为 ${op.mode}`);
          break;
        }
        case "canvas": {
          if (op.ratio !== "16:9" && op.ratio !== "9:16") throw new OpError("ratio 必须是 16:9 或 9:16");
          ratio = op.ratio;
          changes.push(`画布改为 ${op.ratio}`);
          break;
        }
        case "marker": {
          const at = sec(num(op, "at", 0, ms(duration()))!);
          project = { ...project, markers: [...project.markers, { id: uid("marker"), time: at }] };
          changes.push(`在 ${op.at}ms 添加标记`);
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      issues.push({ index, op: String(op?.op ?? ""), message: error.message });
    }
  });
  if (issues.length) return { ok: false, issues, revision: context.revision };
  return { ok: true, project, ratio, captionStyle, captionMode, changes };
}
