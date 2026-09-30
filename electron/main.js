const { app, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const net = require("net");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

// Updates are 100% MANUAL. The app never checks for updates on its own —
// the only check happens when the user clicks "Check for Updates" in
// Settings. Even then nothing downloads automatically: the user confirms,
// the update downloads, and installs on the next app quit (or on demand).
// Safe on every PC: if this no-ops (dev mode, offline, no releases yet),
// the Settings page just says "Up to date" or "Couldn't check".
let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = false;          // never download without the user asking
  autoUpdater.autoInstallOnAppQuit = false;  // never swap binaries silently
  autoUpdater.on("update-available", (info) => {
    if (mainWindow) {
      mainWindow.webContents.send("update-status", { type: "available", version: info.version });
    }
  });
  autoUpdater.on("update-not-available", (info) => {
    if (mainWindow) {
      mainWindow.webContents.send("update-status", { type: "up-to-date", version: info?.version });
    }
  });
  autoUpdater.on("error", () => {
    if (mainWindow) mainWindow.webContents.send("update-status", { type: "error" });
  });
  autoUpdater.on("download-progress", (p) => {
    if (mainWindow) mainWindow.webContents.send("update-status", { type: "downloading", percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (mainWindow) mainWindow.webContents.send("update-status", { type: "downloaded", version: info?.version });
  });
} catch {
  // electron-updater not installed / not packaged yet — ignore
}

// Manual-only check, invoked from the Settings page.
function checkForUpdates() {
  if (!autoUpdater || app.isPackaged !== true) {
    if (mainWindow) mainWindow.webContents.send("update-status", { type: "up-to-date" });
    return;
  }
  // Network/publish-config errors surface as the "error" status above.
  autoUpdater.checkForUpdates().catch(() => {});
}

function downloadUpdate() {
  if (!autoUpdater || app.isPackaged !== true) return;
  autoUpdater.downloadUpdate().catch(() => {});
}

function installUpdate() {
  if (!autoUpdater || app.isPackaged !== true) return;
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
}

// IPC surface for the renderer (Settings page).
ipcMain.on("updates:check", () => checkForUpdates());
ipcMain.on("updates:download", () => downloadUpdate());
ipcMain.on("updates:install", () => installUpdate());
ipcMain.handle("updates:is-packaged", () => app.isPackaged === true);
ipcMain.handle("updates:version", () => app.getVersion());
}

const isDev = !app.isPackaged;

// Where the packaged Next.js app lives (electron-builder "files" copies the
// whole project dir into resources/app when asar is disabled).
const PACKAGED_APP_DIR = path.join(process.resourcesPath || "", "app");
const APP_ROOT = isDev ? path.join(__dirname, "..") : PACKAGED_APP_DIR;

let PORT = 3456;
// Dev runs `next dev -p 3457` (own port, never collides with a browser-mode
// `next dev` on 3000 and never hits wait-on races).
const DEV_PORT = process.env.NEXT_DEV_PORT || "3457";
const HOST = "127.0.0.1";

let mainWindow = null;
let serverProcess = null;
let quitting = false;
let PORTABLE_DB_PATH = null; // set by setupDatabase() when packaged

// ─── Single instance ────────────────────────────────────────────
// Prevents two copies (each spawning their own Next server) fighting over the DB.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);
}

// ─── Helpers ────────────────────────────────────────────────────

// Pick a free TCP port so the app never collides with another local service.
function getFreePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, HOST);
    };
    tryPort(start);
  });
}

function waitForServer(url, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("Next server did not start in time"));
        } else {
          setTimeout(attempt, 500);
        }
      });
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
    };
    attempt();
  });
}

function showFatalError(message) {
  const detail = encodeURIComponent(
    `<html><body style="font-family:system-ui,sans-serif;background:#0a0a0f;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:480px;text-align:center;padding:24px"><h1 style="margin-bottom:8px">Stockfolio couldn't start</h1><p style="color:#a1a1aa;line-height:1.6">${message}</p></div></body></html>`,
  );
  if (mainWindow) {
    mainWindow.loadURL(`data:text/html;charset=utf-8,${detail}`);
  }
}

