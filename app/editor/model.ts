// Pure project model and timeline operations shared by the editor UI and its tests.
import { curveAt, evaluateKeyframes, meanSpeed, outputFractionForSource, curveIntegral, shiftKeyframes, sliceCurve } from "./motion.ts";
import type { SpeedPoint } from "./motion.ts";

/** "text" assets are placeholders for title clips; the content lives on the clip. */
export type MediaKind = "video" | "image" | "gif" | "audio" | "text";

export type Asset = {
  id: string;
  name: string;
  kind: MediaKind;
  url: string;
  sourcePath: string;
  duration: number; // natural length; stills use the default display length
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnail: string;
  frames: string[]; // filmstrip, evenly spaced across the duration
  peaks: number[];
  peaksPerSecond: number;
};

export type Track = { id: string; kind: "video" | "audio"; main: boolean; muted: boolean; hidden: boolean; locked: boolean; /** Added by hand, so it stays even while empty. */ keep?: boolean };

export type Clip = {
  id: string;
  assetId: string;
  trackId: string;
  start: number;
  in: number;
  out: number;
  speed: number;
  reverse: boolean;
  freezeAt: number | null;
  mirror: boolean;
  rotate90: 0 | 90 | 180 | 270;
  crop: { x: number; y: number; w: number; h: number };
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
  adjust: { brightness: number; contrast: number; saturation: number; temperature: number };
  effects: VisualEffect[];
  chromaKey: { color: string; similarity: number };
  animationIn: { type: AnimationType; duration: number };
  animationOut: { type: AnimationType; duration: number };
  audio: ClipAudioSettings;
  keyframes?: VisualKeyframes;
  /** Speed multiplier over the clip's output, on top of `speed`. */
  speedCurve?: SpeedPoint[];
  /** Transition into the next adjacent clip on the main track. */
  transitionOut?: { type: TransitionType; duration: number };
  text?: TextStyle;
};

export type TransitionType = "crossfade" | "dip" | "wipe" | "slide";
export type TextStyle = {
  content: string;
  fontFamily: string;
  fontSize: number; // px at 1080p
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  strokeColor: string;
  strokeWidth: number;
  backgroundColor: string;
  backgroundOpacity: number; // 0..1
  shadow: boolean;
};

export type Marker = { id: string; time: number };
export type TimedWord = { start: number; end: number; text: string; prob: number };
export type Subtitle = { id: number; start: number; end: number; zh: string; en: string; words?: TimedWord[] };
/** Speech recognised for one asset, in source seconds; sentences are the recogniser's segments. */
export type Transcript = { language: string; source: "local" | "cloud"; words: TimedWord[]; sentences: Array<{ start: number; end: number }> };
/** Canvas and caption settings captured into history by edits that change them (e.g. the assistant). */
export type ProjectView = { ratio: "16:9" | "9:16"; captionStyle: Record<string, unknown>; captionMode: "zh" | "en" | "both" };
/** Separated stems per asset (full-length renders of its audio), produced on demand. */
export type Stems = { voice: string; background: string };
export type Project = { tracks: Track[]; clips: Clip[]; markers: Marker[]; subtitles: Subtitle[]; transcripts?: Record<string, Transcript>; stems?: Record<string, Stems>; view?: ProjectView };

/** Audio file that should play for a clip: a separated stem when the clip keeps only voice or background. */
export function audioSourceFor(project: Project, clip: Clip, asset: Asset) {
  const stems = project.stems?.[asset.id];
  if (!stems || !clip.audio.separation || clip.audio.separation === "none") return null;
  return clip.audio.separation === "voice" ? stems.voice : stems.background;
}
export type EditOptions = { magnet: boolean; linkage: boolean };

export const defaultStillDuration = 4;
export const minClipDuration = 0.1;

