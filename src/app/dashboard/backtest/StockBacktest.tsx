"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Scatter,
} from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import { PanelBoard, ChartPanel } from "@/components/PanelBoard";
import { BAR_INTERVALS, cadenceLabel, type BarInterval, type BarUnit } from "@/lib/bar-resample";
import DetailDrawer, { toneOf } from "@/components/DetailDrawer";
import { downloadCSV } from "@/lib/export";
import { loadMegaPrefs, megaWeightsLabel, activeMegaWeights, activeMegaOverrides, saveMegaWeights, type MegaPrefs } from "@/lib/mega-prefs";
import { MEGA_BASELINE, explainBaseline, isMegaBaseline, type WeightMap } from "@/lib/mega-indicator";
import type { BacktestOutput } from "@/lib/backtest-engine";
import type { IndicatorReading, MegaScoreSnapshot } from "@/lib/mega-score";
import StrategyCompare from "./StrategyCompare";
import ParamOptimizer from "./ParamOptimizer";
import WalkForward from "./WalkForward";
import TrainingLab from "./TrainingLab";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const fmt2 = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const num = (n: number) => new Intl.NumberFormat("en-US").format(n);

interface CatalogParam { key: string; label: string; default: number; min?: number; max?: number; step?: number; }
interface CatalogStrategy { id: string; name: string; description: string; params: CatalogParam[]; minBars: number; defaults: Record<string, number>; }

const PRESETS = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "SPY", "QQQ", "JPM", "KO", "XOM"];
const YEAR_OPTIONS = [1 / 12, 0.5, 1, 2, 3, 5, 10, 15, 20, 25, 30];
// Sub-year windows render as months (1M / 6M), otherwise as years (2Y, 5Y…)
const yearLabel = (y: number) => (y < 1 ? (Math.round(y * 12) === 1 ? "1M" : "6M") : `${y}Y`);

/**
 * Identity of the trade whose per-indicator breakdown is on screen. Used as the
 * key of the snapshot state so a stale response for a previously opened trade
 * can never be rendered, without an effect having to clear state on close.
 */
const tradeKeyOf = (t: { id: number; entryDate: string; exitDate: string | null }) =>
  `${t.id}|${t.entryDate}|${t.exitDate ?? "open"}`;

/** How long one bar is — the run's history line says so instead of assuming days. */
const barCadence = (r: { bars: number; summary: { barMinutes: number; barUnit: BarUnit } }) =>
  cadenceLabel({ barMinutes: r.summary.barMinutes, periodsPerYear: 0, barUnit: r.summary.barUnit }, r.bars);

/** Average hold, in the units the run actually traded in. */
const holdLabel = (s: { avgBarsHeld: number; barUnit: BarUnit; barMinutes: number }) => {
  const unit = s.barUnit === "day" ? "days" : s.barUnit === "week" ? "weeks" : s.barUnit === "month" ? "months" : "bars";
  const detail = s.barUnit === "minute" ? ` (≈${(s.avgBarsHeld * s.barMinutes).toFixed(0)} min)` : "";
  return `${s.avgBarsHeld.toFixed(s.barUnit === "minute" ? 0 : 1)} ${unit}${detail} held`;
};

/** One line per frequency, shown under the chooser and on hover. */
const BAR_INTERVAL_HINTS: Record<BarInterval, string> = {
  daily: "the default: one decision per session, Sharpe annualized on 252 periods",
  weekly: "the daily series resampled to weekly bars — fewer, longer holds, 52 periods a year",
  monthly: "monthly bars — the slowest, cheapest way to trade the same signal, 12 periods a year",
};

