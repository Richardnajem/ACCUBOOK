// Update-flow self-test harness (main process).
// Runs the REAL electron-updater code path against a configurable feed.
// Prints single-line results prefixed with "UPDTEST:" that the runner parses.
//
// Modes (via ACCB_TEST_MODE):
//   real    — check the actual GitHub publish repo (Richardnajem/ACCUBOOK).
//             Expectation: no releases yet → "up-to-date" / not-available.
//   local   — check a local static feed serving a fake v99.0.0
//             (latest.yml + installer). Expect: available → download → downloaded.

const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const mode = process.env.ACCB_TEST_MODE || "real";

function log(msg) {
  process.stdout.write(`UPDTEST:${msg}\n`);
}

app.whenReady().then(async () => {
  try {
    const { autoUpdater } = require("electron-updater");

    // Never let the harness actually install anything.
    autoUpdater.autoDownload = mode === "local"; // local flow needs the download step
    autoUpdater.autoInstallOnAppQuit = false;
    if (mode === "local") {
      autoUpdater.disableDifferentialDownload = true;
      // Point the updater at the local static feed instead of GitHub.
      const feedUrl = process.env.ACCB_TEST_FEED;
      if (!feedUrl) throw new Error("ACCB_TEST_FEED not set for local mode");
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    }

    const result = { stages: [], error: null };

    autoUpdater.on("update-available", (i) => result.stages.push(`available:${i.version}`));
    autoUpdater.on("update-not-available", (i) => result.stages.push(`not-available:${i ? i.version : "?"}`));
    autoUpdater.on("download-progress", (p) => {
      if (!result.stages.some((s) => s.startsWith("downloading"))) result.stages.push("downloading");
    });
    autoUpdater.on("update-downloaded", (i) => result.stages.push(`downloaded:${i ? i.version : "?"}`));
    autoUpdater.on("error", (e) => {
      result.error = String((e && e.message) || e).slice(0, 200);
    });

    log(`mode=${mode} starting`);
    await autoUpdater.checkForUpdates();

    // Local mode: after "available", trigger the download explicitly
    // (mirrors the Settings page: check → confirm → download).
    if (mode === "local" && result.stages.some((s) => s.startsWith("available"))) {
      await autoUpdater.downloadUpdate();
    }

    // Give event handlers a tick to flush.
    await new Promise((r) => setTimeout(r, 500));

    log(`result stages=[${result.stages.join(" ")}] error=${result.error ? result.error : "none"}`);
    log(`mode=${mode} done`);
    app.exit(0);
  } catch (e) {
    log(`fatal=${String((e && e.message) || e).slice(0, 300)}`);
    app.exit(1);
  }
});