// ─── Portable data mode ─────────────────────────────────────
// PORTABLE (default for this build): the database lives in a `data/` folder
// NEXT TO the app. Move/copy the app folder — to a USB stick, another PC,
// another path — and the whole portfolio (trades, watchlist, price cache,
// score history) travels with it. Nothing is left in AppData.
//
// A `data/portable.txt` marker is written on first run so we can detect the
// mode later; if a legacy AppData copy exists it is migrated into data/ once.
function setupDatabase() {
  try {
    if (isDev) return; // dev uses the project's own DB via cwd
    const dataDir = path.join(PACKAGED_APP_DIR, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const marker = path.join(dataDir, "portable.txt");
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "Stockfolio portable data folder. Delete this folder to reset all data.\n");
    }
    const portableDb = path.join(dataDir, "portfolio.db");

    // One-time migration: an older install kept its DB in userData (AppData).
    if (!fs.existsSync(portableDb)) {
      const legacyDb = path.join(app.getPath("userData"), "portfolio.db");
      if (fs.existsSync(legacyDb)) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try { fs.copyFileSync(legacyDb + suffix, portableDb + suffix); } catch { /* suffix file absent */ }
        }
        console.log("Migrated database from AppData to portable data/ folder");
      }
    }

    PORTABLE_DB_PATH = portableDb;
  } catch (err) {
    // Fall back to userData if the app dir is read-only (e.g. Program Files install)
    console.error("Portable data setup failed, falling back to userData:", err);
    try {
      const dataDir = path.join(app.getPath("userData"), "data");
      fs.mkdirSync(dataDir, { recursive: true });
      PORTABLE_DB_PATH = path.join(dataDir, "portfolio.db");
    } catch (err2) {
      console.error("userData fallback also failed:", err2);
    }
  }
}

function startProductionServer() {
  return getFreePort(PORT).then((port) => {
    PORT = port;
    serverProcess = spawn(process.execPath, [path.join(__dirname, "next-server.js")], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(PORT),
        STOCKFOLIO_APP_ROOT: APP_ROOT,
        STOCKFOLIO_DB_PATH: PORTABLE_DB_PATH || path.join(app.getPath("userData"), "portfolio.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.on("error", (err) => {
      console.error("Server process error:", err);
    });
    serverProcess.on("exit", (code) => {
      if (!quitting && code !== 0 && code !== null) {
        showFatalError(`The internal server exited unexpectedly (code ${code}). Please reinstall the application.`);
      }
    });
    return waitForServer(`http://${HOST}:${PORT}/api/trades`);
  });
}

function attachDevServerWatch() {
  // In dev, if `next dev` is restarted or dies, show a friendly error instead
  // of a hung white window on the next navigation.
  const check = setInterval(() => {
    if (!isDev || quitting) return clearInterval(check);
    const req = http.get(`http://localhost:${DEV_PORT}/`, (res) => res.resume());
    req.on("error", () => {
      clearInterval(check);
      showFatalError("The Next.js dev server stopped. Reopen the app or run <code>npm run dev:electron</code>.");
    });
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  }, 10000);
}

function createWindow() {
  setupDatabase();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Stockfolio — Portfolio Manager",
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    show: false,
    icon: getIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // NOTE: deliberately no update check on startup — updates are manual only
  // (Settings → Check for Updates).

  // If the page fails to load (server not up yet), show an error page.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) {
      showFatalError(`Could not load the app.<br><span style="font-size:13px;color:#71717a">${code} ${desc}</span>`);
    }
  });

  // Block navigation away from the local app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev
      ? url.startsWith(`http://localhost:${DEV_PORT}`) || url.startsWith(`http://127.0.0.1:${DEV_PORT}`)
      : url.startsWith(`http://${HOST}:${PORT}`);
    if (!allowed) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (isDev) {
    // Dev: `npm run dev:electron` starts `next dev -p 3457` alongside Electron.
    // Bare `electron .` also works if the dev server is already running.
    waitForServer(`http://localhost:${DEV_PORT}/api/trades`, 30000)
      .then(() => mainWindow.loadURL(`http://localhost:${DEV_PORT}/dashboard`))
      .catch(() => showFatalError(`Could not reach the dev server on port ${DEV_PORT}.<br>Run <code>npm run dev:electron</code>, or <code>npm run dev</code> first, then the Electron window.`));
    attachDevServerWatch();
  } else {
    startProductionServer()
      .then(() => mainWindow.loadURL(`http://${HOST}:${PORT}/dashboard`))
      .catch((err) => {
        console.error(err);
        showFatalError("The internal server could not start. Please reinstall the application.");
      });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function getIcon() {
  const iconPath = path.join(APP_ROOT, "public", "icon.png");
  try {
    if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  } catch {}
  return undefined;
}

function killServer() {
  if (serverProcess) {
    try {
      if (process.platform === "win32") {
        // Ensure the whole child tree dies, not just the shell
        spawn("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        serverProcess.kill();
      }
    } catch {}
    serverProcess = null;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  killServer();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