let counter = 0;
export function uid(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function createProject(): Project {
  return {
    tracks: [
      { id: "track-main", kind: "video", main: true, muted: false, hidden: false, locked: false },
      { id: "track-audio", kind: "audio", main: false, muted: false, hidden: false, locked: false },
    ],
    clips: [],
    markers: [],
    subtitles: [],
  };
}

export function defaultClipSettings(): Omit<Clip, "id" | "assetId" | "trackId" | "start" | "in" | "out"> {
  return {
    speed: 1,
    reverse: false,
    freezeAt: null,
    mirror: false,
    rotate90: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    adjust: { brightness: 0, contrast: 1, saturation: 1, temperature: 0 },
    effects: [],
    chromaKey: { color: "#00ff00", similarity: 0.3 },
    animationIn: { type: "none", duration: 0.5 },
    animationOut: { type: "none", duration: 0.5 },
    audio: { volume: 1, fadeIn: 0, fadeOut: 0, muted: false, effects: [] },
  };
}

export function clipDuration(clip: Clip) {
  return (clip.out - clip.in) / (clip.speed * (clip.speedCurve ? meanSpeed(clip.speedCurve) : 1));
}

/** Current speed multiplier at a timeline time, including the speed curve. */
export function speedAt(clip: Clip, time: number) {
  if (!clip.speedCurve) return clip.speed;
  return clip.speed * curveAt(clip.speedCurve, Math.max(0, Math.min(1, (time - clip.start) / clipDuration(clip))));
}

export function clipEnd(clip: Clip) {
  return clip.start + clipDuration(clip);
}

export function projectDuration(project: Project) {
  return project.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
}

export function mainTrack(project: Project) {
  return project.tracks.find((track) => track.main)!;
}

export function trackClips(project: Project, trackId: string) {
  return project.clips.filter((clip) => clip.trackId === trackId).sort((a, b) => a.start - b.start);
}

/** Stills, freeze frames and GIFs can be stretched freely; videos and audio are bounded by the source. */
export function isStretchable(clip: Clip, asset: Asset | undefined) {
  return clip.freezeAt !== null || asset?.kind === "image" || asset?.kind === "gif" || asset?.kind === "text";
}

/** Maps a timeline time inside the clip to the source time that should be shown. */
export function sourceTimeAt(clip: Clip, time: number) {
  if (clip.freezeAt !== null) return clip.freezeAt;
  const elapsed = Math.max(0, time - clip.start);
  const offset = clip.speedCurve
    ? (clip.out - clip.in) * (curveIntegral(clip.speedCurve, Math.min(1, elapsed / clipDuration(clip))) / meanSpeed(clip.speedCurve))
    : elapsed * clip.speed;
  return clip.reverse ? Math.max(clip.in, clip.out - offset) : Math.min(clip.out, clip.in + offset);
}

export function createClip(asset: Asset, trackId: string, start: number): Clip {
  return { id: uid("clip"), assetId: asset.id, trackId, start, in: 0, out: asset.duration, ...defaultClipSettings() };
}

/** Packs the main track left-to-right without gaps, preserving order. */
export function packMainTrack(project: Project): Project {
  const main = mainTrack(project);
  let cursor = 0;
  const packed = new Map<string, number>();
  for (const clip of trackClips(project, main.id)) {
    packed.set(clip.id, cursor);
    cursor += clipDuration(clip);
  }
  return { ...project, clips: project.clips.map((clip) => packed.has(clip.id) ? { ...clip, start: packed.get(clip.id)! } : clip) };
}

export function shiftSubtitle(item: Subtitle, delta: number): Subtitle {
  return { ...item, start: Math.max(0, item.start + delta), end: Math.max(0, item.end + delta), words: item.words?.map((word) => ({ ...word, start: Math.max(0, word.start + delta), end: Math.max(0, word.end + delta) })) };
}

/** Shifts everything not on `exceptTrackId` that starts at or after `time`, plus subtitles. */
export function rippleOthers(project: Project, exceptTrackId: string, time: number, delta: number): Project {
  if (!delta) return project;
  return {
    ...project,
    clips: project.clips.map((clip) => clip.trackId !== exceptTrackId && clip.start >= time - 0.001 ? { ...clip, start: Math.max(0, clip.start + delta) } : clip),
    markers: project.markers.map((marker) => marker.time >= time - 0.001 ? { ...marker, time: Math.max(0, marker.time + delta) } : marker),
    subtitles: project.subtitles.map((item) => item.start >= time - 0.001 ? shiftSubtitle(item, delta) : item),
  };
}

/**
 * Re-packs the main track after an edit and, with linkage on, moves attached items by the
 * same amount the main track moved at `time`.
 */
export function settle(before: Project, after: Project, options: EditOptions, time: number): Project {
  if (!options.magnet) return after;
  const packed = packMainTrack(after);
  if (!options.linkage) return packed;
  const main = mainTrack(packed).id;
  return rippleOthers(packed, main, time, mainLength(packed, main) - mainLength(before, main));
}

function mainLength(project: Project, mainId: string) {
  return project.clips.reduce((sum, clip) => clip.trackId === mainId ? sum + clipDuration(clip) : sum, 0);
}

function isMainClip(project: Project, clip: Clip) {
  return project.tracks.some((track) => track.id === clip.trackId && track.main);
}

export function clipAt(project: Project, trackId: string, time: number) {
  return project.clips.find((clip) => clip.trackId === trackId && time >= clip.start && time < clipEnd(clip));
}

export function splitClip(project: Project, clipId: string, time: number): { project: Project; rightId: string | null } {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || time <= clip.start + minClipDuration || time >= clipEnd(clip) - minClipDuration) return { project, rightId: null };
  const fraction = (time - clip.start) / clipDuration(clip);
  const source = sourceTimeAt(clip, time);
  const rightId = uid("clip");
  let left: Clip;
  let right: Clip;
  if (clip.reverse) {
    left = { ...clip, in: source };
    right = { ...clip, id: rightId, start: time, out: source };
  } else {
    left = { ...clip, out: source };
    right = { ...clip, id: rightId, start: time, in: source };
  }
  // Each half keeps its part of the speed curve and the keyframes keep their absolute positions.
  if (clip.speedCurve) {
    left = { ...left, speedCurve: sliceCurve(clip.speedCurve, 0, fraction) };
    right = { ...right, speedCurve: sliceCurve(clip.speedCurve, fraction, 1) };
  }
  if (clip.keyframes) right = { ...right, keyframes: Object.fromEntries(Object.entries(clip.keyframes).map(([key, points]) => [key, shiftKeyframes(points, clip.start - time)])) };
  if (clip.audio.volumeKeyframes) right = { ...right, audio: { ...right.audio, volumeKeyframes: shiftKeyframes(clip.audio.volumeKeyframes, clip.start - time) } };
  left = { ...left, transitionOut: undefined };
  // Animations belong to the outer edges of the original clip.
  left = { ...left, animationOut: { ...left.animationOut, type: "none" } };
  right = { ...right, animationIn: { ...right.animationIn, type: "none" } };
  return { project: { ...project, clips: project.clips.flatMap((item) => item.id === clipId ? [left, right] : [item]) }, rightId };
}

