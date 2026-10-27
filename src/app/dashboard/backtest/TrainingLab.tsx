"use client";

import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import { downloadCSV } from "@/lib/export";
import type { CalibrationResult, SymbolReport, VariantReport, WeightDelta } from "@/lib/mega-calibration";
import type { WeightMap } from "@/lib/mega-indicator";

const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const sharpe = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
const YEAR_OPTIONS = [5, 10, 15, 20];
const TRAIN_OPTIONS = [
  { value: 0.6, label: "60 / 40" },
  { value: 0.7, label: "70 / 30" },
  { value: 0.8, label: "80 / 20" },
];
const PASS_OPTIONS = [
  { value: 1, label: "1 (quick)" },
  { value: 2, label: "2 (standard)" },
  { value: 3, label: "3 (thorough)" },
];

interface TrainMeta {
  prepared: Array<{ symbol: string; bars: number; from: string; to: string }>;
  failures: string[];
  elapsedMs: number;
  framesFromCache: boolean;
}

interface TrainDefaults {
  defaultUniverse: string[];
  options: { trainFraction: number; minTrades: number; passes: number; commissionBps: number; slippageBps: number; entry: number; exit: number };
  baseline: { entry: number; exit: number };
  units: Array<{ key: string; label: string; ids: string[]; optional: boolean }>;
  limits: { maxSymbols: number; maxYears: number };
}

