"use client";

import { useRef, useState } from "react";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const TRADE_TYPES = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "dividend", label: "Dividend" },
  { value: "deposit", label: "Deposit" },
  { value: "withdrawal", label: "Withdrawal" },
  { value: "fee", label: "Fee" },
];

interface ImportRow {
  date: string;
  description: string;
  symbol: string | null;
  shares: number | null;
  price: number | null;
  type: string;
  fees: number;
}

export default function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const reset = () => {
    setRows(null);
    setFileName("");
    setResult(null);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleFile = async (f: File) => {
    setFileName(f.name);
    setError("");
    setRows(null);
    setResult(null);
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to parse file");
      setRows(data.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (i: number, field: "type", value: string) => {
    if (!rows) return;
    const next = [...rows];
    const row = { ...next[i] };
    (row as unknown as Record<string, string>)[field] = value;
    next[i] = row;
    setRows(next);
  };

  const removeRow = (i: number) => {
    if (!rows) return;
    setRows(rows.filter((_, idx) => idx !== i));
  };

  const commit = async () => {
    if (!rows || rows.length === 0) return;
    setCommitting(true);
    setError("");
    try {
      const res = await fetch("/api/import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult({ inserted: data.inserted, skipped: data.skipped });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  };

  const typeOptions = TRADE_TYPES;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="relative glass rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[var(--card-border)]">
          <div>
            <h3 className="text-base font-semibold">Import Trades</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Broker export (.xlsx/.xls/.csv) or PDF statement — columns are detected automatically
            </p>
          </div>
          <button onClick={close} className="p-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {result ? (
            <div className="text-center py-10">
              <div className="w-14 h-14 rounded-full bg-green-500/10 text-[var(--success)] flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h4 className="text-lg font-bold mb-1">Import complete</h4>
              <p className="text-sm text-[var(--muted)]">
                {result.inserted} row{result.inserted === 1 ? "" : "s"} imported
                {result.skipped > 0 && <> · {result.skipped} duplicate{result.skipped === 1 ? "" : "s"} skipped</>}
              </p>
              <button onClick={close} className="mt-6 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
                Done
              </button>
            </div>
          ) : !rows ? (
            /* Drop zone */
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              className="border-2 border-dashed border-[var(--input-border)] rounded-xl p-10 text-center hover:border-indigo-500/50 transition-colors"
            >
              <div className="w-12 h-12 rounded-xl bg-indigo-600/10 text-indigo-500 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </div>
              <p className="text-sm font-medium">Drag &amp; drop a file here, or</p>
              <button
                onClick={() => inputRef.current?.click()}
                className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg"
              >
                Choose File
              </button>
              <p className="text-xs text-[var(--muted)] mt-3">
                Supports .xlsx, .xls, .csv, .pdf — first sheet is used; the header row is auto-detected
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              {parsing && (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
                  <div className="animate-spin w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full" />
                  Parsing {fileName}…
                </div>
              )}
            </div>
          ) : (
            /* Preview */
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-[var(--muted)]">
                  <span className="font-medium text-[var(--foreground)]">{rows.length}</span> row{rows.length === 1 ? "" : "s"} detected
                  from <span className="font-medium text-[var(--foreground)]">{fileName}</span>
                </p>
                <button onClick={reset} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] font-medium">
                  Choose different file
                </button>
              </div>
              <div className="overflow-x-auto border border-[var(--card-border)] rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[var(--muted)] border-b border-[var(--card-border)]" style={{ background: "var(--input-bg)" }}>
                      <th className="text-left py-2 px-3 font-medium">Date</th>
                      <th className="text-left py-2 px-3 font-medium">Symbol</th>
                      <th className="text-right py-2 px-3 font-medium">Shares</th>
                      <th className="text-right py-2 px-3 font-medium">Price</th>
                      <th className="text-left py-2 px-3 font-medium">Type</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b border-[var(--card-border)] last:border-0">
                        <td className="py-2 px-3 whitespace-nowrap text-[var(--muted)]">{r.date}</td>
                        <td className="py-2 px-3 font-medium">{r.symbol || "—"}</td>
                        <td className="py-2 px-3 text-right">{r.shares ?? "—"}</td>
                        <td className="py-2 px-3 text-right">{fmt(r.price ?? 0)}</td>
                        <td className="py-2 px-3">
                          <select
                            value={r.type}
                            onChange={(e) => updateRow(i, "type", e.target.value)}
                            className="px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          >
                            {typeOptions.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-2">
                          <button onClick={() => removeRow(i)} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title="Remove row">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--muted)] mt-2">
                Duplicates (same date, type, symbol, shares, and price already recorded) are skipped automatically.
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-[var(--danger)]">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        {rows && !result && (
          <div className="flex items-center justify-between p-5 border-t border-[var(--card-border)]">
            <p className="text-sm text-[var(--muted)]">
              {rows.length} row{rows.length === 1 ? "" : "s"} ready
            </p>
            <div className="flex items-center gap-2">
              <button onClick={reset} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                Back
              </button>
              <button
                onClick={commit}
                disabled={committing || rows.length === 0}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-300 text-white text-sm font-medium rounded-lg"
              >
                {committing ? "Importing…" : `Import ${rows.length} row${rows.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
