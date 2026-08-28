#!/usr/bin/env python3
"""DashCat local faster-whisper JSON runner.

The desktop process invokes this file once per source video. Model weights are
downloaded into the app data directory on first use instead of being bundled in
the installer.
"""

import argparse
import json
import os
import platform
import sys

from faster_whisper import WhisperModel, download_model


SUPPORTED_MODELS = ("small", "medium", "large-v3", "turbo")


def model_path(model_root: str, model: str) -> str:
    return os.path.join(os.path.abspath(model_root), model)


def model_is_ready(path: str) -> bool:
    required = ("config.json", "model.bin", "tokenizer.json")
    return all(os.path.isfile(os.path.join(path, filename)) for filename in required)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--model", choices=SUPPORTED_MODELS, default="small")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--model-root")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--runtime-info", action="store_true")
    args = parser.parse_args()

    if args.runtime_info:
      import ctranslate2
      import faster_whisper
      json.dump({
          "python": platform.python_version(),
          "fasterWhisper": faster_whisper.__version__,
          "ctranslate2": ctranslate2.__version__,
          "cudaDeviceCount": ctranslate2.get_cuda_device_count(),
      }, sys.stdout)
      return 0

    if not args.model_root:
        parser.error("--model-root is required")
    target = model_path(args.model_root, args.model)

    if args.download_model:
        os.makedirs(target, exist_ok=True)
        download_model(args.model, output_dir=target)
        if not model_is_ready(target):
            raise RuntimeError("模型下载未完成或文件校验失败")
        size = sum(
            os.path.getsize(os.path.join(root, filename))
            for root, _, files in os.walk(target)
            for filename in files
        )
        json.dump({"model": args.model, "path": target, "sizeBytes": size}, sys.stdout, ensure_ascii=False)
        return 0

    if not args.input:
        parser.error("--input is required for transcription")
    if not model_is_ready(target):
        raise RuntimeError(f"模型 {args.model} 尚未下载，请先在 DashCat 中安装")

    model = WhisperModel(
        target,
        device=args.device,
        compute_type=args.compute_type,
        local_files_only=True,
    )
    segments, info = model.transcribe(
        args.input,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
    )
    result = {
        "language": info.language,
        "languageProbability": info.language_probability,
        "duration": info.duration,
        "segments": [],
    }
    for segment in segments:
        result["segments"].append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "words": [
                {
                    "start": word.start,
                    "end": word.end,
                    "word": word.word,
                    "probability": word.probability,
                }
                for word in (segment.words or [])
            ],
        })
    json.dump(result, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # The desktop process turns this into a UI error.
        json.dump({"error": str(error)}, sys.stderr, ensure_ascii=False)
        raise
