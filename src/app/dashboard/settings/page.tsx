"use client";

import { useCallback, useEffect, useState } from "react";
import { clearErrorLogs, ERROR_LOG_EVENT, getErrorLogs, type ErrorLogEntry } from "@/lib/errorLogger";
import { downloadTextFile } from "@/lib/export";
import { errorLogFileName, errorLogsToCSV, errorLogsToJSON } from "@/lib/log-export";

type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "up-to-date"; version?: string }
  | { type: "available"; version: string }
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; version?: string }
  | { type: "error"; message?: string };

interface ElectronUpdatesAPI {
  isPackaged: () => Promise<boolean>;
  getVersion: () => Promise<string>;
  check: () => void;
  download: () => void;
  install: () => void;
  onStatus: (cb: (status: UpdateStatus) => void) => () => void;
}

export default function SettingsPage() {
  // The preload bridge exists before the page's first render in Electron and
  // is absent in a plain browser — no effect needed to discover it.
  const [isElectron] = useState(
    () => typeof window !== "undefined" && !!(window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates,
  );
  const [isPackaged, setIsPackaged] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ type: "idle" });

  // ── Backups (GET/POST /api/backup) ──────────────────────────
  const [backups, setBackups] = useState<Array<{ name: string; sizeBytes: number; createdAt: string }>>([]);
  const [backupFolder, setBackupFolder] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);

  // ── Logs (local error log) ─────────────────────────────────
  const [logs, setLogs] = useState<ErrorLogEntry[]>([]);

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates;
    if (!api) return; // browser mode: updates don't apply
    let unsubscribe: (() => void) | undefined;
    (async () => {
      const [packaged, version] = await Promise.all([api.isPackaged(), api.getVersion()]);
      setIsPackaged(packaged);
      setAppVersion(version);
      unsubscribe = api.onStatus((s) => setStatus(s));
    })();
    return () => unsubscribe?.();
  }, []);

  const onCheck = useCallback(() => {
    const api = (window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates;
    if (!api) return;
    setStatus({ type: "checking" });
    api.check();
  }, []);

  const onDownload = useCallback(() => {
    const api = (window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates;
    api?.download();
  }, []);

  const onInstall = useCallback(() => {
    const api = (window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates;
    api?.install();
  }, []);

  const refreshBackups = useCallback(async () => {
    try {
      const res = await fetch("/api/backup", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        backups?: Array<{ name: string; sizeBytes: number; createdAt: string }>;
        directory?: string;
      };
      setBackups(data.backups ?? []);
      setBackupFolder(data.directory ?? null);
    } catch {
      // server unreachable — keep whatever list we already have
    }
  }, []);

  // Listed once on mount. The state writes happen in the promise callbacks,
  // never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/backup", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { backups?: typeof backups; directory?: string } | null) => {
        if (cancelled || !data) return;
        setBackups(data.backups ?? []);
        setBackupFolder(data.directory ?? null);
      })
      .catch(() => {
        // server unreachable — leave the empty list, the buttons still work
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // State is written from a promise callback (not the effect body) so the
    // render after mount is the one that shows the stored entries.
    Promise.resolve().then(() => {
      if (!cancelled) setLogs(getErrorLogs());
    });
    const onLogged = () => setLogs(getErrorLogs());
    window.addEventListener(ERROR_LOG_EVENT, onLogged);
    return () => {
      cancelled = true;
      window.removeEventListener(ERROR_LOG_EVENT, onLogged);
    };
  }, []);

  const refreshLogs = useCallback(() => setLogs(getErrorLogs()), []);

  const exportLogs = useCallback((format: "csv" | "json") => {
    const text = format === "csv" ? errorLogsToCSV(logs) : errorLogsToJSON(logs);
    downloadTextFile(
      errorLogFileName(format),
      text,
      format === "csv" ? "text/csv;charset=utf-8;" : "application/json;charset=utf-8",
    );
  }, [logs]);

  const onClearLogs = useCallback(() => {
    if (!window.confirm("Clear the error log on this device? Export it first if you need it.")) return;
    clearErrorLogs();
    setLogs([]);
  }, []);

  const onBackupNow = useCallback(async () => {
    setBackupBusy(true);
    setBackupNote(null);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", label: "manual" }),
      });
      const data = (await res.json()) as { backup?: { name: string }; error?: string };
      setBackupNote(res.ok && data.backup ? `Saved ${data.backup.name}` : (data.error ?? "Backup failed"));
      await refreshBackups();
    } catch (err) {
      setBackupNote(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBackupBusy(false);
    }
  }, [refreshBackups]);

  const onRestoreBackup = useCallback(
    async (name: string) => {
      const ok = window.confirm(
        `Restore ${name}?\n\nYour current database is snapshotted first, so this itself can be undone.`,
      );
      if (!ok) return;
      setBackupBusy(true);
      setBackupNote(null);
      try {
        const res = await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restore", name }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && data.ok) {
          setBackupNote(`Restored ${name} — reloading…`);
          await refreshBackups();
          setTimeout(() => window.location.reload(), 500);
        } else {
          setBackupNote(data.error ?? "Restore failed");
        }
      } catch (err) {
        setBackupNote(err instanceof Error ? err.message : "Restore failed");
      } finally {
        setBackupBusy(false);
      }
    },
    [refreshBackups],
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold">Settings</h2>
        <p className="text-sm text-[var(--muted)] mt-1">
          App information and updates. Nothing here sends data anywhere — Stockfolio stays local.
        </p>
      </div>

      {/* ── Updates ─────────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--card-border)] p-5" style={{ background: "var(--card)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold">Updates</h3>
            <p className="text-xs text-[var(--muted)] mt-1 max-w-md">
              Manual only. The app never checks for updates in the background or on startup —
              nothing downloads or installs unless you click it here.
            </p>
          </div>
          {appVersion && (
            <span className="text-xs text-[var(--muted)] font-mono whitespace-nowrap">
              v{appVersion}
            </span>
          )}
        </div>

        <div className="mt-4">
          {!isElectron ? (
            <p className="text-sm text-[var(--muted)]">
              Running in a browser — updates apply to the desktop app only.
            </p>
          ) : !isPackaged ? (
            <p className="text-sm text-[var(--muted)]">
              Development build — update checks are disabled. Updates work in the installed/portable app.
            </p>
          ) : (
            <UpdateControls status={status} onCheck={onCheck} onDownload={onDownload} onInstall={onInstall} />
          )}
        </div>
      </section>

      {/* ── Data & backups ─────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--card-border)] p-5" style={{ background: "var(--card)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold">Data &amp; backups</h3>
            <p className="text-xs text-[var(--muted)] mt-1 max-w-md">
              Backups checkpoint the database first, so a copy never misses rows that are
              still sitting in the write-ahead log.
            </p>
          </div>
          <button onClick={onBackupNow} disabled={backupBusy} className="btn-secondary disabled:opacity-50">
            Back up now
          </button>
        </div>
        {backupNote && (
          <p className="mt-3 text-xs text-[var(--muted)] font-mono break-all">{backupNote}</p>
        )}
        {backups.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-sm">
            {backups.slice(0, 8).map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs truncate" title={b.name}>
                  {b.name}
                  <span className="text-[var(--muted)]"> · {(b.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                </span>
                <button
                  onClick={() => onRestoreBackup(b.name)}
                  disabled={backupBusy}
                  className="btn-secondary disabled:opacity-50 text-xs"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
        {backupFolder && (
          <p className="mt-3 text-[11px] text-[var(--muted)] font-mono break-all">Folder: {backupFolder}</p>
        )}
        <ul className="mt-3 space-y-1.5 text-sm text-[var(--muted)] list-disc list-inside">
          <li>
            Push a snapshot to GitHub anytime: double-click{" "}
            <code className="text-xs bg-[var(--input-bg)] px-1 py-0.5 rounded border border-[var(--input-border)]">update-github.bat</code>{" "}
            in the project folder — it backs up the database first, every time.
          </li>
          <li>
            Automatic database backups land in{" "}
            <code className="text-xs bg-[var(--input-bg)] px-1 py-0.5 rounded border border-[var(--input-border)]">backups\</code>{" "}
            (last 30 kept).
          </li>
          <li>
            Portable builds keep your data in a{" "}
            <code className="text-xs bg-[var(--input-bg)] px-1 py-0.5 rounded border border-[var(--input-border)]">data\</code>{" "}
            folder next to the .exe — copy it to move everything to another PC. An installed copy keeps it in the OS user-data folder instead.
          </li>
        </ul>
      </section>

      {/* ── Logs ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--card-border)] p-5" style={{ background: "var(--card)" }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold">Logs</h3>
            <p className="text-xs text-[var(--muted)] mt-1 max-w-md">
              Runtime errors and warnings captured on this device. Export them as CSV for a
              spreadsheet, or JSON to keep the stack traces and URLs. Nothing is uploaded.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={refreshLogs} className="btn-secondary text-xs">Refresh</button>
            <button onClick={() => exportLogs("csv")} disabled={logs.length === 0} className="btn-secondary text-xs disabled:opacity-40">
              Export CSV
            </button>
            <button onClick={() => exportLogs("json")} disabled={logs.length === 0} className="btn-secondary text-xs disabled:opacity-40">
              Export JSON
            </button>
          </div>
        </div>

        {logs.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            No errors or warnings logged. Nothing here is placeholder data — the list stays empty
            until something actually fails.
          </p>
        ) : (
          <>
            <p className="mt-3 text-xs text-[var(--muted)]">
              {logs.length} {logs.length === 1 ? "entry" : "entries"} · newest first
            </p>
            <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-[var(--card-border)]">
              {logs.slice(0, 50).map((entry) => (
                <li key={entry.id} className="py-2 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-semibold uppercase ${entry.level === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]"}`}>
                      {entry.level}
                    </span>
                    <span className="font-mono text-[var(--muted)]">{entry.source}</span>
                    {entry.count > 1 && <span className="text-[var(--muted)]">×{entry.count}</span>}
                    <span className="ml-auto text-[var(--muted)] whitespace-nowrap">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-0.5 break-words" title={entry.stack ?? entry.message}>{entry.message}</p>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-[var(--muted)]">
                The last 200 are kept on this device (localStorage, never uploaded).
              </p>
              <button onClick={onClearLogs} className="btn-secondary text-xs">Clear logs</button>
            </div>
          </>
        )}
      </section>

      {/* ── Watermark ──────────────────────────────────────── */}
      <div className="flex flex-col items-end text-right pt-2">
        <span className="text-xs text-[var(--muted)]">by Richard Najem</span>
        <a
          href="https://github.com/Richardnajem/ACCUBOOK"
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-[var(--muted)] hover:text-indigo-400"
        >
          github.com/Richardnajem/ACCUBOOK
        </a>
      </div>
    </div>
  );
}

