// First line of the file: everything below (Electron's own bootstrap, the
// requires, the window, the internal server) is measured from here so startup
// regressions show up in the console instead of being guessed at.
const LAUNCH_T0 = Date.now();
function mark(label) {
  console.log(`[startup] +${Date.now() - LAUNCH_T0}ms ${label}`);
}

const { app, BrowserWindow, nativeImage, ipcMain } = require("electron");
const path = require("path");
const net = require("net");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
mark("main process modules loaded");

// Updates are 100% MANUAL. The app never checks for updates on its own —
// the only check happens when the user clicks "Check for Updates" in
// Settings. Even then nothing downloads automatically: the user confirms,
// the update downloads, and installs on the next app quit (or on demand).
// Safe on every PC: if this no-ops (dev mode, offline, no releases yet),
// the Settings page just says "Up to date" or "Couldn't check".
// electron-updater is required LAZILY — first "Check for Updates" click, not
// at boot. It drags js-yaml + builder-util-runtime in with it, and that cost
// was paid on every single launch by a feature only ever used from one button.
let autoUpdater = null;
let updaterLoadAttempted = false;
function getAutoUpdater() {
  if (autoUpdater || updaterLoadAttempted) return autoUpdater;
  updaterLoadAttempted = true;
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
  return autoUpdater;
}

// Manual-only check, invoked from the Settings page.
function checkForUpdates() {
  const updater = getAutoUpdater();
  if (!updater || app.isPackaged !== true) {
    if (mainWindow) mainWindow.webContents.send("update-status", { type: "up-to-date" });
    return;
  }
  // Network/publish-config errors surface as the "error" status above.
  updater.checkForUpdates().catch(() => {});
}

function downloadUpdate() {
  const updater = getAutoUpdater();
  if (!updater || app.isPackaged !== true) return;
  updater.downloadUpdate().catch(() => {});
}

function installUpdate() {
  const updater = getAutoUpdater();
  if (!updater || app.isPackaged !== true) return;
  quitting = true;
  updater.quitAndInstall(false, true);
}

// IPC surface for the renderer (Settings page).
ipcMain.on("updates:check", () => checkForUpdates());
ipcMain.on("updates:download", () => downloadUpdate());
ipcMain.on("updates:install", () => installUpdate());
ipcMain.handle("updates:is-packaged", () => app.isPackaged === true);
ipcMain.handle("updates:version", () => app.getVersion());

const isDev = !app.isPackaged;

// Where the packaged Next.js app lives. With ASAR enabled (one app.asar file
// instead of ~14,778 loose ones) this points at the archive — Electron's
// patched fs reads straight out of it, including from the ELECTRON_RUN_AS_NODE
// child process that runs the Next server. app.getAppPath() resolves correctly
// whether the build is packed or unpacked.
const PACKAGED_APP_DIR = app.getAppPath();
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
let DATA_DIR = null; // folder holding portable data + diagnostic logs
let serverLogTail = ""; // last server output, for startup-failure diagnostics

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

  app.whenReady().then(() => {
    mark("electron ready");
    createWindow();
  });
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

// Poll until the app's own API answers. Only a healthy (<400) response counts
// — a 500 from a broken DB or a native module that won't load on this machine
// is retried, its body captured, and surfaced after the timeout instead of
// being treated as a successful start.
function waitForServer(url, timeoutMs = 45000) {
  const started = Date.now();
  let lastDetail = "";
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        let body = "";
        res.on("data", (c) => { if (body.length < 8000) body += c; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode < 400) return resolve();
          lastDetail = `HTTP ${res.statusCode} — ${stripHtml(body).slice(0, 300)}`;
          retryOrFail();
        });
        res.resume();
      });
      req.on("error", (err) => {
        lastDetail = err.message;
        retryOrFail();
      });
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
    };
    const retryOrFail = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(lastDetail ? `Server not healthy: ${lastDetail}` : "Next server did not start in time"));
      } else {
        // Poll quickly so the window swaps to the real UI the instant the server
        // is ready (was 500ms, then 150ms — each step shaved real time off the
        // splash; 50ms keeps the wakeup cost negligible on any machine).
        setTimeout(attempt, 50);
      }
    };
    attempt();
  });
}

function appendServerLog(chunk) {
  serverLogTail = (serverLogTail + chunk.toString()).slice(-8000);
}

