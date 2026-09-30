// Preload script for Electron - provides secure bridge between renderer and main process
const { contextBridge } = require("electron");

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,
});
