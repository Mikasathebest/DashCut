// Browser-side media probing: durations, dimensions, first-frame thumbnails and filmstrips.
import { Asset, defaultStillDuration, MediaKind, uid } from "./model";

const filmstripFrames = 24;

function waitFor(element: HTMLMediaElement, event: string) {
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      element.removeEventListener(event, onEvent);
      element.removeEventListener("error", onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    element.addEventListener(event, onEvent, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    // Project media is served from a custom scheme; anonymous CORS keeps canvases readable.
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image.naturalWidth > 0 ? image : null);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

// Sums GIF frame delays by walking the block structure.
export function readGifTiming(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let frames = 0;
  let seconds = 0;
  if (bytes.length < 13 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== "GIF") return { frames, seconds };
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  const skipSubBlocks = () => {
    while (offset < bytes.length && bytes[offset]) offset += bytes[offset] + 1;
    offset += 1;
  };
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x21) {
      if (bytes[offset + 1] === 0xf9) seconds += (bytes[offset + 4] | (bytes[offset + 5] << 8) || 10) / 100;
      offset += 2;
      skipSubBlocks();
    } else if (block === 0x2c) {
      const packed = bytes[offset + 9];
      offset += 10;
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
      offset += 1;
      skipSubBlocks();
      frames += 1;
    } else break;
  }
  return { frames, seconds };
}

function drawFrame(source: CanvasImageSource, width: number, height: number, maxWidth: number) {
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

async function seek(video: HTMLVideoElement, time: number) {
  const ready = waitFor(video, "seeked");
  video.currentTime = time;
  return ready;
}

/** Probes one imported file. Returns null when the browser cannot decode it. */
export async function probeFile(file: File, sourcePath: string): Promise<Asset | null> {
  const url = URL.createObjectURL(file);
  const fail = () => {
    URL.revokeObjectURL(url);
    return null;
  };
  const base = { id: uid("asset"), name: file.name, url, sourcePath, frames: [] as string[], peaks: [] as number[], peaksPerSecond: 0 };
  if (file.type.startsWith("image/")) {
    const image = await loadImage(url);
    if (!image) return fail();
    let kind: MediaKind = "image";
    let duration = defaultStillDuration;
    if (file.type === "image/gif") {
      const { frames, seconds } = readGifTiming(await file.arrayBuffer());
      // Repeat short animations whole so the loop does not jump mid-cycle.
      if (frames > 1 && seconds > 0) {
        kind = "gif";
        duration = seconds * Math.max(1, Math.ceil(defaultStillDuration / seconds));
      }
    }
    return { ...base, kind, duration, width: image.naturalWidth, height: image.naturalHeight, hasAudio: false, thumbnail: drawFrame(image, image.naturalWidth, image.naturalHeight, 240) };
  }
  if (file.type.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    if (!(await waitFor(audio, "loadedmetadata")) || !Number.isFinite(audio.duration) || audio.duration <= 0) return fail();
    return { ...base, kind: "audio", duration: audio.duration, width: 0, height: 0, hasAudio: true, thumbnail: "" };
  }
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = url;
  if (!(await waitFor(video, "loadeddata")) || !Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth) return fail();
  await seek(video, Math.min(0.05, video.duration / 2));
  const thumbnail = drawFrame(video, video.videoWidth, video.videoHeight, 240);
  return { ...base, kind: "video", duration: video.duration, width: video.videoWidth, height: video.videoHeight, hasAudio: true, thumbnail };
}

/** Builds evenly spaced filmstrip frames for timeline previews. */
export async function buildFilmstrip(asset: Asset) {
  if (asset.kind !== "video") return [];
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.crossOrigin = "anonymous";
  video.src = asset.url;
  if (!(await waitFor(video, "loadeddata"))) return [];
  const frames: string[] = [];
  for (let index = 0; index < filmstripFrames; index += 1) {
    const time = Math.min(asset.duration - 0.05, (asset.duration * (index + 0.5)) / filmstripFrames);
    if (!(await seek(video, Math.max(0, time)))) break;
    frames.push(drawFrame(video, video.videoWidth, video.videoHeight, 120));
  }
  video.removeAttribute("src");
  video.load();
  return frames;
}

/** Captures the frame at `time` of a video asset as a data URL. */
export async function captureFrame(asset: Asset, time: number, maxWidth = 1280) {
  if (asset.kind !== "video") return asset.kind === "audio" ? "" : asset.url;
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.crossOrigin = "anonymous";
  video.src = asset.url;
  if (!(await waitFor(video, "loadeddata"))) return "";
  await seek(video, Math.max(0, Math.min(asset.duration - 0.05, time)));
  const frame = drawFrame(video, video.videoWidth, video.videoHeight, maxWidth);
  video.removeAttribute("src");
  video.load();
  return frame;
}

/** Rebuilds the library thumbnail for media reopened from a project file. */
export async function buildThumbnail(asset: Asset) {
  if (asset.kind === "audio" || !asset.url) return "";
  if (asset.kind === "video") return captureFrame(asset, Math.min(0.05, asset.duration / 2), 240);
  const image = await loadImage(asset.url);
  return image ? drawFrame(image, image.naturalWidth, image.naturalHeight, 240) : "";
}