/** Removes the part of a clip before (`side = "left"`) or after the given time. */
export function trimAt(project: Project, clipId: string, time: number, side: "left" | "right", options: EditOptions): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || time <= clip.start + minClipDuration / 2 || time >= clipEnd(clip) - minClipDuration / 2) return project;
  const source = sourceTimeAt(clip, time);
  const fraction = (time - clip.start) / clipDuration(clip);
  let next: Clip;
  if (side === "left") {
    next = clip.reverse ? { ...clip, out: source, start: time } : { ...clip, in: source, start: time };
    if (clip.speedCurve) next = { ...next, speedCurve: sliceCurve(clip.speedCurve, fraction, 1) };
    if (clip.keyframes) next = { ...next, keyframes: Object.fromEntries(Object.entries(clip.keyframes).map(([key, points]) => [key, shiftKeyframes(points, clip.start - time)])) };
  } else {
    next = clip.reverse ? { ...clip, in: source } : { ...clip, out: source };
    if (clip.speedCurve) next = { ...next, speedCurve: sliceCurve(clip.speedCurve, 0, fraction) };
  }
  const after = { ...project, clips: project.clips.map((item) => item.id === clipId ? next : item) };
  // Left trims move the kept content, so attachments from the cut onwards follow it.
  return settle(project, after, options, side === "left" ? time : clipEnd(clip));
}

export function deleteClips(project: Project, clipIds: string[], options: EditOptions): Project {
  const removed = project.clips.filter((clip) => clipIds.includes(clip.id));
  if (!removed.length) return project;
  const after = { ...project, clips: project.clips.filter((clip) => !clipIds.includes(clip.id)) };
  return settle(project, after, options, Math.min(...removed.map((clip) => clipEnd(clip))));
}

export function updateClip(project: Project, clipId: string, patch: Partial<Clip>, options: EditOptions): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return project;
  const after = { ...project, clips: project.clips.map((item) => item.id === clipId ? { ...item, ...patch } : item) };
  const timingChanged = ["in", "out", "speed", "start", "speedCurve"].some((key) => key in patch);
  if (!timingChanged) return after;
  // A left-edge trim moves the remaining content; everything else changes length at the old end.
  const next = after.clips.find((item) => item.id === clipId)!;
  const leftTrim = next.start !== clip.start && next.speed === clip.speed;
  return settle(project, after, options, leftTrim ? Math.max(clip.start, next.start) : clipEnd(clip));
}

