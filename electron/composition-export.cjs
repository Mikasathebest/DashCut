/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createAss, createSrt, resolveFfmpegExecutable, videoEncoderArgs } = require("./video-export.cjs");

// Multi-track composition exporter. Implements the CompositionRequest contract documented in
// types/dashcut.d.ts with filters available in the bundled LGPL FFmpeg build (no eq/boxblur/PNG).

const ANIMATION_TYPES = new Set(["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom-in", "zoom-out", "wipe-left", "wipe-right"]);
const EASINGS = new Set(["linear", "ease-in", "ease-out", "ease-in-out", "hold"]);

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

/** Timeline length of a clip: (out - in) / speed; stills (images, RGBA frames) ignore speed. */
function clipDuration(clip, kind = clip.kind) {
  const range = Math.max(0, num(clip.out) - num(clip.in));
  return kind === "image" || kind === "rgba" ? range : range / clipSpeed(clip);
}

/** Valid keyframe points sorted by time, or null when the property is not keyframed. */
function normalizeKeyframes(points) {
  if (!Array.isArray(points)) return null;
  const valid = points
    .filter((point) => point && Number.isFinite(Number(point.time)) && Number.isFinite(Number(point.value)))
    .map((point) => ({ time: Number(point.time), value: Number(point.value), easing: EASINGS.has(point.easing) ? point.easing : "linear" }))
    .sort((a, b) => a.time - b.time);
  return valid.length ? valid : null;
}

function easeValue(easing, p) {
  if (easing === "ease-in") return p * p;
  if (easing === "ease-out") return 1 - (1 - p) * (1 - p);
  if (easing === "ease-in-out") return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
  if (easing === "hold") return 0;
  return p;
}

function easeExpression(easing, p) {
  if (easing === "ease-in") return `${p}*${p}`;
  if (easing === "ease-out") return `(1-(1-${p})*(1-${p}))`;
  if (easing === "ease-in-out") return `if(lt(${p},0.5),2*${p}*${p},1-2*(1-${p})*(1-${p}))`;
  if (easing === "hold") return "0";
  return p;
}

/**
 * Reference evaluator for keyframes at clip-local time `t`: holds the first/last value outside
 * the keyed range and interpolates each segment with the easing of its left point.
 */
function keyframeValue(points, t) {
  const list = normalizeKeyframes(points);
  if (!list) return undefined;
  if (t < list[0].time) return list[0].value;
  for (let index = 0; index < list.length - 1; index += 1) {
    const left = list[index];
    const right = list[index + 1];
    if (right.time > left.time && t < right.time) {
      return left.value + (right.value - left.value) * easeValue(left.easing, (t - left.time) / (right.time - left.time));
    }
  }
  return list.at(-1).value;
}

