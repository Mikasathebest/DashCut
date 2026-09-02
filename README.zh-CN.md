# DashCut 极剪

[English](README.md) · [下载安装包](https://github.com/Mikasathebest/DashCut/releases/latest) · [提交问题](https://github.com/Mikasathebest/DashCut/issues)

## 1. 项目综述

DashCut（极剪）是一款面向哔哩哔哩和 YouTube 创作者的桌面视频编辑器，重点解决创作中最重复的工作：一次导入多个视频片段、分割和调整时间线、添加背景音乐、生成 1280 × 720 首页图、通过本地 `faster-whisper` 提取带时间轴的中文或英文字幕、统一修改所有字幕的字体/颜色/大小，以及选择 30 或 60 FPS 导出。使用本地 AI 前，极剪会检测 CPU、GPU、内存和磁盘并推荐合适模型；只有用户主动点击安装后才下载模型，安装包用户不需要配置 Python 或其他 AI 依赖。

主要亮点：

- 多视频片段导入、预览、时间线分割和移除
- 本地中文/英文语音识别，以及逐句字幕时间和文本编辑
- 一次设置所有字幕的字体、字号、颜色、描边与背景
- 按需管理 `small`、`medium`、`turbo`、`large-v3` 模型
- 自动检测硬件，并提供 CPU INT8 或 NVIDIA CUDA 推理建议
- 背景音乐、16:9 / 9:16 画布和封面设计器
- 哔哩哔哩 / YouTube 导出预设与 30 / 60 FPS 选项
- Windows x64 未签名一键安装 `.exe`，以及一份 macOS Apple Silicon `.dmg`；配置 Apple 凭据后自动签名和公证

> 当前状态：本地原语言字幕提取已经实现。云端识别提供方和中英自动互译尚未配置；当前版本可以手动编辑第二语言字幕。

## 2. 安装

### 下载安装包

[**下载最新版 DashCut 极剪 →**](https://github.com/Mikasathebest/DashCut/releases/latest)

- Windows：下载 x64 `.exe` 后双击安装；由于尚未签名，Windows 可能显示“未知发布者”或 SmartScreen 确认页。
- macOS：发布的 `.dmg` 支持 Apple Silicon Mac（M1 或更新机型），打开后把 DashCut 拖入“应用程序”。在安装包尚未公证时，首次启动可能需要右键点击 DashCut 并选择“打开”，或到“系统设置 → 隐私与安全性”中允许打开。
- 本地字幕模型不会预装。打开 **字幕 → 本地模型**，查看硬件建议，再点击 **下载安装** 所需模型。

### 从源代码手动安装

环境要求：Node.js 22.13+；Python 3.9+（仅用于构建独立的本地 AI 运行时）。

```bash
git clone https://github.com/Mikasathebest/DashCut.git
cd DashCut
npm install
npm run runtime:build
npm run desktop
```

在本机生成安装包：

```bash
npm run dist:win   # Windows x64 .exe
npm run dist:mac   # macOS .dmg
```

Windows x64 无需证书即可发布未签名的一键安装 `.exe`，但 Windows 可能显示“未知发布者”或 SmartScreen 警告；macOS Apple Silicon 无凭据时也会生成 DMG，但需要 Apple Developer 凭据才能签名、公证并正常通过 Gatekeeper。详见 [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md)。两个安装包都内置独立的 LGPL FFmpeg 运行时：macOS 使用 VideoToolbox，Windows 使用 MediaFoundation，并同时内置源码说明、许可证、依赖许可证和实际构建配置；详见 [`docs/FFMPEG_RUNTIME.md`](docs/FFMPEG_RUNTIME.md)。

## 3. 使用教程

![DashCut 极剪字幕全局样式设置](docs/images/dashcut-subtitle-style.png)

### 导入和编辑多个片段

1. 打开 **媒体**，一次选择多个视频文件导入。
2. 在时间线上选择片段，把播放头移动到目标位置，点击 **分割**。
3. 打开 **音频**，添加音乐文件并设置背景音乐音量。
4. 打开 **封面**，修改标题和强调色，保存 1280 × 720 PNG 首页图。

### 本地提取中文或英文字幕

1. 打开 **字幕**，选择 **本地模型**，让极剪自动检测设备。
2. 查看 CPU、NVIDIA GPU、内存、磁盘和内置运行时状态，使用推荐模型或选择其他兼容模型。
3. 点击 **下载安装**；在点击之前，极剪不会下载任何模型数据。
4. 导入视频，选择字幕视图（**中文**、**English** 或 **双语**），点击 **生成字幕**。
5. `faster-whisper` 会检测每个片段的口语语言。中文识别结果写入中文字段，英文识别结果写入英文字段；导出前请逐句检查专有名词和标点。
6. 当前若要显示双语字幕，请手动填写翻译后的第二行。接入云端或本地翻译提供方后，将支持中英自动互译。

![DashCut 极剪本地 AI 硬件检测和模型选择](docs/images/dashcut-local-model.png)

### 统一设置全部字幕样式

1. 在 **字幕** 中点击 **字幕样式**。
2. 设置字体、字号、文字颜色、描边颜色/宽度和背景透明度。
3. 所有字幕会立即应用同一套样式并反映在预览中；点击 **恢复默认样式** 可以整体重置。
4. 检查时间线后选择哔哩哔哩或 YouTube 预设，再选择 30 或 60 FPS 导出。

## 4. 参与贡献与合并代码

1. Fork 仓库，并创建单一目的的分支，例如 `feat/subtitle-translation` 或 `fix/timeline-split`。
2. 运行 `npm install` 安装依赖，完成改动并新增或更新测试。
3. 推送前运行 `npm run lint`、`npm test` 和 `npm run desktop:smoke`。
4. 使用清晰的约定式提交，例如 `feat: add bilingual translation provider`。
5. 推送分支并向 `main` 发起 Pull Request，说明用户影响、验证步骤、测试平台；界面改动需附截图。
6. 维护者审核后，只有在检查通过且所有审核意见解决后才能合并；建议使用 **Squash and merge**，让每个 PR 在 `main` 中保留一个完整提交。

请勿提交账号密钥、模型权重、构建产物或签名证书。较大的改动建议先创建 Issue，对实现范围和兼容方案达成一致。

## 5. License

DashCut 极剪以 [MIT License](LICENSE) 开源。FFmpeg 以 LGPLv2.1-or-later 分发；其他第三方组件和用户下载的 AI 模型分别遵循其自身许可证与使用条款，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
