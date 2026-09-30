// Runs inside Electron as a node process (ELECTRON_RUN_AS_NODE=1) to serve the
// packaged Next.js app on http://127.0.0.1:<PORT>.
//
// IMPORTANT: this file lives at <app>/electron/next-server.js, but the Next.js
// project root is the app root (where package.json / .next / node_modules are).
const path = require("path");

const PORT = parseInt(process.env.PORT || "3456", 10);
const HOST = "127.0.0.1"; // local-only: never bind 0.0.0.0

// The Next.js project root. In the packaged app everything is under
// process.resourcesPath/app (electron-builder "files" includes the whole app dir).
const APP_ROOT = process.env.STOCKFOLIO_APP_ROOT || process.env.ACCUBOOKS_APP_ROOT || path.join(__dirname, "..");

const next = require(path.join(APP_ROOT, "node_modules", "next"));

const app = next({ dev: false, dir: APP_ROOT });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  require("http")
    .createServer((req, res) => handle(req, res))
    .listen(PORT, HOST, () => {
      console.log(`Stockfolio server ready on http://${HOST}:${PORT}`);
    });
}).catch((err) => {
  console.error("Stockfolio server failed to start:", err);
  process.exit(1);
});