export default function TrainingLab({
  onApply,
}: {
  /** Push the trained weights + bands into the single backtest (and storage). */
  onApply?: (weights: WeightMap, entry: number, exit: number) => void;
}) {
  const [defaults, setDefaults] = useState<TrainDefaults | null>(null);
  const [universe, setUniverse] = useState("");
  const [years, setYears] = useState(15);
  const [trainFraction, setTrainFraction] = useState(0.7);
  const [minTrades, setMinTrades] = useState(4);
  const [passes, setPasses] = useState(2);
  const [entry, setEntry] = useState(65);
  const [exit, setExit] = useState(35);
  const [commissionBps, setCommissionBps] = useState(2);
  const [slippageBps, setSlippageBps] = useState(2);
  const [searchBands, setSearchBands] = useState(true);
  const [includeCatalogue, setIncludeCatalogue] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [meta, setMeta] = useState<TrainMeta | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    fetch("/api/mega-train")
      .then((r) => r.json())
      .then((data: TrainDefaults & { error?: string }) => {
        if (data.error) throw new Error(data.error);
        setDefaults(data);
        setUniverse(data.defaultUniverse.join(", "));
        setYears(Math.min(15, data.limits.maxYears));
        setTrainFraction(data.options.trainFraction);
        setMinTrades(data.options.minTrades);
        setPasses(data.options.passes);
        setCommissionBps(data.options.commissionBps);
        setSlippageBps(data.options.slippageBps);
        setEntry(data.baseline.entry);
        setExit(data.baseline.exit);
      })
      .catch(() => setError("Could not load the training defaults"));
  }, []);

  const symbols = useMemo(
    () => universe.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
    [universe]
  );

  const run = async () => {
    setRunning(true);
    setError(null);
    setApplied(false);
    try {
      const res = await fetch("/api/mega-train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbols,
          years,
          entry,
          exit,
          trainFraction,
          minTrades,
          passes,
          commissionBps,
          slippageBps,
          searchBands,
          includeCatalogue,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Training failed");
      setResult(data.result as CalibrationResult);
      setMeta({
        prepared: data.prepared,
        failures: data.failures ?? [],
        elapsedMs: data.elapsedMs,
        framesFromCache: data.framesFromCache,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Training failed");
    } finally {
      setRunning(false);
    }
  };

  const variants = result?.variants ?? [];
  const tuned = variants.find((v) => v.key === "tuned");
  const prior = variants.find((v) => v.key === "prior");

  const chartData = useMemo(() => {
    if (!tuned || !prior) return [];
    const n = Math.min(tuned.curve.length, prior.curve.length);
    const rows: Array<{ date: string; tuned: number; prior: number }> = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        date: tuned.curve[i].date,
        tuned: Math.round(tuned.curve[i].equity * 1000) / 10,
        prior: Math.round(prior.curve[i].equity * 1000) / 10,
      });
    }
    // Trim to a readable number of points (~600) for the chart only.
    const step = Math.max(1, Math.ceil(rows.length / 600));
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  }, [tuned, prior]);

  const variantColumns: Column<VariantReport>[] = [
    { key: "label", header: "Configuration", render: (r) => (
      <div>
        <p className="font-medium">{r.label}</p>
        <p className="text-[10px] text-[var(--muted)]">{r.description}</p>
      </div>
    ) },
    { key: "bands", header: "Bands", align: "right", render: (r) => <span className="font-mono text-[11px]">{r.entry} / {r.exit}</span> },
    { key: "trainSharpe", header: "Train Sharpe", align: "right", render: (r) => <span className="text-[var(--muted)]">{sharpe(r.train.meanSharpe)}</span> },
    { key: "testSharpe", header: "Test Sharpe", align: "right", render: (r) => (
      <span className={r.test.meanSharpe > 0.5 ? "text-[var(--success)] font-semibold" : r.test.meanSharpe < 0 ? "text-[var(--danger)]" : ""}>
        {sharpe(r.test.meanSharpe)}
      </span>
    ) },
    { key: "testReturn", header: "Test CAGR", align: "right", render: (r) => (
      <span className={r.test.meanCagr >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(r.test.meanCagr)}</span>
    ) },
    { key: "excess", header: "Excess vs B&H", align: "right", render: (r) => (
      <span
        title={`Sharpe ${sharpe(r.test.meanSharpe)} vs buy & hold ${sharpe(r.test.meanBenchmarkSharpe)}`}
        className={r.test.meanExcessSharpe > 0.05 ? "text-[var(--success)] font-semibold" : r.test.meanExcessSharpe < -0.05 ? "text-[var(--danger)]" : "text-[var(--muted)]"}
      >
        {r.test.meanExcessSharpe > 0 ? "+" : ""}{sharpe(r.test.meanExcessSharpe)}
      </span>
    ) },
    { key: "testDD", header: "Test Max DD", align: "right", render: (r) => <span className="text-[var(--danger)]">{pct(r.test.meanMaxDrawdownPct)}</span> },
    { key: "trades", header: "Trades / sym", align: "right", render: (r) => <span className={r.test.meanTrades < (result?.minTrades ?? 0) ? "text-amber-600 dark:text-amber-400" : ""}>{r.test.meanTrades.toFixed(1)}</span> },
    { key: "exposure", header: "Exposure", align: "right", render: (r) => pct(r.test.meanExposurePct, 0) },
  ];

  const weightColumns: Column<WeightDelta>[] = [
    { key: "name", header: "Indicator", render: (r) => (
      <div>
        <p className="font-medium">{r.name}</p>
        <p className="text-[10px] text-[var(--muted)] font-mono">{r.id}{r.unit ? ` · ${r.unit}` : ""}</p>
      </div>
    ) },
    { key: "priorSharePct", header: "Prior %", align: "right", render: (r) => <span className="text-[var(--muted)]">{r.priorSharePct.toFixed(1)}</span> },
    { key: "tunedSharePct", header: "Trained %", align: "right", render: (r) => <span className="font-semibold">{r.tunedSharePct.toFixed(1)}</span> },
    { key: "delta", header: "Δ", align: "right", render: (r) => {
      const d = Math.round((r.tunedSharePct - r.priorSharePct) * 10) / 10;
      return <span className={d > 0 ? "text-[var(--success)]" : d < 0 ? "text-[var(--danger)]" : "text-[var(--muted)]"}>{d > 0 ? "+" : ""}{d.toFixed(1)}</span>;
    } },
  ];

  const symbolColumns: Column<SymbolReport>[] = [
    { key: "symbol", header: "Ticker", render: (r) => <span className="font-mono font-semibold">{r.symbol}</span> },
    { key: "testSharpe", header: "Test Sharpe", align: "right", render: (r) => sharpe(r.test.sharpe) },
    { key: "testReturn", header: "Test Return", align: "right", render: (r) => (
      <span className={r.test.totalReturnPct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>{pct(r.test.totalReturnPct)}</span>
    ) },
    { key: "buyHold", header: "Buy & Hold", align: "right", render: (r) => <span className="text-[var(--muted)]">{pct(r.buyHoldTestPct)}</span> },
    { key: "dd", header: "Max DD", align: "right", render: (r) => pct(r.test.maxDrawdownPct) },
    { key: "trades", header: "Trades", align: "right", render: (r) => String(r.test.trades) },
    { key: "exposure", header: "Exposure", align: "right", render: (r) => pct(r.test.exposurePct, 0) },
  ];

  const kpi = (label: string, value: string, sub?: string, tone: "good" | "bad" | "neutral" = "neutral") => (
    <div className="p-3 rounded-lg" style={{ background: "var(--input-bg)" }}>
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className={`text-base font-bold ${tone === "good" ? "text-[var(--success)]" : tone === "bad" ? "text-[var(--danger)]" : ""}`}>{value}</p>
      {sub && <p className="text-[10px] text-[var(--muted)] mt-0.5">{sub}</p>}
    </div>
  );

  const beatsPrior = tuned && prior ? tuned.test.meanSharpe > prior.test.meanSharpe : false;
  const improved = tuned && prior ? tuned.train.meanSharpe > prior.train.meanSharpe : false;

  return (
    <div className="space-y-6">
      {/* ── Controls ─────────────────────────────────────────── */}
      <div className="glass rounded-xl p-5">
        <p className="text-xs text-[var(--muted)] mb-4 leading-relaxed">
          Trains the <b>Mega Score</b>: it picks the composite&apos;s per-indicator weights and its BUY/SELL bands by
          maximizing risk-adjusted return across a <b>universe</b> of tickers on the first{" "}
          {Math.round(trainFraction * 100)}% of each history, then reports the untouched tail. The SMA/EMA family is
          searched as <b>one</b> weight (16 periods of the same trend), so correlated readings cannot outvote the rest.
          Read the <b>Test</b> column, not the Train one.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-2">
            <label className="block text-xs text-[var(--muted)] mb-1">
              Universe (comma-separated, {symbols.length} / {defaults?.limits.maxSymbols ?? 24} max)
            </label>
            <textarea
              value={universe}
              onChange={(e) => setUniverse(e.target.value.toUpperCase())}
              rows={2}
              spellCheck={false}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono uppercase tracking-wide focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
            <div className="flex flex-wrap gap-1 mt-2">
              {(defaults?.defaultUniverse ?? []).map((s) => (
                <span key={s} className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--card-hover)] text-[var(--muted)]">{s}</span>
              ))}
              <button
                onClick={() => setUniverse(defaults?.defaultUniverse.join(", ") ?? "")}
                className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                reset
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">History</label>
            <div className="flex flex-wrap gap-1">
              {YEAR_OPTIONS.map((y) => (
                <button key={y} onClick={() => setYears(y)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${years === y ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {y}Y
                </button>
              ))}
            </div>
            <label className="block text-xs text-[var(--muted)] mb-1 mt-3">Train / Test split</label>
            <div className="flex flex-wrap gap-1">
              {TRAIN_OPTIONS.map((o) => (
                <button key={o.value} onClick={() => setTrainFraction(o.value)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${trainFraction === o.value ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {o.label}
                </button>
              ))}
            </div>
            <label className="block text-xs text-[var(--muted)] mb-1 mt-3">Search passes</label>
            <div className="flex flex-wrap gap-1">
              {PASS_OPTIONS.map((o) => (
                <button key={o.value} onClick={() => setPasses(o.value)}
                  className={`px-2.5 py-1 rounded text-xs transition-colors ${passes === o.value ? "bg-indigo-600 text-white" : "bg-[var(--card-hover)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1" title="Starting BUY band; also the band searched when band training is off.">Entry band</label>
                <input type="number" min={10} max={90} value={entry} onChange={(e) => setEntry(Number(e.target.value))}
                  className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1" title="Starting SELL band.">Exit band</label>
                <input type="number" min={5} max={85} value={exit} onChange={(e) => setExit(Number(e.target.value))}
                  className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1" title="Per-symbol trade floor: a ticker needs this many trades in a window to count.">Min trades</label>
                <input type="number" min={1} max={60} value={minTrades} onChange={(e) => setMinTrades(Math.max(1, Number(e.target.value)))}
                  className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1" title="Per-side commission in basis points.">Commission bps</label>
                <input type="number" min={0} max={100} value={commissionBps} onChange={(e) => setCommissionBps(Number(e.target.value))}
                  className="w-full px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input type="checkbox" checked={searchBands} onChange={(e) => setSearchBands(e.target.checked)} />
              Search the BUY/SELL bands too
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input type="checkbox" checked={includeCatalogue} onChange={(e) => setIncludeCatalogue(e.target.checked)} />
              Let catalogue indicators join the search
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <span className="shrink-0" title="Per-side slippage in basis points.">Slippage bps</span>
              <input type="number" min={0} max={200} value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))}
                className="w-16 px-2 py-1 rounded text-xs font-mono bg-[var(--input-bg)] border border-[var(--input-border)] focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          <button onClick={run} disabled={running || symbols.length < 2}
            className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors">
            {running ? "Training…" : "🎓 Train weights"}
          </button>
          {symbols.length < 2 && <span className="text-xs text-amber-600 dark:text-amber-400">Pick at least two tickers.</span>}
          {running && (
            <span className="text-xs text-[var(--muted)]">
              Building indicator series for {symbols.length} tickers, then searching {defaults?.units.length ?? 40} weight axes — first run takes a minute.
            </span>
          )}
          {meta && !running && (
            <span className="text-xs text-[var(--muted)]">
              {meta.prepared.length} tickers · {meta.elapsedMs} ms search{meta.framesFromCache ? " · indicator series reused" : ""}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {!result && !running && !error && (
        <div className="glass rounded-xl p-5 text-sm text-[var(--muted)] space-y-2">
          <p className="font-semibold text-[var(--foreground)]">What a run does</p>
          <ol className="list-decimal pl-5 space-y-1 text-xs leading-relaxed">
            <li>Every indicator&apos;s 0–100 score is computed once per ticker from the cached daily bars (causal at every bar).</li>
            <li>Weights are searched by coordinate descent over {defaults?.units.length ?? 40} units — one pass moves each unit to the level that raises the objective, with a penalty for drifting away from the current defaults.</li>
            <li>The BUY/SELL bands are then searched with the weights frozen, and the two steps alternate.</li>
            <li>Nothing in the held-out tail is used for any choice; the Test column is what the rule would have done there.</li>
            <li>The run reports how many candidates were tried and what excess Sharpe over buy &amp; hold luck alone would produce over that many tries — the bar the held-out result is judged against.</li>
          </ol>
        </div>
      )}

      {result && tuned && prior && (
        <>
          {/* ── Verdict ─────────────────────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold">
                {beatsPrior ? "✅ The trained score beat the prior out of sample" : "⚠️ The trained score did not beat the prior out of sample"}
              </h3>
              <span className="text-xs text-[var(--muted)]">
                {result.symbols.length} tickers · {result.dateFrom} → {result.dateTo} · train ends {result.trainTo}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {kpi("Test Sharpe (trained)", sharpe(tuned.test.meanSharpe), `prior ${sharpe(prior.test.meanSharpe)}`,
                beatsPrior ? "good" : "bad")}
              {kpi("Excess vs buy & hold", `${tuned.test.meanExcessSharpe > 0 ? "+" : ""}${sharpe(tuned.test.meanExcessSharpe)}`,
                `B&H Sharpe ${sharpe(tuned.test.meanBenchmarkSharpe)}`, tuned.test.meanExcessSharpe > 0.05 ? "good" : tuned.test.meanExcessSharpe < -0.05 ? "bad" : "neutral")}
              {kpi("Test CAGR (trained)", pct(tuned.test.meanCagr), `prior ${pct(prior.test.meanCagr)}`,
                tuned.test.meanCagr >= prior.test.meanCagr ? "good" : "bad")}
              {kpi("Test max drawdown", pct(tuned.test.meanMaxDrawdownPct), `prior ${pct(prior.test.meanMaxDrawdownPct)}`, "bad")}
              {kpi("Trained bands", `${result.tuned.entry} / ${result.tuned.exit}`,
                `prior ${result.prior.entry} / ${result.prior.exit}`, improved ? "good" : "neutral")}
              {kpi("Trades / symbol", tuned.test.meanTrades.toFixed(1),
                `floor ${result.minTrades} · exposure ${pct(tuned.test.meanExposurePct, 0)}`,
                tuned.test.meanTrades >= result.minTrades ? "good" : "bad")}
              {kpi("Search trials", String(result.trials),
                `luck bar ≈ ${result.luckExcessSharpe.toFixed(2)} excess Sharpe`, "neutral")}
            </div>

            <p className="mt-3 text-[11px] text-[var(--muted)] leading-relaxed">
              Objective: {result.objective}. Train window: {result.trainYears} years. Score percentiles on the test
              window: p10 {result.distribution.test.p10} · p50 {result.distribution.test.p50} · p90{" "}
              {result.distribution.test.p90} — the trained bands sit at {result.tuned.entry} / {result.tuned.exit}.
            </p>

            {/*
              The bar is on the measure the objective maximizes, and it is compared
              against that measure. Comparing the raw Sharpe with it (or the excess
              with the raw bar) is how a run that added nothing over buy & hold ends
              up looking like it cleared a threshold.
            */}
            <p className="mt-2 text-[11px] text-[var(--muted)] leading-relaxed">
              {result.trials} candidates were tried on the training window, so pure luck over that many tries is
              expected to produce an excess Sharpe of about {result.luckExcessSharpe.toFixed(2)} (the rule&apos;s return
              correlation with its benchmark measured {result.returnCorrelation.toFixed(2)}; on the raw Sharpe scale the
              same bar is {result.luckSharpe.toFixed(2)}).{" "}
              {tuned.test.meanExcessSharpe > result.luckExcessSharpe
                ? `The held-out excess of ${tuned.test.meanExcessSharpe.toFixed(2)} is above that bar.`
                : `The held-out excess of ${tuned.test.meanExcessSharpe.toFixed(2)} is below that bar, so this run is not evidence of an edge over simply holding the same stocks.`}
            </p>

            <div className="flex flex-wrap gap-2 mt-4">
              <button
                onClick={() => {
                  onApply?.(result.weights, result.tuned.entry, result.tuned.exit);
                  setApplied(true);
                }}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-500"
              >
                Apply weights + bands to the Mega Score backtest
              </button>
              <button
                onClick={() => downloadCSV(
                  "mega-weights-trained.csv",
                  ["id", "indicator", "prior_share_pct", "trained_share_pct", "trained_weight"],
                  result.deltas.map((d) => [d.id, d.name, d.priorSharePct, d.tunedSharePct, d.tuned])
                )}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              >
                Download weights CSV
              </button>
              <button
                onClick={() => navigator.clipboard?.writeText(JSON.stringify(result.weights, null, 2))}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              >
                Copy weight map
              </button>
              {applied && <span className="text-xs text-[var(--success)] self-center">Saved — the Mega Score strategy now trades the trained composite.</span>}
            </div>
          </div>

          {/* ── Out-of-sample curve ─────────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold">Held-out window — equal-weight universe equity (100 = start)</h3>
              <span className="text-xs text-[var(--muted)]">trained vs prior, same days, same costs</span>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                <XAxis dataKey="date" stroke="var(--muted)" tick={{ fontSize: 10 }} minTickGap={60} />
                <YAxis stroke="var(--muted)" tick={{ fontSize: 10 }} domain={["auto", "auto"]} tickFormatter={(v: number) => `${Math.round(v)}`} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                  formatter={(v: unknown, name: unknown) => [Number(v).toFixed(1), name === "tuned" ? "Trained" : "Prior"]}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="tuned" name="Trained" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="prior" name="Prior" stroke="#9ca3af" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── Ablation table ──────────────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-1">Weights vs bands — what each change buys</h3>
            <p className="text-xs text-[var(--muted)] mb-4">
              Every row is the same rule measured the same way. If band tuning alone matches the full training run, the
              weight search is not adding anything.
            </p>
            <SortableTable
              columns={variantColumns}
              data={variants}
              searchPlaceholder="Search configurations…"
              searchKey="label"
              emptyMessage="No configurations"
              rowKey={(r) => r.key}
            />
          </div>

          {/* ── Weights ─────────────────────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold">Trained weights</h3>
              <span className="text-xs text-[var(--muted)]">
                {result.searchUnits.length} search axes · shares of the 0–100 composite
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {result.searchUnits.map((u) => (
                <span key={u.key} title={u.ids.join(", ")}
                  className="px-2 py-0.5 rounded text-[10px] border border-[var(--card-border)] text-[var(--muted)]">
                  {u.label.split(" (")[0]}: <span className="font-mono">{u.prior}</span> → <span className="font-mono font-semibold text-[var(--foreground)]">{u.tuned}</span>
                </span>
              ))}
            </div>
            <SortableTable
              columns={weightColumns}
              data={result.deltas}
              searchPlaceholder="Search indicators…"
              searchKey="name"
              emptyMessage="No indicators"
              rowKey={(r) => r.id}
            />
          </div>

          {/* ── Per symbol ──────────────────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Held-out results per ticker (trained weights + bands)</h3>
            <SortableTable
              columns={symbolColumns}
              data={tuned.perSymbol}
              searchPlaceholder="Search tickers…"
              searchKey="symbol"
              emptyMessage="No tickers"
              rowKey={(r) => r.symbol}
            />
          </div>

          {result.warnings.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs space-y-1">
              {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
