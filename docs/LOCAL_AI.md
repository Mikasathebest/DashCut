# DashCat 本地字幕运行时

DashCat 桌面版可以在“自动字幕”中切换云端模型或本地 `faster-whisper`。应用安装包自带隔离的 Python、CTranslate2 和 PyAV 运行时；用户不需要安装 Python、FFmpeg 或修改环境变量。本地模型按需下载到应用数据目录，不会打进 `.exe` 或 `.dmg`。

## 支持范围

- 开发环境中的 `faster-whisper` 要求 Python 3.9 或更高版本；发布版已经内置兼容版本。
- Windows / Linux 的 GPU 推理要求 NVIDIA GPU、CUDA 12 的 cuBLAS 和 CUDA 12 的 cuDNN 9。
- macOS 可以通过 x86-64 或 ARM64 CPU 运行，但 CTranslate2 的预编译 GPU 后端不支持 Apple Metal GPU。因此 MacBook 会使用 CPU 推理。
- 不要求系统单独安装 FFmpeg；`faster-whisper` 使用 PyAV 自带的 FFmpeg 库解码音视频。

上面的运行时要求来自 [`faster-whisper` 官方文档](https://github.com/SYSTRAN/faster-whisper#requirements)和 [CTranslate2 硬件支持文档](https://opennmt.net/CTranslate2/hardware_support.html)。

## DashCat 配置等级

下面是 DashCat 为保证视频编辑期间仍有可用内存而采用的产品门槛，不是上游项目声明的绝对最低值。

| 等级 | CPU | 系统内存 | GPU | 可用磁盘 | 默认模型 |
| --- | --- | --- | --- | --- | --- |
| 最低可用 | 4 个逻辑核心 | 8 GB | 可选 | 4 GB | `small` + CPU INT8 |
| 推荐 | 8 个逻辑核心 | 16 GB | NVIDIA 8 GB VRAM | 10 GB | `large-v3` + CUDA FP16 |

原始 Whisper 给出的近似显存需求为：`small` 约 2 GB、`medium` 约 5 GB、`turbo` 约 6 GB、`large` 约 10 GB。`faster-whisper` 的 INT8 模式通常会进一步减少占用，但同时运行视频预览和导出仍需保留余量。[Whisper 模型列表](https://github.com/openai/whisper#available-models-and-languages)

## 模型安装行为

- 首次安装 DashCat 时不会下载任何模型权重。
- 选择“本地模型”会自动检测硬件，但不会开始下载。
- 只有用户点击“下载安装”后，所选模型才会写入应用数据目录。
- 本地识别强制使用 `local_files_only`；未安装的模型不会在识别过程中后台下载。
- 下载失败会删除不完整目录，避免把损坏模型显示为“已安装”。

## 开发环境构建

```bash
npm run runtime:build
npm run desktop
```

`runtime:build` 在项目内创建隔离的 `.runtime-venv`，然后使用 PyInstaller 生成当前操作系统和 CPU 架构对应的独立运行时，不会修改用户全局 Python。

Windows 和 macOS 安装包分别运行：

```bash
npm run dist:win
npm run dist:mac
```

Release 工作流会在 Windows x64、macOS Apple Silicon 和 macOS Intel 三种环境分别构建运行时，再签名并生成一键安装包。PyInstaller 会把 Python 解释器和依赖复制进应用资源目录，模型权重仍保持按需下载。[PyInstaller 运行方式](https://pyinstaller.org/en/stable/operating-mode.html)

## 当前边界

本地运行器已能输出原语言字幕和词级时间戳。中英双向翻译仍通过独立翻译提供方完成；不要使用 Whisper 的 `translate` 任务代替双向翻译，因为该任务的目标语言仅为英文。
