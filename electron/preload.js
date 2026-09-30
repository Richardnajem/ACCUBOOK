// Preload script for Electron - provides secure bridge between renderer and main process
const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isElectron: true,

  // ── Manual updates (Settings page) ──────────────────────────
  // The app NEVER checks/downloads on its own; every step is user-initiated.
  updates: {
    // True only in packaged (installed/portable) builds — the button is
    // hidden in dev where updates don't apply.
    isPackaged: () => ipcRenderer.invoke("updates:is-packaged"),
    // Current app version, e.g. "2.1.0".
    getVersion: () => ipcRenderer.invoke("updates:version"),
    // Step 1: ask GitHub Releases if a newer version exists (no download).
    check: () => ipcRenderer.send("updates:check"),
    // Step 2: download the update after the user confirms.
    download: () => ipcRenderer.send("updates:download"),
    // Step 3: quit and install (only enabled after "downloaded").
    install: () => ipcRenderer.send("updates:install"),
    // Progress feed: { type: "checking" | "available" | "up-to-date" |
    //   "downloading" | "downloaded" | "error", version?, percent? }
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("update-status", listener);
      return () => ipcRenderer.removeListener("update-status", listener);
    },
  },
});
