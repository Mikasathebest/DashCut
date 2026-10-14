// Samples a clip's frames and finds the main face with MediaPipe BlazeFace (runs locally in the renderer).
import type { Asset, Clip } from "./model";
import { sourceRangeToTimeline } from "./model";
import { chooseSubject, SubjectSample } from "./reframe";

type Detector = { detect: (image: HTMLCanvasElement) => { detections: Array<{ boundingBox?: { originX: number; width: number; height: number } }> }; close: () => void };
let detector: Promise<Detector> | null = null;

/** Loads the vision runtime from the app bundle and the model bytes provided by the main process. */
export function loadFaceDetector(modelBytes: () => Promise<ArrayBuffer>) {
  detector ??= (async () => {
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks("/vendor/mediapipe");
    return vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(await modelBytes()), delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    }) as unknown as Promise<Detector>;
  })().catch((error) => {
    detector = null;
    throw error;
  });
  return detector;
}

function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", fail); resolve(); };
    const fail = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", fail); reject(new Error("无法读取视频画面")); };
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = time;
  });
}

/**
 * The detector shrinks its input to 128 px, so faces in wide frames get tiny. Detecting on overlapping
 * square tiles (left, middle, right) keeps them large; duplicates from the overlaps are merged.
 */
function detectTiled(found: Detector, canvas: HTMLCanvasElement) {
  const side = Math.min(canvas.width, canvas.height);
  const offsets = canvas.width / canvas.height > 1.2 ? [0, (canvas.width - side) / 2, canvas.width - side] : [0];
  const tile = document.createElement("canvas");
  tile.width = canvas.width / canvas.height > 1.2 ? side : canvas.width;
  tile.height = canvas.width / canvas.height > 1.2 ? side : canvas.height;
  const context = tile.getContext("2d")!;
  const faces: Array<{ center: number; size: number }> = [];
  for (const offset of offsets) {
    context.drawImage(canvas, offset, 0, tile.width, tile.height, 0, 0, tile.width, tile.height);
    for (const detection of found.detect(tile).detections) {
      const box = detection.boundingBox;
      if (!box) continue;
      const center = (offset + box.originX + box.width / 2) / canvas.width;
      const duplicate = faces.find((face) => Math.abs(face.center - center) < box.width / canvas.width / 2);
      if (duplicate) duplicate.size = Math.max(duplicate.size, box.width * box.height);
      else faces.push({ center, size: box.width * box.height });
    }
  }
  return faces;
}

/** Subject centre (0..1 of the cropped width) every `interval` seconds of the clip, in clip-local time. */
export async function trackSubject(asset: Asset, clip: Clip, found: Detector, interval = 0.25, onProgress?: (fraction: number) => void): Promise<SubjectSample[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = asset.url;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error(`无法打开 ${asset.name}`)), { once: true });
  });
  const canvas = document.createElement("canvas");
  const width = 640;
  const cropWidth = video.videoWidth * clip.crop.w;
  const cropHeight = video.videoHeight * clip.crop.h;
  canvas.width = width;
  canvas.height = Math.round((width * cropHeight) / cropWidth);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const samples: SubjectSample[] = [];
  const steps = Math.max(1, Math.ceil((clip.out - clip.in) / interval));
  let previous: number | null = null;
  for (let step = 0; step <= steps; step += 1) {
    const source = Math.min(clip.out - 0.02, clip.in + step * interval);
    await seek(video, source);
    context.drawImage(video, clip.crop.x * video.videoWidth, clip.crop.y * video.videoHeight, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    const faces = detectTiled(found, canvas);
    const center = chooseSubject(faces, previous);
    if (center !== null) previous = center;
    // Mirrored clips show the subject on the other side.
    const mirrored = center === null ? null : clip.mirror ? 1 - center : center;
    const mapped = sourceRangeToTimeline(clip, source, source + 0.001);
    samples.push({ time: mapped ? mapped.start - clip.start : step * interval, center: mirrored });
    onProgress?.((step + 1) / (steps + 1));
  }
  video.removeAttribute("src");
  video.load();
  return samples;
}
