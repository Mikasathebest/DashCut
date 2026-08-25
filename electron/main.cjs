const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let desktopServer;

async function createWindow() {
  const { startAppServer } = await import(pathToFileURL(path.join(__dirname, "server.mjs")).href);
  desktopServer = await startAppServer({ rootDir: app.getAppPath() });
  const window = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: "#0c0e13",
    title: "FrameFlow",
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
