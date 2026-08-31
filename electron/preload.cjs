/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("dashCutDesktop", {
  platform: process.platform,
  version: process.versions.electron,
  getFilePath: (file) => webUtils.getPathForFile(file),
  getHardwareProfile: () => ipcRenderer.invoke("hardware:get-profile"),
  getLocalModels: () => ipcRenderer.invoke("models:list"),
  installLocalModel: (model) => ipcRenderer.invoke("models:install", model),
  removeLocalModel: (model) => ipcRenderer.invoke("models:remove", model),
  transcribeLocal: (request) => ipcRenderer.invoke("transcription:local", request),
});