/** FFmpeg expression mirroring keyframeValue; `localTime` is an expression for clip-local seconds. */
function keyframeExpression(points, localTime) {
  const list = normalizeKeyframes(points);
  if (!list) return undefined;
  let expression = f(list.at(-1).value);
  for (let index = list.length - 2; index >= 0; index -= 1) {
    const left = list[index];
    const right = list[index + 1];
    if (!(right.time > left.time)) continue;
    const delta = right.value - left.value;
    const p = `((${localTime}-${f(left.time)})/${f(right.time - left.time)})`;
    const segment = left.easing === "hold" || delta === 0 ? f(left.value) : `(${f(left.value)}+${f(delta)}*${easeExpression(left.easing, p)})`;
    expression = `if(lt(${localTime},${f(right.time)}),${segment},${expression})`;
  }
  return list.length > 1 ? `if(lt(${localTime},${f(list[0].time)}),${f(list[0].value)},${expression})` : expression;
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
function progressExpressions(start, end, animIn, animOut, time = "t") {
  const pIn = animIn.type === "none" ? "1" : `clip((${time}-${f(start)})/${f(animIn.duration)},0,1)`;
  const pOut = animOut.type === "none" ? "1" : `clip((${f(end)}-${time})/${f(animOut.duration)},0,1)`;
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

/** geq alpha mask for wipes: wipe-right keeps the left p fraction, wipe-left the right p fraction. */
function wipeTerm(animation, progress) {
  if (animation.type === "wipe-right") return `lt(X,W*${progress})`;
  if (animation.type === "wipe-left") return `gte(X,W*(1-${progress}))`;
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
  if (visual.kind === "rgba") {
    // One raw RGBA8 frame; the layer chain loops it for the clip's duration.
    const rawWidth = Math.max(1, Math.round(num(visual.rgba?.width, 1)));
    const rawHeight = Math.max(1, Math.round(num(visual.rgba?.height, 1)));
    return ["-f", "rawvideo", "-pix_fmt", "rgba", "-video_size", `${rawWidth}x${rawHeight}`, "-framerate", String(fps), "-i", sourcePath];
  }
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

  // 1. Timing: source range → layer-local timeline [0, length). RGBA titles hold their single frame.
  if (isFrozen(visual) || visual.kind === "rgba") {
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

  // 3. Contain-fit into the canvas, scaled by transform.scale (static part). Keyframed scale fits
  // at its largest value and shrinks per frame in step 6, so the overlay frame size stays fixed.
  const transform = visual.transform || {};
  const keyframes = visual.keyframes || {};
  const local = (time) => `(${time}-${f(start)})`;
  const scaleKeys = normalizeKeyframes(keyframes.scale);
  const scale = clamp(scaleKeys ? Math.max(...scaleKeys.map((point) => point.value)) : num(transform.scale, 1), 0.01, 20);
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

  // 6a. Per-frame alpha for opacity keyframes and wipe masks, applied to the layer box (geq's T is timeline time).
  const animIn = normalizeAnimation(visual.animationIn);
  const animOut = normalizeAnimation(visual.animationOut);
  const { pIn, pOut } = progressExpressions(start, end, animIn, animOut);
  const geqProgress = progressExpressions(start, end, animIn, animOut, "T");
  const opacityExpression = keyframeExpression(keyframes.opacity, local("T"));
  // geq evaluates per pixel, so the time-only values are computed once per row (X = 0, rows never
  // span slice threads) into st() registers, and only the alpha plane is processed.
  const stores = [];
  const alphaFactors = [];
  if (opacityExpression) {
    stores.push(`st(0,clip(${opacityExpression},0,1))`);
    alphaFactors.push("ld(0)");
  }
  [[animIn, geqProgress.pIn, 1], [animOut, geqProgress.pOut, 2]].forEach(([animation, progress, register]) => {
    const term = wipeTerm(animation, `ld(${register})`);
    if (!term) return;
    stores.push(`st(${register},${progress})`);
    alphaFactors.push(term);
  });
  if (alphaFactors.length) {
    const colour = `kc${index}`;
    const alpha = `ka${index}`;
    const mask = `km${index}`;
    const expression = `if(eq(X,0),${stores.join("+")},0);p(X,Y)*${alphaFactors.join("*")}`;
    filters.push(`split[${colour}][${alpha}];[${alpha}]alphaextract,geq=lum='${expression}'[${mask}];[${colour}][${mask}]alphamerge`, "format=rgba");
  }

  // 6b. Animated zoom and keyframed scale keep a constant frame size: scale per frame, then pad into a fixed box.
  const scaleExpression = keyframeExpression(keyframes.scale, local("t"));
  const zoomParts = [
    scaleExpression ? `(clip(${scaleExpression},0.01,20)/${f(scale)})` : "",
    zoomTerm(animIn, pIn),
    zoomTerm(animOut, pOut),
  ].filter(Boolean);
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
  const rotationExpression = keyframeExpression(keyframes.rotation, local("t"));
  if (rotationExpression) {
    // A canvas as wide as the diagonal fits the layer at any angle.
    const side = "ceil(hypot(iw,ih)/2)*2";
    filters.push(`rotate=a='(${rotationExpression})*PI/180':ow='${side}':oh='${side}':c=black@0:bilinear=1`);
  } else if (Math.abs(rotation) > 1e-6) {
    const radians = f((rotation * Math.PI) / 180);
    filters.push(`rotate=a=${radians}:ow='rotw(${radians})':oh='roth(${radians})':c=black@0:bilinear=1`);
  }
  const opacity = clamp(num(transform.opacity, 1), 0, 1);
  if (!opacityExpression && opacity < 1) filters.push(`colorchannelmixer=aa=${f(opacity)}`);
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
  const xExpression = keyframeExpression(keyframes.x, local("t"));
  const yExpression = keyframeExpression(keyframes.y, local("t"));
  const x = `main_w/2+${xExpression ? `(${xExpression})` : f(num(transform.x, 0))}*main_w-overlay_w/2${slideX}`;
  const y = `main_h/2+${yExpression ? `(${yExpression})` : f(num(transform.y, 0))}*main_h-overlay_h/2${slideY}`;
  const enable = `between(t,${f(start)},${f(end - 1 / (fps * 4))})`;
  return { chain, layerLabel, overlay: `overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:format=auto:enable='${enable}'`, start, end };
}

// Gentle vocal polish: rumble cut, a little low warmth, presence lift, softened sibilance and light
// compression. Net boost stays ≤ +3 dB so a -6 dBFS signal does not clip.
const VOICE_BEAUTIFY = [
  "highpass=f=90",
  "lowshelf=f=200:g=1.5",
  "equalizer=f=3000:t=q:w=1:g=3",
  "highshelf=f=8000:g=-3",
  "acompressor=threshold=0.25:ratio=2:attack=15:release=250:makeup=1",
];

function audioEffectFilters(effects, settings = {}) {
  const filters = [];
  const target = settings.loudnessTarget;
  const loudness = target === null || target === undefined || !Number.isFinite(Number(target)) ? -16 : clamp(Number(target), -70, -5);
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (effect === "denoise") filters.push("afftdn=nr=12:nf=-40");
    else if (effect === "voice-enhance") filters.push("highpass=f=80", "acompressor=threshold=0.125:ratio=3:attack=10:release=200:makeup=1.5");
    else if (effect === "voice-beautify") filters.push(...VOICE_BEAUTIFY);
    else if (effect === "loudnorm") filters.push(`loudnorm=I=${f(loudness)}:TP=-1.5:LRA=11`, "aresample=48000");
  }
  return filters;
}

/** Pitch shift in semitones (-12..12) as a resampling ratio; 1 when unset. */
function pitchRatio(settings) {
  const semitones = clamp(num(settings?.pitch, 0), -12, 12);
  return Math.abs(semitones) < 1e-6 ? 1 : 2 ** (semitones / 12);
}

/**
 * Speed and pitch together: asetrate raises the pitch (and tempo) by r, aresample returns to
 * 48 kHz and one atempo chain applies speed / r, so the clip still lasts (out - in) / speed.
 */
function speedPitchFilters(speed, ratio) {
  if (ratio === 1) return atempoChain(speed);
  const rate = Math.round(48000 * ratio);
  return [`asetrate=${rate}`, "aresample=48000", ...atempoChain((speed * 48000) / rate)];
}

/** Channel layout remap on the stereo signal (mono sources are upmixed before this). */
function channelFilters(layout) {
  if (layout === "left") return ["pan=stereo|c0=c0|c1=c0"];
  if (layout === "right") return ["pan=stereo|c0=c1|c1=c1"];
  if (layout === "mono") return ["pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1"];
  if (layout === "swap") return ["pan=stereo|c0=c1|c1=c0"];
  return [];
}

/**
 * Stereo balance -1..1 with the equal-power (sin/cos) law, normalised to unity at the centre and
 * capped at unity: the far side follows √2·cos/sin of θ = (pan + 1)·π/4, the near side stays at 1.
 */
function panFilters(value) {
  const pan = clamp(num(value, 0), -1, 1);
  if (Math.abs(pan) < 1e-6) return [];
  const theta = ((pan + 1) * Math.PI) / 4;
  const left = Math.min(1, Math.SQRT2 * Math.cos(theta));
  const right = Math.min(1, Math.SQRT2 * Math.sin(theta));
  return [`pan=stereo|c0=${f(left)}*c0|c1=${f(right)}*c1`];
}

/** Audio chain for one clip: trim (input side) → reverse → speed/pitch → channels → pan → effects → volume → fades → delay. */
function audioClipChain(clip, inputLabel, outLabel, options = {}) {
  const settings = clip.audio || {};
  const start = Math.max(0, num(clip.start));
  const length = clipDuration(clip, "audio");
  const filters = ["asetpts=PTS-STARTPTS", "aresample=48000", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
  if (options.reverse) filters.push("areverse");
  filters.push(...speedPitchFilters(clipSpeed(clip), pitchRatio(settings)));
  filters.push(...channelFilters(settings.channels));
  filters.push(...panFilters(settings.pan));
  filters.push(...audioEffectFilters(settings.effects, settings));
  filters.push(`atrim=duration=${f(length)}`, "asetpts=PTS-STARTPTS");
  // After atrim/asetpts (and before adelay) t is clip-local timeline time, i.e. after the speed
  // change, which is how volume keyframe times are defined.
  const volumeExpression = keyframeExpression(settings.volumeKeyframes, "t");
  const volume = clamp(num(settings.volume, 1), 0, 2);
  if (volumeExpression) filters.push(`volume=eval=frame:volume='clip(${volumeExpression},0,2)'`);
  else if (volume !== 1) filters.push(`volume=${f(volume)}`);
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
 * `fps` overrides the request frame rate (GIF/analysis); `audioOnly` skips the picture entirely
 * (only audio inputs are added), `videoOnly` drops all audio (GIF); `videoTail` replaces the final video filters and `audioFilters`
 * are appended to the final mix (loudnorm, meters).
 */
function buildCompositionGraph(request, options = {}) {
  const W = even(num(request.width, 1920));
  const H = even(num(request.height, 1080));
  const fps = options.fps ? clamp(num(options.fps, 30), 1, 60) : request.fps === 60 ? 60 : 30;
  const duration = Math.max(0.1, num(request.duration, 0));
  const sources = options.sources || {};
  const silentVisuals = options.silentVisuals || new Set();
  const audioOnly = Boolean(options.audioOnly);
  const videoOnly = !audioOnly && Boolean(options.videoOnly);
  const settings = { width: W, height: H, fps };
  const inputs = [];
  const chains = [];
  const audioLabels = [];
  let inputIndex = 0;

  if (!audioOnly) chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f(duration)},format=yuv420p,setsar=1[base0]`);
  let current = "base0";
  const visuals = (Array.isArray(request.visuals) ? request.visuals : []).filter((visual) => clipDuration(visual) > 0 && num(visual.start) < duration);
  visuals.forEach((visual, index) => {
    const settingsAudio = visual.audio || {};
    const hasAudio = !videoOnly && visual.kind === "video" && visual.hasAudio && !settingsAudio.muted && !isFrozen(visual) && !silentVisuals.has(index);
    if (audioOnly && !hasAudio) return;
    // A separate audio source (e.g. a separated stem) is a full-length render of the same media,
    // so it is read with the same in/out range and gets its own input after the picture input.
    const audioPath = hasAudio && typeof visual.audioPath === "string" && visual.audioPath ? visual.audioPath : null;
    let audioInput = inputIndex;
    if (!audioOnly || !audioPath) {
      const sourcePath = sources[index] || visual.path;
      inputs.push(...visualInputArgs(visual, fps, sourcePath));
      if (!audioOnly) {
        const layer = visualLayerChain(visual, index, `${inputIndex}:v:0`, settings);
        chains.push(layer.chain);
        const next = `base${index + 1}`;
        chains.push(`[${current}][${layer.layerLabel}]${layer.overlay}[${next}]`);
        current = next;
      }
      inputIndex += 1;
    }
    if (audioPath) {
      inputs.push("-ss", f(Math.max(0, num(visual.in))), "-t", f(Math.max(0, num(visual.out) - num(visual.in))), "-i", audioPath);
      audioInput = inputIndex;
      inputIndex += 1;
    }
    if (hasAudio) {
      const label = `va${index}`;
      chains.push(audioClipChain(visual, `${audioInput}:a:0`, label, { reverse: Boolean(visual.reverse) }));
      audioLabels.push(label);
    }
  });

  const audios = videoOnly ? [] : (Array.isArray(request.audios) ? request.audios : []).filter((clip) => clipDuration(clip, "audio") > 0 && num(clip.start) < duration && !clip.audio?.muted);
  audios.forEach((clip, index) => {
    inputs.push("-ss", f(Math.max(0, num(clip.in))), "-t", f(Math.max(0, num(clip.out) - num(clip.in))), "-i", clip.path);
    const label = `aa${index}`;
    chains.push(audioClipChain(clip, `${inputIndex}:a:0`, label));
    audioLabels.push(label);
    inputIndex += 1;
  });

  if (!audioOnly) {
    // JPEG stills tag frames as full range; the canvas is limited range, so retag the output for players and uploads.
    const ass = options.assPath ? `ass='${escapeFilterPath(options.assPath)}',` : "";
    chains.push(`[${current}]${ass}${options.videoTail || "format=yuv420p,setparams=range=tv"}[vout]`);
  }

  const audioTail = Array.isArray(options.audioFilters) && options.audioFilters.length ? `,${options.audioFilters.join(",")}` : "";
  if (videoOnly) {
    // GIF: no audio inputs and no mix, so no unmapped output label.
  } else if (audioLabels.length) {
    const mixed = audioLabels.length === 1 ? `[${audioLabels[0]}]anull` : `${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0:dropout_transition=0`;
    chains.push(`${mixed},apad=whole_dur=${f(duration)},atrim=duration=${f(duration)},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo${audioTail}[aout]`);
  } else {
    chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f(duration)}${audioTail}[aout]`);
  }

  return { inputs, filterGraph: chains.join(";\n"), videoLabel: audioOnly ? null : "vout", audioLabel: videoOnly ? null : "aout", width: W, height: H, fps, duration, hasAudioSources: audioLabels.length > 0 };
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

/** Runs FFmpeg; resolves with its stderr (the tail, or the whole log when `capture` is set). */
function runFfmpeg(args, onTime, options = {}, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(options), ["-hide_banner", "-y", ...args], { windowsHide: true });
    let stderr = "";
    let log = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-30_000);
      if (capture) log += chunk;
      const latest = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
      if (latest && onTime) onTime(Number(latest[1]) * 3600 + Number(latest[2]) * 60 + Number(latest[3]));
    });
    child.on("error", (error) => reject(error.code === "ENOENT" ? new Error("安装包缺少 LGPL FFmpeg 运行时，请重新安装 DashCut 极剪") : error));
    child.on("close", (code) => code === 0 ? resolve(capture ? log : stderr) : reject(new Error(stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n") || `FFmpeg exited with ${code}`)));
  });
}