/** Inserts a held frame at `time` inside a video clip, splitting it around the freeze. */
export function freezeFrame(project: Project, clipId: string, time: number, length: number, options: EditOptions): { project: Project; freezeId: string | null } {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || clip.freezeAt !== null) return { project, freezeId: null };
  const frameTime = sourceTimeAt(clip, time);
  const split = time > clip.start + minClipDuration && time < clipEnd(clip) - minClipDuration ? splitClip(project, clipId, time) : { project, rightId: null };
  const freezeStart = split.rightId ? time : time >= clipEnd(clip) - minClipDuration ? clipEnd(clip) : clip.start;
  const freeze: Clip = { ...clip, id: uid("clip"), start: freezeStart, in: 0, out: length, speed: 1, reverse: false, freezeAt: frameTime, animationIn: { ...clip.animationIn, type: "none" }, animationOut: { ...clip.animationOut, type: "none" } };
  // Make room on the clip's own track, then let the main track settle.
  const shifted = split.project.clips.map((item) => item.trackId === clip.trackId && item.start >= freezeStart - 0.001 ? { ...item, start: item.start + length } : item);
  let next: Project = { ...split.project, clips: [...shifted, freeze] };
  if (options.linkage && isMainClip(project, clip)) next = rippleOthers(next, clip.trackId, freezeStart, length);
  return { project: options.magnet ? packMainTrack(next) : next, freezeId: freeze.id };
}

/** Replaces a clip with several source ranges laid end to end (smart cuts). */
export function replaceWithRanges(project: Project, clipId: string, ranges: Array<{ start: number; end: number }>, options: EditOptions): Project {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip || !ranges.length) return project;
  let cursor = clip.start;
  const pieces = ranges.map((range, index) => {
    const piece: Clip = {
      ...clip,
      id: index === 0 ? clip.id : uid("clip"),
      start: cursor,
      in: range.start,
      out: range.end,
      reverse: false,
      animationIn: index === 0 ? clip.animationIn : { ...clip.animationIn, type: "none" },
      animationOut: index === ranges.length - 1 ? clip.animationOut : { ...clip.animationOut, type: "none" },
    };
    cursor += clipDuration(piece);
    return piece;
  });
  const delta = cursor - clipEnd(clip);
  const shifted = project.clips.flatMap((item) => item.id === clipId ? pieces : item.trackId === clip.trackId && item.start >= clipEnd(clip) - 0.001 ? [{ ...item, start: item.start + delta }] : [item]);
  let next: Project = { ...project, clips: shifted };
  if (options.linkage && isMainClip(project, clip)) next = rippleOthers(next, clip.trackId, clipEnd(clip), delta);
  return options.magnet ? packMainTrack(next) : next;
}

/** Splits a clip at several source times (scene cuts). Returns the new project. */
export function splitAtSourceTimes(project: Project, clipId: string, sourceTimes: number[]) {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return project;
  const timelineTimes = sourceTimes
    .map((source) => clip.start + (clip.reverse ? clip.out - source : source - clip.in) / clip.speed)
    .sort((a, b) => b - a);
  let next = project;
  // Split from the right so the left piece keeps the original id for the next cut.
  for (const time of timelineTimes) next = splitClip(next, clipId, time).project;
  return next;
}

export function hasRoom(project: Project, trackId: string, start: number, duration: number, ignoreId?: string) {
  return !project.clips.some((clip) => clip.trackId === trackId && clip.id !== ignoreId && start < clipEnd(clip) - 0.001 && start + duration > clip.start + 0.001);
}

/** Places (or moves) a clip; on the magnetic main track it is inserted at the nearest boundary. */
export function placeClip(project: Project, clip: Clip, trackId: string, start: number, options: EditOptions): Project {
  const track = project.tracks.find((item) => item.id === trackId)!;
  const others = project.clips.filter((item) => item.id !== clip.id);
  if (track.main && options.magnet) {
    const wasOnMain = project.clips.some((item) => item.id === clip.id && item.trackId === trackId);
    const mainClips = packMainTrack({ ...project, clips: others }).clips.filter((item) => item.trackId === trackId).sort((a, b) => a.start - b.start);
    // Insert before the first clip whose midpoint lies after the drop position.
    const index = mainClips.findIndex((item) => start < item.start + clipDuration(item) / 2);
    const insertAt = index === -1 ? mainClips.reduce((end, item) => Math.max(end, clipEnd(item)), 0) : mainClips[index].start;
    // A start just before the neighbour makes the packer order the inserted clip first.
    const packed = packMainTrack({ ...project, clips: [...others.map((item) => mainClips.find((main) => main.id === item.id) ?? item), { ...clip, trackId, start: insertAt - 0.0005 }] });
    return options.linkage && !wasOnMain ? rippleOthers(packed, trackId, insertAt, clipDuration(clip)) : packed;
  }
  const placed = { ...clip, trackId, start: Math.max(0, start) };
  const after = { ...project, clips: [...others, placed] };
  // Leaving the main track closes the gap there without dragging attached items along.
  const wasMain = project.clips.some((item) => item.id === clip.id && isMainClip(project, item));
  return wasMain && options.magnet ? packMainTrack(after) : after;
}

