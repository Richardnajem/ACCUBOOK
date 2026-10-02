"use client";

import { useEffect, useState, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import { loadMegaPrefs, activeMegaWeights } from "@/lib/mega-prefs";
import type { WalkForwardResult, WalkForwardFold } from "@/lib/backtest-engine";

const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

const PRESETS = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ", "TSLA", "KO"];
const TRAIN_OPTIONS = [0.08, 0.5, 2, 3, 5, 8];
const TEST_OPTIONS = [0.08, 0.5, 1, 2];
// Sub-year windows render as months (1M / 6M), otherwise as years (2Y, 5Y…)
const yearLabel = (y: number) => (y < 1 ? (Math.round(y * 12) === 1 ? "1M" : "6M") : `${y}Y`);

interface CatalogParam { key: string; label: string; default: number; min?: number; max?: number; }
interface CatalogStrategy { id: string; name: string; params: CatalogParam[]; defaults: Record<string, number>; }

export default function WalkForward({ onApply }: { onApply?: (strategyId: string, params: Record<string, number>) => void }) {
  const [catalog, setCatalog] = useState<CatalogStrategy[]>([]);
  const [ticker, setTicker] = useState("AAPL");
  const [strategyId, setStrategyId] = useState("sma_cross");
  const [trainYears, setTrainYears] = useState(3);
  const [testYears, setTestYears] = useState(1);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WalkForwardResult | null>(null);
  const [selected, setSelected] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    fetch("/api/backtest?type=catalog")
      .then(r => r.json())
      .then((items: CatalogStrategy[]) => setCatalog(items.filter(s => s.params.length > 0)))
      .catch(() => setError("Failed to load strategy catalog"));
  }, []);

  const effectiveStrategyId = catalog.some(s => s.id === strategyId)
    ? strategyId
    : catalog[0]?.id ?? "sma_cross";
  const selectedDef = catalog.find(s => s.id === effectiveStrategyId);
  const paramLabel = (key: string) => selectedDef?.params.find(p => p.key === key)?.label ?? key;

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "walkForward", symbol: ticker, strategyId: effectiveStrategyId, trainYears, testYears, megaWeights: activeMegaWeights(true, loadMegaPrefs()) ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Walk-forward failed");
      setResult(data);
      setSelected(data.folds?.[data.folds.length - 1]?.bestParams ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Walk-forward failed");
    } finally {
      setRunning(false);
    }
  };

  const chartData = useMemo(
    () => (result ? result.stitchedEquity.map(p => ({
      date: p.date,
      equity: Math.round(p.equity * 10) / 10,
      benchmark: p.benchmark > 0 ? Math.round(p.benchmark * 10) / 10 : null,
    })) : []),
    [result]
  );

  const paramSummary = (params: Record<string, number>) =>
    Object.entries(params).map(([k, v]) => `${paramLabel(k)}: ${v}`).join(" · ");

  const columns: Column<WalkForwardFold>[] = [
    { key: "trainFrom", header: "Train window", render: r => `${r.trainFrom} → ${r.trainTo}` },
    { key: "testFrom", header: "Test window", render: r => `${r.testFrom} → ${r.testTo}` },
    {
      key: "bestParams", header: "Chosen params",
      render: r => <span className="font-mono text-[11px]">{paramSummary(r.bestParams)}</span>,
    },
    {
      key: "trainSharpe", header: "Train Sharpe", align: "right",
      render: r => <span className="text-[var(--muted)]">{r.trainSharpe.toFixed(2)}</span>,
    },
    {
      key: "testSharpe", header: "Test Sharpe", align: "right",
      render: r => (
        <span className={r.isFail ? "text-[var(--danger)] font-semibold" : r.testSharpe >= 0.5 ? "text-[var(--success)]" : ""}>
          {r.testSharpe.toFixed(2)}{r.isFail ? " ⚠" : ""}
        </span>
      ),
    },
    {
      key: "testReturnPct", header: "OOS Return", align: "right",
      render: r => <span className={r.testReturnPct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(r.testReturnPct)}</span>,
    },
    { key: "testMaxDrawdownPct", header: "OOS Max DD", align: "right", render: r => pct(-r.testMaxDrawdownPct) },
    { key: "testTrades", header: "Trades", align: "right" },
    {
      key: "apply", header: "", align: "center",
      render: (r) => onApply && result ? (
        <button
          onClick={() => { setSelected(r.bestParams); onApply(result.strategyId, r.bestParams); }}
          className="px-2 py-1 text-[10px] rounded border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
        >
          Apply
        </button>
      ) : null,
    },
  ];

  const oosBeatsBench = result ? result.oosReturnPct > result.benchmarkReturnPct : false;
  const degraded = result ? result.folds.filter(f => f.isFail).length : 0;

  return (
    <div className="space-y-6">
      <div className="glass rounded-xl p-5">
        <p className="text-xs text-[var(--muted)] mb-4">
          The honest way to fight overfitting: repeatedly optimize on a <b>training window</b>, then run the winning
          parameters on the <b>unseen data</b> right after it. The stitched out-of-sample curve shows what this
          re-optimization process would actually have delivered live — overfit parameter sets fall apart here.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
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
            <label className="block text-xs text-[var(--muted)] mb-1">Train window</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {TRAIN_OPTIONS.map(y => (
                <button key={y} onClick={() => setTrainYears(y)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${trainYears === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {yearLabel(y)}
                </button>
              ))}
            </div>
            <label className="block text-xs text-[var(--muted)] mb-1 mt-3">Test window</label>
            <div className="flex flex-wrap gap-1">
              {TEST_OPTIONS.map(y => (
                <button key={y} onClick={() => setTestYears(y)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${testYears === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {yearLabel(y)}
                </button>
              ))}
            </div>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-xs text-[var(--muted)] mb-1">How to read it</label>
            <p className="text-[11px] text-[var(--muted)] leading-relaxed p-2 rounded-lg" style={{ background: "var(--input-bg)" }}>
              OOS Sharpe &gt; 0.5 and few ⚠ folds → the edge survives unseen data. OOS far below train Sharpe →
              the optimized parameters were memorizing the past.
            </p>
            <button onClick={run} disabled={running || !ticker || !effectiveStrategyId}
              className="mt-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
              {running ? "Walking forward…" : "🚶 Walk Forward"}
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {result && (
        <>
          {/* OOS summary */}
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
              <h3 className="text-sm font-semibold">
                {result.strategyName} on {result.symbol} — stitched out-of-sample equity
              </h3>
              <span className="text-xs text-[var(--muted)]">
                {result.folds.length} folds · {result.trainBars} train / {result.testBars} test bars · data: {result.dataSource}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {[
                { label: "OOS Return", value: pct(result.oosReturnPct), good: result.oosReturnPct >= 0 },
                { label: "OOS Sharpe", value: result.oosSharpe.toFixed(2), good: result.oosSharpe >= 0.5 },
                { label: "OOS Max DD", value: pct(-result.oosMaxDrawdownPct), good: false },
                { label: "B&H same window", value: pct(result.benchmarkReturnPct), good: oosBeatsBench },
              ].map(c => (
                <div key={c.label} className="p-3 rounded-lg" style={{ background: "var(--input-bg)" }}>
                  <p className="text-xs text-[var(--muted)]">{c.label}</p>
                  <p className={`text-base font-bold ${c.good ? "text-[var(--success)]" : c.label === "OOS Max DD" ? "text-[var(--danger)]" : ""}`}>
                    {c.value}
                  </p>
                </div>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 10 }} minTickGap={60} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 10 }} domain={["auto", "auto"]}
                  tickFormatter={(v: number) => `${Math.round(v)}`} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                  formatter={(v: unknown, name: unknown) => [Number(v).toFixed(1), name === "equity" ? "OOS equity" : "B&H"]}
                  labelFormatter={l => `Date: ${l}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="equity" name="OOS equity" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="benchmark" name="Buy & Hold" stroke="#9ca3af" strokeWidth={1.5} dot={false} strokeDasharray="4 3" connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            {degraded > 0 && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                ⚠ {degraded}/{result.folds.length} folds degraded badly out-of-sample (test Sharpe &lt; 50% of train) — treat the tuned parameters with suspicion.
              </p>
            )}
          </div>

          {/* Fold table */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Folds — optimize on train, verify on test</h3>
            <SortableTable
              columns={columns}
              data={result.folds}
              searchPlaceholder="Search folds…"
              searchKey="testFrom"
              emptyMessage="No folds"
              rowKey={(r) => `${r.trainFrom}-${r.testFrom}`}
            />
            {selected && (
              <p className="mt-3 text-xs text-[var(--muted)]">
                Last-fold params: <span className="font-mono">{paramSummary(selected)}</span>
                {onApply && " — use Apply to run them in the single backtest."}
              </p>
            )}
          </div>

          {result.warnings.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs">
              {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