const OUTPUT_FORMATS = new Set(["mp4", "mov", "m4a", "wav", "gif"]);
const LOUDNORM_TP = -1.5;
const LOUDNORM_LRA = 11;

/** Fills defaults for `request.output` (mp4 / H.264 / no loudness target). */
function normalizeOutput(output) {
  const format = OUTPUT_FORMATS.has(output?.format) ? output.format : "mp4";
  const codec = output?.codec === "hevc" ? "hevc" : "h264";
  const target = output?.loudnessTarget;
  const loudnessTarget = target === null || target === undefined || !Number.isFinite(Number(target)) ? null : clamp(Number(target), -70, -5);
  const gif = {
    fps: clamp(Math.round(num(output?.gif?.fps, 12)) || 12, 1, 30),
    width: even(clamp(num(output?.gif?.width, 480) || 480, 16, 3840)),
    maxDuration: Math.max(0.1, num(output?.gif?.maxDuration, 15) || 15),
  };
  return { format, codec, loudnessTarget: format === "gif" ? null : loudnessTarget, gif };
}

/** HEVC encoder args derived from the H.264 settings: same rate control, ~70 % of the bitrate. */
function hevcEncoderArgs(platform, settings) {
  const h264 = videoEncoderArgs(platform, settings);
  const h264Bitrate = parseInt(h264[h264.indexOf("-b:v") + 1], 10);
  const bitrate = Math.max(500, Math.round(h264Bitrate * 0.7));
  if (platform === "darwin") {
    return ["-c:v", "hevc_videotoolbox", "-profile:v", "main", "-allow_sw", "1", "-realtime", "0", "-b:v", `${bitrate}k`, "-maxrate", `${Math.round(bitrate * 1.35)}k`, "-bufsize", `${bitrate * 2}k`];
  }
  if (platform === "win32") {
    return ["-c:v", "hevc_mf", "-hw_encoding", settings.hardware === false ? "0" : "1", "-rate_control", "quality", "-quality", settings.finalPass ? "82" : "76", "-b:v", `${bitrate}k`];
  }
  throw new Error(`当前平台 ${platform} 尚未提供 LGPL HEVC 编码器`);
}