export function addTrack(project: Project, kind: "video" | "audio", position: "top" | "bottom"): { project: Project; trackId: string } {
  const track: Track = { id: uid("track"), kind, main: false, muted: false, hidden: false, locked: false };
  const tracks = position === "top" ? [track, ...project.tracks] : [...project.tracks, track];
  return { project: { ...project, tracks: normalizeTrackOrder(tracks) }, trackId: track.id };
}

/** Video tracks always sit above audio tracks so the main track separates overlays from sound. */
export function normalizeTrackOrder(tracks: Track[]) {
  return [...tracks.filter((track) => track.kind === "video"), ...tracks.filter((track) => track.kind === "audio")];
}

/** Drops empty non-main tracks so dragging clips away does not leave blank rows behind. */
export function pruneTracks(project: Project): Project {
  const used = new Set(project.clips.map((clip) => clip.trackId));
  const firstAudio = project.tracks.find((track) => track.kind === "audio");
  const tracks = project.tracks.filter((track) => track.main || track.keep || track === firstAudio || used.has(track.id));
  return tracks.length === project.tracks.length ? project : { ...project, tracks };
}

/** Snaps `time` to the nearest candidate within `threshold` seconds. */
export function snapTime(time: number, candidates: number[], threshold: number) {
  let best = time;
  let distance = threshold;
  for (const candidate of candidates) {
    const gap = Math.abs(candidate - time);
    if (gap < distance) {
      best = candidate;
      distance = gap;
    }
  }
  return best;
}

export function snapCandidates(project: Project, playhead: number, ignoreId?: string) {
  return [0, playhead, ...project.markers.map((marker) => marker.time), ...project.clips.filter((clip) => clip.id !== ignoreId).flatMap((clip) => [clip.start, clipEnd(clip)])];
}

/** Evaluates transform and opacity including in/out animations, matching the exporter. */
export function evaluateVisual(clip: Clip, time: number) {
  const local = time - clip.start;
  const keyframes = clip.keyframes ?? {};
  let x = evaluateKeyframes(keyframes.x, local, clip.transform.x);
  let y = evaluateKeyframes(keyframes.y, local, clip.transform.y);
  let scale = evaluateKeyframes(keyframes.scale, local, clip.transform.scale);
  let opacity = evaluateKeyframes(keyframes.opacity, local, clip.transform.opacity);
  const rotation = evaluateKeyframes(keyframes.rotation, local, clip.transform.rotation);
  // Visible fraction of the layer box from the left / right edge for wipe animations.
  let wipe: { from: "left" | "right"; visible: number } | null = null;
  const length = clipDuration(clip);
  const apply = (type: AnimationType, p: number) => {
    if (type === "wipe-right") wipe = { from: "left", visible: p };
    if (type === "wipe-left") wipe = { from: "right", visible: p };
    if (type === "fade") opacity *= p;
    if (type === "slide-left") x -= 1 - p;
    if (type === "slide-right") x += 1 - p;
    if (type === "slide-up") y -= 1 - p;
    if (type === "slide-down") y += 1 - p;
    if (type === "zoom-in") scale *= 0.5 + 0.5 * p;
    if (type === "zoom-out") scale *= 1.5 - 0.5 * p;
  };
  const inLength = Math.min(clip.animationIn.duration, length);
  const outLength = Math.min(clip.animationOut.duration, length);
  if (clip.animationIn.type !== "none" && local < inLength) apply(clip.animationIn.type, Math.max(0, local / inLength));
  if (clip.animationOut.type !== "none" && local > length - outLength) apply(clip.animationOut.type, Math.max(0, (length - local) / outLength));
  return { x, y, scale, rotation, opacity: Math.max(0, Math.min(1, opacity)), wipe: wipe as { from: "left" | "right"; visible: number } | null };
}

/** Volume after fades at a timeline time. */
export function evaluateVolume(clip: Clip, time: number) {
  if (clip.audio.muted) return 0;
  const local = time - clip.start;
  const length = clipDuration(clip);
  let gain = evaluateKeyframes(clip.audio.volumeKeyframes, local, clip.audio.volume);
  if (clip.audio.fadeIn > 0 && local < clip.audio.fadeIn) gain *= Math.max(0, local / clip.audio.fadeIn);
  if (clip.audio.fadeOut > 0 && local > length - clip.audio.fadeOut) gain *= Math.max(0, (length - local) / clip.audio.fadeOut);
  return gain;
}

