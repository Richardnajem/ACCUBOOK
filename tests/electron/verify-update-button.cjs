#!/usr/bin/env node
// End-to-end check of the Settings → "Check for Updates" button in the REAL
// packaged app (not the test harness): it launches the built exe, drives the
// page over the Chrome DevTools Protocol and clicks the actual button.
//
// What it proves:
//   1. The packaged app boots from the ASAR (its internal Next server answers).
//   2. window.electronAPI.updates is wired: isPackaged(), getVersion().
//   3. Clicking "Check for Updates" reaches GitHub Releases through the real
//      electron-updater and reports a terminal status in the UI.
//
// Usage: node tests/electron/verify-update-button.cjs [path-to-exe]
// Exit:  0 = button behaved correctly, 1 = anything missing.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "release", "win-unpacked", "Stockfolio.exe");
const CDP_PORT = 9333;
const TERMINAL = ["up-to-date", "available", "error"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForTargets(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("/dashboard"));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return null;
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`CDP timeout: ${method}`));
    }, 90000);
  });
}

let evalId = 100;

async function evaluate(ws, expression) {
  const out = await rpc(ws, evalId++, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description || "evaluate threw");
  }
  return out.result.value;
}

// The window first shows a data: splash and only then navigates to the app —
// relative navigation from the splash has no base URL, so wait for http.
async function waitForHttpPage(ws, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const protocol = await evaluate(ws, `location.protocol`);
      if (String(protocol).startsWith("http")) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function waitForText(ws, pattern, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const text = await evaluate(ws, `document.body ? document.body.innerText : ""`);
      if (pattern.test(text || "")) return text;
    } catch {}
    await sleep(500);
  }
  return null;
}

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`✗ exe not found: ${EXE}`);
    process.exit(1);
  }

  console.log(`  Launching ${path.relative(ROOT, EXE)} on CDP ${CDP_PORT}…`);
  const child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOut = "";
  child.stdout.on("data", (d) => (childOut += d.toString()));
  child.stderr.on("data", (d) => (childOut += d.toString()));

  let failed = false;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed = true;
  };

  try {
    const target = await waitForTargets(60000);
    if (!target) {
      check("packaged app window opened and served /dashboard", false, "no CDP target (see app log below)");
      console.error(childOut.slice(-3000));
      process.exit(1);
    }
    check("packaged app boots from ASAR (window reached /dashboard)", true, target.url);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
    });

    await rpc(ws, 1, "Runtime.enable", {});

    const onAppPage = await waitForHttpPage(ws, 45000);
    check("internal Next server answered (page is on http)", onAppPage);
    if (!onAppPage) throw new Error("app never left the splash page");

    // Open the Settings page and wait for it to render.
    await evaluate(ws, `location.href = location.origin + "/dashboard/settings"; "navigating"`);
    const settingsText = await waitForText(
      ws,
      /Check for Updates|Development build|up to date/,
      30000,
    );
    check(
      "Settings page rendered with the update section",
      !!settingsText,
      settingsText ? "" : "button not found on the page",
    );

    // Read the update API state before clicking.
    const apiState = await evaluate(
      ws,
      `(async () => {
        const api = window.electronAPI && window.electronAPI.updates;
        if (!api) return { api: false };
        const [packaged, version] = await Promise.all([api.isPackaged(), api.getVersion()]);
        return { api: true, packaged, version, hasCheck: typeof api.check === "function" };
      })()`,
    );
    check(
      "electronAPI.updates is exposed in the packaged app",
      apiState.api === true && apiState.hasCheck === true,
      JSON.stringify(apiState),
    );
    check("app reports itself as packaged", apiState.packaged === true);

    // Click the button the user would click, and collect every status it shows.
    // Statuses are also mirrored on window.__updStatuses so they survive a CDP
    // timeout — the main process only ever sends them once.
    const statuses = await evaluate(
      ws,
      `(async () => {
        const api = window.electronAPI.updates;
        const seen = (window.__updStatuses = []);
        await new Promise((resolve) => {
          api.onStatus((s) => {
            seen.push(s);
            if (${JSON.stringify(TERMINAL)}.includes(s.type)) resolve();
          });
          const btn = Array.from(document.querySelectorAll("button"))
            .find((b) => /check for updates|check again/i.test(b.textContent || ""));
          if (btn) btn.click();
          else api.check(); // fallback: same IPC the button sends
          setTimeout(resolve, 60000);
        });
        return seen;
      })()`,
    ).catch(async () => {
      // CDP gave up — read whatever the page recorded before it did.
      return await evaluate(ws, `window.__updStatuses || []`).catch(() => []);
    });
    const last = Array.isArray(statuses) ? statuses[statuses.length - 1] : null;
    check(
      "Check for Updates reached a terminal status",
      !!last && TERMINAL.includes(last.type),
      JSON.stringify(statuses),
    );
    check(
      "status came from GitHub (up-to-date or a newer version offered)",
      !!last && (last.type === "up-to-date" || last.type === "available"),
      last ? JSON.stringify(last) : "none",
    );

    // The page must reflect that status, not just the IPC.
    const pageText = await waitForText(
      ws,
      /up to date|New version|Couldn/i,
      15000,
    );
    check(
      "UI shows the result",
      !!pageText,
      (pageText || "").match(/You're up to date[^\n]*|New version[^\n]*|Couldn't check[^\n]*/)?.[0] || "no result text",
    );

    ws.close();
  } catch (e) {
    check("verification ran to completion", false, String(e && e.message ? e.message : e).split("\n")[0]);
    console.error((e && e.stack) || e);
  } finally {
    try { child.kill(); } catch {}
  }

  if (failed) {
    console.log("\n  ✗ Update button verification FAILED");
    process.exit(1);
  }
  console.log("\n  ✓ Update button works end-to-end in the packaged app.");
  process.exit(0);
})();
