// Versioned on-disk project document (*.dashcut). Pure: no DOM, no fs.
import type { SubtitleStyle } from "./captions";
import type { Asset, Clip, Marker, Project, Subtitle, Track } from "./model";
import { t } from "../i18n/index.ts";
import { normalizeCover, type CoverDesign } from "./cover.ts";

export const projectSchemaVersion = 2;
export const projectExtension = "dashcut";

export type CaptionStyle = SubtitleStyle;
export type CaptionMode = "zh" | "en" | "both";
export type ExportSettings = {
  resolution: 720 | 1080 | 2160;
  fps: 30 | 60;
  platform: "bilibili" | "youtube";
  // Added later; optional so older files open unchanged.
  format?: CompositionOutput["format"];
  codec?: CompositionOutput["codec"];
  loudnessTarget?: number | null;
};

/** Media reference stored on disk; previews (thumbnails, filmstrips, waveforms) are rebuilt on open. */
export type StoredAsset = {
  id: string;
  name: string;
  kind: Asset["kind"];
  /** Path relative to the project file's folder when possible; the main process fills this in on save. */
  path: string;
  absolutePath: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

/** Clips carry optional keyframes, speed curves, transitions and text; older files simply lack them. */
export type StoredClip = Clip;

export type ProjectDocument = {
  schemaVersion: number;
  app: "DashCut";
  meta: { id: string; title: string; createdAt: string; modifiedAt: string };
  canvas: { ratio: "16:9" | "9:16"; fps: 30 | 60 };
  assets: StoredAsset[];
  tracks: Track[];
  clips: StoredClip[];
  transitions: unknown[];
  markers: Marker[];
  subtitles: Subtitle[];
  /** Recognised words per asset (optional; older files have none). */
  transcripts?: Project["transcripts"];
  /** Separated voice/background stems per asset (optional cache paths). */
  stems?: Project["stems"];
  captionStyle: CaptionStyle;
  captionMode: CaptionMode;
  exportSettings: ExportSettings;
  cover: CoverDesign;
  /** Small JPEG of the cover or first frame, shown on the start screen (written on save, optional). */
  preview?: string;
};

export type EditorState = {
  id: string;
  title: string;
  createdAt: string;
  ratio: "16:9" | "9:16";
  project: Project;
  assets: Asset[];
  captionStyle: CaptionStyle;
  captionMode: CaptionMode;
  exportSettings: ExportSettings;
  cover: CoverDesign;
};

export function buildDocument(state: EditorState, now = new Date()): ProjectDocument {
  const used = new Set(state.project.clips.map((clip) => clip.assetId));
  return {
    schemaVersion: projectSchemaVersion,
    app: "DashCut",
    meta: { id: state.id, title: state.title, createdAt: state.createdAt, modifiedAt: now.toISOString() },
    canvas: { ratio: state.ratio, fps: state.exportSettings.fps },
    // Keep library items even when unused so the bin survives a reopen, but never blob-only media.
    assets: state.assets.filter((asset) => asset.sourcePath || used.has(asset.id)).map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      path: asset.sourcePath,
      absolutePath: asset.sourcePath,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      hasAudio: asset.hasAudio,
    })),
    tracks: state.project.tracks,
    clips: state.project.clips,
    transitions: [],
    markers: state.project.markers,
    subtitles: state.project.subtitles,
    transcripts: state.project.transcripts,
    stems: state.project.stems,
    captionStyle: state.captionStyle,
    captionMode: state.captionMode,
    exportSettings: state.exportSettings,
    cover: state.cover,
  };
}

/** Upgrades older documents step by step; each step takes version n to n + 1. */
const migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 kept the caption view and style at the top level without export settings.
  1: (doc) => ({
    ...doc,
    schemaVersion: 2,
    captionMode: doc.captionMode ?? "both",
    exportSettings: doc.exportSettings ?? { resolution: 1080, fps: (doc.canvas as { fps?: number } | undefined)?.fps ?? 30, platform: "bilibili" },
    transitions: doc.transitions ?? [],
    cover: doc.cover ?? { title: "", accent: "#ffcc45" },
  }),
};

export function migrateDocument(input: unknown): ProjectDocument {
  if (!input || typeof input !== "object") throw new Error(t("项目文件格式无效"));
  let doc = input as Record<string, unknown>;
  if (doc.app !== "DashCut") throw new Error(t("不是 DashCut 项目文件"));
  let version = Number(doc.schemaVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error(t("项目文件缺少版本号"));
  if (version > projectSchemaVersion) throw new Error(t("项目由更新版本的 DashCut 创建（版本 {version}），请升级后再打开", { version }));
  while (version < projectSchemaVersion) {
    const step = migrations[version];
    if (!step) throw new Error(t("无法从版本 {version} 升级项目文件", { version }));
    doc = step(doc);
    version = Number(doc.schemaVersion);
  }
  return validateDocument(doc as ProjectDocument);
}

function validateDocument(doc: ProjectDocument) {
  for (const key of ["assets", "tracks", "clips", "markers", "subtitles"] as const) {
    if (!Array.isArray(doc[key])) throw new Error(t("项目文件缺少 {key}", { key }));
  }
  if (!doc.tracks.some((track) => track.main)) throw new Error(t("项目文件缺少主轨"));
  const assetIds = new Set(doc.assets.map((asset) => asset.id));
  const trackIds = new Set(doc.tracks.map((track) => track.id));
  const orphan = doc.clips.find((clip) => !assetIds.has(clip.assetId) || !trackIds.has(clip.trackId));
  if (orphan) throw new Error(t("片段 {id} 引用了不存在的素材或轨道", { id: orphan.id }));
  return doc;
}

/** Rebuilds editor state. `resolveUrl` maps an absolute path to a URL the preview can load. */
export function readDocument(doc: ProjectDocument, resolveUrl: (absolutePath: string) => string): EditorState {
  const assets: Asset[] = doc.assets.map((stored) => ({
    id: stored.id,
    name: stored.name,
    kind: stored.kind,
    url: stored.absolutePath ? resolveUrl(stored.absolutePath) : "",
    sourcePath: stored.absolutePath,
    duration: stored.duration,
    width: stored.width,
    height: stored.height,
    hasAudio: stored.hasAudio,
    thumbnail: "",
    frames: [],
    peaks: [],
    peaksPerSecond: 0,
  }));
  return {
    id: doc.meta.id,
    title: doc.meta.title,
    createdAt: doc.meta.createdAt,
    ratio: doc.canvas.ratio,
    project: { tracks: doc.tracks, clips: doc.clips, markers: doc.markers, subtitles: doc.subtitles, ...(doc.transcripts ? { transcripts: doc.transcripts } : {}), ...(doc.stems ? { stems: doc.stems } : {}) },
    assets,
    captionStyle: doc.captionStyle,
    captionMode: doc.captionMode,
    exportSettings: doc.exportSettings,
    cover: normalizeCover(doc.cover),
  };
}
