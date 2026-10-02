"use client";

import { useEffect, useState, useMemo } from "react";
import { loadMegaPrefs, activeMegaWeights } from "@/lib/mega-prefs";
import type { OptimizeResult, OptimizePoint } from "@/lib/backtest-engine";

const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

const PRESETS = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ", "TSLA", "KO"];
const YEAR_OPTIONS = [1 / 12, 0.5, 1, 2, 3, 5, 10, 15, 20];
// Sub-year windows render as months (1M / 6M), otherwise as years (2Y, 5Y…)
const yearLabel = (y: number) => (y < 1 ? (Math.round(y * 12) === 1 ? "1M" : "6M") : `${y}Y`);

interface CatalogParam { key: string; label: string; default: number; min?: number; max?: number; }
interface CatalogStrategy { id: string; name: string; params: CatalogParam[]; defaults: Record<string, number>; }

const METRICS = [
  { key: "sharpe", label: "Sharpe", higherBetter: true },
  { key: "totalReturnPct", label: "Return %", higherBetter: true },
  { key: "sortino", label: "Sortino", higherBetter: true },
  { key: "maxDrawdownPct", label: "Max DD %", higherBetter: false },
  { key: "winRate", label: "Win %", higherBetter: true },
  { key: "totalTrades", label: "Trades", higherBetter: true },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function fmtMetric(k: MetricKey, v: number): string {
  if (k === "sharpe" || k === "sortino") return v.toFixed(2);
  if (k === "totalTrades") return String(Math.round(v));
  return pct(v, 1);
}

export default function ParamOptimizer({ onApply }: { onApply?: (strategyId: string, params: Record<string, number>) => void }) {
  const [catalog, setCatalog] = useState<CatalogStrategy[]>([]);
  const [ticker, setTicker] = useState("AAPL");
  const [strategyId, setStrategyId] = useState("sma_cross");
  const [years, setYears] = useState(10);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [metric, setMetric] = useState<MetricKey>("sharpe");
  const [selected, setSelected] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    fetch("/api/backtest?type=catalog")
      .then(r => r.json())
      .then((items: CatalogStrategy[]) => setCatalog(items.filter(s => s.params.length > 0)))
      .catch(() => setError("Failed to load strategy catalog"));
  }, []);

  // Derived default: fall back to the first catalog entry when the current
  // selection isn't in the list (initial mount, before catalog loads).
  const effectiveStrategyId = catalog.some(s => s.id === strategyId)
    ? strategyId
    : catalog[0]?.id ?? "sma_cross";

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "optimizeStrategy", symbol: ticker, strategyId: effectiveStrategyId, years, initialCapital: 100000, commissionBps: 2, slippageBps: 2, positionPct: 100, megaWeights: activeMegaWeights(true, loadMegaPrefs()) ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Optimization failed");
      setResult(data);
      setSelected(data.best?.params ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Optimization failed");
    } finally {
      setRunning(false);
    }
  };

  const selectedDef = catalog.find(s => s.id === effectiveStrategyId);
  const paramLabel = (key: string) => selectedDef?.params.find(p => p.key === key)?.label ?? key;

  // ── Heatmap model: best point per (x,y) cell + color scale ──
  const heatmap = useMemo(() => {
    if (!result) return null;
    const xs = Array.from(new Set(result.points.map(p => p.params[result.xAxis]))).sort((a, b) => a - b);
    const ys = Array.from(new Set(result.points.map(p => p.params[result.yAxis]))).sort((a, b) => a - b);
    const bestByCell = new Map<string, OptimizePoint>();
    for (const p of result.points) {
      const k = `${p.params[result.xAxis]}|${p.params[result.yAxis]}`;
      const cur = bestByCell.get(k);
      if (!cur || p.sharpe > cur.sharpe || (p.sharpe === cur.sharpe && p.totalReturnPct > cur.totalReturnPct)) {
        bestByCell.set(k, p);
      }
    }
    const vals = Array.from(bestByCell.values()).map(p => p[metric]);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    if (max === min) max = min + 1;
    return { xs, ys, bestByCell, min, max };
  }, [result, metric]);

  const cellColor = (v: number) => {
    if (!heatmap) return "transparent";
    const m = METRICS.find(x => x.key === metric)!;
    let t = (v - heatmap.min) / (heatmap.max - heatmap.min);
    if (!m.higherBetter) t = 1 - t;
    t = Math.max(0, Math.min(1, t));
    return `hsl(${Math.round(t * 140)}, 62%, ${Math.round(46 - t * 10)}%)`;
  };

  const comboLabel = (params: Record<string, number>) =>
    Object.entries(params).map(([k, v]) => `${paramLabel(k)}: ${v}`).join(" · ");

  const comboCard = (title: string, p: OptimizePoint | null, highlight: boolean) => {
    if (!p) return null;
    return (
      <div key={title}
        onClick={() => setSelected(p.params)}
        className={`p-3 rounded-lg cursor-pointer transition-all border ${highlight ? "border-indigo-500" : "border-transparent"} hover:border-indigo-400`}
        style={{ background: "var(--input-bg)" }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold">{title}</p>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/15 text-indigo-500 dark:text-indigo-400">Sharpe {p.sharpe.toFixed(2)}</span>
        </div>
        <p className="text-[11px] text-[var(--muted)] leading-snug">{comboLabel(p.params)}</p>
        <div className="flex gap-3 mt-2 text-[11px]">
          <span className={p.totalReturnPct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(p.totalReturnPct)}</span>
          <span className="text-[var(--muted)]">DD {pct(-p.maxDrawdownPct)}</span>
          <span className="text-[var(--muted)]">{p.totalTrades} trades</span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="glass rounded-xl p-5">
        <p className="text-xs text-[var(--muted)] mb-4">
          Sweeps the strategy&apos;s parameters across a grid, backtesting every combination, and shows a performance
          heatmap. The chosen metric colors each cell; click a cell to inspect that combination.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Ticker</label>
            <input
              type="text" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") run(); }}
              maxLength={12}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm font-mono uppercase tracking-wider focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {PRESETS.map(t => (
                <button key={t} onClick={() => setTicker(t)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${ticker === t ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Strategy</label>
            <select value={effectiveStrategyId} onChange={(e) => setStrategyId(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
              {catalog.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">History</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {YEAR_OPTIONS.map(y => (
                <button key={y} onClick={() => setYears(y)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${years === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {yearLabel(y)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Heatmap metric</label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
              {METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            <button onClick={run} disabled={running || !ticker || !effectiveStrategyId}
              className="mt-4 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
              {running ? "Sweeping…" : "🧭 Optimize"}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {result && heatmap && result.best && result.byReturn && result.byDrawdown && (
        <>
          {/* Best combos */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {comboCard("🏆 Best Sharpe", result.best, JSON.stringify(selected) === JSON.stringify(result.best.params))}
            {comboCard("💰 Best Return", result.byReturn, JSON.stringify(selected) === JSON.stringify(result.byReturn.params))}
            {comboCard("🛡 Lowest Drawdown", result.byDrawdown, JSON.stringify(selected) === JSON.stringify(result.byDrawdown.params))}
          </div>

          {/* Heatmap */}
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h3 className="text-sm font-semibold">
                {result.strategyName} — {METRICS.find(m => m.key === metric)?.label ?? ""} heatmap
              </h3>
              <div className="flex items-center gap-2 text-[10px] text-[var(--muted)]">
                <span>{heatmap.min.toFixed(2)}</span>
                <span className="w-28 h-2.5 rounded" style={{ background: "linear-gradient(90deg, hsl(0,62%,46%), hsl(70,62%,40%), hsl(140,62%,36%))" }} />
                <span>{heatmap.max.toFixed(2)}</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="border-separate" style={{ borderSpacing: "3px" }}>
                <thead>
                  <tr>
                    <th></th>
                    {heatmap.xs.map(x => (
                      <th key={x} className="px-1 pb-1 text-[10px] font-mono text-[var(--muted)] font-normal">{x}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmap.ys.slice().reverse().map(y => (
                    <tr key={y}>
                      <th className="pr-2 text-[10px] font-mono text-[var(--muted)] font-normal text-right whitespace-nowrap">
                        {y}
                      </th>
                      {heatmap.xs.map(x => {
                        const p = heatmap.bestByCell.get(`${x}|${y}`);
                        if (!p) return <td key={x} className="w-14 h-9 rounded" style={{ background: "var(--card-hover)" }} />;
                        const v = p[metric];
                        const isSel = selected && JSON.stringify(selected) === JSON.stringify(p.params);
                        return (
                          <td key={x}
                            onClick={() => setSelected(p.params)}
                            title={`${paramLabel(result.xAxis)}: ${x}\n${paramLabel(result.yAxis)}: ${y}\n${METRICS.find(m => m.key === metric)?.label ?? ""}: ${fmtMetric(metric, v)}\nTrades: ${p.totalTrades}`}
                            className={`w-14 h-9 rounded text-center text-[10px] font-mono cursor-pointer transition-transform hover:scale-105 ${isSel ? "ring-2 ring-indigo-400" : ""}`}
                            style={{ background: cellColor(v), color: "#fff" }}>
                            {fmtMetric(metric, v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-[var(--muted)] mt-3">
              Columns: {paramLabel(result.xAxis)} · Rows: {paramLabel(result.yAxis)}
              {result.skippedCombos > 0 && ` · ${result.skippedCombos} invalid/skipped combinations`}
            </p>
          </div>

          {/* Selected combo detail + apply */}
          {selected && (
            <div className="glass rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs text-[var(--muted)] mb-1">Selected combination</p>
                <p className="text-sm font-semibold">{comboLabel(selected)}</p>
              </div>
              {onApply && (
                <button
                  onClick={() => onApply(result.strategyId, selected)}
                  className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 transition-colors">
                  ▶ Run this combo in Backtest
                </button>
              )}
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs">
              {result
.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
