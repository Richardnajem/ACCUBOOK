// Fold the WAL into a SQLite database before anything copies the file.
// Used by update-github.bat (and any other raw file copy): without this a
// copy of portfolio.db can miss committed rows still sitting in the -wal.
// Usage: node scripts/checkpoint-db.cjs [path/to/db]   (default ./portfolio.db)
"use strict";
const path = require("path");

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.error("[checkpoint-db] better-sqlite3 not available:", err.message);
  process.exit(1);
}

const file = path.resolve(process.argv[2] || "portfolio.db");
try {
  const db = new Database(file, { fileMustExist: true });
  const result = db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(`[checkpoint-db] checkpointed ${file} (busy=${result[0]}, log=${result[1]}, checkpointed=${result[2]})`);
  process.exit(0);
} catch (err) {
  console.error(`[checkpoint-db] failed for ${file}:`, err.message);
  process.exit(1);
}