export function canvasSize(ratio: "16:9" | "9:16", resolution: 720 | 1080 | 2160) {
  const long = Math.round((resolution * 16) / 9);
  return ratio === "16:9" ? { width: long, height: resolution } : { width: resolution, height: long };
}

function shiftClipTimes(clip: Clip, delta: number): Clip {
  const keyframes = clip.keyframes && Object.fromEntries(Object.entries(clip.keyframes).map(([key, points]) => [key, shiftKeyframes(points, delta)]));
  return { ...clip, keyframes, audio: { ...clip.audio, volumeKeyframes: shiftKeyframes(clip.audio.volumeKeyframes, delta) } };
}

/** Extra timeline seconds a clip can grow by at its end (after) or start (before) from unused source. */
function handle(clip: Clip, asset: Asset | undefined, side: "after" | "before") {
  if (isStretchable(clip, asset)) return Infinity;
  if (clip.speedCurve || !asset) return 0;
  const room = (side === "after") !== clip.reverse ? asset.duration - clip.out : clip.in;
  return Math.max(0, room / clip.speed);
}

function extendClip(clip: Clip, asset: Asset | undefined, amount: number, edge: "start" | "end"): Clip {
  const stretch = isStretchable(clip, asset);
  const source = amount * clip.speed;
  if (edge === "end") {
    if (stretch || !clip.reverse) return { ...clip, out: clip.out + (stretch ? amount : source) };
    return { ...clip, in: clip.in - source };
  }
  const moved = shiftClipTimes({ ...clip, start: clip.start - amount }, amount);
  if (stretch) return { ...moved, out: moved.out + amount };
  return clip.reverse ? { ...moved, out: moved.out + source } : { ...moved, in: moved.in - source };
}

/**
 * Clips as drawn and heard. A transition between adjacent main-track clips overlaps them around the
 * cut (using unused source on both sides) and animates the incoming clip; without enough source it
 * falls back to a dip through black. Draw order on a track follows start time.
 */
export function renderClips(project: Project, assets: Map<string, Asset>): Clip[] {
  const result = new Map(project.clips.map((clip) => [clip.id, clip]));
  const mainClips = trackClips(project, mainTrack(project).id);
  for (let index = 0; index < mainClips.length - 1; index += 1) {
    const a = mainClips[index];
    const b = mainClips[index + 1];
    if (!a.transitionOut || Math.abs(clipEnd(a) - b.start) > 0.01) continue;
    const duration = Math.min(a.transitionOut.duration, clipDuration(a), clipDuration(b));
    const half = a.transitionOut.type === "dip" ? 0 : Math.min(duration / 2, handle(a, assets.get(a.assetId), "after"), handle(b, assets.get(b.assetId), "before"));
    const currentA = result.get(a.id)!;
    const currentB = result.get(b.id)!;
    if (half < 0.05) {
      const fade = duration / 2;
      result.set(a.id, { ...currentA, animationOut: { type: "fade", duration: fade }, audio: { ...currentA.audio, fadeOut: Math.max(currentA.audio.fadeOut, fade) } });
      result.set(b.id, { ...currentB, animationIn: { type: "fade", duration: fade }, audio: { ...currentB.audio, fadeIn: Math.max(currentB.audio.fadeIn, fade) } });
      continue;
    }
    const overlap = half * 2;
    const extendedA = extendClip(currentA, assets.get(a.assetId), half, "end");
    const extendedB = extendClip(currentB, assets.get(b.assetId), half, "start");
    const type = a.transitionOut.type;
    result.set(a.id, { ...extendedA, animationOut: type === "slide" ? { type: "slide-left", duration: overlap } : { ...extendedA.animationOut, type: "none" }, audio: { ...extendedA.audio, fadeOut: overlap } });
    result.set(b.id, { ...extendedB, animationIn: { type: type === "crossfade" ? "fade" : type === "wipe" ? "wipe-right" : "slide-right", duration: overlap }, audio: { ...extendedB.audio, fadeIn: overlap } });
  }
  return project.clips.map((clip) => result.get(clip.id)!);
}

/** Scale that cancels contain-fit so a text box keeps its designed size (font px at 1080p). */
export function textBaseScale(boxWidth: number, boxHeight: number, ratio: "16:9" | "9:16") {
  const aspect = ratio === "16:9" ? 16 / 9 : 9 / 16;
  return 1 / Math.min((1080 * aspect) / boxWidth, 1080 / boxHeight);
}

export type TextLayer = { path: string; width: number; height: number; boxWidth: number; boxHeight: number };
const curveChunks = 24;

