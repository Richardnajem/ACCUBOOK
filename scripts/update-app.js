#!/usr/bin/env node
// Manual updater — "start.bat update" / "npm run update:app".
// Checks GitHub Releases for a newer version and downloads the Windows
// installer to release\. No background checks, no auto-install: every step
// is user-initiated, matching the in-app Settings → Check for Updates flow.
//
// Exit codes: 0 = up to date or updated, 1 = error, 2 = network error.

const fs = require("fs");
const path = require("path");
const https = require("https");

const REPO_OWNER = "Richardnajem";
const REPO_NAME = "ACCUBOOK";

const PROJECT_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, "release");
const PKG = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const CURRENT = PKG.version;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "accubook-updater",
            Accept: "application/vnd.github+json",
          },
        },
        (res) => {
          if (res.statusCode === 404) return reject(Object.assign(new Error("no-releases"), { code: 404 }));
          if (res.statusCode !== 200) {
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { code: res.statusCode }));
          }
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      const total = Number(res.headers["content-length"] || 0);
      let done = 0;
      let lastPct = -1;
      res.on("data", (c) => {
        done += c.length;
        if (total) {
          const pct = Math.floor((done / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\r  Downloading… ${pct}%  `);
          }
        }
      });
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => {
        process.stdout.write("\n");
        resolve();
      }));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// electron-builder / NSIS artifact names: ACCUBOOK-Setup-<version>.exe
function pickInstaller(release) {
  const exe = (release.assets || []).filter(
    (a) => a.name.endsWith(".exe") && !/portable/i.test(a.name)
  );
  exe.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return exe[0] || null;
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const yes = args.has("--yes") || args.has("-y");

  console.log("");
  console.log("  ACCUBOOK — Check for Updates");
  console.log("  Current version: v" + CURRENT);
  console.log("");

  let release;
  try {
    release = await fetchJson(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
  } catch (err) {
    if (err.code === 404) {
      console.log("  No releases published yet — you're running the latest build.");
      process.exit(0);
    }
    console.error("  Network error while checking GitHub:", err.message);
    process.exit(2);
  }

  const latest = (release.tag_name || "").replace(/^v/, "");
  if (!latest) {
    console.log("  No usable release found — you're running the latest build.");
    process.exit(0);
  }

  if (compareVersions(latest, CURRENT) <= 0) {
    console.log(`  You're up to date (latest release: v${latest}).`);
    process.exit(0);
  }

  console.log(`  New version available: v${latest}  (you have v${CURRENT})`);
  const asset = pickInstaller(release);
  if (!asset) {
    console.log("  The release has no Windows installer asset yet — check back later.");
    process.exit(0);
  }

  console.log(`  Installer: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

  if (!yes) {
    process.stdout.write("  Download it now? [Y/n] ");
    const answer = await new Promise((resolve) => {
      process.stdin.once("data", (d) => resolve(d.toString().trim().toLowerCase()));
    });
    if (answer && answer.startsWith("n")) {
      console.log("  Skipped. Run \"start.bat update\" again whenever you like.");
      process.exit(0);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = path.join(OUT_DIR, asset.name);
  try {
    await download(asset.browser_download_url, dest);
  } catch (err) {
    console.error("\n  Download failed:", err.message);
    process.exit(2);
  }
  console.log(`  Saved to: ${path.relative(PROJECT_ROOT, dest)}`);
  console.log("");
  console.log("  Close the app, then run the installer to update.");

  if (yes) process.exit(0);
  process.stdout.write("  Launch installer now? [y/N] ");
  const answer = await new Promise((resolve) => {
    process.stdin.once("data", (d) => resolve(d.toString().trim().toLowerCase()));
  });
  if (answer && answer.startsWith("y")) {
    const { spawn } = require("child_process");
    spawn("cmd", ["/c", "start", "", `"${dest}"`], { detached: true, stdio: "ignore" }).unref();
  }
  process.exit(0);
}

main();
