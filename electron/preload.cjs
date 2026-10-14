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
  listHubModels: (config) => ipcRenderer.invoke("hub:models", config),
  translateSubtitles: (request) => ipcRenderer.invoke("hub:translate", request),
  transcribeHub: (request) => ipcRenderer.invoke("hub:transcribe", request),
  exportVideo: (request) => ipcRenderer.invoke("export:video", request),
  revealExport: (target) => ipcRenderer.invoke("export:reveal", target),
  exportComposition: (request) => ipcRenderer.invoke("export:composition", request),
  extractWaveform: (source) => ipcRenderer.invoke("media:waveform", source),
  detectScenes: (source, range) => ipcRenderer.invoke("smart:scenes", source, range),
  detectSpeechSegments: (source, range) => ipcRenderer.invoke("smart:speech", source, range),
  saveRecording: (bytes) => ipcRenderer.invoke("recording:save", bytes),
  requestMicrophone: () => ipcRenderer.invoke("media:microphone"),
  onExportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("export:progress", listener);
    return () => ipcRenderer.removeListener("export:progress", listener);
  },
});
