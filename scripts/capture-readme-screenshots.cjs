/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getHardwareProfile } = require("../electron/hardware.cjs");
const { getModels, getRuntimeStatus } = require("../electron/model-manager.cjs");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "docs", "images");

function localAiOptions() {
  const executable = process.platform === "win32" ? "dashcut-transcribe.exe" : "dashcut-transcribe";
  return {
    isPackaged: false,
    modelsPath: path.join(app.getPath("userData"), "models"),
    bundledRunnerPath: path.join(rootDir, "local-runtime", "dashcut-transcribe", executable),
    devRunnerPath: path.join(rootDir, "local-engine", "transcribe.py"),
  };
}

async function waitFor(window, selector, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function clickButton(window, text) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not find button containing: ${text}`);
}

async function capture(window, fileName) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage();
  await writeFile(path.join(outputDir, fileName), image.toPNG());
}

app.whenReady().then(async () => {
  const options = localAiOptions();
  ipcMain.handle("hardware:get-profile", async () => {
    const runtime = await getRuntimeStatus(options);
    return getHardwareProfile(app.getPath("userData"), runtime);
  });
  ipcMain.handle("models:list", () => getModels(options));

  const { startAppServer } = await import(pathToFileURL(path.join(rootDir, "electron", "server.mjs")).href);
  const desktopServer = await startAppServer({ rootDir });
  const window = new BrowserWindow({
    width: 1480,
    height: 930,
    backgroundColor: "#0c0e13",
    show: false,
    webPreferences: {
      preload: path.join(rootDir, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await mkdir(outputDir, { recursive: true });
    await window.loadURL(desktopServer.url);
    await waitFor(window, ".app-shell");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await clickButton(window, "字幕样式");
    await waitFor(window, ".subtitle-style-editor");
    await capture(window, "dashcut-subtitle-style.png");

    await clickButton(window, "字幕样式");
    await clickButton(window, "本地模型");
    await waitFor(window, ".hardware-content", 30000);
    await capture(window, "dashcut-local-model.png");
  } finally {
    window.destroy();
    await desktopServer.close();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
