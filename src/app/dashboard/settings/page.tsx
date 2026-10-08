"use client";

import { useCallback, useEffect, useState } from "react";

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
            In the packaged app your data lives in a{" "}
            <code className="text-xs bg-[var(--input-bg)] px-1 py-0.5 rounded border border-[var(--input-border)]">data\</code>{" "}
            folder next to the app — copy it to move everything to another PC.
          </li>
        </ul>
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
