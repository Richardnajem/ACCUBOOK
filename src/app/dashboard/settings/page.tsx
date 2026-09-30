"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "up-to-date"; version?: string }
  | { type: "available"; version: string }
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; version?: string }
  | { type: "error" };

interface ElectronUpdatesAPI {
  isPackaged: () => Promise<boolean>;
  getVersion: () => Promise<string>;
  check: () => void;
  download: () => void;
  install: () => void;
  onStatus: (cb: (status: UpdateStatus) => void) => () => void;
}

export default function SettingsPage() {
  const [isElectron, setIsElectron] = useState(false);
  const [isPackaged, setIsPackaged] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ type: "idle" });
  const statusRef = useRef<UpdateStatus>(status);
  statusRef.current = status;

  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { updates?: ElectronUpdatesAPI } }).electronAPI?.updates;
    if (!api) return; // browser mode: updates don't apply
    setIsElectron(true);
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

      {/* ── About ───────────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--card-border)] p-5" style={{ background: "var(--card)" }}>
        <h3 className="font-semibold">About</h3>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--muted)]">App</dt>
            <dd className="font-medium">Stockfolio (ACCUBOOK)</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--muted)]">Data storage</dt>
            <dd className="font-medium">Local only — portfolio.db on this PC</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--muted)]">Source code</dt>
            <dd className="font-medium">
              <a
                href="https://github.com/Richardnajem/ACCUBOOK"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-500 hover:text-indigo-400"
              >
                github.com/Richardnajem/ACCUBOOK
              </a>
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--muted)]">License</dt>
            <dd className="font-medium">MIT</dd>
          </div>
        </dl>
      </section>

      {/* ── Data & backups ─────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--card-border)] p-5" style={{ background: "var(--card)" }}>
        <h3 className="font-semibold">Data &amp; backups</h3>
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
          <span className="text-sm text-red-400">Couldn&apos;t check for updates (offline? no release published yet?).</span>
          <button onClick={onCheck} className="btn-secondary">Retry</button>
        </div>
      );
  }
}
