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
  listAiModels: (config) => ipcRenderer.invoke("ai:models", config),
  translateSubtitles: (request) => ipcRenderer.invoke("ai:translate", request),
  transcribeCloud: (request) => ipcRenderer.invoke("ai:transcribe", request),
  exportVideo: (request) => ipcRenderer.invoke("export:video", request),
  revealExport: (target) => ipcRenderer.invoke("export:reveal", target),
  exportComposition: (request) => ipcRenderer.invoke("export:composition", request),
  extractWaveform: (source) => ipcRenderer.invoke("media:waveform", source),
  detectScenes: (source, range) => ipcRenderer.invoke("smart:scenes", source, range),
  detectSpeechSegments: (source, range) => ipcRenderer.invoke("smart:speech", source, range),
  saveRecording: (bytes) => ipcRenderer.invoke("recording:save", bytes),
  requestMicrophone: () => ipcRenderer.invoke("media:microphone"),
  registerMedia: (paths) => ipcRenderer.invoke("media:register", paths),
  saveProject: (request) => ipcRenderer.invoke("project:save", request),
  openProject: (projectPath) => ipcRenderer.invoke("project:open", projectPath),
  recentProjects: () => ipcRenderer.invoke("project:recent"),
  removeRecentProject: (projectPath) => ipcRenderer.invoke("project:recent-remove", projectPath),
  autosaveProject: (request) => ipcRenderer.invoke("project:autosave", request),
  recoveryList: () => ipcRenderer.invoke("project:recovery-list"),
  readRecovery: (id) => ipcRenderer.invoke("project:recovery-read", id),
  discardRecovery: (id) => ipcRenderer.invoke("project:recovery-discard", id),
  locateMedia: (request) => ipcRenderer.invoke("project:locate", request),
  setProjectState: (state) => ipcRenderer.invoke("project:state", state),
  closeReady: () => ipcRenderer.invoke("project:close-ready"),
  onMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
  onExportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("export:progress", listener);
    return () => ipcRenderer.removeListener("export:progress", listener);
  },
  onCaptionProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("captions:progress", listener);
    return () => ipcRenderer.removeListener("captions:progress", listener);
  },
});
