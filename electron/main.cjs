/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell, systemPreferences } = require("electron");
const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getHardwareProfile } = require("./hardware.cjs");
const { transcribeLocal } = require("./local-transcription.cjs");
const { getModels, getRuntimeStatus, installModel, removeModel } = require("./model-manager.cjs");
const { exportVideo } = require("./video-export.cjs");
const { exportComposition } = require("./composition-export.cjs");
const { detectScenes, detectSpeechSegments, extractWaveform } = require("./smart-edit.cjs");
const { handleMediaScheme, registerMediaScheme } = require("./media-protocol.cjs");
const { createAutosave, createRecentList, findSiblings, loadProject, saveProject } = require("./project-store.cjs");

registerMediaScheme(protocol);
let media;
let mainWindow;
let projectState = { dirty: false, id: "" };
let closeConfirmed = false;
const recent = () => createRecentList(path.join(app.getPath("userData"), "recent-projects.json"));
const autosave = () => createAutosave(path.join(app.getPath("userData"), "autosave"));
const projectFilters = [{ name: "DashCut 项目", extensions: ["dashcut"] }];
const { listHubModels, translateSubtitles, transcribeHub } = require("./AI API.cjs");

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
ipcMain.handle("transcription:local", (_event, request) => {
  const options = localAiOptions();
  return transcribeLocal(request, { ...options, getRuntimeStatus: () => getRuntimeStatus(options) });
});
ipcMain.handle("hub:models", (_event, config) => listHubModels(config));
ipcMain.handle("hub:translate", (_event, request) => translateSubtitles(request));
ipcMain.handle("hub:transcribe", (_event, request) => transcribeHub(request, {
  tempPath: app.getPath("temp"), ffmpegPath: mediaRuntimePath(),
}));
ipcMain.handle("export:video", async (event, request) => {
  const result = await dialog.showSaveDialog({
    title: "导出视频",
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
  const result = process.env.DASHCUT_EXPORT_PATH ? { canceled: false, filePath: process.env.DASHCUT_EXPORT_PATH } : await dialog.showSaveDialog({
    title: "导出视频",
    defaultPath: "DashCut-export.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
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
ipcMain.handle("media:register", (_event, paths) => media.allow(Array.isArray(paths) ? paths : []));
ipcMain.handle("project:save", async (_event, { document, projectPath, saveAs }) => {
  let target = projectPath;
  if ((!target || saveAs) && process.env.DASHCUT_PROJECT_PATH) target = process.env.DASHCUT_PROJECT_PATH;
  else if (!target || saveAs) {
    const result = await dialog.showSaveDialog(mainWindow, { title: saveAs ? "项目另存为" : "保存项目", defaultPath: `${document.meta.title || "未命名项目"}.dashcut`, filters: projectFilters });
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
    const result = await dialog.showOpenDialog(mainWindow, { title: "打开项目", filters: projectFilters, properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    target = result.filePaths[0];
  }
  const { doc, missing } = await loadProject(target);
  await recent().add({ path: target, title: doc.meta?.title ?? path.basename(target, ".dashcut") });
  return { projectPath: target, document: doc, missing };
});
ipcMain.handle("project:recent", () => recent().list());
ipcMain.handle("project:recent-remove", (_event, target) => recent().remove(target));
ipcMain.handle("project:autosave", (_event, { document, projectPath }) => autosave().write(document.meta.id, { document, projectPath }));
ipcMain.handle("project:recovery-list", () => autosave().list());
ipcMain.handle("project:recovery-read", (_event, id) => autosave().read(id));
ipcMain.handle("project:recovery-discard", (_event, id) => autosave().clear(id));
ipcMain.handle("project:locate", async (_event, { name, otherNames }) => {
  const result = await dialog.showOpenDialog(mainWindow, { title: `重新定位「${name}」`, properties: ["openFile"] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const chosen = result.filePaths[0];
  return { path: chosen, siblings: findSiblings(path.dirname(chosen), Array.isArray(otherNames) ? otherNames : []) };
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
    { label: "文件", submenu: [
      { label: "新建项目", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new") },
      { label: "打开项目…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("open") },
      { label: "保存", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
      { label: "另存为…", accelerator: "Shift+CmdOrCtrl+S", click: () => sendCommand("save-as") },
      { type: "separator" },
      { label: "导入素材…", accelerator: "CmdOrCtrl+I", click: () => sendCommand("import") },
      { label: "导出视频…", accelerator: "CmdOrCtrl+E", click: () => sendCommand("export") },
      ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
    ] },
    // Undo/redo route through the renderer so text fields and the timeline each get their own history.
    { label: "编辑", submenu: [
      { label: "撤销", accelerator: "CmdOrCtrl+Z", click: () => sendCommand("undo") },
      { label: "重做", accelerator: "Shift+CmdOrCtrl+Z", click: () => sendCommand("redo") },
      { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
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
    const choice = dialog.showMessageBoxSync(window, { type: "warning", buttons: ["保存", "不保存", "取消"], defaultId: 0, cancelId: 2, message: "项目有未保存的修改", detail: "关闭前要保存当前项目吗？" });
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