type Mode = "single" | "compare" | "optimize" | "walk" | "train";
const MODES: { key: Mode; label: string }[] = [
  { key: "single", label: "🔍 Single Backtest" },
  { key: "compare", label: "⚔ Compare All" },
  { key: "optimize", label: "🧭 Optimize Params" },
  { key: "walk", label: "🚶 Walk Forward" },
  { key: "train", label: "🎓 Train Weights" },
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
  /** How often the rule is allowed to act. The daily series is resampled first. */
  const [barInterval, setBarInterval] = useState<BarInterval>("daily");
  const [capital, setCapital] = useState(100000);
  const [commissionBps, setCommissionBps] = useState(2);
  const [slippageBps, setSlippageBps] = useState(2);
  const [positionPct, setPositionPct] = useState(100);
  const [params, setParams] = useState<Record<string, number>>({});
  const [stopLossPct, setStopLossPct] = useState(0);
  const [takeProfitPct, setTakeProfitPct] = useState(0);
  const [maxTrades, setMaxTrades] = useState(0);
  const [minTrades, setMinTrades] = useState(0);
  const [benchmarkSymbol, setBenchmarkSymbol] = useState("");
  const [useMegaPrefs, setUseMegaPrefs] = useState(false);
  const [megaPrefs, setMegaPrefs] = useState<MegaPrefs>({ weights: null, preset: null, ticker: null, hasCustomWeights: false });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestOutput | null>(null);
  // Trade opened from the Trade Log — its drawer shows the exact dates and the
  // Mega Score on the entry/exit day.
  const [tradeDetail, setTradeDetail] = useState<BacktestOutput["trades"][number] | null>(null);
  // Per-indicator breakdown of the bars a trade was decided on. Fetched on
  // demand (the run itself only carries the composite), so opening the trade
  // log row shows every indicator without bloating every backtest response.
  // Keyed by trade, so closing the drawer or opening another trade invalidates
  // the loaded data without any state reset.
  const [snapshotResult, setSnapshotResult] = useState<{
    key: string;
    snapshots: Partial<Record<"entry" | "exit", MegaScoreSnapshot>>;
    error: string | null;
  } | null>(null);
  /** Which bar the user is looking at, remembered per trade. */
  const [sideChoice, setSideChoice] = useState<{ key: string; side: "entry" | "exit" } | null>(null);
  // Right-clicked Trade Log row: the menu jumps straight to the indicators on
  // either bar of that trade, instead of opening the drawer on the entry side
  // and switching tabs by hand.
  const [logMenu, setLogMenu] = useState<{
    trade: BacktestOutput["trades"][number]; x: number; y: number;
  } | null>(null);

  /** Open the trade drawer focused on one bar's full indicator breakdown. */
  const inspectTradeBar = (trade: BacktestOutput["trades"][number], side: "entry" | "exit") => {
    setTradeDetail(trade);
    setSideChoice({ key: tradeKeyOf(trade), side });
    setLogMenu(null);
  };

  const snapshotKey = tradeDetail ? tradeKeyOf(tradeDetail) : null;
  /** The signal dates to fetch for the open trade (pure — derived, not stored). */
  const snapshotWanted = useMemo<Partial<Record<"entry" | "exit", string>>>(() => {
    if (!tradeDetail) return {};
    const wanted: Partial<Record<"entry" | "exit", string>> = {
      entry: tradeDetail.entrySignalDate ?? tradeDetail.entryDate,
    };
    const exitDate = tradeDetail.exitSignalDate ?? tradeDetail.exitDate;
    if (exitDate) wanted.exit = exitDate;
    return wanted;
  }, [tradeDetail]);
  const snapshotSide = sideChoice && sideChoice.key === snapshotKey ? sideChoice.side : "entry";
  const snapshotsAreCurrent = snapshotKey !== null && snapshotResult?.key === snapshotKey;
  const snapshotLoading = snapshotKey !== null && !snapshotsAreCurrent;
  const snapshotError = snapshotsAreCurrent ? snapshotResult?.error ?? null : null;
  const [showZeroWeight, setShowZeroWeight] = useState(false);
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

  // Trade opened from the log → pull the per-indicator breakdown of the bars it
  // was decided on (same weights the run traded). Recomputed server-side on
  // demand so a normal response never ships ~150 series.
  //
  // Which dates belong to the open trade, which side the tab is on, and whether
  // the load is still pending are all DERIVED below — the effect only fetches and
  // writes the response in its callbacks. Clearing/resetting state up front would
  // cascade renders on every drawer open (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!tradeDetail || !result) return;
    const dates = Object.values(snapshotWanted).filter(Boolean) as string[];
    if (dates.length === 0) return;
    const key = tradeKeyOf(tradeDetail);
    let alive = true;
    fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "indicatorSnapshot",
        symbol: result.symbol,
        years: result.config.years,
        dates,
        megaWeights: result.config.megaWeights,
        megaOverrides: result.config.megaOverrides,
      }),
    })
      .then((r) => r.json())
      .then((data: { error?: string; snapshots?: MegaScoreSnapshot[] }) => {
        if (!alive) return;
        if (data.error) throw new Error(data.error);
        const byDate = new Map((data.snapshots ?? []).map((s) => [s.date, s]));
        const next: Partial<Record<"entry" | "exit", MegaScoreSnapshot>> = {};
        for (const side of ["entry", "exit"] as const) {
          const d = snapshotWanted[side];
          const snap = d ? byDate.get(d) : undefined;
          if (snap) next[side] = snap;
        }
        setSnapshotResult({ key, snapshots: next, error: null });
      })
      .catch((err) => {
        if (!alive) return;
        setSnapshotResult({
          key,
          snapshots: {},
          error: err instanceof Error ? err.message : "Could not load the indicator breakdown",
        });
      });
    return () => { alive = false; };
  }, [tradeDetail, result, snapshotWanted]);

  const selected = catalog.find(s => s.id === strategyId);
  // Mega Score's buy/sell thresholds have their own "base score" panel below,
  // so keep them out of the generic strategy-parameters row.
  const visibleParams = selected
    ? selected.params.filter(
        (p) => !(selected.id === "mega_score" && (p.key === "entry" || p.key === "exit"))
      )
    : [];
  const changeStrategy = (id: string) => {
    setStrategyId(id);
    const def = catalog.find(s => s.id === id);
    if (def) setParams(def.defaults);
  };

  // ── Mega Score baseline bands (the strategy's whole buy/sell rule) ──
  const entryScore = Number.isFinite(params.entry) ? params.entry : MEGA_BASELINE.entry;
  const exitScore = Number.isFinite(params.exit) ? params.exit : MEGA_BASELINE.exit;
  const baseline = explainBaseline(entryScore, exitScore);
  const onBaseline = isMegaBaseline(entryScore, exitScore);
  const bandInvalid = strategyId === "mega_score" && baseline.error !== null;
  const setBand = (key: "entry" | "exit", raw: number) => {
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
    setParams(prev => ({ ...prev, [key]: v }));
  };

  const run = useCallback(async (overrides?: { strategyId?: string; params?: Record<string, number>; megaWeights?: WeightMap }) => {
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
          maxTrades,
          minTrades,
          benchmarkSymbol,
          barInterval,
          megaWeights: overrides?.megaWeights ?? activeMegaWeights(useMegaPrefs, megaPrefs) ?? undefined,
          // Read at run time, like the weights, so an edit made on the Mega
          // Indicator page applies to the next run — the backtest then scores
          // the same indicators the UI shows.
          megaOverrides: activeMegaOverrides() ?? undefined,
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
  }, [ticker, strategyId, capital, years, commissionBps, slippageBps, positionPct, params, stopLossPct, takeProfitPct, maxTrades, minTrades, benchmarkSymbol, useMegaPrefs, megaPrefs, barInterval]);

  /**
   * Adoption path for the Training tab: the trained weights become the app's
   * saved Mega weights (so the Mega Indicator page agrees), the trained bands
   * become the Mega Score strategy's bands, and the run starts immediately with
   * unsmoothed score = the exact series the training measured.
   */
  const handleApplyTrainedWeights = useCallback(
    (weights: WeightMap, entryBand: number, exitBand: number) => {
      saveMegaWeights(weights, "custom");
      setMegaPrefs({ weights, preset: "custom", ticker: megaPrefs.ticker, hasCustomWeights: true });
      setUseMegaPrefs(true);
      setMode("single");
      changeStrategy("mega_score");
      const p = { entry: entryBand, exit: exitBand, smooth: 1 };
      setParams(p);
      run({ strategyId: "mega_score", params: p, megaWeights: weights });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, megaPrefs.ticker]
  );

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
  // Thresholds the LAST run actually used (not the live inputs, which may have
  // been edited since): draw them on the score axis so crossings are visible.
  const megaBands = result && result.strategyId === "mega_score"
    ? {
        entry: Number(result.config.params?.entry ?? MEGA_BASELINE.entry),
        exit: Number(result.config.params?.exit ?? MEGA_BASELINE.exit),
      }
    : null;
  const monthlyData = useMemo(
    () => (result ? result.monthlyReturns.map(m => ({ month: m.month, ret: Math.round(m.ret * 10) / 10 })) : []),
    [result]
  );

  // The breakdown shown in the trade drawer: the bar that was asked for, every
  // indicator that carried weight (or all of them, on request), biggest
  // contributor first.
  const activeSnapshot = snapshotsAreCurrent ? snapshotResult?.snapshots[snapshotSide] ?? null : null;
  const indicatorRows = useMemo(() => {
    if (!activeSnapshot) return [];
    const rank = (v: number | null) => (v == null ? Number.NEGATIVE_INFINITY : v);
    return activeSnapshot.readings
      .filter((r) => showZeroWeight || r.weight > 0)
      .sort((a, b) => rank(b.contribution) - rank(a.contribution));
  }, [activeSnapshot, showZeroWeight]);
  const fmtUnit = (unit: string) => (unit === "%" ? "%" : unit === "x" ? "×" : unit ? ` ${unit}` : "");
  const readingText = (r: IndicatorReading) => {
    if (r.raw == null) return "—";
    const abs = Math.abs(r.raw);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    return `${r.raw.toFixed(digits)}${fmtUnit(r.unit)}`;
  };

  // Mega Score at a trade date, coloured by the run's own buy/sell bands.
  const scoreTone = (v: number | null | undefined): "pos" | "neg" | "muted" | undefined => {
    if (v == null) return "muted";
    if (!megaBands) return undefined;
    return v >= megaBands.entry ? "pos" : v <= megaBands.exit ? "neg" : "muted";
  };
  // The signal reading is smoothed on the Mega Score strategy; name the window
  // so the number in the log is traceable to the rule that used it.
  const signalSmoothDays = result?.strategyId === "mega_score"
    ? Math.max(1, Math.round(Number(result.config.params?.smooth ?? 5)))
    : 1;
  const signalWindow = signalSmoothDays > 1 ? `SMA-${signalSmoothDays}` : "raw";
  const scoreText = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1));
  const scoreCell = (v: number | null | undefined) => {
    const tone = scoreTone(v);
    const cls = tone === "pos" ? "text-[var(--success)]" : tone === "neg" ? "text-[var(--danger)]" : "text-[var(--muted)]";
    return <span className={`tabular-nums ${v == null ? "" : cls}`}>{scoreText(v)}</span>;
  };
  // "Monday, 3 Jan 2022" — the exact session a fill happened on.
  const longDate = (d: string | null | undefined) => {
    if (!d) return "—";
    const dt = new Date(`${d}T00:00:00`);
    return Number.isNaN(dt.getTime())
      ? d
      : dt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
  };

  const tradeColumns: Column<BacktestOutput["trades"][number]>[] = [
    { key: "id", header: "#", render: r => r.id },
    {
      key: "entryDate", header: "Entry",
      // Clicking the log row (or this date) opens the trade detail.
      render: r => (
        <span className="underline decoration-dotted underline-offset-2 decoration-[var(--muted)]">
          {r.entryDate}
        </span>
      ),
    },
    {
      key: "exitDate", header: "Exit", render: r => r.exitDate
        ? r.exitDate
        : <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">OPEN</span>,
    },
    { key: "bars", header: "Days", align: "right" },
    {
      key: "entryScore", header: "Score in (signal)", align: "right",
      render: r => (
        <span className="whitespace-nowrap">
          {scoreCell(r.entryScore)}
          {r.reentry && <span title="Re-opened after a stop/target while the regime stayed long" className="ml-0.5 text-[10px] text-[var(--muted)]">↻</span>}
        </span>
      ),
    },
    { key: "exitScore", header: "Score out (signal)", align: "right", render: r => scoreCell(r.exitScore) },
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
          : r.reason === "trailing-stop"
          ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
          : r.reason === "take-profit"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          : r.reason === "session-close"
          ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
          : r.reason === "end-of-test"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          : "bg-[var(--card-hover)] text-[var(--muted)]";
        const label = r.reason === "stop-loss" ? "STOP" : r.reason === "trailing-stop" ? "TRAIL" : r.reason === "session-close" ? "EOD" : r.reason === "take-profit" ? "TARGET" : r.reason === "end-of-test" ? "EOT" : "SIGNAL";
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
      {mode === "train" && <TrainingLab onApply={handleApplyTrainedWeights} />}

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
                    {yearLabel(y)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1 mt-3">
                Trading frequency{" "}
                <span className="text-[10px]">
                  — how often the rule may act; {""}
                  {BAR_INTERVAL_HINTS[barInterval]}
                </span>
              </label>
              <div className="flex flex-wrap gap-1">
                {BAR_INTERVALS.map(iv => (
                  <button key={iv} onClick={() => setBarInterval(iv)}
                    title={BAR_INTERVAL_HINTS[iv]}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${barInterval === iv ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                    {iv.toUpperCase()}
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
                Max trades <span className="opacity-60">(0 = no limit)</span>
              </label>
              <input type="number" value={maxTrades} min={0} max={10000} onChange={(e) => setMaxTrades(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                title="No new position is opened after this many trades; an open trade still exits on its own signal/stop/target."
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1">
                Min trades <span className="opacity-60">(0 = no minimum)</span>
              </label>
              <input type="number" value={minTrades} min={0} max={10000} onChange={(e) => setMinTrades(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                title="Quality floor: the run is flagged when it closes fewer trades than this, and the optimizer / walk-forward keep anything below it out of the best picks."
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              {minTrades > 0 && maxTrades > 0 && minTrades > maxTrades && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                  Higher than the max-trades cap ({maxTrades}) — this floor can never be met.
                </p>
              )}
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

        {/* ── Mega Score baseline: the buy/sell rule, in one clear place ── */}
        {strategyId === "mega_score" && (
          <div className="mt-4 p-4 rounded-xl border border-indigo-500/40" style={{ background: "var(--input-bg)" }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">🎯 Mega Score baseline — when to buy, when to sell</h3>
              <span className={`text-[11px] ${onBaseline ? "text-[var(--muted)]" : "text-indigo-600 dark:text-indigo-400 font-medium"}`}>
                {onBaseline
                  ? `Baseline (${MEGA_BASELINE.entry} / ${MEGA_BASELINE.exit}) — unchanged`
                  : `Custom bands — baseline is ${MEGA_BASELINE.entry} / ${MEGA_BASELINE.exit}`}
              </span>
            </div>
            <p className="text-[11px] text-[var(--muted)] mt-1">
              The composite Mega Score runs 0–100. These two numbers are the entire buy/sell rule for the Mega Score
              Regime strategy: the entry score starts a position, the exit score ends it.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <div>
                <label htmlFor="mega-entry-score" className="block text-xs font-medium mb-1">
                  Entry score <span className="text-[var(--muted)] font-normal">— buy at or above</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="mega-entry-score"
                    type="number" min={1} max={99} step={1}
                    value={entryScore}
                    onChange={(e) => setBand("entry", Number(e.target.value))}
                    className="w-24 px-2 py-1.5 bg-[var(--card)] border border-[var(--input-border)] rounded text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
                  <span className="text-[10px] text-[var(--muted)]">baseline {MEGA_BASELINE.entry}</span>
                </div>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed mt-1.5">{baseline.entry}</p>
              </div>
              <div>
                <label htmlFor="mega-exit-score" className="block text-xs font-medium mb-1">
                  Exit score <span className="text-[var(--muted)] font-normal">— sell strictly below</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="mega-exit-score"
                    type="number" min={1} max={99} step={1}
                    value={exitScore}
                    onChange={(e) => setBand("exit", Number(e.target.value))}
                    className="w-24 px-2 py-1.5 bg-[var(--card)] border border-[var(--input-border)] rounded text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
                  <span className="text-[10px] text-[var(--muted)]">baseline {MEGA_BASELINE.exit}</span>
                </div>
                <p className="text-[11px] text-[var(--muted)] leading-relaxed mt-1.5">{baseline.exit}</p>
              </div>
            </div>

            {/* The bands on the 0–100 score scale, so the rule is visible at a glance. */}
            <div className="mt-4">
              <div className="flex h-6 w-full overflow-hidden rounded-md text-[10px] font-semibold">
                <div
                  style={{ width: `${Math.max(0, Math.min(100, exitScore))}%` }}
                  className="flex items-center justify-center whitespace-nowrap bg-rose-500/25 text-rose-700 dark:text-rose-300">
                  {exitScore > 12 ? `SELL < ${exitScore}` : ""}
                </div>
                <div
                  style={{ width: `${Math.max(0, entryScore - exitScore)}%` }}
                  className="flex items-center justify-center whitespace-nowrap bg-amber-400/20 text-amber-700 dark:text-amber-300">
                  {entryScore - exitScore > 14 ? `HOLD ${exitScore}–${entryScore}` : ""}
                </div>
                <div
                  style={{ width: `${Math.max(0, 100 - entryScore)}%` }}
                  className="flex items-center justify-center whitespace-nowrap bg-emerald-500/25 text-emerald-700 dark:text-emerald-300">
                  {100 - entryScore > 12 ? `BUY ≥ ${entryScore}` : ""}
                </div>
              </div>
              <div className="flex justify-between text-[10px] text-[var(--muted)] mt-1">
                <span>score 0</span><span>50</span><span>100</span>
              </div>
            </div>

            <p className="text-[11px] text-[var(--muted)] leading-relaxed mt-3">{baseline.hold}</p>

            {baseline.error && (
              <p className="mt-2 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                ⚠ {baseline.error} The backtest will not run until the bands are fixed.
              </p>
            )}

            <button
              onClick={() => setParams(prev => ({ ...prev, entry: MEGA_BASELINE.entry, exit: MEGA_BASELINE.exit }))}
              disabled={onBaseline}
              className="mt-3 px-2.5 py-1.5 text-[11px] rounded border border-[var(--input-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] disabled:opacity-40 disabled:cursor-not-allowed">
              ↺ Reset to baseline ({MEGA_BASELINE.entry} / {MEGA_BASELINE.exit})
            </button>
          </div>
        )}

        {/* Mega Indicator weights bridge (only relevant to the Mega Score strategy) */}
        {strategyId === "mega_score" && (
          <div className="mt-3 p-3 rounded-lg flex flex-wrap items-center gap-x-4 gap-y-2" style={{ background: "var(--input-bg)" }}>
            <span className="text-[11px] font-semibold">Composite weights</span>
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
            {visibleParams.length > 0 && (
              <div className="flex flex-wrap items-end gap-4 mt-3">
                {visibleParams.map(p => (
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
          <button onClick={() => run()} disabled={running || !ticker || !strategyId || bandInvalid}
            title={bandInvalid ? baseline.error ?? undefined : undefined}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
            {running ? "Running backtest…" : "▶ Run Backtest"}
          </button>
          {result && !running && (
            <span className="text-xs text-[var(--muted)]">
              {result.symbol} · {result.meta.name} · {barCadence(result)} ({result.dateFrom} → {result.dateTo})
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

          {/* Min-trades quality floor, stated as a pass/fail rather than a footnote. */}
          {result.minTrades !== null && (
            <div className={`p-3 rounded-lg border text-xs ${
              result.meetsMinTrades
                ? "bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400"
                : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400"
            }`}>
              {result.meetsMinTrades
                ? `✓ Quality floor met — ${s.totalTrades} closed trade${s.totalTrades === 1 ? "" : "s"} against your minimum of ${result.minTrades}.`
                : `⚠ Below your minimum — this run closed ${s.totalTrades} trade${s.totalTrades === 1 ? "" : "s"}, ${result.minTrades - s.totalTrades} short of ${result.minTrades}. Lower the entry score, raise the exit score or use a longer history for more trades; until then read these ratios as indicative.`}
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
            {card("Closed Trades", String(s.totalTrades), "neutral", `${s.tradesPerYear.toFixed(1)} / year · ${holdLabel(s)}`)}
            {card("Win Rate", pct(s.winRate), "neutral", `${s.totalTrades} closed trades${maxTrades > 0 ? ` · max ${maxTrades}` : ""}${minTrades > 0 ? ` · min ${minTrades}` : ""}`)}
            {card("Profit Factor", s.profitFactor >= 99 ? "∞" : s.profitFactor.toFixed(2), s.profitFactor >= 1.5 ? "good" : s.profitFactor >= 1 ? "neutral" : "bad")}
            {card("Avg Trade", pct(s.avgTradeReturnPct, 2), s.avgTradeReturnPct >= 0 ? "good" : "bad", `best ${pct(s.bestTradePct, 1)} / worst ${pct(s.worstTradePct, 1)}`)}
            {card("Avg Hold", `${s.avgBarsHeld.toFixed(0)} days`, "neutral")}
            {card("Calmar Ratio", s.calmar.toFixed(2), s.calmar >= 1 ? "good" : s.calmar >= 0.5 ? "neutral" : "bad", "CAGR / Max DD")}
            {card("Time in Market", pct(s.timeInMarketPct), "neutral", "rest earns 0% cash")}

            {card("Expectancy", pct(s.expectancyPct, 2), s.expectancyPct >= 0 ? "good" : "bad", "avg return per trade")}
            {card("Payoff Ratio", s.payoffRatio >= 99 ? "∞" : s.payoffRatio.toFixed(2), s.payoffRatio >= 1.5 ? "good" : s.payoffRatio >= 1 ? "neutral" : "bad", "avg win / avg loss")}
            {card("Max Loss Streak", String(s.maxConsecutiveLosses), s.maxConsecutiveLosses <= 3 ? "neutral" : "bad", `${s.maxConsecutiveWins} best win streak`)}
            {card("Recovery Factor", s.recoveryFactor >= 99 ? "∞" : s.recoveryFactor.toFixed(2), s.recoveryFactor >= 2 ? "good" : s.recoveryFactor >= 1 ? "neutral" : "bad", "return / max DD")}
          </div>

          {/* Risk profile — one comparable factor, and the measured pieces behind it */}
          <div className="rounded-xl border border-[var(--card-border)] p-3 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold">Risk profile</p>
              <p className="text-[10px] text-[var(--muted)]">
                Risk factor = 40 % volatility vs buy &amp; hold + 35 % Ulcer index + 25 % max drawdown (0–100, lower = calmer)
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {card("Risk Factor", `${s.risk.riskFactor.toFixed(0)}/100`, s.risk.riskFactor < 45 ? "good" : s.risk.riskFactor < 65 ? "neutral" : "bad", s.risk.riskLevel)}
              {card("Volatility", pct(s.risk.annualVolPct, 1), "neutral", `B&H: ${pct(s.risk.benchmarkVolPct, 1)}`)}
              {card("Beta", s.risk.beta.toFixed(2), "neutral", "vs benchmark")}
              {card("Downside Dev", pct(s.risk.downsideDevPct, 1), "neutral", "loss days only")}
              {card("Ulcer Index", s.risk.ulcerIndex.toFixed(1), "neutral", "RMS drawdown depth")}
            </div>
          </div>

          <PanelBoard
            boardKey="backtest"
            ids={["equity", "price", "drawdown", "monthly", "trades"]}
            className="grid grid-cols-1 xl:grid-cols-2 gap-6"
          >
          {/* Equity curve vs benchmark */}
          <ChartPanel
            id="equity"
            title={<>Equity Curve{result.config.benchmarkSymbol ? ` vs ${result.config.benchmarkSymbol} (benchmark)` : " vs Buy & Hold"}</>}
            className="xl:col-span-2"
            right={
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-indigo-500 inline-block" /> Strategy</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-gray-400 inline-block" /> {result.config.benchmarkSymbol || "Buy & Hold"}</span>
              </div>
            }
          >
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
          </ChartPanel>

          {/* Price chart with SMAs, Mega Score overlay + trade markers */}
          <ChartPanel
            id="price"
            title={`${result.symbol} Price (adjusted, with 50/200-day SMA)`}
            className="xl:col-span-2"
            right={
              <div className="flex items-center gap-4 text-[10px] text-[var(--muted)]">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" /> Close</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-amber-500 inline-block" /> SMA 50</span>
                <span className="flex items-center gap-1"><span className="w-2 h-0.5 bg-green-500 inline-block" /> SMA 200</span>
                {hasMega && <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-fuchsia-500 inline-block" /> Mega Score (0-100)</span>}
                {megaBands && (
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-0.5 bg-emerald-500 inline-block" /> Buy ≥ {megaBands.entry}
                    <span className="w-3 h-0.5 bg-red-500 inline-block ml-1" /> Sell {"<"} {megaBands.exit}
                  </span>
                )}
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Trade marker</span>
              </div>
            }
          >
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
                {megaBands && (
                  <>
                    <ReferenceLine yAxisId="mega" y={megaBands.entry} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.85} />
                    <ReferenceLine yAxisId="mega" y={megaBands.exit} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.85} />
                  </>
                )}
                <Scatter yAxisId="price" dataKey="entryMarker" fill="#34d399" shape="triangle" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            {hasMega && (
              <p className="text-[10px] text-[var(--muted)] mt-2">
                {result.megaScoreDescription}
                {result.config.megaWeights && result.strategyId === "mega_score" && useMegaPrefs ? " · matching your Mega Indicator weights" : ""}
                {megaBands ? ` · traded at buy ≥ ${megaBands.entry}, sell < ${megaBands.exit}` : ""}
              </p>
            )}
          </ChartPanel>

          {/* Drawdown */}
          <ChartPanel id="drawdown" title="Drawdown (from running peak)">
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
          </ChartPanel>

          {/* Monthly returns */}
          {monthlyData.length > 1 && (
            <ChartPanel id="monthly" title="Monthly Returns (%)">
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
            </ChartPanel>
          )}

          {/* Trades */}
          <ChartPanel
            id="trades"
            title={`Trade Log (${result.trades.length} trades)`}              subtitle="Click a trade for its exact entry/exit days and the Mega Score on each · right-click to jump to every indicator on either bar"
            className="xl:col-span-2"
            right={
              <button onClick={() => {
                downloadCSV(
                  `backtest-${result.symbol}-${result.strategyId}.csv`,
                  ["#", "Entry Date", "Exit Date", "Days", "Score In", "Score In (fill day)", "Score Out", "Score Out (fill day)", "Shares", "Entry $", "Exit $", "Return %", "P&L", "Exit Reason"],
                  result.trades.map(t => [t.id, t.entryDate, t.exitDate || "OPEN", t.bars, t.entryScore ?? "", t.entryFillScore ?? "", t.exitScore ?? "", t.exitFillScore ?? "", t.shares, t.entryPrice, t.exitPrice || "", t.returnPct, t.pnl, t.reason]),
                );
              }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)] transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Export CSV
              </button>
            }
          >
            <SortableTable
              columns={tradeColumns}
              data={result.trades}
              searchPlaceholder="Search trades…"
              searchKey="entryDate"
              emptyMessage="No trades were generated"
              rowKey={(r) => r.id}
              onRowClick={(r) => setTradeDetail(r)}
              onRowContextMenu={(r, e) => setLogMenu({ trade: r, x: e.clientX, y: e.clientY })}
            />
          </ChartPanel>
          </PanelBoard>
        </>
      )}

      {/* ── Right-click a Trade Log row: that trade's indicators at either bar ── */}
      {logMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setLogMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setLogMenu(null); }}
        >
          <div
            className="absolute w-72 rounded-xl border border-[var(--card-border)] bg-[var(--card)] shadow-2xl p-2 text-xs"
            style={{
              left: Math.max(8, Math.min(logMenu.x, (typeof window !== "undefined" ? window.innerWidth : 900) - 300)),
              top: Math.max(8, Math.min(logMenu.y, (typeof window !== "undefined" ? window.innerHeight : 700) - 220)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-2 py-1 font-semibold text-[11px] truncate">
              Trade #{logMenu.trade.id} · every indicator at…
            </p>
            <button
              onClick={() => inspectTradeBar(logMenu.trade, "entry")}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--card-hover)] flex items-center justify-between gap-2"
            >
              <span>Entry bar</span>
              <span className="font-mono text-[10px] text-[var(--muted)]">
                {logMenu.trade.entrySignalDate ?? logMenu.trade.entryDate}
              </span>
            </button>
            <button
              onClick={() => inspectTradeBar(logMenu.trade, "exit")}
              disabled={!logMenu.trade.exitDate}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--card-hover)] flex items-center justify-between gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>Exit bar{logMenu.trade.reason ? ` (${logMenu.trade.reason})` : ""}</span>
              <span className="font-mono text-[10px] text-[var(--muted)]">
                {logMenu.trade.exitSignalDate ?? logMenu.trade.exitDate ?? "still open"}
              </span>
            </button>
            <p className="px-2 py-1.5 text-[10px] leading-relaxed text-[var(--muted)]">
              Each indicator&apos;s raw reading, 0-100 score and the points it added to the composite on that bar.
            </p>
          </div>
        </div>
      )}

      {/* ── Trade detail: exact days + Mega Score at entry/exit ── */}
      <DetailDrawer
        open={tradeDetail !== null}
        onClose={() => setTradeDetail(null)}
        title={tradeDetail ? `Trade #${tradeDetail.id} · ${result?.symbol ?? ticker}` : "Trade"}
        subtitle={tradeDetail ? `${result?.strategyName ?? strategyId} · ${tradeDetail.side}` : undefined}
        badges={
          tradeDetail ? (
            <>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[var(--card-hover)] text-[var(--muted)]">
                {tradeDetail.exitDate ? `${tradeDetail.bars} days held` : "still open"}
              </span>
              {tradeDetail.entryScore != null && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/15 text-indigo-500 dark:text-indigo-400">
                  Mega Score {tradeDetail.entryScore.toFixed(1)} in
                  {tradeDetail.exitScore != null ? ` → ${tradeDetail.exitScore.toFixed(1)} out` : ""}
                </span>
              )}
            </>
          ) : undefined
        }
        sections={
          tradeDetail
            ? [
                {
                  heading: "Entry",
                  rows: [
                    { label: "Exact day (fill)", value: longDate(tradeDetail.entryDate) },
                    {
                      label: `Mega Score at entry signal (${signalWindow}, prior close)`,
                      value: scoreText(tradeDetail.entryScore),
                      tone: scoreTone(tradeDetail.entryScore),
                    },
                    {
                      label: "Why this entry",
                      value: tradeDetail.reentry
                        ? "Re-opened after a stop/target while the regime stayed long — no fresh score crossing"
                        : "Score crossed the buy band",
                      tone: "muted",
                    },
                    {
                      label: "Mega Score on fill day's close",
                      value: scoreText(tradeDetail.entryFillScore),
                      tone: scoreTone(tradeDetail.entryFillScore),
                    },
                    { label: "Fill price", value: fmt2(tradeDetail.entryPrice) },
                    { label: "Shares", value: num(tradeDetail.shares) },
                  ],
                },
                {
                  heading: "Exit",
                  rows: tradeDetail.exitDate
                    ? [
                        { label: "Exact day (fill)", value: longDate(tradeDetail.exitDate) },
                        ...(tradeDetail.reason === "signal"
                          ? [
                              {
                                label: `Mega Score at exit signal (${signalWindow}, prior close)`,
                                value: scoreText(tradeDetail.exitScore),
                                tone: scoreTone(tradeDetail.exitScore),
                              },
                              {
                                label: "Mega Score on fill day's close",
                                value: scoreText(tradeDetail.exitFillScore),
                                tone: scoreTone(tradeDetail.exitFillScore),
                              },
                            ]
                          : tradeDetail.reason === "end-of-test"
                          ? [{
                              label: "Mega Score on the last bar",
                              value: scoreText(tradeDetail.exitFillScore),
                              tone: "muted" as const,
                            }]
                          : [{
                              label: "Mega Score on exit day (intra-bar fill)",
                              value: scoreText(tradeDetail.exitScore),
                              tone: scoreTone(tradeDetail.exitScore),
                            }]),
                        { label: "Fill price", value: tradeDetail.exitPrice == null ? "—" : fmt2(tradeDetail.exitPrice) },
                        {
                          label: "Exit reason",
                          value: tradeDetail.reason === "stop-loss" ? "Stop-loss"
                            : tradeDetail.reason === "trailing-stop" ? "ATR trailing stop"
                            : tradeDetail.reason === "session-close" ? "Session close (flat by the bell)"
                            : tradeDetail.reason === "take-profit" ? "Take-profit target"
                            : tradeDetail.reason === "end-of-test" ? "Closed at end of test"
                            : "Strategy signal",
                        },
                      ]
                    : [
                        { label: "Exact day", value: "Still open at the end of the test", tone: "muted" as const },
                        {
                          label: "Mega Score on the last bar",
                          value: scoreText(result?.priceSeries[result.priceSeries.length - 1]?.mega),
                          tone: "muted" as const,
                        },
                      ],
                },
                {
                  heading: "Result",
                  rows: [
                    { label: "P&L", value: fmt2(tradeDetail.pnl), tone: toneOf(tradeDetail.pnl) },
                    { label: "Return", value: pct(tradeDetail.returnPct, 2), tone: toneOf(tradeDetail.returnPct) },
                  ],
                },
                ...(megaBands
                  ? [{
                      heading: "Score bands this run traded",
                      rows: [
                        { label: "Buy when score ≥", value: megaBands.entry.toFixed(0) },
                        { label: "Sell when score is below", value: megaBands.exit.toFixed(0) },
                      ],
                    }]
                  : []),
              ]
            : []
        }
      >
        {tradeDetail && (
          <div className="space-y-4">
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              The signal score is the Mega Score reading that generated the trade ({signalWindow} of the same
              look-ahead-safe series plotted under the price chart) — that is the number the buy/sell bands are
              compared against. Signals fill at the next session&apos;s open, and the fill day&apos;s own close is
              shown beside it because the score can move overnight.
              {tradeDetail.entryScore == null && " This run did not compute the score series (bulk compare/optimize runs skip it)."}
            </p>

            {/* Every indicator behind the composite on the entry / exit bar. */}
            <div className="border-t border-[var(--card-border)] pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold">Every indicator at this trade</p>
                <div className="flex rounded-lg overflow-hidden border border-[var(--card-border)]">
                  {(["entry", "exit"] as const).map((side) => {
                    const available = snapshotsAreCurrent && (side === "entry" ? !!snapshotWanted.entry : !!snapshotWanted.exit);
                    const active = snapshotSide === side;
                    return (
                      <button
                        key={side}
                        onClick={() => snapshotKey && setSideChoice({ key: snapshotKey, side })}
                        disabled={!available}
                        className={`px-2.5 py-1 text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          active
                            ? "bg-indigo-600 text-white"
                            : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
                        }`}>
                        {side === "entry" ? "Entry bar" : "Exit bar"}
                      </button>
                    );
                  })}
                </div>
              </div>

              {snapshotsAreCurrent && snapshotLoading && (
                <p className="text-[11px] text-[var(--muted)] mt-2">Recomputing the indicator series…</p>
              )}
              {snapshotsAreCurrent && snapshotError && !snapshotLoading && (
                <p className="text-[11px] text-[var(--danger)] mt-2">⚠ {snapshotError}</p>
              )}

              {snapshotsAreCurrent && !snapshotLoading && !snapshotError && activeSnapshot && (
                <>
                  <p className="text-[11px] text-[var(--muted)] mt-2 leading-relaxed">
                    {activeSnapshot.date} close · composite{" "}
                    <span className="font-mono font-semibold text-[var(--foreground)]">
                      {activeSnapshot.composite == null ? "—" : activeSnapshot.composite.toFixed(1)}
                    </span>{" "}
                    · {activeSnapshot.readings.filter((r) => r.weight > 0 && r.score != null).length} of{" "}
                    {activeSnapshot.readings.length} indicators in the composite
                    {activeSnapshot.missing > 0 && ` · ${activeSnapshot.missing} still warming up`}
                  </p>

                  <label className="flex items-center gap-2 text-[10px] text-[var(--muted)] mt-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showZeroWeight}
                      onChange={(e) => setShowZeroWeight(e.target.checked)}
                      className="accent-indigo-500" />
                    include indicators your weights exclude (0)
                  </label>

                  <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-[var(--card-border)]">
                    <table className="w-full text-[11px] border-collapse">
                      <thead className="sticky top-0 bg-[var(--card)] z-10">
                        <tr className="text-[10px] text-[var(--muted)] text-left">
                          <th className="py-1.5 px-2 font-medium">Indicator</th>
                          <th className="py-1.5 px-2 font-medium text-right whitespace-nowrap">Reading</th>
                          <th className="py-1.5 px-2 font-medium text-right">Score</th>
                          <th className="py-1.5 px-2 font-medium text-right">Wt</th>
                          <th className="py-1.5 px-2 font-medium text-right">Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {indicatorRows.map((r) => (
                          <tr key={r.id} title={r.description} className="border-t border-[var(--card-border)]/60">
                            <td className="py-1 px-2">
                              <span className="font-medium">{r.name}</span>
                              <span className="block text-[9px] text-[var(--muted)]">{r.category}</span>
                            </td>
                            <td className="py-1 px-2 text-right font-mono whitespace-nowrap text-[var(--muted)]">
                              {readingText(r)}
                            </td>
                            <td
                              className={`py-1 px-2 text-right font-mono ${
                                r.score == null
                                  ? "text-[var(--muted)]"
                                  : r.score >= MEGA_BASELINE.entry
                                    ? "text-[var(--success)]"
                                    : r.score <= MEGA_BASELINE.exit
                                      ? "text-[var(--danger)]"
                                      : ""
                              }`}>
                              {r.score == null ? "—" : r.score.toFixed(1)}
                            </td>
                            <td className="py-1 px-2 text-right font-mono text-[var(--muted)]">{r.weight}</td>
                            <td className="py-1 px-2 text-right font-mono whitespace-nowrap">
                              {r.contribution == null
                                ? "—"
                                : `${r.contribution > 0 ? "+" : ""}${r.contribution.toFixed(1)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-[10px] text-[var(--muted)] mt-1.5 leading-relaxed">
                    <b>Reading</b> is the indicator&apos;s own value on that bar, <b>Score</b> is that value re-wrapped as
                    0–100 health, <b>Wt</b> is the weight your composite gives it, and <b>Pts</b> is how many points of
                    the 0–100 composite it added — they sum to the composite above. Sorted by contribution.
                    {result?.strategyId === "mega_score" && tradeDetail.entryScore != null &&
                      " The band check above used the smoothed signal reading, so it can differ slightly from this bar's raw composite."}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </DetailDrawer>
    </div>
  );
}
