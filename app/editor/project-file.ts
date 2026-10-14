// Versioned on-disk project document (*.dashcut). Pure: no DOM, no fs.
import type { Asset, Clip, Marker, Project, Subtitle, Track } from "./model";

export const projectSchemaVersion = 2;
export const projectExtension = "dashcut";

export type CaptionStyle = { fontFamily: string; fontSize: number; color: string; outlineColor: string; outlineWidth: number; backgroundOpacity: number };
export type CaptionMode = "zh" | "en" | "both";
export type ExportSettings = { resolution: 720 | 1080 | 2160; fps: 30 | 60; platform: "bilibili" | "youtube" };

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

/** Reserved for upcoming features so older files stay readable once they land. */
export type KeyframeTrack = { property: string; keyframes: Array<{ time: number; value: number; easing?: string }> };
export type StoredClip = Clip & { keyframes?: KeyframeTrack[]; speedCurve?: Array<{ x: number; y: number }> };

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
  captionStyle: CaptionStyle;
  captionMode: CaptionMode;
  exportSettings: ExportSettings;
  cover: { title: string; accent: string };
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
  cover: { title: string; accent: string };
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
  if (!input || typeof input !== "object") throw new Error("项目文件格式无效");
  let doc = input as Record<string, unknown>;
  if (doc.app !== "DashCut") throw new Error("不是 DashCut 项目文件");
  let version = Number(doc.schemaVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error("项目文件缺少版本号");
  if (version > projectSchemaVersion) throw new Error(`项目由更新版本的 DashCut 创建（版本 ${version}），请升级后再打开`);
  while (version < projectSchemaVersion) {
    const step = migrations[version];
    if (!step) throw new Error(`无法从版本 ${version} 升级项目文件`);
    doc = step(doc);
    version = Number(doc.schemaVersion);
  }
  return validateDocument(doc as ProjectDocument);
}

function validateDocument(doc: ProjectDocument) {
  for (const key of ["assets", "tracks", "clips", "markers", "subtitles"] as const) {
    if (!Array.isArray(doc[key])) throw new Error(`项目文件缺少 ${key}`);
  }
  if (!doc.tracks.some((track) => track.main)) throw new Error("项目文件缺少主轨");
  const assetIds = new Set(doc.assets.map((asset) => asset.id));
  const trackIds = new Set(doc.tracks.map((track) => track.id));
  const orphan = doc.clips.find((clip) => !assetIds.has(clip.assetId) || !trackIds.has(clip.trackId));
  if (orphan) throw new Error(`片段 ${orphan.id} 引用了不存在的素材或轨道`);
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
    project: { tracks: doc.tracks, clips: doc.clips, markers: doc.markers, subtitles: doc.subtitles },
    assets,
    captionStyle: doc.captionStyle,
    captionMode: doc.captionMode,
    exportSettings: doc.exportSettings,
    cover: doc.cover,
  };
}
