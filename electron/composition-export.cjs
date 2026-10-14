/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { createAss, createSrt, resolveFfmpegExecutable, videoEncoderArgs } = require("./video-export.cjs");

// Multi-track composition exporter. Implements the CompositionRequest contract documented in
// types/dashcut.d.ts with filters available in the bundled LGPL FFmpeg build (no eq/boxblur/PNG).

const ANIMATION_TYPES = new Set(["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "zoom-out"]);

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Compact decimal formatting for filter arguments (no exponent notation).
function f(value) {
  const rounded = Math.round(num(value) * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function even(value) {
  return Math.max(2, Math.ceil(value / 2) * 2);
}

function escapeFilterPath(target) {
  return target.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

function ffmpegColor(hex) {
  const value = String(hex || "#00ff00").trim().replace(/^#/, "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  return /^[0-9a-fA-F]{6}$/.test(full) ? `0x${full.toLowerCase()}` : "0x00ff00";
}

function clipSpeed(visualOrAudio) {
  return clamp(num(visualOrAudio.speed, 1) || 1, 0.1, 10);
}

/** Timeline length of a clip: (out - in) / speed; images ignore speed. */
function clipDuration(clip, kind = clip.kind) {
  const range = Math.max(0, num(clip.out) - num(clip.in));
  return kind === "image" ? range : range / clipSpeed(clip);
}

/** atempo accepts 0.5..100 per instance; split slower factors into a chain. */
function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-6) return [];
  const filters = [];
  let remaining = speed;
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  if (Math.abs(remaining - 1) > 1e-6) filters.push(`atempo=${f(remaining)}`);
  return filters;
}

function normalizeAnimation(animation) {
  const type = ANIMATION_TYPES.has(animation?.type) ? animation.type : "none";
  const duration = Math.max(0, num(animation?.duration));
  return type === "none" || duration <= 0 ? { type: "none", duration: 0 } : { type, duration };
}

/**
 * Expression helpers for in/out animation progress. `t` is timeline time.
 * p_in rises 0→1 over [start, start + dIn]; p_out falls 1→0 over [end - dOut, end].
 */
function progressExpressions(start, end, animIn, animOut) {
  const pIn = animIn.type === "none" ? "1" : `clip((t-${f(start)})/${f(animIn.duration)},0,1)`;
  const pOut = animOut.type === "none" ? "1" : `clip((${f(end)}-t)/${f(animOut.duration)},0,1)`;
  return { pIn, pOut };
}

function slideTerm(animation, progress, axis, size) {
  const sign = { "slide-left": ["x", -1], "slide-right": ["x", 1], "slide-up": ["y", -1], "slide-down": ["y", 1] }[animation.type];
  if (!sign || sign[0] !== axis) return "";
  return `${sign[1] < 0 ? "-" : "+"}(1-${progress})*${size}`;
}

function zoomTerm(animation, progress) {
  if (animation.type === "zoom-in") return `(0.5+0.5*${progress})`;
  if (animation.type === "zoom-out") return `(1.5-0.5*${progress})`;
  return "";
}

function adjustFilters(adjust) {
  const brightness = clamp(num(adjust?.brightness, 0), -1, 1);
  const contrast = clamp(num(adjust?.contrast, 1), 0, 2);
  const saturation = clamp(num(adjust?.saturation, 1), 0, 3);
  const temperature = clamp(num(adjust?.temperature, 0), -1, 1);
  const filters = [];
  if (brightness !== 0 || contrast !== 1 || temperature !== 0) {
    // CSS-equivalent order: brightness(1+b) then contrast(c) around mid-grey. Temperature is a
    // per-channel gain (warm > 0 boosts red and cuts blue by up to 15 %).
    const channel = (gain) => `'clip((val*${f((1 + brightness) * gain)}/255-0.5)*${f(contrast)}*255+127.5,0,255)'`;
    filters.push(`lutrgb=r=${channel(1 + 0.15 * temperature)}:g=${channel(1)}:b=${channel(1 - 0.15 * temperature)}`);
  }
  if (saturation !== 1) filters.push(`hue=s=${f(saturation)}`);
  return filters;
}

function effectFilters(effects) {
  const list = Array.isArray(effects) ? effects : [];
  const filters = [];
  for (const effect of list) {
    if (effect === "bw") filters.push("hue=s=0");
    else if (effect === "vintage") filters.push("colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131");
    else if (effect === "vignette") filters.push("vignette=angle=PI/4");
    else if (effect === "sharpen") filters.push("unsharp=5:5:0.8:5:5:0");
    else if (effect === "denoise") filters.push("atadenoise");
    else if (effect === "beauty") filters.push("bilateral=sigmaS=4:sigmaR=0.06");
    else if (effect === "blur") filters.push("gblur=sigma=8");
  }
  return filters;
}

/** Input arguments (placed before `-i`) for one visual layer. */
function visualInputArgs(visual, fps, sourcePath) {
  const length = clipDuration(visual);
  if (visual.kind === "image") return ["-loop", "1", "-framerate", String(fps), "-t", f(length + 1 / fps), "-i", sourcePath];
  if (visual.kind === "gif") return ["-ignore_loop", "0", "-t", f(num(visual.out) + 1), "-i", sourcePath];
  if (visual.freezeAt !== null && visual.freezeAt !== undefined && Number.isFinite(Number(visual.freezeAt))) {
    return ["-ss", f(Math.max(0, num(visual.freezeAt))), "-t", "1", "-i", sourcePath];
  }
  return ["-ss", f(Math.max(0, num(visual.in))), "-t", f(Math.max(0, num(visual.out) - num(visual.in))), "-i", sourcePath];
}

function isFrozen(visual) {
  return visual.kind === "video" && visual.freezeAt !== null && visual.freezeAt !== undefined && Number.isFinite(Number(visual.freezeAt));
}

/** Filter chain that turns input stream `label` into a positioned RGBA layer `[out]`. */
function visualLayerChain(visual, index, inputLabel, settings) {
  const { width: W, height: H, fps } = settings;
  const start = Math.max(0, num(visual.start));
  const length = clipDuration(visual);
  const end = start + length;
  const speed = clipSpeed(visual);
  const filters = [];

  // 1. Timing: source range → layer-local timeline [0, length).
  if (isFrozen(visual)) {
    filters.push("trim=end_frame=1", "setpts=PTS-STARTPTS", "loop=loop=-1:size=1:start=0", `fps=${fps}`);
  } else if (visual.kind === "image") {
    filters.push("setpts=PTS-STARTPTS", `fps=${fps}`);
  } else {
    if (visual.kind === "gif") filters.push(`trim=start=${f(Math.max(0, num(visual.in)))}`);
    filters.push("setpts=PTS-STARTPTS");
    if (visual.reverse) filters.push("reverse");
    if (Math.abs(speed - 1) > 1e-6) filters.push(`setpts=PTS/${f(speed)}`);
    filters.push(`fps=${fps}`);
  }
  filters.push(`trim=duration=${f(length)}`, "setpts=PTS-STARTPTS", "format=rgba", "setsar=1");

  // 2. Source geometry: crop (normalized) → mirror → rotate90 clockwise.
  const crop = visual.crop || { x: 0, y: 0, w: 1, h: 1 };
  const cx = clamp(num(crop.x, 0), 0, 1);
  const cy = clamp(num(crop.y, 0), 0, 1);
  const cw = clamp(num(crop.w, 1), 0.01, 1 - cx);
  const ch = clamp(num(crop.h, 1), 0.01, 1 - cy);
  if (cx > 0 || cy > 0 || cw < 1 || ch < 1) {
    filters.push(`crop=w='max(1,floor(iw*${f(cw)}))':h='max(1,floor(ih*${f(ch)}))':x='floor(iw*${f(cx)})':y='floor(ih*${f(cy)})':exact=1`);
  }
  if (visual.mirror) filters.push("hflip");
  const quarter = num(visual.rotate90, 0);
  if (quarter === 90) filters.push("transpose=clock");
  else if (quarter === 180) filters.push("hflip", "vflip");
  else if (quarter === 270) filters.push("transpose=cclock");

  // 3. Contain-fit into the canvas, scaled by transform.scale (static part).
  const transform = visual.transform || {};
  const scale = clamp(num(transform.scale, 1), 0.01, 20);
  const boxW = Math.max(2, Math.round(W * scale));
  const boxH = Math.max(2, Math.round(H * scale));
  filters.push(`scale=w=${boxW}:h=${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic`, "setsar=1");

  // 4. Look: adjust → effects → chroma key.
  filters.push(...adjustFilters(visual.adjust));
  filters.push(...effectFilters(visual.effects));
  const effects = Array.isArray(visual.effects) ? visual.effects : [];
  if (effects.includes("chroma-key")) {
    const similarity = clamp(num(visual.chromaKey?.similarity, 0.3), 0.01, 1);
    filters.push("format=yuva444p", `chromakey=color=${ffmpegColor(visual.chromaKey?.color)}:similarity=${f(similarity)}:blend=${f(Math.min(0.2, similarity / 3))}`, "format=rgba");
  }

  // 5. Move onto the timeline so frame timestamps equal composition time.
  filters.push(`setpts=PTS+${f(start)}/TB`);

  // 6. Animated zoom keeps a constant frame size: scale per frame, then pad into a fixed box.
  const animIn = normalizeAnimation(visual.animationIn);
  const animOut = normalizeAnimation(visual.animationOut);
  const { pIn, pOut } = progressExpressions(start, end, animIn, animOut);
  const zoomParts = [zoomTerm(animIn, pIn), zoomTerm(animOut, pOut)].filter(Boolean);
  if (zoomParts.length) {
    const maxZoom = [animIn, animOut].some((item) => item.type === "zoom-out") ? 1.5 : 1;
    const zoom = zoomParts.join("*");
    filters.push(
      `scale=w='max(2,trunc(iw*${zoom}/2)*2)':h='max(2,trunc(ih*${zoom}/2)*2)':eval=frame:flags=bicubic`,
      `pad=w=${even(boxW * maxZoom) + 2}:h=${even(boxH * maxZoom) + 2}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame`,
    );
  }

  // 7. Rotation about the centre, then opacity and fades on the alpha channel.
  const rotation = num(transform.rotation, 0) % 360;
  if (Math.abs(rotation) > 1e-6) {
    const radians = f((rotation * Math.PI) / 180);
    filters.push(`rotate=a=${radians}:ow='rotw(${radians})':oh='roth(${radians})':c=black@0:bilinear=1`);
  }
  const opacity = clamp(num(transform.opacity, 1), 0, 1);
  if (opacity < 1) filters.push(`colorchannelmixer=aa=${f(opacity)}`);
  if (animIn.type === "fade") filters.push(`fade=t=in:st=${f(start)}:d=${f(Math.min(animIn.duration, length))}:alpha=1`);
  if (animOut.type === "fade") {
    const fadeDuration = Math.min(animOut.duration, length);
    filters.push(`fade=t=out:st=${f(end - fadeDuration)}:d=${f(fadeDuration)}:alpha=1`);
  }

  const layerLabel = `layer${index}`;
  const chain = `[${inputLabel}]${filters.join(",")}[${layerLabel}]`;

  // Overlay position: centre at (W/2 + x*W, H/2 + y*H) plus slide offsets.
  const slideX = [slideTerm(animIn, pIn, "x", "main_w"), slideTerm(animOut, pOut, "x", "main_w")].join("");
  const slideY = [slideTerm(animIn, pIn, "y", "main_h"), slideTerm(animOut, pOut, "y", "main_h")].join("");
  const x = `main_w/2+${f(num(transform.x, 0))}*main_w-overlay_w/2${slideX}`;
  const y = `main_h/2+${f(num(transform.y, 0))}*main_h-overlay_h/2${slideY}`;
  const enable = `between(t,${f(start)},${f(end - 1 / (fps * 4))})`;
  return { chain, layerLabel, overlay: `overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:format=auto:enable='${enable}'`, start, end };
}

function audioEffectFilters(effects) {
  const filters = [];
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (effect === "denoise") filters.push("afftdn=nr=12:nf=-40");
    else if (effect === "voice-enhance") filters.push("highpass=f=80", "acompressor=threshold=0.125:ratio=3:attack=10:release=200:makeup=1.5");
    else if (effect === "loudnorm") filters.push("loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000");
  }
  return filters;
}

/** Audio chain for one clip: trim (input side) → reverse → speed → effects → volume → fades → delay. */
function audioClipChain(clip, inputLabel, outLabel, options = {}) {
  const settings = clip.audio || {};
  const start = Math.max(0, num(clip.start));
  const length = clipDuration(clip, "audio");
  const filters = ["asetpts=PTS-STARTPTS", "aresample=48000", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
  if (options.reverse) filters.push("areverse");
  filters.push(...atempoChain(clipSpeed(clip)));
  filters.push(...audioEffectFilters(settings.effects));
  filters.push(`atrim=duration=${f(length)}`, "asetpts=PTS-STARTPTS");
  const volume = clamp(num(settings.volume, 1), 0, 2);
  if (volume !== 1) filters.push(`volume=${f(volume)}`);
  const fadeIn = Math.min(Math.max(0, num(settings.fadeIn)), length);
  const fadeOut = Math.min(Math.max(0, num(settings.fadeOut)), length);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${f(fadeIn)}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${f(length - fadeOut)}:d=${f(fadeOut)}`);
  if (start > 0) filters.push(`adelay=delays=${Math.round(start * 1000)}:all=1`);
  return `[${inputLabel}]${filters.join(",")}[${outLabel}]`;
}

/**
 * Pure builder: returns FFmpeg input args, the filter_complex graph and output map labels.
 * `sources` optionally maps visual index → replacement path (e.g. prepared JPEG stills);
 * `silentVisuals` is a Set of visual indices whose file turned out to have no audio stream.
 */
function buildCompositionGraph(request, options = {}) {
  const W = even(num(request.width, 1920));
  const H = even(num(request.height, 1080));
  const fps = request.fps === 60 ? 60 : 30;
  const duration = Math.max(0.1, num(request.duration, 0));
  const sources = options.sources || {};
  const silentVisuals = options.silentVisuals || new Set();
  const settings = { width: W, height: H, fps };
  const inputs = [];
  const chains = [];
  const audioLabels = [];
  let inputIndex = 0;

  chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f(duration)},format=yuv420p,setsar=1[base0]`);
  let current = "base0";
  const visuals = (Array.isArray(request.visuals) ? request.visuals : []).filter((visual) => clipDuration(visual) > 0 && num(visual.start) < duration);
  visuals.forEach((visual, index) => {
    const sourcePath = sources[index] || visual.path;
    inputs.push(...visualInputArgs(visual, fps, sourcePath));
    const layer = visualLayerChain(visual, index, `${inputIndex}:v:0`, settings);
    chains.push(layer.chain);
    const next = `base${index + 1}`;
    chains.push(`[${current}][${layer.layerLabel}]${layer.overlay}[${next}]`);
    current = next;
    const settingsAudio = visual.audio || {};
    if (visual.kind === "video" && visual.hasAudio && !settingsAudio.muted && !isFrozen(visual) && !silentVisuals.has(index)) {
      const label = `va${index}`;
      chains.push(audioClipChain(visual, `${inputIndex}:a:0`, label, { reverse: Boolean(visual.reverse) }));
      audioLabels.push(label);
    }
    inputIndex += 1;
  });

  const audios = (Array.isArray(request.audios) ? request.audios : []).filter((clip) => clipDuration(clip, "audio") > 0 && num(clip.start) < duration && !clip.audio?.muted);
  audios.forEach((clip, index) => {
    inputs.push("-ss", f(Math.max(0, num(clip.in))), "-t", f(Math.max(0, num(clip.out) - num(clip.in))), "-i", clip.path);
    const label = `aa${index}`;
    chains.push(audioClipChain(clip, `${inputIndex}:a:0`, label));
    audioLabels.push(label);
    inputIndex += 1;
  });

  // JPEG stills tag frames as full range; the canvas is limited range, so retag the output for players and uploads.
  if (options.assPath) chains.push(`[${current}]ass='${escapeFilterPath(options.assPath)}',format=yuv420p,setparams=range=tv[vout]`);
  else chains.push(`[${current}]format=yuv420p,setparams=range=tv[vout]`);

  if (audioLabels.length) {
    const mixed = audioLabels.length === 1 ? `[${audioLabels[0]}]anull` : `${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0`;
    chains.push(`${mixed},apad=whole_dur=${f(duration)},atrim=duration=${f(duration)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`);
  } else {
    chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f(duration)}[aout]`);
  }

  return { inputs, filterGraph: chains.join(";\n"), videoLabel: "vout", audioLabel: "aout", width: W, height: H, fps, duration };
}

/** True when FFmpeg reports an audio stream in `file` (guards against stale `hasAudio` flags). */
function probeHasAudio(file, options) {
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpegExecutable(options), ["-hide_banner", "-i", file], { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => resolve(true));
    child.on("close", () => resolve(/Stream #\d+:\d+[^\n]*: Audio:/.test(stderr)));
  });
}

function runFfmpeg(args, onTime, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(options), ["-hide_banner", "-y", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-30_000);
      const latest = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
      if (latest && onTime) onTime(Number(latest[1]) * 3600 + Number(latest[2]) * 60 + Number(latest[3]));
    });
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error("安装包缺少 LGPL FFmpeg 运行时，请重新安装 DashCut 极剪") : error));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n") || `FFmpeg exited with ${code}`)));
  });
}

async function exportComposition(request, options) {
  const visuals = Array.isArray(request.visuals) ? request.visuals : [];
  if (!visuals.length && !(request.audios || []).length) throw new Error("时间线中没有可导出的内容");
  const duration = num(request.duration);
  if (!(duration > 0)) throw new Error("导出时长无效");
  const exportPlatform = options.platform ?? process.platform;
  const tempDir = await mkdtemp(path.join(options.tempPath, "dashcut-composition-"));
  const emit = (progress, stage) => options.onProgress?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), stage });
  try {
    emit(0, "正在准备素材");
    const width = even(num(request.width, 1920));
    const height = even(num(request.height, 1080));
    const assPath = path.join(tempDir, "subtitles.ass");
    await writeFile(assPath, createAss(request.subtitles || [], request.subtitleStyle || {}, width, height), "utf8");

    // The LGPL FFmpeg build has no PNG decoder, so the host re-encodes stills to JPEG first.
    const sources = {};
    const prepared = new Map();
    const usable = visuals.filter((visual) => clipDuration(visual) > 0 && num(visual.start) < duration);
    for (const [index, visual] of usable.entries()) {
      if (visual.kind !== "image" || !options.prepareStill) continue;
      if (!prepared.has(visual.path)) prepared.set(visual.path, await options.prepareStill(visual.path, path.join(tempDir, `still-${prepared.size}.jpg`)));
      sources[index] = prepared.get(visual.path);
    }

    const silentVisuals = new Set();
    const audioChecks = new Map();
    for (const [index, visual] of usable.entries()) {
      if (visual.kind !== "video" || !visual.hasAudio || visual.audio?.muted || isFrozen(visual)) continue;
      if (!audioChecks.has(visual.path)) audioChecks.set(visual.path, probeHasAudio(visual.path, options));
      if (!(await audioChecks.get(visual.path))) silentVisuals.add(index);
    }

    const graph = buildCompositionGraph(request, { sources, assPath, silentVisuals });
    const graphPath = path.join(tempDir, "graph.txt");
    await writeFile(graphPath, graph.filterGraph, "utf8");
    const hardwareModes = exportPlatform === "win32" ? [true, false] : [undefined];
    let finalError;
    for (const hardware of hardwareModes) {
      const encoderArgs = videoEncoderArgs(exportPlatform, { width: graph.width, height: graph.height, fps: graph.fps, destination: request.platform, finalPass: true, hardware });
      const args = [
        ...graph.inputs,
        "-/filter_complex", graphPath,
        "-map", `[${graph.videoLabel}]`, "-map", `[${graph.audioLabel}]`,
        ...encoderArgs,
        "-r", String(graph.fps), "-pix_fmt", exportPlatform === "win32" ? "nv12" : "yuv420p", "-color_range", "tv", "-tag:v", "avc1",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f(graph.duration), "-movflags", "+faststart", options.outputPath,
      ];
      try {
        await runFfmpeg(args, (time) => emit(Math.min(99, (time / graph.duration) * 100), hardware === false ? "正在使用兼容模式完成导出" : "正在合成多轨视频"), options);
        finalError = undefined;
        break;
      } catch (error) {
        finalError = error;
      }
    }
    if (finalError) throw finalError;

    const base = options.outputPath.replace(/\.[^.]+$/, "");
    await Promise.all([
      writeFile(`${base}.zh.srt`, createSrt(request.subtitles || [], "zh"), "utf8"),
      writeFile(`${base}.en.srt`, createSrt(request.subtitles || [], "en"), "utf8"),
    ]);
    emit(100, "导出完成");
    return { outputPath: options.outputPath, duration: graph.duration, subtitleFiles: [`${base}.zh.srt`, `${base}.en.srt`] };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { atempoChain, buildCompositionGraph, clipDuration, exportComposition };