/** Flattens the project into the exporter contract (visual layers bottom → top). */
export function toComposition(project: Project, assets: Asset[], settings: { ratio: "16:9" | "9:16"; resolution: 720 | 1080 | 2160; fps: 30 | 60; platform: "bilibili" | "youtube"; subtitleStyle: Record<string, string | number>; subtitleMode: "zh" | "en" | "both" }, textLayers: Map<string, TextLayer> = new Map()): CompositionRequest {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const { width, height } = canvasSize(settings.ratio, settings.resolution);
  const drawn = renderClips(project, byId);
  const clipsOn = (trackId: string) => drawn.filter((clip) => clip.trackId === trackId).sort((a, b) => a.start - b.start);

  // A speed curve is exported as short constant-speed pieces; atempo keeps the pitch.
  const pieces = (clip: Clip): Clip[] => {
    if (!clip.speedCurve || clip.freezeAt !== null) return [clip];
    const length = clipDuration(clip);
    return Array.from({ length: curveChunks }, (_, index) => {
      const t0 = clip.start + (length * index) / curveChunks;
      const t1 = clip.start + (length * (index + 1)) / curveChunks;
      const s0 = sourceTimeAt(clip, t0);
      const s1 = sourceTimeAt(clip, t1);
      const shifted = shiftClipTimes(clip, clip.start - t0);
      return {
        ...shifted,
        start: t0,
        in: Math.min(s0, s1),
        out: Math.max(s0, s1),
        speed: Math.abs(s1 - s0) / (t1 - t0),
        speedCurve: undefined,
        animationIn: index === 0 ? clip.animationIn : { ...clip.animationIn, type: "none" },
        animationOut: index === curveChunks - 1 ? clip.animationOut : { ...clip.animationOut, type: "none" },
        audio: { ...shifted.audio, fadeIn: index === 0 ? clip.audio.fadeIn : 0, fadeOut: index === curveChunks - 1 ? clip.audio.fadeOut : 0 },
      };
    });
  };

  const videoTracks = project.tracks.filter((track) => track.kind === "video" && !track.hidden).reverse();
  const visuals: CompositionVisual[] = videoTracks.flatMap((track) => clipsOn(track.id).flatMap(pieces).flatMap((clip) => {
    const asset = byId.get(clip.assetId);
    if (!asset || asset.kind === "audio") return [];
    let path = asset.sourcePath;
    let kind: CompositionVisual["kind"] = asset.kind === "text" ? "rgba" : asset.kind;
    let rgba: CompositionVisual["rgba"];
    let transform = clip.transform;
    let keyframes = clip.keyframes;
    if (asset.kind === "text") {
      const layer = textLayers.get(clip.id);
      if (!layer) return [];
      path = layer.path;
      kind = "rgba";
      rgba = { width: layer.width, height: layer.height };
      const base = textBaseScale(layer.boxWidth, layer.boxHeight, settings.ratio);
      transform = { ...transform, scale: transform.scale * base };
      if (keyframes?.scale) keyframes = { ...keyframes, scale: keyframes.scale.map((point) => ({ ...point, value: point.value * base })) };
    }
    return [{
      path,
      kind,
      rgba,
      start: clip.start,
      in: clip.in,
      out: clip.out,
      speed: asset.kind === "image" || asset.kind === "text" ? 1 : clip.speed,
      reverse: clip.reverse,
      freezeAt: clip.freezeAt,
      mirror: clip.mirror,
      rotate90: clip.rotate90,
      crop: clip.crop,
      transform,
      keyframes,
      adjust: clip.adjust,
      effects: clip.effects,
      chromaKey: clip.chromaKey,
      animationIn: clip.animationIn,
      animationOut: clip.animationOut,
      hasAudio: asset.kind === "video" && asset.hasAudio && clip.freezeAt === null && !track.muted,
      audio: clip.audio,
      audioPath: audioSourceFor(project, clip, asset) ?? undefined,
    }];
  }));
  const audios: CompositionAudio[] = project.tracks.filter((track) => track.kind === "audio" && !track.muted).flatMap((track) => clipsOn(track.id).flatMap(pieces).flatMap((clip) => {
    const asset = byId.get(clip.assetId);
    if (!asset || !asset.hasAudio) return [];
    return [{ path: audioSourceFor(project, clip, asset) ?? asset.sourcePath, start: clip.start, in: clip.in, out: clip.out, speed: clip.speed, audio: clip.audio }];
  }));
  return { width, height, fps: settings.fps, platform: settings.platform, duration: projectDuration(project), visuals, audios, subtitles: project.subtitles, subtitleStyle: settings.subtitleStyle, subtitleMode: settings.subtitleMode };
}