/** Parses the JSON block printed by `loudnorm=print_format=json`; null when unusable (e.g. silence). */
function parseLoudnormJson(stderr) {
  const match = [...String(stderr).matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)].at(-1);
  if (!match) return null;
  try {
    const data = JSON.parse(match[0]);
    const values = { I: Number(data.input_i), TP: Number(data.input_tp), LRA: Number(data.input_lra), thresh: Number(data.input_thresh), offset: Number(data.target_offset) };
    return Object.values(values).every(Number.isFinite) && values.I > -70 ? values : null;
  } catch {
    return null;
  }
}

/** Second-pass linear loudnorm using the measured values; loudnorm upsamples, so resample back. */
function loudnormFilters(target, measured) {
  return [
    `loudnorm=I=${f(target)}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:measured_I=${f(measured.I)}:measured_TP=${f(measured.TP)}:measured_LRA=${f(measured.LRA)}:measured_thresh=${f(measured.thresh)}:offset=${f(measured.offset)}:linear=true:print_format=summary`,
    "aresample=48000",
  ];
}

/** Parses the last `ebur128` Summary block: integrated loudness, loudness range and true peak. */
function parseEbur128Summary(stderr) {
  const text = String(stderr);
  const at = text.lastIndexOf("Summary:");
  if (at < 0) return { integratedLufs: null, loudnessRange: null, truePeak: null };
  const summary = text.slice(at);
  const value = (pattern) => {
    const raw = summary.match(pattern)?.[1];
    const parsed = raw === undefined || /inf|nan/i.test(raw) ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const integrated = value(/\bI:\s*(-?inf|-?nan|-?[\d.]+)\s*LUFS/i);
  return {
    // ebur128 reports its -70 LUFS absolute gate for silence.
    integratedLufs: integrated === null || integrated <= -70 ? null : integrated,
    loudnessRange: value(/\bLRA:\s*(-?inf|-?nan|-?[\d.]+)\s*LU\b/i),
    truePeak: value(/Peak:\s*(-?inf|-?nan|-?[\d.]+)\s*dBFS/i),
  };
}

/** Pairs `silence_start` / `silence_end` lines; an open silence is closed at `duration`. */
function parseSilences(stderr, duration) {
  const ranges = [];
  let open = null;
  for (const match of String(stderr).matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const time = clamp(Number(match[2]), 0, duration);
    if (match[1] === "start") open = time;
    else if (open !== null) {
      if (time > open) ranges.push({ start: open, end: time });
      open = null;
    }
  }
  if (open !== null && duration > open) ranges.push({ start: open, end: duration });
  return ranges;
}

/** Parses `blackdetect` ranges. */
function parseBlackFrames(stderr, duration) {
  return [...String(stderr).matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)]
    .map((match) => ({ start: clamp(Number(match[1]), 0, duration), end: clamp(Number(match[2]), 0, duration) }))
    .filter((range) => range.end > range.start);
}

