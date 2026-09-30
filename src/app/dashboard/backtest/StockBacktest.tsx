"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Scatter,
} from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import { downloadCSV } from "@/lib/export";
import { loadMegaPrefs, megaWeightsLabel, activeMegaWeights, type MegaPrefs } from "@/lib/mega-prefs";
import type { BacktestOutput } from "@/lib/backtest-engine";
import StrategyCompare from "./StrategyCompare";
import ParamOptimizer from "./ParamOptimizer";
import WalkForward from "./WalkForward";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const fmt2 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const num = (n: number) => new Intl.NumberFormat("en-US").format(n);

interface CatalogParam { key: string; label: string; default: number; min?: number; max?: number; step?: number; }
interface CatalogStrategy { id: string; name: string; description: string; params: CatalogParam[]; minBars: number; defaults: Record<string, number>; }

const PRESETS = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "SPY", "QQQ", "JPM", "KO", "XOM"];
const YEAR_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 25, 30];

type Mode = "single" | "compare" | "optimize" | "walk";
const MODES: { key: Mode; label: string }[] = [
  { key: "single", label: "🔍 Single Backtest" },
  { key: "compare", label: "⚔ Compare All" },
  { key: "optimize", label: "🧭 Optimize Params" },
  { key: "walk", label: "🚶 Walk Forward" },
];

// Keep recharts responsive on long histories (~2500 bars)
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out.length === 0 || out[out.length - 1] !== last) out.push(last);
  return out;
}

