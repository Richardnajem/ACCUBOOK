"use client";

import { useEffect, useRef, useState } from "react";

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

interface PriceRow {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PriceWorkbook {
  fileName: string;
  totalRows: number;
  sheets: { sheet: string; symbol: string; rows: number; dateFrom: string | null; dateTo: string | null }[];
  warnings: string[];
  rows: PriceRow[];
}

interface PositionRow {
  symbol: string;
  shares: number;
  avgCost: number;
}

interface WatchDraft {
  symbol: string;
  target: number | null;
  notes: string | null;
}

type Tab = "trades" | "prices" | "positions" | "watchlist";

// ─── Delimited-text helpers (client-side, for the Positions/Watchlist tabs) ──
function splitCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === "," || ch === "\t" || ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function toNumber(s: string): number | null {
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, "").replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/** Parse "symbol, shares, avg cost" rows — header optional, auto-mapped. */
function parsePositions(text: string): PositionRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  let start = 0;
  let si = 0, sh = 1, ci = 2;
  const first = splitCells(lines[0]).map((h) => h.toLowerCase());
  const symIdx = first.findIndex((h) => /symbol|ticker|sym/.test(h));
  const shIdx = first.findIndex((h) => /share|quantity|qty|units/.test(h));
  const costIdx = first.findIndex((h) => /avg|average|cost|price|basis/.test(h));
  if (symIdx !== -1 && shIdx !== -1 && costIdx !== -1) {
    start = 1; si = symIdx; sh = shIdx; ci = costIdx;
  }
  const rows: PositionRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitCells(lines[i]);
    const symbol = (c[si] || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    const shares = toNumber(c[sh] || "");
    const avgCost = toNumber(c[ci] || "");
    if (!symbol || shares == null || shares <= 0 || avgCost == null || avgCost < 0) continue;
    rows.push({ symbol, shares, avgCost });
  }
  return rows;
}

/** Parse a watchlist sheet: symbol[, target, notes]. */
function parseWatchlist(text: string): WatchDraft[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  let start = 0;
  let si = 0, ti = 1, ni = 2;
  const first = splitCells(lines[0]).map((h) => h.toLowerCase());
  const symIdx = first.findIndex((h) => /symbol|ticker|sym/.test(h));
  if (symIdx !== -1) {
    start = 1;
    si = symIdx;
    const tIdx = first.findIndex((h) => /target/.test(h));
    const nIdx = first.findIndex((h) => /note|comment|desc/.test(h));
    ti = tIdx === -1 ? -1 : tIdx;
    ni = nIdx === -1 ? -1 : nIdx;
  }
  const rows: WatchDraft[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = splitCells(lines[i]);
    const symbol = (c[si] || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!symbol) continue;
    const target = ti !== -1 ? toNumber(c[ti] || "") : null;
    const notes = ni !== -1 ? (c[ni] || "").trim() || null : null;
    rows.push({ symbol, target, notes });
  }
  return rows;
}