/** Prepares JPEG stills (no PNG decoder in the LGPL build) and finds clips whose file has no audio. */
async function prepareInputs(request, options, tempDir, { stills = true, audio = true } = {}) {
  const duration = num(request.duration);
  const visuals = Array.isArray(request.visuals) ? request.visuals : [];
  const usable = visuals.filter((visual) => clipDuration(visual) > 0 && num(visual.start) < duration);
  const sources = {};
  const prepared = new Map();
  if (stills) {
    for (const [index, visual] of usable.entries()) {
      if (visual.kind !== "image" || !options.prepareStill) continue;
      if (!prepared.has(visual.path)) prepared.set(visual.path, await options.prepareStill(visual.path, path.join(tempDir, `still-${prepared.size}.jpg`)));
      sources[index] = prepared.get(visual.path);
    }
  }
  const silentVisuals = new Set();
  const audioChecks = new Map();
  for (const [index, visual] of audio ? usable.entries() : []) {
    if (visual.kind !== "video" || !visual.hasAudio || visual.audio?.muted || isFrozen(visual)) continue;
    // The audio comes from audioPath when set, so that is the file that must carry a stream.
    const audioSource = typeof visual.audioPath === "string" && visual.audioPath ? visual.audioPath : visual.path;
    if (!audioChecks.has(audioSource)) audioChecks.set(audioSource, probeHasAudio(audioSource, options));
    if (!(await audioChecks.get(audioSource))) silentVisuals.add(index);
  }
  return { sources, silentVisuals };
}

