# DashCut 极剪

[简体中文](README.zh-CN.md) · [Download](https://github.com/Mikasathebest/DashCut/releases/latest) · [Report an issue](https://github.com/Mikasathebest/DashCut/issues)

## 1. Overview

DashCut (极剪) is a desktop-first video editor for Bilibili and YouTube creators. It focuses on the repetitive work around creator videos: import multiple clips, split and rearrange a timeline, add background music, generate a 1280 × 720 cover image, create time-aligned Chinese or English captions with local `faster-whisper`, apply one font/color/size style to every caption, and prepare 30 or 60 FPS exports. The local AI workflow checks CPU, GPU, memory, and disk before recommending a model; model weights are never downloaded until the user explicitly clicks install, and packaged users do not need to configure Python or other AI dependencies.

Highlights:

- Multi-clip import, preview, timeline splitting, and removal
- Local Chinese and English speech recognition with editable caption timing and text
- Global caption font, size, color, outline, and background controls
- On-demand `small`, `medium`, `turbo`, and `large-v3` model management
- Automatic hardware assessment with CPU INT8 and CUDA recommendations
- Background music controls, 16:9 / 9:16 canvases, and a cover-image studio
- Bilibili and YouTube export presets with 30 / 60 FPS choices
- Unsigned Windows x64 one-click `.exe` releases and one macOS Apple Silicon `.dmg`; Apple credentials automatically enable signing and notarization

> Bilingual subtitles: local Whisper now combines with AI API translation to produce Chinese and English captions while preserving recognition timestamps. Gemini cloud audio recognition is also available with estimated timing. See the [tested models, speed, cost and setup guide](docs/AI_API.md).

## 2. Installation

### Download an installer

[**Download the latest DashCut release →**](https://github.com/Mikasathebest/DashCut/releases/latest)

- Windows: download the x64 `.exe` and double-click it. Because it is unsigned, Windows may show an unknown-publisher or SmartScreen confirmation.
- macOS: the published `.dmg` supports Apple Silicon Macs (M1 or newer). Open it and move DashCut to Applications. Until the release is notarized, first launch may require right-clicking DashCut and choosing **Open**, or allowing it in **System Settings → Privacy & Security**.
- Local caption models are not bundled. Open **Captions → Local model**, review the hardware recommendation, then click **Download and install** for the model you want.

### Build and run manually

Requirements: Node.js 22.13+ and Python 3.9+ (Python is only needed to build the self-contained local AI runtime).

```bash
git clone https://github.com/Mikasathebest/DashCut.git
cd DashCut
npm install
npm run runtime:build
npm run desktop
```

Create local installers with:

```bash
npm run dist:win   # Windows x64 .exe
npm run dist:mac   # macOS .dmg
```

Windows x64 releases produce an unsigned one-click `.exe` without credentials; Windows may display an unknown-publisher or SmartScreen warning. The macOS Apple Silicon DMG is also produced without credentials, but Apple Developer credentials are required to sign and notarize it for a normal Gatekeeper launch. See [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md). Both installers embed a self-contained LGPL FFmpeg runtime built natively with VideoToolbox on macOS or MediaFoundation on Windows, including its source notice, licenses, dependency licenses, and build configuration; details are documented in [`docs/FFMPEG_RUNTIME.md`](docs/FFMPEG_RUNTIME.md).

## 3. Tutorial

![DashCut editor with global subtitle style controls](docs/images/dashcut-subtitle-style.png)

### Import and edit on a multi-track timeline

1. Click **Import media** (⌘I) and pick any mix of videos, images, GIFs and audio. They appear in the library in import order with a first-frame thumbnail and duration; nothing is placed on the timeline automatically.
2. Drag media from the library onto a track. Drop it on the empty strip above the tracks to create a new picture-in-picture track, so images and videos can be stacked.
3. Use the toolbar above the timeline: import, select/blade mode, undo/redo/reset, split, trim left/right, delete, marker, freeze, reverse, mirror, rotate, crop, smart talk cut, smart scene split and a voice-over recorder with a 3-second countdown. Toggles on the right control main-track magnet, snapping, linkage and the hover preview axis; −/+ zooms the timeline and **…** sets track height and waveform size.
4. Select a clip to edit it in the right-hand panel: picture (scale, position, rotation, opacity, mirror, crop), audio (volume, fades, effects), speed, in/out animations, colour adjustment and AI effects. Preview and export use the same settings.
5. Click the cover tile at the left of the main track to design a 1280 × 720 thumbnail.

### Edit by transcript and clean up talking-head takes

1. Open the **Transcript** tab and click **Recognise transcript**. Add names, brands or jargon under **Vocabulary** in the captions tab so the local model spells them correctly.
2. Select words by clicking, dragging or shift-clicking, then press ⌫. The matching video, audio and captions are cut and the timeline closes the gap. It is one undo step.
3. **Smart clean cut**, in the transcript tab or the toolbar, lists filler words (嗯/啊/um/uh), stutters, long pauses and abandoned retakes. Fillers that are often real words (那个/就是/like/so) are listed but left unchecked. Review the list, adjust the pause threshold or filler lists, then apply the checked items. Clips without a transcript fall back to silence detection.

### Save, reopen and recover projects

- **File → Save** (⌘S) writes a `.dashcut` project file. Media is referenced, not copied: paths are stored relative to the project file, so moving the project folder together with its media keeps working.
- **File → Open** (⌘O) or the project menu next to the title reopens projects; the menu also lists recent projects. If media was moved, DashCut asks you to locate it, and other missing files with the same names in that folder are relinked automatically.
- Unsaved work is autosaved every 30 seconds and whenever the window loses focus. After a crash, DashCut offers to restore it on the next launch. Closing a project with unsaved changes asks whether to save first.

### Extract Chinese or English captions locally

1. Open **Captions**, choose **Local model**, and let DashCut inspect the device.
2. Review the detected CPU, CUDA GPU, memory, disk, and runtime status. Pick the recommended model or another supported model.
3. Click **Download and install**. Nothing is downloaded before this explicit action.
4. Import the clips, select the subtitle view (**中文**, **English**, or **双语**), then click **Generate captions**.
5. `faster-whisper` detects each clip's spoken language. Chinese recognition is written to the Chinese field; English recognition is written to the English field. Review each line and correct names or punctuation before export.
6. For automatic bilingual captions, enter your AI API API key and enable automatic translation. Qwen3 Next is the default translator; Gemini 3.5 Flash is a tested alternative. Disable automatic translation for offline source-language recognition. Both caption lines remain editable.

![DashCut local AI hardware check and model selector](docs/images/dashcut-local-model.png)

### Apply one subtitle style everywhere

1. In **Captions**, click **Subtitle style**.
2. Choose the font, text size, text color, outline color/width, and background opacity.
3. Changes are applied immediately to every caption and reflected in the preview. Use **Restore defaults** to reset the full style.
4. Choose the Bilibili or YouTube preset, select 30 or 60 FPS, and export after reviewing the timeline.

## 4. Contributing and merging code

1. Fork the repository and create a focused branch such as `feat/subtitle-translation` or `fix/timeline-split`.
2. Install dependencies with `npm install`, implement the change, and add or update tests.
3. Run `npm run lint`, `npm test`, and `npm run desktop:smoke` before pushing.
4. Use a clear conventional commit, for example `feat: add bilingual translation provider`.
5. Push the branch and open a pull request against `main`. Explain the user impact, verification steps, platforms tested, and include screenshots for UI changes.
6. A maintainer reviews the pull request. Merge only after required checks pass and review comments are resolved; prefer **Squash and merge** so `main` keeps one coherent commit per pull request.

Please keep credentials, model weights, build output, and signing certificates out of commits. For larger changes, open an issue first so the implementation and compatibility plan can be agreed on.

## 5. License

DashCut is released under the [MIT License](LICENSE). FFmpeg is distributed under LGPLv2.1-or-later; other components and downloaded AI models remain subject to their own licenses and terms. See [Third-party notices](THIRD_PARTY_NOTICES.md).
