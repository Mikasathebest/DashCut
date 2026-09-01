/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getHardwareProfile } = require("./hardware.cjs");
const { transcribeLocal } = require("./local-transcription.cjs");
const { getModels, getRuntimeStatus, installModel, removeModel } = require("./model-manager.cjs");
const { exportVideo } = require("./video-export.cjs");

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
    onProgress: (progress) => event.sender.send("export:progress", progress),
  });
});
ipcMain.handle("export:reveal", (_event, target) => {
  if (typeof target === "string" && path.isAbsolute(target)) shell.showItemInFolder(target);
});

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
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(desktopServer.url);
}

app.whenReady().then(createWindow).catch((error) => {
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