/** Pass 1 of a loudness-targeted export: measures the audio mix only. Null when it cannot be normalised. */
async function measureLoudness(request, options, tempDir, inputs, target, onTime) {
  const graph = buildCompositionGraph(request, { ...inputs, audioOnly: true, audioFilters: [`loudnorm=I=${f(target)}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA}:print_format=json`] });
  if (!graph.hasAudioSources) return null;
  const graphPath = path.join(tempDir, "loudness-graph.txt");
  await writeFile(graphPath, graph.filterGraph, "utf8");
  const stderr = await runFfmpeg([...graph.inputs, "-/filter_complex", graphPath, "-map", `[${graph.audioLabel}]`, "-t", f(graph.duration), "-f", "null", "-"], onTime, options);
  return parseLoudnormJson(stderr);
}

const GIF_PALETTE = "split[gifa][gifb];[gifa]palettegen=stats_mode=diff[gifpal];[gifb][gifpal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";

async function exportComposition(request, options) {
  const visuals = Array.isArray(request.visuals) ? request.visuals : [];
  if (!visuals.length && !(request.audios || []).length) throw new Error("时间线中没有可导出的内容");
  const duration = num(request.duration);
  if (!(duration > 0)) throw new Error("导出时长无效");
  const output = normalizeOutput(request.output);
  const audioOnly = output.format === "m4a" || output.format === "wav";
  const isGif = output.format === "gif";
  const exportPlatform = options.platform ?? process.platform;
  const tempDir = await mkdtemp(path.join(options.tempPath || tmpdir(), "dashcut-composition-"));
  const emit = (progress, stage) => options.onProgress?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), stage });
  try {
    emit(0, "正在准备素材");
    const inputs = await prepareInputs(request, options, tempDir, { stills: !audioOnly, audio: !isGif });

    // GIF: render directly at the target width (height follows the canvas) and frame rate, capped at maxDuration.
    let renderRequest = request;
    if (isGif) {
      const canvasW = even(num(request.width, 1920));
      const canvasH = even(num(request.height, 1080));
      renderRequest = { ...request, width: output.gif.width, height: even(Math.round((output.gif.width * canvasH) / canvasW)), duration: Math.min(duration, output.gif.maxDuration) };
    }
    let assPath;
    if (!audioOnly) {
      assPath = path.join(tempDir, "subtitles.ass");
      const width = even(num(renderRequest.width, 1920));
      const height = even(num(renderRequest.height, 1080));
      await writeFile(assPath, createAss(request.subtitles || [], request.subtitleStyle || {}, width, height, request.subtitleMode), "utf8");
    }

    // Loudness target: measuring pass (0-25 %), then the render pass (25-100 %).
    let audioFilters = [];
    let renderStart = 0;
    if (output.loudnessTarget !== null) {
      emit(1, "正在分析响度");
      const measured = await measureLoudness(request, options, tempDir, inputs, output.loudnessTarget, (time) => emit(Math.min(24, (time / duration) * 25), "正在分析响度"));
      if (measured) audioFilters = loudnormFilters(output.loudnessTarget, measured);
      renderStart = 25;
      emit(renderStart, "正在合成多轨视频");
    }
    const progressFor = (time, total) => renderStart + Math.min(99 - renderStart, (time / total) * (100 - renderStart));

    const graph = buildCompositionGraph(renderRequest, {
      ...inputs,
      assPath,
      audioOnly,
      audioFilters,
      fps: isGif ? output.gif.fps : undefined,
      videoOnly: isGif,
      videoTail: isGif ? GIF_PALETTE : undefined,
    });
    const graphPath = path.join(tempDir, "graph.txt");
    await writeFile(graphPath, graph.filterGraph, "utf8");

    if (audioOnly) {
      const codecArgs = output.format === "m4a"
        ? ["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-f", "ipod"]
        : ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-f", "wav"];
      const args = [...graph.inputs, "-/filter_complex", graphPath, "-map", `[${graph.audioLabel}]`, "-vn", ...codecArgs, "-t", f(graph.duration), options.outputPath];
      await runFfmpeg(args, (time) => emit(progressFor(time, graph.duration), "正在导出音频"), options);
      emit(100, "导出完成");
      return { outputPath: options.outputPath, duration: graph.duration, subtitleFiles: [] };
    }
    if (isGif) {
      const args = [...graph.inputs, "-/filter_complex", graphPath, "-map", `[${graph.videoLabel}]`, "-an", "-c:v", "gif", "-loop", "0", "-t", f(graph.duration), "-f", "gif", options.outputPath];
      await runFfmpeg(args, (time) => emit(progressFor(time, graph.duration), "正在生成 GIF"), options);
      emit(100, "导出完成");
      return { outputPath: options.outputPath, duration: graph.duration, subtitleFiles: [] };
    }

    const hardwareModes = exportPlatform === "win32" ? [true, false] : [undefined];
    const hevc = output.codec === "hevc";
    let finalError;
    for (const hardware of hardwareModes) {
      const encoderSettings = { width: graph.width, height: graph.height, fps: graph.fps, destination: request.platform, finalPass: true, hardware };
      const encoderArgs = hevc ? hevcEncoderArgs(exportPlatform, encoderSettings) : videoEncoderArgs(exportPlatform, encoderSettings);
      const args = [
        ...graph.inputs,
        "-/filter_complex", graphPath,
        "-map", `[${graph.videoLabel}]`, "-map", `[${graph.audioLabel}]`,
        ...encoderArgs,
        // hvc1 (parameter sets in the sample entry) is the tag QuickTime and Apple devices require for HEVC.
        "-r", String(graph.fps), "-pix_fmt", exportPlatform === "win32" ? "nv12" : "yuv420p", "-color_range", "tv", "-tag:v", hevc ? "hvc1" : "avc1",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f(graph.duration), "-movflags", "+faststart", "-f", output.format === "mov" ? "mov" : "mp4", options.outputPath,
      ];
      try {
        await runFfmpeg(args, (time) => emit(progressFor(time, graph.duration), hardware === false ? "正在使用兼容模式完成导出" : "正在合成多轨视频"), options);
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

const ANALYSIS_WIDTH = 320;
const ANALYSIS_FPS = 10;

/**
 * Renders the composition small (no captions, no file written) and measures loudness (ebur128),
 * silences (silencedetect, -45 dB for 2 s) and black frames (blackdetect, 0.5 s). Times are timeline seconds.
 * `options`: { tempPath?, ffmpegPath?, platform?, prepareStill?, onProgress? }.
 */
async function analyzeComposition(request, options = {}) {
  const duration = num(request.duration);
  if (!(duration > 0)) throw new Error("导出时长无效");
  const tempDir = await mkdtemp(path.join(options.tempPath || tmpdir(), "dashcut-analysis-"));
  const emit = (progress, stage) => options.onProgress?.({ progress: Math.max(0, Math.min(100, Math.round(progress))), stage });
  try {
    emit(0, "正在准备素材");
    const inputs = await prepareInputs(request, options, tempDir);
    const canvasW = even(num(request.width, 1920));
    const canvasH = even(num(request.height, 1080));
    const width = Math.min(canvasW, ANALYSIS_WIDTH);
    const graph = buildCompositionGraph({ ...request, width, height: even(Math.round((width * canvasH) / canvasW)) }, {
      ...inputs,
      fps: ANALYSIS_FPS,
      videoTail: "format=yuv420p,blackdetect=d=0.5:pic_th=0.98:pix_th=0.10",
      audioFilters: ["ebur128=peak=true:framelog=quiet", "silencedetect=n=-45dB:d=2"],
    });
    const graphPath = path.join(tempDir, "analysis-graph.txt");
    await writeFile(graphPath, graph.filterGraph, "utf8");
    const log = await runFfmpeg(
      [...graph.inputs, "-/filter_complex", graphPath, "-map", `[${graph.videoLabel}]`, "-map", `[${graph.audioLabel}]`, "-t", f(graph.duration), "-f", "null", "-"],
      (time) => emit(Math.min(99, (time / graph.duration) * 100), "正在分析成片"),
      options,
      true,
    );
    emit(100, "分析完成");
    return {
      duration: graph.duration,
      ...parseEbur128Summary(log),
      blackFrames: parseBlackFrames(log, graph.duration),
      silences: parseSilences(log, graph.duration),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  analyzeComposition,
  atempoChain,
  buildCompositionGraph,
  clipDuration,
  exportComposition,
  keyframeExpression,
  keyframeValue,
  normalizeOutput,
  panFilters,
  parseEbur128Summary,
  parseLoudnormJson,
  parseSilences,
};
