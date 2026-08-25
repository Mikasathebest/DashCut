const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("frameFlowDesktop", {
  platform: process.platform,
  version: process.versions.electron,
});