// ── Update controls: check → (confirm) download → install ──────
function UpdateControls({
  status,
  onCheck,
  onDownload,
  onInstall,
}: {
  status: UpdateStatus;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  switch (status.type) {
    case "idle":
      return (
        <button onClick={onCheck} className="btn-primary">
          Check for Updates
        </button>
      );
    case "checking":
      return (
        <div className="flex items-center gap-3 text-sm text-[var(--muted)]">
          <span className="w-4 h-4 border-2 border-[var(--muted)] border-t-transparent rounded-full animate-spin" />
          Checking GitHub Releases…
        </div>
      );
    case "up-to-date":
      return (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-green-500 flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            You&apos;re up to date{status.version ? ` (latest: v${status.version})` : ""}.
          </span>
          <button onClick={onCheck} className="btn-secondary">Check again</button>
        </div>
      );
    case "available":
      return (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm">
            New version <span className="font-semibold">v{status.version}</span> available.
          </span>
          <button onClick={onDownload} className="btn-primary">
            Download Update
          </button>
          <span className="text-xs text-[var(--muted)]">Nothing downloads until you click.</span>
        </div>
      );
    case "downloading":
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[var(--muted)]">Downloading update…</span>
            <span className="font-mono text-xs">{status.percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--input-bg)] overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
            />
          </div>
        </div>
      );
    case "downloaded":
      return (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-green-500">
            Update ready{status.version ? ` (v${status.version})` : ""}.
          </span>
          <button onClick={onInstall} className="btn-primary">
            Restart &amp; Install
          </button>
          <span className="text-xs text-[var(--muted)]">The app restarts to apply it.</span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-red-400">
            Couldn&apos;t check for updates (offline? no release published yet?).
          </span>
          <button onClick={onCheck} className="btn-secondary">Retry</button>
          {status.message && (
            <span className="w-full text-xs text-[var(--muted)] font-mono break-all">
              {status.message}
            </span>
          )}
        </div>
      );
  }
}