export default function StockBacktest() {
  const [catalog, setCatalog] = useState<CatalogStrategy[]>([]);
  const [ticker, setTicker] = useState("AAPL");
  const [strategyId, setStrategyId] = useState("sma_cross");
  const [years, setYears] = useState(10);
  const [capital, setCapital] = useState(100000);
  const [commissionBps, setCommissionBps] = useState(2);
  const [slippageBps, setSlippageBps] = useState(2);
  const [positionPct, setPositionPct] = useState(100);
  const [params, setParams] = useState<Record<string, number>>({});
  const [stopLossPct, setStopLossPct] = useState(0);
  const [takeProfitPct, setTakeProfitPct] = useState(0);
  const [benchmarkSymbol, setBenchmarkSymbol] = useState("");
  const [useMegaPrefs, setUseMegaPrefs] = useState(false);
  const [megaPrefs, setMegaPrefs] = useState<MegaPrefs>({ weights: null, preset: null, ticker: null, hasCustomWeights: false });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestOutput | null>(null);
  const [mode, setMode] = useState<Mode>("single");

  useEffect(() => {
    fetch("/api/backtest?type=catalog")
      .then(r => r.json())
      .then((items: CatalogStrategy[]) => {
        setCatalog(items);
        const def = items.find(s => s.id === "sma_cross") || items[0];
        if (def) {
          setStrategyId(def.id);
          setParams(def.defaults);
        }
      })
      .catch(() => setError("Failed to load strategy catalog"));
  }, []);

  // Saved Mega Indicator weights/preset (localStorage) — reusable by the
  // Mega Score strategy. Re-read on every tab focus so recent tweaks on the
  // Mega Indicator page are picked up without a reload.
  useEffect(() => {
    const sync = () => setMegaPrefs(loadMegaPrefs());
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const selected = catalog.find(s => s.id === strategyId);

  const changeStrategy = (id: string) => {
    setStrategyId(id);
    const def = catalog.find(s => s.id === id);
    if (def) setParams(def.defaults);
  };

  const run = useCallback(async (overrides?: { strategyId?: string; params?: Record<string, number> }) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "runStockBacktest",
          symbol: ticker,
          strategyId: overrides?.strategyId ?? strategyId,
          initialCapital: capital,
          years,
          commissionBps,
          slippageBps,
          positionPct,
          stopLossPct,
          takeProfitPct,
          benchmarkSymbol,
          megaWeights: activeMegaWeights(useMegaPrefs, megaPrefs) ?? undefined,
          params: overrides?.params ?? params,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backtest failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backtest failed");
    } finally {
      setRunning(false);
    }
  }, [ticker, strategyId, capital, years, commissionBps, slippageBps, positionPct, params, stopLossPct, takeProfitPct, benchmarkSymbol, useMegaPrefs, megaPrefs]);

  const handleApplyFromOptimizer = useCallback((sid: string, p: Record<string, number>) => {
    setMode("single");
    changeStrategy(sid);
    setParams(p);
    run({ strategyId: sid, params: p });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, ticker, capital, years, commissionBps, slippageBps, positionPct]);

  const equityData = useMemo(
    () => result
      ? downsample(result.equityCurve, 600).map(p => ({
          date: p.date,
          equity: Math.round(p.equity),
          benchmark: Math.round(p.benchmark),
          dd: -p.drawdownPct,
        }))
      : [],
    [result]
  );
  // Build a Set of dates that have trade entries/exits for chart markers
  const tradeMarkerDates = useMemo(() => {
    if (!result) return new Set<string>();
    const s = new Set<string>();
    for (const t of result.trades) {
      s.add(t.entryDate);
      if (t.exitDate) s.add(t.exitDate);
    }
    return s;
  }, [result]);

  const priceDataWithMarkers = useMemo(() => {
    if (!result) return [];
    return downsample(result.priceSeries, 600).map(p => ({
      ...p,
      entryMarker: tradeMarkerDates.has(p.date) ? p.close : undefined,
    }));
  }, [result, tradeMarkerDates]);
  const hasMega = !!result?.priceSeries.some(p => p.mega != null);
  const monthlyData = useMemo(
    () => (result ? result.monthlyReturns.map(m => ({ month: m.month, ret: Math.round(m.ret * 10) / 10 })) : []),
    [result]
  );

  const tradeColumns: Column<BacktestOutput["trades"][number]>[] = [
    { key: "id", header: "#", render: r => r.id },
    { key: "entryDate", header: "Entry" },
    {
      key: "exitDate", header: "Exit", render: r => r.exitDate
        ? r.exitDate
        : <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">OPEN</span>,
    },
    { key: "bars", header: "Days", align: "right" },
    { key: "shares", header: "Shares", align: "right", render: r => num(r.shares) },
    { key: "entryPrice", header: "Entry $", align: "right", render: r => fmt2(r.entryPrice) },
    { key: "exitPrice", header: "Exit $", align: "right", render: r => (r.exitPrice == null ? "—" : fmt2(r.exitPrice)) },
    {
      key: "returnPct", header: "Return", align: "right",
      render: r => <span className={r.returnPct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(r.returnPct, 2)}</span>,
    },
    {
      key: "pnl", header: "P&L", align: "right",
      render: r => <span className={r.pnl >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{fmt2(r.pnl)}</span>,
    },
    {
      key: "reason", header: "Exit", align: "left",
      render: r => {
        const style = r.reason === "stop-loss"
          ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          : r.reason === "take-profit"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          : r.reason === "end-of-test"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          : "bg-[var(--card-hover)] text-[var(--muted)]";
        const label = r.reason === "stop-loss" ? "STOP" : r.reason === "take-profit" ? "TARGET" : r.reason === "end-of-test" ? "EOT" : "SIGNAL";
        return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${style}`}>{label}</span>;
      },
    },
  ];

  const card = (label: string, value: string, tone: "good" | "bad" | "neutral" = "neutral", sub?: string) => (
    <div className="p-3 rounded-lg" style={{ background: "var(--input-bg)" }}>
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className={`text-base font-bold ${tone === "good" ? "text-[var(--success)]" : tone === "bad" ? "text-[var(--danger)]" : ""}`}>{value}</p>
      {sub && <p className="text-[10px] text-[var(--muted)] mt-0.5">{sub}</p>}
    </div>
  );

  const tooltipStyle = { background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 };
  const s = result?.summary;

  return (
    <div className="space-y-6">

      {/* ── Mode switcher ─────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {MODES.map(m => (
          <button key={m.key} onClick={() => setMode(m.key)}
            className={`px-4 py-2 text-sm font-medium rounded-xl border transition-all ${
              mode === m.key
                ? "bg-indigo-600/15 text-indigo-600 dark:text-indigo-400 border-indigo-500"
                : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
            }`}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "compare" && <StrategyCompare />}
      {mode === "optimize" && <ParamOptimizer onApply={handleApplyFromOptimizer} />}
      {mode === "walk" && <WalkForward onApply={handleApplyFromOptimizer} />}

      {/* ── Control panel ─────────────────────────────────── */}
      <div className={`glass rounded-xl p-5 ${mode !== "single" ? "hidden" : ""}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Ticker (any publicly traded symbol)</label>
            <input
              type="text" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") run(); }}
              placeholder="AAPL"
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
            <select value={strategyId} onChange={(e) => changeStrategy(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
              {catalog.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1 mt-3">History</label>
              <div className="flex flex-wrap gap-1">
                {YEAR_OPTIONS.map(y => (
                  <button key={y} onClick={() => setYears(y)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${years === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                    {y}Y
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Initial capital ($)</label>
              <input type="number" value={capital} min={1000} step={1000} onChange={(e) => setCapital(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Position size (% of equity)</label>
              <input type="number" value={positionPct} min={1} max={100} onChange={(e) => setPositionPct(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Commission (bps per side)</label>
              <input type="number" value={commissionBps} min={0} max={100} onChange={(e) => setCommissionBps(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">Slippage (bps per side)</label>
              <input type="number" value={slippageBps} min={0} max={200} onChange={(e) => setSlippageBps(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">
                Stop-loss % <span className="opacity-60">(0 = off)</span>
              </label>
              <input type="number" value={stopLossPct} min={0} max={90} onChange={(e) => setStopLossPct(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">
                Take-profit % <span className="opacity-60">(0 = off)</span>
              </label>
              <input type="number" value={takeProfitPct} min={0} max={500} onChange={(e) => setTakeProfitPct(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">
                Benchmark <span className="opacity-60">(blank = same ticker)</span>
              </label>
              <input
                type="text" value={benchmarkSymbol} onChange={(e) => setBenchmarkSymbol(e.target.value.toUpperCase())}
                placeholder="e.g. SPY"
                maxLength={12}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm font-mono uppercase tracking-wider focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Mega Indicator weights bridge (only relevant to the Mega Score strategy) */}
        {strategyId === "mega_score" && (
          <div className="mt-3 p-3 rounded-lg flex flex-wrap items-center gap-x-4 gap-y-2" style={{ background: "var(--input-bg)" }}>
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input type="checkbox" checked={useMegaPrefs} onChange={(e) => setUseMegaPrefs(e.target.checked)} className="accent-indigo-500" />
              <span>Use my saved Mega Indicator weights</span>
            </label>
            <span className="text-xs text-[var(--muted)]">{megaWeightsLabel(megaPrefs)}</span>
            {!megaPrefs.weights && (
              <span className="text-xs text-[var(--muted)]">— nothing saved yet; tune the sliders on the Mega Indicator page first</span>
            )}
            {useMegaPrefs && megaPrefs.hasCustomWeights && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400">
                strategy + chart overlay will use them
              </span>
            )}
          </div>
        )}

        {/* Strategy description + params */}
        {selected && (
          <div className="mt-4 p-3 rounded-lg" style={{ background: "var(--input-bg)" }}>
            <p className="text-xs text-[var(--muted)] leading-relaxed">{selected.description}</p>
            {selected.params.length > 0 && (
              <div className="flex flex-wrap items-end gap-4 mt-3">
                {selected.params.map(p => (
                  <div key={p.key}>
                    <label className="block text-[10px] text-[var(--muted)] mb-1">{p.label}</label>
                    <input
                      type="number" value={params[p.key] ?? p.default} min={p.min} max={p.max} step={p.step ?? 1}
                      onChange={(e) => setParams(prev => ({ ...prev, [p.key]: Number(e.target.value) }))}
                      className="w-24 px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
                  </div>
                ))}
                <button onClick={() => setParams(selected.defaults)}
                  className="px-2 py-1.5 text-[10px] rounded border border-[var(--input-border)] text-[var(--muted)] hover:text-[var(--foreground)]">
                  Reset defaults
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => run()} disabled={running || !ticker || !strategyId}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
            {running ? "Running backtest…" : "▶ Run Backtest"}
          </button>
          {result && !running && (
            <span className="text-xs text-[var(--muted)]">
              {result.symbol} · {result.meta.name} · {result.bars} trading days ({result.dateFrom} → {result.dateTo})
              · data: {result.dataSource === "cache" ? "cached" : "Yahoo Finance"}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* ── Results ───────────────────────────────────────── */}
      {result && s && (
        <>
          {result.warnings.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs">
              {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}

          {/* Metric cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {card("Final Equity", fmt(s.finalEquity), s.finalEquity >= result.config.initialCapital ? "good" : "bad")}
            {card("Total Return", pct(s.totalReturnPct), s.totalReturnPct >= 0 ? "good" : "bad", `B&H: ${pct(s.benchmarkReturnPct)}`)}
            {card("CAGR", pct(s.cagr), s.cagr >= 0 ? "good" : "bad")}
            {card("Sharpe Ratio", s.sharpe.toFixed(2), s.sharpe >= 1 ? "good" : s.sharpe >= 0.5 ? "neutral" : "bad")}
            {card("Sortino Ratio", s.sortino.toFixed(2), s.sortino >= 1 ? "good" : "neutral")}
            {card("Max Drawdown", pct(-s.maxDrawdownPct), "bad", `B&H: ${pct(-s.benchmarkMaxDrawdownPct)}`)}
            {card("Win Rate", pct(s.winRate), "neutral", `${s.totalTrades} closed trades`)}
            {card("Profit Factor", s.profitFactor >= 99 ? "∞" : s.profitFactor.toFixed(2), s.profitFactor >= 1.5 ? "good" : s.profitFactor >= 1 ? "neutral" : "bad")}
            {card("Avg Trade", pct(s.avgTradeReturnPct, 2), s.avgTradeReturnPct >= 0 ? "good" : "bad", `best ${pct(s.bestTradePct, 1)} / worst ${pct(s.worstTradePct, 1)}`)}
            {card("Avg Hold", `${s.avgBarsHeld.toFixed(0)} days`, "neutral")}
            {card("Calmar Ratio", s.calmar.toFixed(2), s.calmar >= 1 ? "good" : s.calmar >= 0.5 ? "neutral" : "bad", "CAGR / Max DD")}
            {card("Time in Market", pct(s.timeInMarketPct), "neutral", "rest earns 0% cash")}
            {card("Trades / Year", (s.totalTrades / Math.max(result.equityCurve.length / 252, 0.1)).toFixed(1), "neutral")}
            {card("Expectancy", pct(s.expectancyPct, 2), s.expectancyPct >= 0 ? "good" : "bad", "avg return per trade")}
            {card("Payoff Ratio", s.payoffRatio >= 99 ? "∞" : s.payoffRatio.toFixed(2), s.payoffRatio >= 1.5 ? "good" : s.payoffRatio >= 1 ? "neutral" : "bad", "avg win / avg loss")}
            {card("Max Loss Streak", String(s.maxConsecutiveLosses), s.maxConsecutiveLosses <= 3 ? "neutral" : "bad", `${s.maxConsecutiveWins} best win streak`)}
            {card("Recovery Factor", s.recoveryFactor >= 99 ? "∞" : s.recoveryFactor.toFixed(2), s.recoveryFactor >= 2 ? "good" : s.recoveryFactor >= 1 ? "neutral" : "bad", "return / max DD")}
          </div>

          {/* Equity curve vs benchmark */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Equity Curve{result.config.benchmarkSymbol ? ` vs ${result.config.benchmarkSymbol} (benchmark)` : " vs Buy & Hold"}</h3>
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> Strategy</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-gray-400 inline-block" /> {result.config.benchmarkSymbol || "Buy & Hold"}</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={equityData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 10 }} minTickGap={60} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 10 }} tickFormatter={compact} domain={["auto", "auto"]} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, name: unknown) => [fmt(Number(v)), name === "equity" ? "Strategy" : "Buy & Hold"]} labelFormatter={l => `Date: ${l}`} />
                <Line type="monotone" dataKey="equity" stroke="#6366f1" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="benchmark" stroke="#9ca3af" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Price chart with SMAs, Mega Score overlay + trade markers */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">{result.symbol} Price (adjusted, with 50/200-day SMA)</h3>
              <div className="flex items-center gap-4 text-[10px] text-[var(--muted)]">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" /> Close</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-amber-500 inline-block" /> SMA 50</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-green-500 inline-block" /> SMA 200</span>
                {hasMega && <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-fuchsia-500 inline-block" /> Mega Score (0-100)</span>}
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Trade marker</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={priceDataWithMarkers}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 10 }} minTickGap={60} />
                <YAxis yAxisId="price" stroke="var(--muted)" tick={{ fontSize: 10 }} domain={["auto", "auto"]} tickFormatter={(v) => `$${v}`} />
                {hasMega && (
                  <YAxis yAxisId="mega" orientation="right" domain={[0, 100]} stroke="#d946ef" tick={{ fontSize: 9 }}
                    tickFormatter={(v: number) => `${v}`} width={34} />
                )}
                <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, name: unknown) => [name === "entryMarker" ? "Trade" : name === "mega" ? Number(v).toFixed(1) : fmt2(Number(v)), name === "entryMarker" ? "Trade Marker" : name === "mega" ? "Mega Score" : String(name)]} labelFormatter={(l) => `Date: ${l}`} />
                <Line yAxisId="price" type="monotone" dataKey="close" stroke="#6366f1" strokeWidth={1.5} dot={false} name="Close" />
                <Line yAxisId="price" type="monotone" dataKey="ma1" stroke="#f59e0b" strokeWidth={1} dot={false} name="SMA 50" connectNulls />
                <Line yAxisId="price" type="monotone" dataKey="ma2" stroke="#22c55e" strokeWidth={1} dot={false} name="SMA 200" connectNulls />
                {hasMega && (
                  <Line yAxisId="mega" type="monotone" dataKey="mega" stroke="#d946ef" strokeWidth={1.5} dot={false} name="Mega Score" connectNulls strokeDasharray="2 2" />
                )}
                <Scatter yAxisId="price" dataKey="entryMarker" fill="#34d399" shape="triangle" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            {hasMega && (
              <p className="text-[10px] text-[var(--muted)] mt-2">
                {result.megaScoreDescription}
                {result.config.megaWeights && strategyId === "mega_score" && useMegaPrefs ? " · matching your Mega Indicator weights" : ""}
              </p>
            )}
          </div>

          {/* Drawdown */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-3">Drawdown (from running peak)</h3>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={equityData}>
                <defs>
                  <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 10 }} minTickGap={60} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => pct(Number(v))} labelFormatter={(l: unknown) => `Date: ${l}`} />
                <Area type="monotone" dataKey="dd" stroke="#ef4444" fill="url(#ddGrad)" strokeWidth={1} />
                <ReferenceLine y={0} stroke="var(--grid-stroke)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Monthly returns */}
          {monthlyData.length > 1 && (
            <div className="glass rounded-xl p-5">
              <h3 className="text-sm font-semibold mb-3">Monthly Returns (%)</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                  <XAxis dataKey="month" stroke="var(--muted)" tick={{ fontSize: 9 }} minTickGap={24} />
                  <YAxis stroke="var(--muted)" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => pct(Number(v))} labelFormatter={(l: unknown) => `Month: ${l}`} />
                  <ReferenceLine y={0} stroke="var(--muted)" />
                  <Bar dataKey="ret" radius={[2, 2, 0, 0]}>
                    {monthlyData.map((m, i) => (
                      <Cell key={i} fill={m.ret >= 0 ? "#22c55e" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Trades */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Trade Log ({result.trades.length} trades)</h3>
              <button onClick={() => {
                downloadCSV(
                  `backtest-${result.symbol}-${result.strategyId}.csv`,
                  ["#", "Entry Date", "Exit Date", "Days", "Shares", "Entry $", "Exit $", "Return %", "P&L", "Exit Reason"],
                  result.trades.map(t => [t.id, t.entryDate, t.exitDate || "OPEN", t.bars, t.shares, t.entryPrice, t.exitPrice || "", t.returnPct, t.pnl, t.reason]),
                );
              }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)] transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Export CSV
              </button>
            </div>
            <SortableTable
              columns={tradeColumns}
              data={result.trades}
              searchPlaceholder="Search trades…"
              searchKey="entryDate"
              emptyMessage="No trades were generated"
              rowKey={(r) => r.id}
            />
          </div>
        </>
      )}
    </div>
  );
}
