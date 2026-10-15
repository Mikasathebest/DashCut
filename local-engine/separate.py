#!/usr/bin/env python3
"""DashCut local voice / background separation runner (Demucs htdemucs, 2 stems).

The desktop process invokes this file once per source media file. It writes
`vocals.wav` and `background.wav` (48 kHz stereo PCM s16) into --output-dir,
streams `PROGRESS <0..1>` lines on stderr and prints one JSON object on stdout.

Model weights are never bundled: `--download-model` fetches the official
htdemucs checkpoint into --model-root (verified by SHA-256) and separation
loads it from there strictly offline.

Audio is decoded and encoded by the FFmpeg executable passed via --ffmpeg, and
processed in fixed-size chunks with cross-faded overlaps so memory stays flat
regardless of the input length.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
import urllib.request

MODEL_NAME = "htdemucs"
MODEL_SIG = "955717e8"
MODEL_FILE = "955717e8-8726e21a.th"
MODEL_URL = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/" + MODEL_FILE
MODEL_SHA256 = "8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4"
MODEL_BYTES = 84141911

SAMPLE_RATE = 44100          # htdemucs native rate
OUTPUT_RATE = 48000
CHUNK_SECONDS = 30           # audio handed to apply_model at once
OVERLAP_SECONDS = 2          # context shared by neighbouring chunks, cross-faded
FRAME_BYTES = 2 * 4          # stereo float32


class UserError(Exception):
    """An error whose message is shown to the user as-is."""


def progress(value: float) -> None:
    print(f"PROGRESS {max(0.0, min(1.0, value)):.4f}", file=sys.stderr, flush=True)


def model_dir(model_root: str) -> str:
    return os.path.join(os.path.abspath(model_root), MODEL_NAME)


def model_is_ready(target: str) -> bool:
    weights = os.path.join(target, MODEL_FILE)
    return (
        os.path.isfile(weights)
        and os.path.getsize(weights) == MODEL_BYTES
        and os.path.isfile(os.path.join(target, f"{MODEL_NAME}.yaml"))
    )


def download_model(model_root: str) -> dict:
    target = model_dir(model_root)
    if model_is_ready(target):
        return {"model": MODEL_NAME, "path": target, "sizeBytes": MODEL_BYTES, "alreadyInstalled": True}
    os.makedirs(target, exist_ok=True)
    partial = os.path.join(target, MODEL_FILE + ".part")
    digest = hashlib.sha256()
    received = 0
    # urllib honours HTTP(S)_PROXY / NO_PROXY from the environment.
    request = urllib.request.Request(MODEL_URL, headers={"User-Agent": "DashCut"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, open(partial, "wb") as handle:
            total = int(response.headers.get("Content-Length") or MODEL_BYTES)
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                handle.write(block)
                digest.update(block)
                received += len(block)
                progress(received / total)
    except OSError as error:
        if os.path.exists(partial):
            os.remove(partial)
        raise UserError(f"声音分离模型下载失败：{error}") from error
    if received != MODEL_BYTES or digest.hexdigest() != MODEL_SHA256:
        os.remove(partial)
        raise UserError("声音分离模型下载不完整或校验失败，请重试")
    os.replace(partial, os.path.join(target, MODEL_FILE))
    with open(os.path.join(target, f"{MODEL_NAME}.yaml"), "w", encoding="utf-8") as handle:
        handle.write(f"models: ['{MODEL_SIG}']\n")
    return {"model": MODEL_NAME, "path": target, "sizeBytes": MODEL_BYTES}


def load_model(model_root: str):
    from pathlib import Path

    from demucs.repo import AnyModelRepo, BagOnlyRepo, LocalRepo

    target = model_dir(model_root)
    if not model_is_ready(target):
        raise UserError("声音分离模型尚未下载，请先在 DashCut 极剪中安装")
    # Local repo only: never reaches out to the network at separation time.
    # LocalRepo verifies the checksum embedded in the file name before unpickling.
    model_repo = LocalRepo(Path(target))
    model = AnyModelRepo(model_repo, BagOnlyRepo(Path(target), model_repo)).get_model(MODEL_NAME)
    model.eval()
    return model


def probe_duration(ffmpeg: str, source: str) -> float:
    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-nostdin", "-i", source],
            capture_output=True, text=True, errors="replace",
        )
    except OSError as error:
        raise UserError(f"无法启动 FFmpeg：{error}") from error
    log = result.stderr
    if "Audio:" not in log:
        if re.search(r"No such file|does not exist|Invalid data", log):
            raise UserError("无法读取素材文件")
        raise UserError("素材没有音轨，无法分离人声")
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", log)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def open_decoder(ffmpeg: str, source: str) -> subprocess.Popen:
    return subprocess.Popen(
        [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", source,
         "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", str(SAMPLE_RATE),
         "-f", "f32le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def open_encoder(ffmpeg: str, destination: str) -> subprocess.Popen:
    return subprocess.Popen(
        [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y",
         "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-i", "pipe:0",
         "-af", f"aresample={OUTPUT_RATE}",
         "-c:a", "pcm_s16le", "-rf64", "auto", "-f", "wav", destination],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def read_frames(stream, frames: int):
    """Read up to `frames` stereo float32 frames; returns a (2, n) float32 numpy array."""
    import numpy as np

    data = stream.read(frames * FRAME_BYTES)
    usable = len(data) - len(data) % FRAME_BYTES
    return np.frombuffer(data[:usable], dtype=np.float32).reshape(-1, 2).T


def finish(process: subprocess.Popen, label: str) -> None:
    _, error = process.communicate()
    if process.returncode != 0:
        detail = (error or b"").decode("utf-8", "replace").strip().splitlines()
        raise UserError(f"{label}失败：{detail[-1] if detail else process.returncode}")


def mono_stats(ffmpeg: str, source: str):
    """First pass: mean / std of the mono mix, used to normalise every chunk the same way."""
    decoder = open_decoder(ffmpeg, source)
    count = 0
    total = 0.0
    total_sq = 0.0
    while True:
        block = read_frames(decoder.stdout, SAMPLE_RATE * 60)
        if block.shape[1] == 0:
            break
        mono = block.astype("float64").mean(axis=0)
        count += mono.size
        total += float(mono.sum())
        total_sq += float((mono * mono).sum())
    finish(decoder, "音频解码")
    if count == 0:
        raise UserError("素材音轨为空，无法分离人声")
    mean = total / count
    variance = max(0.0, total_sq / count - mean * mean)
    return mean, variance ** 0.5, count


def resolve_device(requested: str) -> str:
    import torch

    if requested == "mps":
        if not torch.backends.mps.is_available():
            raise UserError("当前设备不支持 Apple GPU 加速")
        return "mps"
    return "cpu"


def separate(args) -> dict:
    import numpy as np
    import torch
    from demucs.apply import apply_model

    if not os.path.isfile(args.input):
        raise UserError("找不到需要分离的素材文件")
    if not model_is_ready(model_dir(args.model_root)):
        raise UserError("声音分离模型尚未下载，请先在 DashCut 极剪中安装")
    duration = probe_duration(args.ffmpeg, args.input)
    model = load_model(args.model_root)
    if model.samplerate != SAMPLE_RATE or "vocals" not in model.sources:
        raise UserError("声音分离模型与运行时不匹配")
    device = resolve_device(args.device)
    vocals_index = model.sources.index("vocals")
    # htdemucs loads as a one-model bag; apply_model splits by the inner model's segment.
    inner = model.models[0] if hasattr(model, "models") else model
    segment_frames = int(float(inner.segment) * SAMPLE_RATE)
    args.output_dir = os.path.abspath(args.output_dir)
    os.makedirs(args.output_dir, exist_ok=True)
    targets = {
        "vocals": os.path.join(args.output_dir, "vocals.wav"),
        "background": os.path.join(args.output_dir, "background.wav"),
    }

    progress(0)
    mean, std, total_frames = mono_stats(args.ffmpeg, args.input)
    scale = std + 1e-8
    chunk = SAMPLE_RATE * CHUNK_SECONDS
    overlap = SAMPLE_RATE * OVERLAP_SECONDS
    fade_in = torch.linspace(0.0, 1.0, overlap)
    fade_out = 1.0 - fade_in

    decoder = open_decoder(args.ffmpeg, args.input)
    encoders = {name: open_encoder(args.ffmpeg, path + ".part") for name, path in targets.items()}

    def write(stems: "torch.Tensor") -> None:
        # stems: (2 stems, 2 channels, n) -> interleaved float32 per stem
        for index, name in enumerate(("vocals", "background")):
            encoders[name].stdin.write(stems[index].T.contiguous().numpy().astype(np.float32).tobytes())

    context = None     # last `overlap` input frames of the previous chunk
    held = None        # last `overlap` output frames of the previous chunk (not yet written)
    done_frames = 0    # new (non-context) input frames consumed so far
    try:
        while True:
            fresh = read_frames(decoder.stdout, chunk)
            if fresh.shape[1] == 0:
                break
            mix = torch.from_numpy(fresh.copy())
            lead = 0 if context is None else context.shape[1]
            if context is not None:
                mix = torch.cat([context, mix], dim=1)
            base = done_frames - lead
            span = mix.shape[1]

            def on_segment(state, base=base, span=span):
                if state.get("state") == "end" and total_frames:
                    reached = min(span, state.get("segment_offset", 0) + segment_frames)
                    progress(0.02 + 0.96 * (base + reached) / total_frames)

            normalised = (mix - mean) / scale
            with torch.no_grad():
                sources = apply_model(
                    model, normalised[None], shifts=0, split=True, overlap=0.25,
                    device=device, progress=False, callback=on_segment,
                )[0] * scale  # the mix's DC offset is dropped rather than added to every stem
            vocals = sources[vocals_index]
            background = sources.sum(dim=0) - vocals
            stems = torch.stack([vocals, background]).cpu()

            if held is not None:
                stems[..., :lead] = held * fade_out[:lead] + stems[..., :lead] * fade_in[:lead]
            keep = min(overlap, fresh.shape[1])
            if fresh.shape[1] >= chunk:
                # More audio may follow: hold the tail back to cross-fade with the next chunk.
                write(stems[..., :stems.shape[-1] - keep])
                held = stems[..., stems.shape[-1] - keep:].clone()
                context = mix[:, mix.shape[1] - keep:].clone()
            else:
                write(stems)
                held = None
                context = None
            done_frames += fresh.shape[1]
            if fresh.shape[1] < chunk:
                break
        if held is not None:
            write(held)
        finish(decoder, "音频解码")
        for encoder in encoders.values():
            finish(encoder, "音频写入")  # communicate() closes stdin, then waits
    except BaseException:
        for process in (decoder, *encoders.values()):
            if process.poll() is None:
                process.kill()
        for path in targets.values():
            if os.path.exists(path + ".part"):
                os.remove(path + ".part")
        raise
    for path in targets.values():
        os.replace(path + ".part", path)
    progress(1)
    return {
        "vocals": targets["vocals"],
        "background": targets["background"],
        "duration": done_frames / SAMPLE_RATE if done_frames else duration,
        "device": device,
        "model": MODEL_NAME,
    }


def runtime_info() -> dict:
    import demucs
    import torch

    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "demucs": getattr(demucs, "__version__", "unknown"),
        "model": MODEL_NAME,
        "mps": bool(torch.backends.mps.is_available()),
        "threads": torch.get_num_threads(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--model-root")
    parser.add_argument("--device", choices=("cpu", "mps"), default="cpu")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="FFmpeg executable used to decode / encode audio")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--runtime-info", action="store_true")
    args = parser.parse_args()

    if args.runtime_info:
        json.dump(runtime_info(), sys.stdout)
        return 0
    if not args.model_root:
        parser.error("--model-root is required")
    if args.download_model:
        json.dump(download_model(args.model_root), sys.stdout, ensure_ascii=False)
        return 0
    if not args.input or not args.output_dir:
        parser.error("--input and --output-dir are required for separation")
    started = time.monotonic()
    result = separate(args)
    result["elapsed"] = round(time.monotonic() - started, 3)
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UserError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
    except Exception as error:  # The desktop process turns this into a UI error.
        print(json.dumps({"error": f"声音分离失败：{error}"}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
