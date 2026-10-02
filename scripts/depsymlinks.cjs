// `next build` (Turbopack) writes .next/node_modules/<pkg>-<hash> as symlinks
// pointing at absolute paths in this project's node_modules (one per
// serverExternalPackages entry). Two problems when packaging with
// electron-builder:
//   1. Windows blocks recreating symlinks (EPERM) unless Developer Mode or
//      admin is enabled, so `electron-builder` fails with EPERM.
//   2. The absolute targets won't exist after moving the app to another PC.
// This script replaces each symlink with a real directory copy. It is
// idempotent and safe to run before every electron-builder invocation
// (wired into the dist/pack/build:electron scripts).
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.next', 'node_modules');
if (!fs.existsSync(dir)) {
  console.log('[depsymlinks] no .next/node_modules — nothing to do (run `npm run build` first)');
  process.exit(0);
}

let converted = 0;
for (const entry of fs.readdirSync(dir)) {
  const full = path.join(dir, entry);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    continue;
  }
  if (!stat.isSymbolicLink()) continue;

  const target = fs.readlinkSync(full);
  if (!path.isAbsolute(target)) continue; // relative links are fine to keep

  fs.rmSync(full, { force: true, recursive: true });
  fs.cpSync(target, full, { recursive: true, dereference: true });
  converted += 1;
  console.log(`[depsymlinks] replaced symlink ${entry} with a real copy`);
}
console.log(`[depsymlinks] done (${converted} symlink${converted === 1 ? '' : 's'} converted)`);
