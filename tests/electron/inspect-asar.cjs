#!/usr/bin/env node
// Reports what the built app.asar actually contains (used while debugging the
// ASAR packaging change: does the package carry the native modules it needs?).
const asar = require("@electron/asar");

const target = process.argv[2] || "release/win-unpacked/resources/app.asar";
const list = asar.listPackage(target).map((f) => f.replace(/\\/g, "/"));
console.log("asar:", target, "entries:", list.length);

const has = (p) => list.some((f) => f.includes(p));
for (const p of [
  "better-sqlite3",
  "pdf-parse",
  "xlsx",
  "@next/swc",
  "sharp",
  "node_modules/next/dist/bin",
  "node_modules/.bin",
  "node_modules/next/package.json",
  ".next/server",
]) {
  console.log(String(has(p)).padEnd(5), p);
}

const top = new Set();
for (const f of list) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f);
  if (m) top.add(m[1]);
}
console.log("\nnode_modules packages present:", top.size);
console.log([...top].sort().slice(0, 60).join(", "));
