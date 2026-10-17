/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, shell, systemPreferences } = require("electron");
const { existsSync } = require("node:fs");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getHardwareProfile } = require("./hardware.cjs");
const { transcribeLocal } = require("./local-transcription.cjs");
const { getModels, getRuntimeStatus, installModel, removeModel } = require("./model-manager.cjs");
const { exportVideo } = require("./video-export.cjs");
const { analyzeComposition, exportComposition } = require("./composition-export.cjs");
const { detectScenes, detectSpeechSegments, extractWaveform } = require("./smart-edit.cjs");
const { handleMediaScheme, registerMediaScheme } = require("./media-protocol.cjs");
const { createAgentHost } = require("./agent-host.cjs");
const { createKeyStore } = require("./agent-keys.cjs");
const { setLanguage, tr } = require("./i18n.cjs");
const { listVoices, renderDub } = require("./dubbing.cjs");
const { getSeparationStatus, installSeparationModel, separateAudio } = require("./separation.cjs");
const { createAutosave, createRecentList, findSiblings, loadProject, saveProject } = require("./project-store.cjs");
const { projectLibrary } = require("./project-library.cjs");

registerMediaScheme(protocol);
let media;
let mainWindow;
let projectState = { dirty: false, id: "" };
let closeConfirmed = false;
const recent = () => createRecentList(path.join(app.getPath("userData"), "recent-projects.json"));
const autosave = () => createAutosave(path.join(app.getPath("userData"), "autosave"));
const projectFilters = () => [{ name: tr("DashCut 项目"), extensions: ["dashcut"] }];
const { listModels, translateSubtitles, transcribeCloud } = require("./ai-api.cjs");

let desktopServer;

function localAiOptions() {
  const executable = process.platform === "win32" ? "dashcut-transcribe.exe" : "dashcut-transcribe";
  return {
    isPackaged: app.isPackaged,
    modelsPath: path.join(app.getPath("userData"), "models"),
    bundledRunnerPath: app.isPackaged
      ? path.join(process.resourcesPath, "local-runtime", "dashcut-transcribe", executable)
      : path.join(__dirname, "..", "local-runtime", "dashcut-transcribe", executable),
    devRunnerPath: path.join(__dirname, "..", "local-engine", "transcribe.py"),
  };
}

function mediaRuntimePath() {
  if (process.env.DASHCUT_FFMPEG_PATH) return process.env.DASHCUT_FFMPEG_PATH;
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const expected = app.isPackaged
    ? path.join(process.resourcesPath, "media-runtime", executable)
    : path.join(__dirname, "..", "media-runtime", "current", executable);
  return app.isPackaged || existsSync(expected) ? expected : undefined;
}

async function prepareStillImage(source, output) {
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) return source;
  await writeFile(output, image.toJPEG(95));
  return output;
}

