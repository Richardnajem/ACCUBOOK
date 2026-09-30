"use client";

import { useState } from "react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import { loadMegaPrefs, activeMegaWeights } from "@/lib/mega-prefs";
import type { ComparisonResult } from "@/lib/backtest-engine";

const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

const PRESETS = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ", "TSLA", "KO", "JPM"];
const YEAR_OPTIONS = [1, 2, 3, 5, 10, 15, 20];

export default function StrategyCompare() {
  const [ticker, setTicker] = useState("AAPL");
  const [years, setYears] = useState(10);
  const [capital, setCapital] = useState(100000);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "compareStrategies",
          symbol: ticker,
          initialCapital: capital,
          years,
          commissionBps: 2,
          slippageBps: 2,
          positionPct: 100,
          megaWeights: activeMegaWeights(true, loadMegaPrefs()) ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Comparison failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comparison failed");
    } finally {
      setRunning(false);
    }
  };

  const rows = result?.rows ?? [];
  const bench = result?.benchmarkReturnPct ?? 0;

  const columns: Column<ComparisonResult["rows"][number]>[] = [
    { key: "rank", header: "#", render: (_r, i) => i + 1 },
    { key: "strategyName", header: "Strategy" },
    {
      key: "totalReturnPct", header: "Return", align: "right",
      render: (r) => <span className={r.totalReturnPct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(r.totalReturnPct)}</span>,
    },
    { key: "cagr", header: "CAGR", align: "right", render: (r) => pct(r.cagr) },
    {
      key: "sharpe", header: "Sharpe", align: "right",
      render: (r) => (
        <span className={`font-semibold ${r.sharpe >= 1 ? "text-[var(--success)]" : r.sharpe >= 0.5 ? "" : "text-[var(--danger)]"}`}>
          {r.sharpe.toFixed(2)}
        </span>
      ),
    },
    { key: "sortino", header: "Sortino", align: "right", render: (r) => r.sortino.toFixed(2) },
    { key: "maxDrawdownPct", header: "Max DD", align: "right", render: (r) => pct(-r.maxDrawdownPct) },
    { key: "winRate", header: "Win %", align: "right", render: (r) => pct(r.winRate, 0) },
    { key: "profitFactor", header: "PF", align: "right", render: (r) => (r.profitFactor >= 99 ? "∞" : r.profitFactor.toFixed(2)) },
    { key: "totalTrades", header: "Trades", align: "right" },
    { key: "timeInMarketPct", header: "Exposure", align: "right", render: (r) => pct(r.timeInMarketPct, 0) },
    {
      key: "beatsBuyHold", header: "vs B&H", align: "center",
      render: (r) =>
        r.error ? (
          <span className="text-[var(--danger)] text-xs">err</span>
        ) : r.beatsBuyHold ? (
          <span className="text-[var(--success)]">✓</span>
        ) : (
          <span className="text-[var(--muted)]">—</span>
        ),
    },
  ];

  const chartData = rows
    .filter(r => !r.error)
    .map(r => ({ name: r.strategyName.replace(/ \(.*\)/, ""), sharpe: Math.round(r.sharpe * 100) / 100, id: r.strategyId }));

  return (
    <div className="space-y-6">
      <div className="glass rounded-xl p-5">
        <p className="text-xs text-[var(--muted)] mb-4">
          Runs every strategy over the same ticker and history with identical cost settings, then ranks by Sharpe ratio.
          The Buy &amp; Hold return is shown as the benchmark every active strategy must beat.
          Your saved Mega Indicator weights (from the Mega Indicator page) are applied to the Mega Score strategy here.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            <label className="block text-xs text-[var(--muted)] mb-1">History</label>
            <div className="flex flex-wrap gap-1 mt-1">
              {YEAR_OPTIONS.map(y => (
                <button key={y} onClick={() => setYears(y)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${years === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {y}Y
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Initial capital ($)</label>
            <input type="number" value={capital} min={1000} step={1000} onChange={(e) => setCapital(Number(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            <button onClick={run} disabled={running || !ticker}
              className="mt-4 px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
              {running ? "Comparing…" : "⚔ Compare All"}
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
          <div className="glass rounded-xl p-4 flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <span><span className="text-[var(--muted)] text-xs">Ticker:</span> <b>{result.symbol}</b> · {result.meta.name}</span>
            <span><span className="text-[var(--muted)] text-xs">Window:</span> {result.dateFrom} → {result.dateTo} ({result.bars} bars, {result.dataSource})</span>
            <span><span className="text-[var(--muted)] text-xs">Buy&amp;Hold:</span> <b className={bench >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(bench)}</b> (Sharpe {result.benchmarkSharpe.toFixed(2)}, DD {pct(-result.benchmarkMaxDrawdownPct)})</span>
          </div>

          {chartData.length > 0 && (
            <div className="glass rounded-xl p-5">
              <h3 className="text-sm font-semibold mb-3">Sharpe Ratio by Strategy</h3>
              <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 36)}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                  <XAxis type="number" stroke="var(--muted)" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" stroke="var(--muted)" width={170} tick={{ fontSize: 11 }} />
                  <Tooltip
                  
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                    formatter={(v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v))}
                  />
                  <ReferenceLine x={0} stroke="var(--muted)" />
                  <Bar dataKey="sharpe" radius={[0, 4, 4, 0]}>
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={d.sharpe >= 1 ? "#22c55e" : d.sharpe >= 0.5 ? "#6366f1" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">All Strategies — click a header to re-sort</h3>
            <SortableTable
              columns={columns}
              data={rows}
              searchPlaceholder="Search strategies…"
              searchKey="strategyName"
              emptyMessage="No results"
              rowKey={(r) => r.strategyId}
            />
          </div>
        </>
      )}
    </div>
  );
}
