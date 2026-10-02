"use client";

import { useCallback, useEffect, useState } from "react";
import { useUndoRedo } from "@/lib/undo-redo";

const fmt = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

interface WatchRow {
  id: number;
  symbol: string;
  notes: string | null;
  target_price: number | null;
  quote: {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    previousClose: number | null;
    name: string | null;
    marketState: string | null;
  } | null;
  distanceToTargetPct: number | null;
  error: string | null;
}

export default function WatchlistPage() {
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const { push } = useUndoRedo();

  const load = useCallback(() => {
    fetch("/api/watchlist", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRows(d.items || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh quotes every 5s (server quote cache is 3s TTL, so every poll sees
  // a fresh quote without hammering Yahoo)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, targetPrice: target ? Number(target) : null, notes: notes || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add");
      push({ label: `Watch ${symbol.toUpperCase()}`, undo: async () => {}, redo: async () => {} });
      setSymbol(""); setTarget(""); setNotes(""); setAdding(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
    }
  };

  const openEdit = (row: WatchRow) => {
    if (editingId === row.id) {
      setEditingId(null);
      return;
    }
    setEditingId(row.id);
    setEditTarget(row.target_price?.toString() ?? "");
    setEditNotes(row.notes ?? "");
  };

  const saveRow = async (row: WatchRow) => {
    await fetch("/api/watchlist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: row.id,
        notes: editNotes || null,
        targetPrice: editTarget ? Number(editTarget) : null,
      }),
    });
    setEditingId(null);
    load();
  };

  const remove = async (row: WatchRow) => {
    await fetch(`/api/watchlist?id=${row.id}`, { method: "DELETE" });
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Watchlist</h2>
          <p className="text-sm text-[var(--muted)]">Track ideas with live quotes and target prices</p>
        </div>
        <button onClick={() => setAdding(!adding)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
          {adding ? "Close" : "+ Add Symbol"}
        </button>
      </div>

      {adding && (
        <form onSubmit={add} className="glass rounded-xl p-5 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Symbol</label>
            <input
              required value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm uppercase focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Target Price (optional)</label>
            <input
              type="number" step="any" min="0" value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
          <button type="submit" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
            Add to Watchlist
          </button>
          {error && <p className="text-sm text-[var(--danger)] sm:col-span-4">{error}</p>}
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {loading ? (
          <div className="flex items-center justify-center py-16 md:col-span-2 xl:col-span-3">
            <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)] text-center py-16 md:col-span-2 xl:col-span-3">
            Watchlist is empty. Add symbols you want to track for entry points.
          </p>
        ) : (
          rows.map((row) => {
            const q = row.quote;
            const up = (q?.change ?? 0) >= 0;
            const nearTarget =
              row.distanceToTargetPct != null &&
              Math.abs(row.distanceToTargetPct) <= 5;
            return (
              <div key={row.id} className="glass rounded-xl p-4 relative group">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold">{row.symbol}</span>
                      {q?.marketState === "REGULAR" && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" title="Market open" />
                      )}
                    </div>
                    <p className="text-xs text-[var(--muted)] truncate max-w-[180px]">{q?.name ?? row.notes ?? ""}</p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => openEdit(row)}
                      className="p-1.5 text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] rounded"
                      title="Edit"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                    <button
                      onClick={() => remove(row)}
                      className="p-1.5 text-[var(--muted)] hover:text-red-500 hover:bg-red-500/10 rounded"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>

                <div className="flex items-baseline gap-3 mt-3">
                  <span className="text-2xl font-bold tabular-nums">{fmt(q?.price ?? null)}</span>
                  {q?.changePercent != null && (
                    <span className={`text-sm font-medium tabular-nums ${up ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                      {up ? "▲" : "▼"} {Math.abs(q.changePercent).toFixed(2)}%
                    </span>
                  )}
                </div>
                {/* Live price vs previous close, shown as distinct values */}
                <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--muted)]">
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
                    Live
                  </span>
                  {q?.previousClose != null && <span>Prev close <b className="text-[var(--foreground)] tabular-nums">{fmt(q.previousClose)}</b></span>}
                </div>
                {row.error && <p className="text-xs text-amber-500 dark:text-amber-400 mt-1">⚠ {row.error}</p>}

                {row.target_price != null && (
                  <div className="mt-3 pt-3 border-t border-[var(--card-border)] flex items-center justify-between text-xs">
                    <span className="text-[var(--muted)]">Target: <b className="text-[var(--foreground)]">{fmt(row.target_price)}</b></span>
                    <span className={nearTarget ? "text-[var(--warning)] font-medium" : "text-[var(--muted)]"}>
                      {row.distanceToTargetPct != null
                        ? row.distanceToTargetPct > 0
                          ? `${row.distanceToTargetPct.toFixed(1)}% below`
                          : `${Math.abs(row.distanceToTargetPct).toFixed(1)}% above`
                        : "—"}
                    </span>
                  </div>
                )}

                {editingId === row.id && (
                  <div className="mt-3 pt-3 border-t border-[var(--card-border)] space-y-2">
                    <input
                      type="number" step="any" min="0" placeholder="Target price"
                      value={editTarget}
                      onChange={(e) => setEditTarget(e.target.value)}
                      className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    />
                    <input
                      placeholder="Notes"
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-sm focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    />
                    <button onClick={() => saveRow(row)} className="w-full px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded">
                      Save
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