ipcMain.handle("hardware:get-profile", async () => {
  const options = localAiOptions();
  const runtime = await getRuntimeStatus(options);
  return getHardwareProfile(app.getPath("userData"), runtime);
});
ipcMain.handle("models:list", () => getModels(localAiOptions()));
ipcMain.handle("models:install", (_event, model) => installModel(model, localAiOptions()));
ipcMain.handle("models:remove", (_event, model) => removeModel(model, localAiOptions()));
// Caption jobs report { progress: 0..1, stage } to the window that started them.
const captionProgress = (event) => (progress) => { if (!event.sender.isDestroyed()) event.sender.send("captions:progress", progress); };
ipcMain.handle("transcription:local", (event, request) => {
  const options = localAiOptions();
  return transcribeLocal(request, { ...options, getRuntimeStatus: () => getRuntimeStatus(options), onProgress: captionProgress(event) });
});
// Network calls go through Chromium (net.fetch) so system proxies and certificates apply.
const proxyAwareFetch = (...args) => net.fetch(...args);
ipcMain.handle("ai:models", (_event, config) => listModels(config, { fetchImpl: proxyAwareFetch }));
// Caption API key: encrypted with safeStorage (OS keychain) so it survives restarts; created lazily because safeStorage needs app ready.
let captionKeys = null;
const captionKeyStore = () => captionKeys ??= createKeyStore({ file: path.join(app.getPath("userData"), "caption-keys.json"), safeStorage });
ipcMain.handle("ai:saved-key", () => captionKeyStore().get("captions") || "");
ipcMain.handle("ai:save-key", (_event, key) => {
  if (typeof key === "string" && key.trim()) return captionKeyStore().set("captions", key);
  captionKeyStore().clear("captions");
  return { persisted: false };
});
// Text fields use Chromium's native clipboard; document.execCommand("paste") is blocked for page content.
ipcMain.handle("edit:native", (event, command) => {
  if (["copy", "cut", "paste", "undo", "redo", "selectAll"].includes(command)) event.sender[command]();
});
ipcMain.handle("ai:translate", (event, request) => translateSubtitles(request, { onProgress: captionProgress(event), fetchImpl: proxyAwareFetch }));
ipcMain.handle("ai:transcribe", (event, request) => transcribeCloud(request, {
  tempPath: app.getPath("temp"), ffmpegPath: mediaRuntimePath(), onProgress: captionProgress(event), fetchImpl: proxyAwareFetch,
}));
ipcMain.handle("export:video", async (event, request) => {
  const result = await dialog.showSaveDialog({
    title: tr("导出视频"),
    defaultPath: "DashCut-export.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return exportVideo(request, {
    outputPath: result.filePath,
    tempPath: app.getPath("temp"),
    ffmpegPath: mediaRuntimePath(),
    platform: process.platform,
    prepareStill: prepareStillImage,
    onProgress: (progress) => event.sender.send("export:progress", progress),
  });
});
ipcMain.handle("export:composition", async (event, request) => {
  // Automated end-to-end runs pass the destination instead of driving the native dialog.
  const format = ["mp4", "mov", "m4a", "wav", "gif"].includes(request?.output?.format) ? request.output.format : "mp4";
  const kinds = { mp4: tr("MP4 视频"), mov: tr("QuickTime 视频"), m4a: tr("M4A 音频"), wav: tr("WAV 音频"), gif: tr("GIF 动图") };
  const result = process.env.DASHCUT_EXPORT_PATH ? { canceled: false, filePath: process.env.DASHCUT_EXPORT_PATH } : await dialog.showSaveDialog({
    title: tr("导出"),
    defaultPath: `DashCut-export.${format}`,
    filters: [{ name: kinds[format], extensions: [format] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  return exportComposition(request, {
    outputPath: result.filePath,
    tempPath: app.getPath("temp"),
    ffmpegPath: mediaRuntimePath(),
    platform: process.platform,
    prepareStill: prepareStillImage,
    onProgress: (progress) => event.sender.send("export:progress", progress),
  });
});
function separationOptions() {
  const executable = process.platform === "win32" ? "dashcut-separate.exe" : "dashcut-separate";
  return {
    isPackaged: app.isPackaged,
    modelsPath: path.join(app.getPath("userData"), "models"),
    bundledSeparatorPath: app.isPackaged ? path.join(process.resourcesPath, "local-runtime", "dashcut-separate", executable) : undefined,
  };
}
const separationProgress = (event) => ({ progress, stage }) => captionProgress(event)({ progress, stage: tr(stage) });
ipcMain.handle("separation:status", () => getSeparationStatus(separationOptions()));
ipcMain.handle("separation:install", (event) => installSeparationModel(separationOptions(), separationProgress(event)));
ipcMain.handle("separation:run", (event, input) => separateAudio({
  input, cacheDir: path.join(app.getPath("userData"), "stems"), ffmpegPath: mediaRuntimePath(),
}, separationOptions(), separationProgress(event)));
ipcMain.handle("dub:voices", () => listVoices());
ipcMain.handle("dub:render", (event, request) => renderDub({
  lines: request?.lines, voice: request?.voice, language: request?.language,
  outputPath: path.join(app.getPath("userData"), "dubs", `dub-${Date.now()}.wav`),
  tempPath: app.getPath("temp"), ffmpegPath: mediaRuntimePath(), onProgress: (progress) => captionProgress(event)({ progress, stage: tr("正在合成配音…") }),
}));
ipcMain.handle("media:waveform", (_event, source) => extractWaveform(source, { ffmpegPath: mediaRuntimePath() }));
ipcMain.handle("smart:scenes", (_event, source, range) => detectScenes(source, { ...range, ffmpegPath: mediaRuntimePath() }));
ipcMain.handle("smart:speech", (_event, source, range) => detectSpeechSegments(source, { ...range, ffmpegPath: mediaRuntimePath() }));
ipcMain.handle("recording:save", async (_event, bytes) => {
  const folder = path.join(app.getPath("userData"), "recordings");
  await mkdir(folder, { recursive: true });
  const target = path.join(folder, `recording-${Date.now()}.webm`);
  await writeFile(target, Buffer.from(bytes));
  return target;
});
ipcMain.handle("media:microphone", async () => {
  if (process.platform !== "darwin") return true;
  return systemPreferences.getMediaAccessStatus("microphone") === "granted" || systemPreferences.askForMediaAccess("microphone");
});
// Title layers rendered by the editor for the exporter; old ones are cleared on the next launch.
const layerDir = () => path.join(app.getPath("temp"), "dashcut-layers");
ipcMain.handle("export:write-layer", async (_event, bytes) => {
  await mkdir(layerDir(), { recursive: true });
  const target = path.join(layerDir(), `layer-${Date.now()}-${Math.random().toString(36).slice(2)}.rgba`);
  await writeFile(target, Buffer.from(bytes));
  return target;
});
app.whenReady().then(() => rm(layerDir(), { recursive: true, force: true })).catch(() => undefined);
// Open face-detection model (MediaPipe BlazeFace short range, Apache-2.0), downloaded on first use of smart reframe.
const faceModelUrl = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
ipcMain.handle("reframe:model", async () => {
  const target = path.join(app.getPath("userData"), "models", "face", "blaze_face_short_range.tflite");
  if (!existsSync(target)) {
    // Chromium's network stack honours system proxies, unlike Node's fetch.
    const response = await net.fetch(faceModelUrl);
    if (!response.ok) throw new Error(tr("人脸检测模型下载失败（HTTP {status}）", { status: response.status }));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 100_000) throw new Error(tr("人脸检测模型下载不完整"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(`${target}.tmp`, bytes);
    await rename(`${target}.tmp`, target);
  }
  const data = await readFile(target);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});
ipcMain.handle("export:analyze", (event, request) => analyzeComposition(request, {
  tempPath: app.getPath("temp"),
  ffmpegPath: mediaRuntimePath(),
  platform: process.platform,
  prepareStill: prepareStillImage,
  onProgress: (progress) => event.sender.send("export:progress", progress),
}));
ipcMain.handle("media:exists", (_event, paths) => (Array.isArray(paths) ? paths : []).map((item) => typeof item === "string" && path.isAbsolute(item) && existsSync(item)));
ipcMain.handle("media:register", (_event, paths) => media.allow(Array.isArray(paths) ? paths : []));
ipcMain.handle("project:save", async (_event, { document, projectPath, saveAs }) => {
  let target = projectPath;
  if ((!target || saveAs) && process.env.DASHCUT_PROJECT_PATH) target = process.env.DASHCUT_PROJECT_PATH;
  else if (!target || saveAs) {
    const result = await dialog.showSaveDialog(mainWindow, { title: saveAs ? tr("项目另存为") : tr("保存项目"), defaultPath: `${document.meta.title || tr("未命名项目")}.dashcut`, filters: projectFilters() });
    if (result.canceled || !result.filePath) return { canceled: true };
    target = result.filePath.endsWith(".dashcut") ? result.filePath : `${result.filePath}.dashcut`;
  }
  await saveProject(target, document);
  await recent().add({ path: target, title: document.meta.title });
  await autosave().clear(document.meta.id);
  app.addRecentDocument(target);
  return { projectPath: target };
});
ipcMain.handle("project:open", async (_event, requested) => {
  let target = requested;
  if (!target) {
    const result = await dialog.showOpenDialog(mainWindow, { title: tr("打开项目"), filters: projectFilters(), properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    target = result.filePaths[0];
  }
  const { doc, missing } = await loadProject(target);
  await recent().add({ path: target, title: doc.meta?.title ?? path.basename(target, ".dashcut") });
  return { projectPath: target, document: doc, missing };
});
ipcMain.handle("project:recent", () => recent().list());
ipcMain.handle("project:library", async () => projectLibrary({
  recent: await recent().list(),
  roots: process.env.DASHCUT_PROJECT_ROOTS ? process.env.DASHCUT_PROJECT_ROOTS.split(path.delimiter) : ["videos", "documents", "desktop", "downloads"].map((name) => { try { return app.getPath(name); } catch { return ""; } }).filter(Boolean),
  ffmpegPath: mediaRuntimePath(),
  cacheDir: path.join(app.getPath("userData"), "project-previews"),
  encodeImage: async (file) => {
    const image = nativeImage.createFromPath(file);
    return image.isEmpty() ? "" : `data:image/jpeg;base64,${image.resize({ width: 480 }).toJPEG(80).toString("base64")}`;
  },
}));
ipcMain.handle("project:recent-remove", (_event, target) => recent().remove(target));
ipcMain.handle("project:autosave", (_event, { document, projectPath }) => autosave().write(document.meta.id, { document, projectPath }));
ipcMain.handle("project:recovery-list", () => autosave().list());
ipcMain.handle("project:recovery-read", (_event, id) => autosave().read(id));
ipcMain.handle("project:recovery-discard", (_event, id) => autosave().clear(id));
ipcMain.handle("project:locate", async (_event, { name, otherNames }) => {
  const result = await dialog.showOpenDialog(mainWindow, { title: tr("重新定位「{name}」", { name }), properties: ["openFile"] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const chosen = result.filePaths[0];
  return { path: chosen, siblings: findSiblings(path.dirname(chosen), Array.isArray(otherNames) ? otherNames : []) };
});
ipcMain.handle("ui:language", (_event, next) => {
  setLanguage(next);
  buildMenu();
});
ipcMain.handle("project:state", (_event, state) => { projectState = { dirty: Boolean(state?.dirty), id: String(state?.id ?? "") }; });
ipcMain.handle("project:close-ready", () => { closeConfirmed = true; mainWindow?.close(); });
ipcMain.handle("export:reveal", (_event, target) => {
  if (typeof target === "string" && path.isAbsolute(target)) shell.showItemInFolder(target);
});

function sendCommand(command) {
  mainWindow?.webContents.send("menu:command", command);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: tr("文件"), submenu: [
      { label: tr("新建项目"), accelerator: "CmdOrCtrl+N", click: () => sendCommand("new") },
      { label: tr("打开项目…"), accelerator: "CmdOrCtrl+O", click: () => sendCommand("open") },
      { label: tr("保存"), accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
      { label: tr("另存为…"), accelerator: "Shift+CmdOrCtrl+S", click: () => sendCommand("save-as") },
      { type: "separator" },
      { label: tr("导入素材…"), accelerator: "CmdOrCtrl+I", click: () => sendCommand("import") },
      { label: tr("导出视频…"), accelerator: "CmdOrCtrl+E", click: () => sendCommand("export") },
      { type: "separator" },
      { label: tr("极剪助手"), accelerator: "CmdOrCtrl+J", click: () => sendCommand("agent") },
      ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
    ] },
    // Undo/redo route through the renderer so text fields and the timeline each get their own history.
    { label: tr("编辑"), submenu: [
      { label: tr("撤销"), accelerator: "CmdOrCtrl+Z", click: () => sendCommand("undo") },
      { label: tr("重做"), accelerator: "Shift+CmdOrCtrl+Z", click: () => sendCommand("redo") },
      { type: "separator" },
      // Clipboard items also route through the renderer: text fields keep native behaviour, clips get clip copy/paste.
      { label: tr("剪切"), accelerator: "CmdOrCtrl+X", click: () => sendCommand("cut") },
      { label: tr("复制"), accelerator: "CmdOrCtrl+C", click: () => sendCommand("copy") },
      { label: tr("粘贴"), accelerator: "CmdOrCtrl+V", click: () => sendCommand("paste") },
      { label: tr("复制并粘贴"), accelerator: "CmdOrCtrl+D", click: () => sendCommand("duplicate") },
      { label: tr("全选"), accelerator: "CmdOrCtrl+A", click: () => sendCommand("select-all") },
    ] },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const { startAppServer } = await import(pathToFileURL(path.join(__dirname, "server.mjs")).href);
  desktopServer = await startAppServer({ rootDir: app.getAppPath() });
  const window = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: "#0c0e13",
    title: "DashCut 极剪",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("blur", () => sendCommand("autosave"));
  window.on("close", (event) => {
    if (closeConfirmed || !projectState.dirty) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, { type: "warning", buttons: [tr("保存"), tr("不保存"), tr("取消")], defaultId: 0, cancelId: 2, message: tr("项目有未保存的修改"), detail: tr("关闭前要保存当前项目吗？") });
    if (choice === 0) sendCommand("save-and-close");
    if (choice === 1) {
      closeConfirmed = true;
      void autosave().clear(projectState.id).finally(() => window.close());
    }
  });
  window.on("closed", () => { mainWindow = undefined; closeConfirmed = false; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(desktopServer.url);
}

app.whenReady().then(() => {
  media = handleMediaScheme(protocol);
  createAgentHost({
    ipcMain,
    safeStorage,
    configFile: path.join(app.getPath("userData"), "agent-config.json"),
    keyFile: path.join(app.getPath("userData"), "agent-keys.json"),
    getWindow: () => mainWindow,
    fetch: proxyAwareFetch,
  });
  buildMenu();
  return createWindow();
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  desktopServer?.server?.close();
});
