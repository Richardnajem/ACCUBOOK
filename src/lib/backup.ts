// ─── Database backups ───────────────────────────────────────────
// Why this exists: the only backup in the project was a raw `copy` in
// update-github.bat. With WAL enabled that copy is only correct after a
// checkpoint — otherwise committed rows still in `portfolio.db-wal` never make
// it into the backup. Every path here checkpoints first, and the packaged app
// (whose database lives in userData) finally gets backups of its own.
import fs from "node:fs";
import path from "node:path";
import { DB_PATH, checkpointDatabase, closeDb, getDb, SCHEMA_VERSION } from "./db";

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string; // ISO-8601
}

// Same rotation the batch script uses: keep the newest 30.
export const MAX_BACKUPS = 30;

const BACKUP_PREFIX = "portfolio_";

export function backupDir(): string {
  const dir = path.join(path.dirname(DB_PATH), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function infoFor(fullPath: string): BackupInfo {
  const stat = fs.statSync(fullPath);
  return {
    name: path.basename(fullPath),
    sizeBytes: stat.size,
    createdAt: new Date(stat.mtimeMs).toISOString(),
  };
}

function labelOf(label: string): string {
  const clean = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return clean || "manual";
}

// Checkpoint, then copy. `label` distinguishes automatic snapshots
// ("pre-import", "before-restore") from ones the user asked for.
export function createBackup(label = "manual"): BackupInfo {
  checkpointDatabase();
  const stamp = new Date().toISOString().replace("T", "_").replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(backupDir(), `${BACKUP_PREFIX}${stamp}_${labelOf(label)}.db`);
  fs.copyFileSync(DB_PATH, target);
  pruneBackups();
  return infoFor(target);
}

// Newest first. Names start with an ISO-ish stamp, so lexical order is
// chronological order.
export function listBackups(): BackupInfo[] {
  const dir = backupDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(".db"))
    .map((f) => infoFor(path.join(dir, f)))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

function pruneBackups(): void {
  const extras = listBackups().slice(MAX_BACKUPS);
  for (const b of extras) {
    try {
      fs.rmSync(path.join(backupDir(), b.name), { force: true });
    } catch {
      // a locked backup is not worth failing the operation over
    }
  }
}

// Replaces the live database with a backup. Two safety properties:
//  1. the current database is snapshotted first ("before-restore"), so a bad
//     restore is itself undoable;
//  2. the connection is closed before the file is swapped — Windows refuses to
//     overwrite an open file, and SQLite would otherwise keep serving the old
//     inode. The next query reopens (and migrates) the restored file.
export function restoreBackup(
  name: string,
): { ok: true; safety: BackupInfo; restored: string } | { ok: false; error: string } {
  const base = path.basename(String(name ?? ""));
  if (!base.startsWith(BACKUP_PREFIX) || !base.endsWith(".db")) {
    return { ok: false, error: "Invalid backup name." };
  }
  const source = path.join(backupDir(), base);
  if (!fs.existsSync(source)) {
    return { ok: false, error: "Backup not found." };
  }

  let safety: BackupInfo;
  try {
    safety = createBackup("before-restore");
  } catch (err) {
    return { ok: false, error: `Could not snapshot the current database: ${(err as Error).message}` };
  }

  try {
    closeDb();
    fs.copyFileSync(source, DB_PATH);
    // The old WAL/SHM describe the replaced file — leaving them would corrupt
    // the restored database on the next open.
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.rmSync(DB_PATH + suffix, { force: true });
      } catch {
        // best effort
      }
    }
    getDb(); // reopen + run any pending migrations
    return { ok: true, safety, restored: base };
  } catch (err) {
    // Put the safety snapshot back if the swap itself failed halfway.
    try {
      fs.copyFileSync(safety.name ? path.join(backupDir(), safety.name) : source, DB_PATH);
    } catch {
      // nothing more we can do here
    }
    return { ok: false, error: `Restore failed: ${(err as Error).message}` };
  }
}

export function backupStatus(): { dbPath: string; schemaVersion: number; backups: number } {
  // Touches the database so schema migrations have run before we report.
  getDb();
  return { dbPath: DB_PATH, schemaVersion: SCHEMA_VERSION, backups: listBackups().length };
}