export default function ImportDialog({
  open,
  onClose,
  onImported,
  initialTab = "trades",
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number } | null>(null);

  // price-history state
  const [priceWb, setPriceWb] = useState<PriceWorkbook | null>(null);
  const [priceResult, setPriceResult] = useState<{ inserted: number; symbols: number } | null>(null);

  // positions state
  const [posRows, setPosRows] = useState<PositionRow[] | null>(null);
  const [posDate, setPosDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [posResult, setPosResult] = useState<{ inserted: number; skipped: number } | null>(null);

  // watchlist state
  const [wlRows, setWlRows] = useState<WatchDraft[] | null>(null);
  const [wlResult, setWlResult] = useState<{ inserted: number; skipped: number } | null>(null);

  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setRows(null);
    setPriceWb(null);
    setPosRows(null);
    setWlRows(null);
    setFileName("");
    setResult(null);
    setPriceResult(null);
    setPosResult(null);
    setWlResult(null);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  // Re-seed the visible tab (and clear stale previews) each time the dialog opens.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setTab(initialTab);
      reset();
    }
    wasOpenRef.current = open;
  }, [open, initialTab]);

  if (!open) return null;

  const close = () => {
    reset();
    onClose();
  };

  const parseTrades = async (f: File) => {
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

  const parsePrices = async (f: File) => {
    setFileName(f.name);
    setError("");
    setPriceWb(null);
    setPriceResult(null);
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/import/prices", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to parse file");
      setPriceWb(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setParsing(false);
    }
  };

  const parsePositionsFile = async (f: File) => {
    setFileName(f.name);
    setError("");
    setPosRows(null);
    setPosResult(null);
    setParsing(true);
    try {
      const text = await f.text();
      const parsed = parsePositions(text);
      if (parsed.length === 0) throw new Error("No importable positions found. Expected symbol, shares, avg cost.");
      setPosRows(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setParsing(false);
    }
  };

  const parseWatchlistFile = async (f: File) => {
    setFileName(f.name);
    setError("");
    setWlRows(null);
    setWlResult(null);
    setParsing(true);
    try {
      const text = await f.text();
      const parsed = parseWatchlist(text);
      if (parsed.length === 0) throw new Error("No symbols found in file.");
      setWlRows(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse file");
    } finally {
      setParsing(false);
    }
  };

  const handleFile = (f: File) => {
    if (tab === "trades") parseTrades(f);
    else if (tab === "prices") parsePrices(f);
    else if (tab === "positions") parsePositionsFile(f);
    else parseWatchlistFile(f);
  };

  const commitTrades = async () => {
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

  const commitPrices = async () => {
    if (!priceWb || priceWb.rows.length === 0) return;
    setCommitting(true);
    setError("");
    try {
      const res = await fetch("/api/import/prices", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: priceWb.rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setPriceResult({ inserted: data.inserted, symbols: Object.keys(data.symbols ?? {}).length });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  };

  // A position snapshot becomes one buy trade per holding (dated posDate), so it
  // flows through the same FIFO engine, dedupe, and pre-import backup as trades.
  const commitPositions = async () => {
    if (!posRows || posRows.length === 0) return;
    setCommitting(true);
    setError("");
    try {
      const tradeRows: ImportRow[] = posRows.map((r) => ({
        date: posDate,
        description: `Imported position ${r.symbol}`,
        symbol: r.symbol,
        shares: r.shares,
        price: r.avgCost,
        type: "buy",
        fees: 0,
      }));
      const res = await fetch("/api/import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: tradeRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setPosResult({ inserted: data.inserted, skipped: data.skipped });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  };

  const commitWatchlist = async () => {
    if (!wlRows || wlRows.length === 0) return;
    setCommitting(true);
    setError("");
    try {
      let inserted = 0;
      let skipped = 0;
      const seen = new Set<string>();
      for (const r of wlRows) {
        if (seen.has(r.symbol)) { skipped++; continue; }
        seen.add(r.symbol);
        const res = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: r.symbol, targetPrice: r.target, notes: r.notes }),
        });
        if (res.ok) inserted++;
        else skipped++;
      }
      setWlResult({ inserted, skipped });
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  };

  const typeOptions = TRADE_TYPES;

  const accept =
    tab === "trades" ? ".xlsx,.xls,.csv,.pdf"
    : tab === "prices" ? ".xlsx,.xls,.csv"
    : ".csv,.txt,.tsv";

  const tabButton = (value: Tab, label: string) => (
    <button
      onClick={() => { setTab(value); reset(); }}
      className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
        tab === value ? "border-indigo-500 text-[var(--foreground)]" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {label}
    </button>
  );

  const dropZone = (title: string, hint: string, icon: React.ReactNode) => (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      className="border-2 border-dashed border-[var(--input-border)] rounded-xl p-8 text-center hover:border-indigo-500/50 transition-colors"
    >
      <div className="w-12 h-12 rounded-xl bg-indigo-600/10 text-indigo-500 flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <button
        onClick={() => inputRef.current?.click()}
        className="mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg"
      >
        Choose File
      </button>
      <p className="text-xs text-[var(--muted)] mt-3">{hint}</p>
      {parsing && <ParsingIndicator fileName={fileName} />}
    </div>
  );

  const pasteZone = (
    placeholder: string,
    onParse: (text: string) => void,
    hint: string,
  ) => (
    <div className="mt-3">
      <p className="text-xs text-[var(--muted)] mb-1">…or paste rows directly</p>
      <textarea
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
        onBlur={(e) => { if (e.target.value.trim()) onParse(e.target.value); }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text.trim()) { e.preventDefault(); onParse(text); }
        }}
        className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
      />
      <p className="text-[10px] text-[var(--muted)] mt-1">{hint}</p>
    </div>
  );

  const doneScreen = (title: string, detail: string, note?: string) => (
    <div className="text-center py-10">
      <div className="w-14 h-14 rounded-full bg-green-500/10 text-[var(--success)] flex items-center justify-center mx-auto mb-4">
        <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      </div>
      <h4 className="text-lg font-bold mb-1">{title}</h4>
      <p className="text-sm text-[var(--muted)]">{detail}</p>
      {note && <p className="text-xs text-[var(--muted)] mt-2">{note}</p>}
      <button onClick={close} className="mt-6 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
        Done
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="relative glass rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header + tabs */}
        <div className="p-5 pb-0 border-b border-[var(--card-border)]">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold">Import Data</h3>
            <button onClick={close} className="p-2 -mr-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="flex gap-4 mt-3 overflow-x-auto">
            {tabButton("trades", "Trades")}
            {tabButton("positions", "Positions")}
            {tabButton("watchlist", "Watchlist")}
            {tabButton("prices", "Price History")}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {result ? (
            doneScreen("Import complete",
              `${result.inserted} row${result.inserted === 1 ? "" : "s"} imported${result.skipped > 0 ? ` · ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"} skipped` : ""}`)
          ) : priceResult ? (
            doneScreen("Price history imported",
              `${priceResult.inserted} daily bar${priceResult.inserted === 1 ? "" : "s"} stored${priceResult.symbols > 0 ? ` for ${priceResult.symbols} ticker${priceResult.symbols === 1 ? "" : "s"}` : ""}`,
              "The ticker is now usable in Backtesting, Mega Indicator, and the Watchlist — even offline.")
          ) : posResult ? (
            doneScreen("Positions imported",
              `${posResult.inserted} position${posResult.inserted === 1 ? "" : "s"} added${posResult.skipped > 0 ? ` · ${posResult.skipped} already recorded and skipped` : ""}`,
              "Each position became a buy trade at its average cost, so cost basis and P&L work as usual.")
          ) : wlResult ? (
            doneScreen("Watchlist imported",
              `${wlResult.inserted} symbol${wlResult.inserted === 1 ? "" : "s"} added${wlResult.skipped > 0 ? ` · ${wlResult.skipped} skipped` : ""}`)
          ) : tab === "trades" ? (
            !rows ? (
              dropZone("Drag & drop a broker export here, or",
                ".xlsx, .xls, .csv, .pdf — trade columns are detected automatically",
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.9A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>)
            ) : (
              <div>
                <PreviewHeader count={rows.length} fileName={fileName} onReset={reset} label="row" />
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
                              onChange={(e) => {
                                const next = [...rows];
                                next[i] = { ...next[i], type: e.target.value };
                                setRows(next);
                              }}
                              className="px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                            >
                              {typeOptions.map((t) => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <button onClick={() => setRows(rows.filter((_, idx) => idx !== i))} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title="Remove row">
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
            )
          ) : tab === "prices" ? (
            !priceWb ? (
              dropZone("Drag & drop a price-history workbook here, or",
                ".xlsx / .xls / .csv with daily Date + OHLCV rows — every sheet is scanned and the ticker is auto-detected.",
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3v18h18M7 14v4m4-9v9m4-6v6m4-11v11" /></svg>)
            ) : (
              <div>
                <PreviewHeader count={priceWb.totalRows} fileName={fileName} onReset={reset} label="daily bar" />
                <div className="overflow-x-auto border border-[var(--card-border)] rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[var(--muted)] border-b border-[var(--card-border)]" style={{ background: "var(--input-bg)" }}>
                        <th className="text-left py-2 px-3 font-medium">Sheet</th>
                        <th className="text-left py-2 px-3 font-medium">Ticker</th>
                        <th className="text-right py-2 px-3 font-medium">Bars</th>
                        <th className="text-left py-2 px-3 font-medium">Range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {priceWb.sheets.map((s) => (
                        <tr key={s.sheet} className="border-b border-[var(--card-border)] last:border-0">
                          <td className="py-2 px-3 text-[var(--muted)]">{s.sheet}</td>
                          <td className="py-2 px-3 font-medium">{s.symbol}</td>
                          <td className="py-2 px-3 text-right">{s.rows}</td>
                          <td className="py-2 px-3 text-[var(--muted)] whitespace-nowrap">{s.dateFrom} → {s.dateTo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {priceWb.warnings.length > 0 && (
                  <div className="mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 space-y-1">
                    {priceWb.warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                )}
                <p className="text-xs text-[var(--muted)] mt-2">
                  Rows land in the local price cache and merge with (or replace) any existing data for the same ticker and date.
                </p>
              </div>
            )
          ) : tab === "positions" ? (
            !posRows ? (
              <div>
                {dropZone("Drag & drop a holdings snapshot here, or",
                  ".csv / .txt / .tsv with Symbol, Shares, Average Cost columns",
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6h18M3 12h18M3 18h18" /></svg>)}
                {pasteZone(
                  "AAPL, 100, 182.50\nMSFT, 40, 310.00",
                  (text) => {
                    const parsed = parsePositions(text);
                    if (parsed.length === 0) { setError("No importable positions found. Expected symbol, shares, avg cost."); return; }
                    setError("");
                    setPosRows(parsed);
                    setFileName("pasted rows");
                  },
                  "One position per line: Symbol, Shares, Average Cost",
                )}
              </div>
            ) : (
              <div>
                <PreviewHeader count={posRows.length} fileName={fileName} onReset={reset} label="position" />
                <div className="overflow-x-auto border border-[var(--card-border)] rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[var(--muted)] border-b border-[var(--card-border)]" style={{ background: "var(--input-bg)" }}>
                        <th className="text-left py-2 px-3 font-medium">Symbol</th>
                        <th className="text-right py-2 px-3 font-medium">Shares</th>
                        <th className="text-right py-2 px-3 font-medium">Avg Cost</th>
                        <th className="text-right py-2 px-3 font-medium">Cost Basis</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {posRows.map((r, i) => (
                        <tr key={i} className="border-b border-[var(--card-border)] last:border-0">
                          <td className="py-2 px-3 font-bold">{r.symbol}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{r.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{fmt(r.avgCost)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{fmt(r.shares * r.avgCost)}</td>
                          <td className="py-2 px-2">
                            <button onClick={() => setPosRows(posRows.filter((_, idx) => idx !== i))} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title="Remove row">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <label className="text-xs text-[var(--muted)]">As-of date</label>
                  <input
                    type="date"
                    value={posDate}
                    onChange={(e) => setPosDate(e.target.value)}
                    className="px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
                <p className="text-xs text-[var(--muted)] mt-2">
                  Each position is recorded as a buy at its average cost on the as-of date. Rows already matching a
                  recorded trade are skipped, so re-importing the same snapshot is safe.
                </p>
              </div>
            )
          ) : (
            !wlRows ? (
              <div>
                {dropZone("Drag & drop a symbol list here, or",
                  ".csv / .txt with Symbol[, Target, Notes]",
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5h14M5 12h14M5 19h14" /></svg>)}
                {pasteZone(
                  "NVDA, 900\nSHOP, 60, waiting for a dip",
                  (text) => {
                    const parsed = parseWatchlist(text);
                    if (parsed.length === 0) { setError("No symbols found."); return; }
                    setError("");
                    setWlRows(parsed);
                    setFileName("pasted rows");
                  },
                  "One symbol per line: SYMBOL[, target price, notes]",
                )}
              </div>
            ) : (
              <div>
                <PreviewHeader count={wlRows.length} fileName={fileName} onReset={reset} label="symbol" />
                <div className="overflow-x-auto border border-[var(--card-border)] rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[var(--muted)] border-b border-[var(--card-border)]" style={{ background: "var(--input-bg)" }}>
                        <th className="text-left py-2 px-3 font-medium">Symbol</th>
                        <th className="text-right py-2 px-3 font-medium">Target</th>
                        <th className="text-left py-2 px-3 font-medium">Notes</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {wlRows.map((r, i) => (
                        <tr key={i} className="border-b border-[var(--card-border)] last:border-0">
                          <td className="py-2 px-3 font-bold">{r.symbol}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{r.target != null ? fmt(r.target) : "—"}</td>
                          <td className="py-2 px-3 text-[var(--muted)]">{r.notes ?? "—"}</td>
                          <td className="py-2 px-2">
                            <button onClick={() => setWlRows(wlRows.filter((_, idx) => idx !== i))} className="p-1 text-red-500 hover:bg-red-500/10 rounded" title="Remove row">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-[var(--muted)] mt-2">Symbols already on your watchlist are skipped.</p>
              </div>
            )
          )}

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-[var(--danger)]">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter
          tab={tab}
          rows={rows}
          priceWb={priceWb}
          posRows={posRows}
          wlRows={wlRows}
          committing={committing}
          onReset={reset}
          onCommitTrades={commitTrades}
          onCommitPrices={commitPrices}
          onCommitPositions={commitPositions}
          onCommitWatchlist={commitWatchlist}
        />
      </div>
      {/* hidden file input shared by every tab */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function DialogFooter({
  tab,
  rows,
  priceWb,
  posRows,
  wlRows,
  committing,
  onReset,
  onCommitTrades,
  onCommitPrices,
  onCommitPositions,
  onCommitWatchlist,
}: {
  tab: Tab;
  rows: ImportRow[] | null;
  priceWb: PriceWorkbook | null;
  posRows: PositionRow[] | null;
  wlRows: WatchDraft[] | null;
  committing: boolean;
  onReset: () => void;
  onCommitTrades: () => void;
  onCommitPrices: () => void;
  onCommitPositions: () => void;
  onCommitWatchlist: () => void;
}) {
  const spec: { count: number; label: string; commit: () => void } | null =
    tab === "trades" && rows ? { count: rows.length, label: "row", commit: onCommitTrades }
    : tab === "prices" && priceWb ? { count: priceWb.totalRows, label: "bar", commit: onCommitPrices }
    : tab === "positions" && posRows ? { count: posRows.length, label: "position", commit: onCommitPositions }
    : tab === "watchlist" && wlRows ? { count: wlRows.length, label: "symbol", commit: onCommitWatchlist }
    : null;

  if (!spec || spec.count === 0) return null;

  return (
    <div className="flex items-center justify-between p-5 border-t border-[var(--card-border)]">
      <p className="text-sm text-[var(--muted)]">
        {spec.count} {spec.label}{spec.count === 1 ? "" : "s"} ready
      </p>
      <div className="flex items-center gap-2">
        <button onClick={onReset} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
          Back
        </button>
        <button
          onClick={spec.commit}
          disabled={committing}
          className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:bg-green-900 disabled:text-green-300 text-white text-sm font-medium rounded-lg"
        >
          {committing ? "Importing…" : `Import ${spec.count} ${spec.label}${spec.count === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function ParsingIndicator({ fileName }: { fileName: string }) {
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
      <div className="animate-spin w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full" />
      Parsing {fileName}…
    </div>
  );
}

function PreviewHeader({ count, fileName, onReset, label }: { count: number; fileName: string; onReset: () => void; label: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <p className="text-sm text-[var(--muted)]">
        <span className="font-medium text-[var(--foreground)]">{count}</span> {label}{count === 1 ? "" : "s"} detected
        from <span className="font-medium text-[var(--foreground)]">{fileName}</span>
      </p>
      <button onClick={onReset} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] font-medium">
        Choose different file
      </button>
    </div>
  );
}
