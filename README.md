# FrameFlow

FrameFlow 是一个面向哔哩哔哩和 YouTube 创作者的双语智能视频编辑器原型，同时支持网页与桌面应用。

## 已实现

- 导入并预览本地视频
- 在播放头位置分割或删除时间轴片段
- 导入背景音乐、调整音量并开启智能避让
- 自动生成和逐句编辑中文、英文或中英双语字幕
- 切换 16:9 / 9:16 画布
- 通过封面设计器生成并保存 1280×720 PNG 首页图
- 使用哔哩哔哩 / YouTube 预设配置 1080P、4K 与 30/60 FPS 导出
- 保存包含时间轴、字幕和导出选项的项目文件

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开终端显示的本地地址（默认 `http://localhost:3000`）。

运行桌面应用：

```bash
npm run desktop
```

## Windows 与 macOS 安装包

每次推送 `v*` 版本标签（例如 `v0.1.0`），GitHub Actions 会自动：

- 在 Windows 环境构建 x64 一键安装 `.exe`
- 在 macOS 环境构建同时支持 Apple Silicon 与 Intel Mac 的通用 `.dmg`
- 创建对应 GitHub Release，并附加两个安装包与自动生成的版本说明

也可以在 GitHub Actions 页面手动运行 **Build signed desktop installers** 工作流验证安装包。

Release 构建要求 Windows Authenticode 与 Apple Developer ID 签名，并自动完成 Apple notarization；缺少任何证书或公证材料时发布会直接失败。首次配置参见 [`docs/CODE_SIGNING.md`](docs/CODE_SIGNING.md)。

## 验证

```bash
npm test
```

当前版本专注于可交互的前端工作流。真实语音识别、逐帧转码和最终 MP4 渲染需要在后续版本接入媒体处理后端（例如 FFmpeg 与语音识别服务）。