/** Maps a source-time range of a clip's asset onto the timeline, or null when it falls outside the clip. */
export function sourceRangeToTimeline(clip: Clip, sourceStart: number, sourceEnd: number) {
  if (clip.freezeAt !== null || clip.reverse) return null;
  const start = Math.max(sourceStart, clip.in);
  const end = Math.min(sourceEnd, clip.out);
  if (end <= start) return null;
  if (clip.speedCurve) {
    const length = clipDuration(clip);
    const at = (source: number) => clip.start + length * outputFractionForSource(clip.speedCurve!, (source - clip.in) / (clip.out - clip.in));
    return { start: at(start), end: at(end), sourceStart: start, sourceEnd: end };
  }
  return { start: clip.start + (start - clip.in) / clip.speed, end: clip.start + (end - clip.in) / clip.speed, sourceStart: start, sourceEnd: end };
}

/** Removes [start, end) of the timeline from subtitles: inside lines go, overlapping lines shrink, later lines move up. */
function cutSubtitles(subtitles: Subtitle[], start: number, end: number) {
  const length = end - start;
  return subtitles.flatMap((item) => {
    if (item.end <= start + 0.001) return [item];
    if (item.start >= end - 0.001) return [shiftSubtitle(item, -length)];
    const words = item.words?.filter((word) => (word.start + word.end) / 2 < start || (word.start + word.end) / 2 >= end).map((word) => word.start >= end ? { ...word, start: word.start - length, end: word.end - length } : word);
    const nextStart = item.start < start ? item.start : start;
    const nextEnd = item.end > end ? item.end - length : Math.min(item.end, start);
    return nextEnd - nextStart > 0.05 ? [{ ...item, start: nextStart, end: nextEnd, words }] : [];
  });
}

/**
 * Ripple-deletes source ranges from clips (transcript edits, clean cuts) in one step.
 * Ranges are in source seconds of each clip's asset; reversed and frozen clips are skipped.
 */
export function cutSourceRanges(project: Project, cuts: Array<{ clipId: string; start: number; end: number }>, options: EditOptions): Project {
  const spans = cuts.flatMap((cut) => {
    const clip = project.clips.find((item) => item.id === cut.clipId);
    // Speed-curved clips map source to timeline non-linearly; transcript cuts skip them.
    const range = clip && !clip.speedCurve && sourceRangeToTimeline(clip, cut.start, cut.end);
    return clip && range && range.end - range.start > 0.02 ? [{ clipId: clip.id, trackId: clip.trackId, start: range.start, end: range.end }] : [];
  });
  // Merge overlapping spans per track, then cut from the end so earlier times stay valid.
  const merged: typeof spans = [];
  for (const span of [...spans].sort((a, b) => a.trackId.localeCompare(b.trackId) || a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.trackId === span.trackId && span.start <= last.end + 0.001) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let next = project;
  for (const span of merged.sort((a, b) => b.start - a.start)) {
    const length = span.end - span.start;
    const isMain = next.tracks.some((track) => track.id === span.trackId && track.main);
    const clips = next.clips.flatMap((clip) => {
      if (clip.trackId !== span.trackId) {
        // Overlays follow the cut only when they are linked to the main track.
        return [options.linkage && isMain && clip.start >= span.end - 0.001 ? { ...clip, start: clip.start - length } : clip];
      }
      const end = clipEnd(clip);
      if (end <= span.start + 0.001) return [clip];
      if (clip.start >= span.end - 0.001) return [{ ...clip, start: clip.start - length }];
      // The span overlaps this clip: keep the parts before and after it, joined at span.start.
      const pieces: Clip[] = [];
      if (span.start > clip.start + minClipDuration / 2) pieces.push({ ...clip, out: clip.in + (span.start - clip.start) * clip.speed, animationOut: { ...clip.animationOut, type: "none" } });
      if (end > span.end + minClipDuration / 2) pieces.push({ ...clip, id: pieces.length ? uid("clip") : clip.id, start: span.start, in: clip.in + (span.end - clip.start) * clip.speed, animationIn: { ...clip.animationIn, type: "none" } });
      return pieces;
    });
    next = {
      ...next,
      clips,
      markers: next.markers.flatMap((marker) => marker.time >= span.end ? [{ ...marker, time: marker.time - length }] : marker.time > span.start ? [] : [marker]),
      subtitles: cutSubtitles(next.subtitles, span.start, span.end),
    };
  }
  return options.magnet ? packMainTrack(next) : next;
}