// Fire the dashboard's own data requests the moment the server is healthy,
// while the window is still loading /dashboard. /api/portfolio is the slow one
// on a cold start (live quotes for every position, ~1-2s) and it is what the
// dashboard's spinner waits on — warming it here means the fetch the page makes
// a moment later usually lands in the in-memory quote cache and returns fast.
// Failures are irrelevant: the page always asks for the data itself.
function warmDashboardData(base) {
  for (const p of ["/api/portfolio", "/api/watchlist", "/api/trades"]) {
    const req = http.get(base + p, (res) => res.resume());
    req.on("error", () => {});
    req.setTimeout(20000, () => req.destroy());
  }
  mark("dashboard data warm-up started");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function showFatalError(message) {
  // Best-effort breadcrumb on disk so startup failures on other PCs can be
  // reported and fixed (data dir is whatever setupDatabase() resolved to).
  if (DATA_DIR) {
    try {
      fs.writeFileSync(
        path.join(DATA_DIR, "server-last-error.log"),
        `${new Date().toISOString()}\n${stripHtml(message)}\n\n--- server output ---\n${serverLogTail.trim()}\n`,
      );
    } catch { /* read-only disk etc. — the window still shows the details */ }
  }
  const logs = serverLogTail.trim();
  const logBlock = logs
    ? `<pre style="text-align:left;background:#18181b;color:#a1a1aa;font-size:11px;line-height:1.5;padding:12px;border-radius:8px;max-height:180px;overflow:auto;white-space:pre-wrap">${escapeHtml(logs.slice(-1200))}</pre><p style="color:#52525b;font-size:12px;margin-top:12px">These details were also saved to server-last-error.log in the app's data folder.</p>`
    : "";
  const detail = encodeURIComponent(
    `<html><body style="font-family:system-ui,sans-serif;background:#0a0a0f;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="max-width:600px;padding:24px"><h1 style="margin-bottom:8px">Stockfolio couldn't start</h1><p style="color:#a1a1aa;line-height:1.6">${message}</p>${logBlock}</div></body></html>`,
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
    // Single-file portable builds extract themselves to a %TEMP% folder at
    // runtime — anything written next to process.resourcesPath there is wiped
    // when the app exits. electron-builder's portable target sets
    // PORTABLE_EXECUTABLE_DIR to the real folder containing the .exe, so keep
    // data/ there: it persists and travels with the file when copied to
    // another PC. Installed (NSIS) builds don't set that env var; with ASAR the
    // app dir is a read-only archive, so their data lives in userData.
    const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR || null;
    const dataDir = portableRoot
      ? path.join(portableRoot, "data")
      : path.join(app.getPath("userData"), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    DATA_DIR = dataDir;
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
      DATA_DIR = dataDir;
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
    serverProcess.stdout.on("data", appendServerLog);
    serverProcess.stderr.on("data", appendServerLog);
    serverProcess.on("error", (err) => {
      console.error("Server process error:", err);
      appendServerLog(`\n[spawn error] ${err.message}\n`);
    });
    serverProcess.on("exit", (code) => {
      if (!quitting && code !== 0 && code !== null) {
        showFatalError(`The internal server exited unexpectedly (code ${code}).`);
      }
    });
    mark("internal server process spawned");
    // Readiness probe = /dashboard itself: it is prerendered static HTML, so
    // it answers without touching the database, and probing it means the page
    // the window is about to show is already rendered and on disk.
    return waitForServer(`http://${HOST}:${PORT}/dashboard`);
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

// Lightweight inline splash shown immediately on launch, while the bundled
// Next.js server boots in the background. Without it the window stays hidden
// until the server is healthy, which is what made the exe feel slow to open.
function showLoadingSplash() {
  if (!mainWindow) return;
  const html = `<html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0a0a0f;color:#e4e4e7;
      font-family:system-ui,-apple-system,Segoe UI,sans-serif;}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}
    .logo{font-size:26px;font-weight:700;letter-spacing:.5px}
    .logo span{color:#6366f1}
    .spinner{width:34px;height:34px;border:3px solid #27272a;border-top-color:#6366f1;border-radius:50%;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    .hint{color:#71717a;font-size:12px}
  </style></head><body><div class="wrap">
    <div class="logo">Stock<span>folio</span></div>
    <div class="spinner"></div>
    <div class="hint">Starting up…</div>
  </div></body></html>`;
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function createWindow() {
  setupDatabase();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Stockfolio — Portfolio Manager by Richard Najem",
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    // Show the frame the moment it exists instead of waiting for "ready-to-show"
    // (which needs a first paint). backgroundColor matches the splash so there
    // is no white flash — the window simply appears sooner.
    show: true,
    icon: getIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // NOTE: deliberately no update check on startup — updates are manual only
  // (Settings → Check for Updates).

  // If the page fails to load (server not up yet), show an error page.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) {
      showFatalError(`Could not load the app.<br><span style="font-size:13px;color:#71717a">${code} ${desc}</span>`);
    }
  });

  // Timing breadcrumb: when the real dashboard (not the splash) has painted.
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow.webContents.getURL();
    if (url.startsWith("http://") && url.includes("/dashboard")) mark("dashboard finished loading");
  });

  // Block navigation away from the local app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev
      ? url.startsWith(`http://localhost:${DEV_PORT}`) || url.startsWith(`http://127.0.0.1:${DEV_PORT}`)
      : url.startsWith(`http://${HOST}:${PORT}`);
    if (!allowed) event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Show something instantly, then swap to the app when the server is ready.
  showLoadingSplash();
  mark("window visible with splash");

  if (isDev) {
    // Dev: `npm run dev:electron` starts `next dev -p 3457` alongside Electron.
    // Bare `electron .` also works if the dev server is already running.
    waitForServer(`http://localhost:${DEV_PORT}/dashboard`, 30000)
      .then(() => {
        mark("dev server healthy");
        mainWindow.loadURL(`http://localhost:${DEV_PORT}/dashboard`);
      })
      .catch(() => showFatalError(`Could not reach the dev server on port ${DEV_PORT}.<br>Run <code>npm run dev:electron</code>, or <code>npm run dev</code> first, then the Electron window.`));
    attachDevServerWatch();
  } else {
    startProductionServer()
      .then(() => {
        mark("internal server healthy");
        // Kick off the dashboard's API calls now, in parallel with the page
        // load — the spinner the page shows is usually over before it starts.
        warmDashboardData(`http://${HOST}:${PORT}`);
        mainWindow.loadURL(`http://${HOST}:${PORT}/dashboard`);
      })
      .catch((err) => {
        console.error(err);
        showFatalError(`The internal server could not start.${err && err.message ? `<br><span style="font-size:13px;color:#71717a">${escapeHtml(err.message)}</span>` : ""}`);
      });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function getIcon() {
  const iconPath = path.join(APP_ROOT, "public", "icon.png");
  try {
    // Reading out of the ASAR can yield an empty image on some platforms —
    // treat that the same as "no icon" so the window keeps the exe's own icon.
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
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
