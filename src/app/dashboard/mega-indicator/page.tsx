"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell,
  AreaChart, Area, LineChart, Line, Legend, ReferenceLine,
} from "recharts";
import { scoreColor, scoreLabel, WeightMap } from "@/lib/mega-indicator";

interface MegaIndicator {
  id: string;
  name: string;
  category: string;
  unit: string;
  value: number;
  score: number;
  weight: number;
  enabled: boolean;
  direction: "higher" | "lower" | "band";
  thresholds: [number, number];
  description: string;
}

interface MegaCategory { category: string; score: number; weightShare: number; }

interface MegaResponse {
  score: number;
  grade: string;
  verdict: string;
  indicators: MegaIndicator[];
  categories: MegaCategory[];
  contributions: Array<{ id: string; name: string; contribution: number }>;
  meta: {
    asOf: string | null;
    ticker: string | null;
    dataSource: "cache" | "yahoo" | "none";
    technicalCount: number;
  };
  technicalError: string | null;
  error?: string;
}

interface LiveQuote {
  symbol: string;
  name: string | null;
  currency: string;
  exchange: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  volume: number | null;
  marketState: string | null;
  preMarket: number | null;
  postMarket: number | null;
  quoteTime: number | null;
}

interface SparkPoint { t: number; price: number; }

interface MegaHistoryPoint {
  date: string;
  score: number;
  grade: string;
  indicators: Record<string, number>;
  close: number;
}

interface MegaHistoryResponse {
  symbol: string;
  from: string;
  to: string;
  points: MegaHistoryPoint[];
  indicatorNames: Record<string, string>;
  cached: boolean;
  warnings: string[];
  error?: string;
}

interface LiveResponse {
  quote: LiveQuote;
  spark: SparkPoint[];
  sparkError: string | null;
  error?: string;
}

// localStorage keys — weights / preset / ticker survive reloads
const LS_WEIGHTS = "mega-indicator:weights:v1";
const LS_PRESET = "mega-indicator:preset:v1";
const LS_TICKER = "mega-indicator:ticker:v1";

function loadStored<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const categoryIcons: Record<string, string> = {
  Technical: "📉",
  "Moving Averages": "📈",
};

type Preset = "all" | "trend" | "momentum" | "reversal" | "smooth" | "custom";

const PRESETS: Array<{ key: Preset; label: string; hint: string }> = [
  { key: "all", label: "⚖️ Everything", hint: "All indicators equally weighted" },
  { key: "trend", label: "🧭 Trend", hint: "Trend, MAs and kernel slope emphasized" },
  { key: "momentum", label: "🚀 Momentum", hint: "RSI, MACD and 3-month momentum emphasized" },
  { key: "reversal", label: "🔄 Mean Reversion", hint: "Bollinger position, RSI band and 52w distance emphasized" },
  { key: "smooth", label: "🌊 Smooth Trends", hint: "Clean trends rewarded — efficiency ratio and kernel residual emphasized" },
];

// Concrete weight maps per preset (indicator ids match lib/mega-indicator specs)
function presetWeights(p: Preset, indicators: MegaIndicator[]): WeightMap {
  const base: WeightMap = {};
  for (const ind of indicators) base[ind.id] = 1;
  const setMany = (pred: (i: MegaIndicator) => boolean, w: number) => {
    for (const ind of indicators) if (pred(ind)) base[ind.id] = w;
  };
  const has = (id: string) => indicators.some((i) => i.id === id);
  switch (p) {
    case "trend":
      setMany((i) => ["ta-trend-50-200", "ta-kernel-slope"].includes(i.id), 4);
      setMany((i) => i.category === "Moving Averages", 2);
      setMany((i) => i.id === "ta-mom-63", 2);
      break;
    case "momentum":
      setMany((i) => ["ta-rsi-14", "ta-macd-hist", "ta-mom-63"].includes(i.id), 4);
      setMany((i) => i.id === "ta-vol-ratio", 2);
      break;
    case "reversal":
      setMany((i) => ["ta-bb-pos", "ta-rsi-14", "ta-dist-52w-high"].includes(i.id), 4);
      setMany((i) => i.id === "ta-atr-pct", 2);
      break;
    case "smooth":
      setMany((i) => ["ta-er-10", "ta-kernel-residual"].includes(i.id), 4);
      setMany((i) => i.id === "ta-atr-pct", 2);
      break;
    default:
      if (!has("ta-trend-50-200")) break; // no indicators loaded yet
      break;
  }
  return base;
}

export default function MegaIndicatorPage() {
  const [data, setData] = useState<MegaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ticker, setTicker] = useState("AAPL");
  const [tickerInput, setTickerInput] = useState("AAPL");
  const [weights, setWeights] = useState<WeightMap>({});
  const [preset, setPreset] = useState<Preset>("all"); // "custom" = user moved a slider manually
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const weightsInitRef = useRef(false);
  const prevPriceRef = useRef<number | null>(null);
  const [search, setSearch] = useState("");

  // ─── Score-over-time history ───────────────────────────────────
  const [history, setHistory] = useState<MegaHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyYears, setHistoryYears] = useState(3);
  const [overlayId, setOverlayId] = useState(""); // "" = composite only

  // Restore saved ticker + preset on first mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = loadStored<string>(LS_TICKER, "");
      const rawPreset = loadStored<string>(LS_PRESET, "custom");
      // Ignore presets removed in the pivot (old values like "value" would
      // otherwise persist forever with no matching button).
      const VALID_PRESETS: Preset[] = ["all", "trend", "momentum", "reversal", "smooth", "custom"];
      const p = (VALID_PRESETS as string[]).includes(rawPreset) ? (rawPreset as Preset) : "custom";
      if (cancelled) return;
      if (t) { setTicker(t); setTickerInput(t); }
      if (p !== "custom") setPreset(p);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (ticker) params.set("ticker", ticker);
        const res = await fetch(`/api/mega-indicator?${params.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setData(json);
        // Initialize weights exactly once: restore saved weights, else all-1s.
        if (json.indicators && !weightsInitRef.current) {
          weightsInitRef.current = true;
          const stored = loadStored<WeightMap>(LS_WEIGHTS, {});
          if (Object.keys(stored).length > 0) {
            setWeights(stored);
          } else {
            const init: WeightMap = {};
            for (const ind of json.indicators) init[ind.id] = 1;
            setWeights(init);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ticker]);

  // Persist weights / preset / ticker on every change
  useEffect(() => {
    if (!weightsInitRef.current) return; // don't save the empty initial state
    try {
      window.localStorage.setItem(LS_WEIGHTS, JSON.stringify(weights));
      window.localStorage.setItem(LS_PRESET, JSON.stringify(preset));
      window.localStorage.setItem(LS_TICKER, JSON.stringify(ticker));
    } catch { /* storage unavailable — ignore */ }
  }, [weights, preset, ticker]);

  // Fetch score history when ticker or horizon changes (weights intentionally
  // NOT a dependency — even-weight history is cached and instant; refetching on
  // every slider move would be slow and noisy).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      try {
        const res = await fetch(`/api/mega-history?ticker=${encodeURIComponent(ticker)}&years=${historyYears}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setHistory(json);
      } catch {
        if (!cancelled) setHistory(null);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ticker, historyYears]);

  const historyData = useMemo(() => {
    if (!history?.points?.length) return [];
    return history.points.map((p) => ({
      date: p.date,
      score: p.score,
      overlay: overlayId ? p.indicators[overlayId] ?? null : null,
    }));
  }, [history, overlayId]);

  // ─── Live price polling (every ~3s, true Yahoo streaming price) ──
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms = 3000) => { timer = setTimeout(tick, ms); };
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule(); // tab hidden — idle-poll without fetching
        return;
      }
      try {
        const res = await fetch(`/api/live-quote?ticker=${encodeURIComponent(ticker)}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setLive(json);
        setLiveError(null);
        const p = json?.quote?.price;
        if (typeof p === "number" && prevPriceRef.current !== null && p !== prevPriceRef.current) {
          setFlash(p > prevPriceRef.current ? "up" : "down");
          setTimeout(() => setFlash(null), 800);
        }
        if (typeof p === "number") prevPriceRef.current = p;
      } catch (e) {
        if (!cancelled) setLiveError(e instanceof Error ? e.message : "Live feed error");
      } finally {
        if (!cancelled) schedule();
      }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [ticker]);

  // Local live recompute of the composite from weights (instant slider feedback),
  // while the server value is the source of truth after each fetch.
  const view = useMemo(() => {
    if (!data) return null;
    const enabled = data.indicators.filter((i) => (weights[i.id] ?? 1) > 0);
    const tw = enabled.reduce((s, i) => s + (weights[i.id] ?? 1), 0);
    const score = tw > 0 ? enabled.reduce((s, i) => s + i.score * (weights[i.id] ?? 1), 0) / tw : 50;
    const cats: Record<string, { ws: number; wsum: number }> = {};
    for (const i of enabled) {
      if (!cats[i.category]) cats[i.category] = { ws: 0, wsum: 0 };
      cats[i.category].ws += i.score * (weights[i.id] ?? 1);
      cats[i.category].wsum += weights[i.id] ?? 1;
    }
    const contributions = enabled
      .map((i) => ({ id: i.id, name: i.name, contribution: i.score * (weights[i.id] ?? 1) }))
      .sort((a, b) => b.contribution - a.contribution);
    return {
      ...data,
      score: Math.round(score * 10) / 10,
      categories: data.categories
        .map((c) => cats[c.category]
          ? { ...c, score: Math.round((cats[c.category].ws / cats[c.category].wsum) * 10) / 10, weightShare: tw > 0 ? Math.round((cats[c.category].wsum / tw) * 1000) / 10 : 0 }
          : { ...c, score: 0, weightShare: 0 })
        .sort((a, b) => b.weightShare - a.weightShare),
      contributions,
    };
  }, [data, weights]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (!data) return;
    setWeights(presetWeights(p, data.indicators));
  };

  const setWeight = (id: string, w: number) => {
    setPreset("custom"); // manual override — no preset matches anymore
    setWeights((prev) => ({ ...prev, [id]: w }));
  };

  const resetWeights = () => {
    if (!data) return;
    setPreset("all");
    const w: WeightMap = {};
    for (const ind of data.indicators) w[ind.id] = 1;
    setWeights(w);
  };

  const totalEffectiveWeight = useMemo(
    () => (data?.indicators || []).reduce((s, i) => s + Math.max(0, weights[i.id] ?? 1), 0),
    [data, weights]
  );

  const grouped = useMemo(() => {
    const g: Record<string, MegaIndicator[]> = {};
    for (const i of data?.indicators || []) {
      if (search && !i.name.toLowerCase().includes(search.toLowerCase())) continue;
      if (!g[i.category]) g[i.category] = [];
      g[i.category].push(i);
    }
    return g;
  }, [data, search]);

  const radarData = (view?.categories || [])
    .filter((c) => c.weightShare > 0)
    .map((c) => ({ category: c.category, score: c.score }));

  const score = view?.score ?? 0;
  const col = scoreColor(score);
  const circumference = 2 * Math.PI * 50;

  const gaugeArc = (score / 100) * circumference;

  // ─── Live strip helpers ─────────────────────────────────────────
  const q = live?.quote || null;
  const up = (q?.change ?? 0) >= 0;
  const changeColor = q ? ((q.change ?? 0) >= 0 ? "text-emerald-500" : "text-red-500") : "";
  const fmtPrice = (v: number | null) =>
    v === null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtVol = (v: number | null) => {
    if (v === null) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  };
  const statePill = (() => {
    const s = q?.marketState || "";
    if (s === "REGULAR") return { label: "MARKET OPEN", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500 animate-pulse" };
    if (s.startsWith("PRE")) return { label: "PRE-MARKET", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" };
    if (s.startsWith("POST")) return { label: "AFTER HOURS", cls: "bg-indigo-500/15 text-indigo-500 dark:text-indigo-400", dot: "bg-indigo-400" };
    return { label: "MARKET CLOSED", cls: "bg-[var(--card-hover)] text-[var(--muted)]", dot: "bg-[var(--muted)]" };
  })();
  const sparkData = (live?.spark || []).map((p) => ({ t: p.t, price: p.price }));
  const quoteTimeStr = q?.quoteTime
    ? new Date(q.quoteTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <div className="space-y-6">
      {/* ─── Controls row ─────────────────────────────────────── */}
      <div className="glass rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => { e.preventDefault(); setTicker(tickerInput.trim().toUpperCase()); }}
          className="flex items-center gap-2"
        >
          <input
            value={tickerInput}
            onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
            placeholder="Ticker (AAPL)"
            className="w-28 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm uppercase tracking-wide focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
          <button type="submit" className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 transition-colors">
            Analyze
          </button>
        </form>

        <div className="flex-1" />

        <div className="flex items-center gap-1 bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-1 flex-wrap">
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => applyPreset(p.key)} title={p.hint}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${preset === p.key ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/40" : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"}`}>
              {p.label}
            </button>
          ))}
          {preset === "custom" && (
            <span className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
              ✎ Custom
            </span>
          )}
          <button onClick={resetWeights} title="Reset all weights to 1"
            className="px-3 py-1.5 text-xs font-medium rounded-md text-[var(--muted)] hover:text-[var(--foreground)]">
            ↺ Reset
          </button>
        </div>
      </div>

      {/* ─── Live price strip (3s polling) ─────────────────────── */}
      {q && (
        <div className="glass rounded-2xl p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">{q.symbol}</span>
              {q.name && <span className="text-xs text-[var(--muted)] truncate max-w-40 hidden sm:inline">{q.name}</span>}
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide flex items-center gap-1.5 ${statePill.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statePill.dot}`} />
                {statePill.label}
              </span>
            </div>
            <div className="flex items-baseline gap-3 mt-0.5">
              <span className={`text-4xl font-black tabular-nums px-2 -mx-2 rounded-lg ${flash === "up" ? "flash-up" : flash === "down" ? "flash-down" : ""}`}>
                {fmtPrice(q.price)}
              </span>
              <span className={`text-sm font-bold tabular-nums ${changeColor}`}>
                {up ? "▲" : "▼"} {fmtPrice(q.change === null ? null : Math.abs(q.change))} ({q.changePercent === null ? "—" : Math.abs(q.changePercent).toFixed(2) + "%"})
              </span>
            </div>
          </div>

          {/* Intraday sparkline */}
          <div className="flex-1 min-w-56 h-16">
            {sparkData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparkData} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={up ? "#22c55e" : "#ef4444"} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={up ? "#22c55e" : "#ef4444"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                    labelFormatter={(l) => new Date(Number(l)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    formatter={(v) => [fmtPrice(Number(v)), "Price"]}
                  />
                  <Area type="monotone" dataKey="price" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth={1.5} fill="url(#sparkFill)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center text-xs text-[var(--muted)]">
                {live?.sparkError ? `⚠ ${live.sparkError}` : "Waiting for intraday data…"}
              </div>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs">
            <div>
              <p className="text-[var(--muted)]">Day Range</p>
              <p className="font-medium tabular-nums">{fmtPrice(q.dayLow)} – {fmtPrice(q.dayHigh)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">52W Range</p>
              <p className="font-medium tabular-nums">{fmtPrice(q.yearLow)} – {fmtPrice(q.yearHigh)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Volume</p>
              <p className="font-medium tabular-nums">{fmtVol(q.volume)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Last Quote</p>
              <p className="font-medium tabular-nums">{quoteTimeStr ?? "—"}{liveError ? " ⚠" : ""}</p>
            </div>
          </div>
        </div>
      )}
      {liveError && !q && (
        <p className="text-xs text-amber-500 dark:text-amber-400">⚠ Live feed: {liveError}</p>
      )}

      {error && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {loading && !view && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      )}

      {view && (
        <>
          {/* ─── Mega gauge header ─────────────────────────────── */}
          <div className="glass rounded-2xl p-6 glow">
            {totalEffectiveWeight === 0 && (
              <p className="mb-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
                All indicators are excluded (weight 0) — the Mega Score defaults to 50. Raise any weight below to include it.
              </p>
            )}
            <div className="flex flex-col lg:flex-row items-center gap-8">
              {/* Gauge */}
              <div className="relative w-48 h-48 flex-shrink-0">
                <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="var(--card-border)" strokeWidth="10" />
                  <circle cx="60" cy="60" r="50" fill="none" stroke={col} strokeWidth="10"
                    strokeDasharray={`${gaugeArc} ${circumference}`} strokeLinecap="round"
                    style={{ transition: "stroke-dasharray 0.4s ease, stroke 0.4s ease" }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-5xl font-black tabular-nums" style={{ color: col }}>{score.toFixed(1)}</span>
                  <span className="text-xs text-[var(--muted)]">MEGA SCORE / 100</span>
                  <span className="mt-1 text-2xl font-black" style={{ color: col }}>{view?.grade}</span>
                </div>
              </div>

              {/* Verdict + meta */}
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-bold mb-1">{scoreLabel(score)}</h2>
                <p className="text-sm text-[var(--muted)] mb-4">{view?.verdict}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="px-2.5 py-1 rounded-full bg-[var(--card-hover)] text-[var(--muted)]">
                    {view?.meta.technicalCount} indicators
                  </span>
                  {view?.meta.ticker && (
                    <span className="px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-500 dark:text-indigo-400 font-medium">
                      📉 {view.meta.ticker} · data to {view.meta.asOf} ({view.meta.dataSource})
                    </span>
                  )}
                </div>
                {view?.technicalError && (
                  <p className="mt-3 text-xs text-amber-500 dark:text-amber-400">⚠ {view.technicalError}</p>
                )}
              </div>

              {/* Category radar */}
              <div className="w-72 h-56 flex-shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="var(--grid-stroke)" />
                    <PolarAngleAxis dataKey="category" stroke="var(--muted)" tick={{ fontSize: 10 }} />
                    <PolarRadiusAxis stroke="var(--grid-stroke)" tick={false} domain={[0, 100]} />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }} />
                    <Radar name="Score" dataKey="score" stroke={col} fill={col} fillOpacity={0.25} strokeWidth={2} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* ─── Score history over time ──────────────────────── */}
          <div className="glass rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold">Mega Score Over Time</h3>
                <p className="text-xs text-[var(--muted)]">
                  Every indicator recomputed per day (trailing windows only — no look-ahead)
                  {history?.cached && " · cached"}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={overlayId}
                  onChange={(e) => setOverlayId(e.target.value)}
                  className="px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none max-w-56"
                  aria-label="Overlay indicator"
                >
                  <option value="">Composite only</option>
                  {(history ? Object.entries(history.indicatorNames) : []).map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
                <div className="flex items-center bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-0.5">
                  {[1, 3, 5, 10].map((y) => (
                    <button key={y} onClick={() => setHistoryYears(y)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        historyYears === y ? "bg-indigo-600 text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                      }`}>
                      {y}Y
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {historyLoading && !history ? (
              <div className="flex items-center justify-center py-16">
                <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" />
              </div>
            ) : historyData.length === 0 ? (
              <p className="text-sm text-[var(--muted)] text-center py-12">No history available for {ticker}.</p>
            ) : (
              <>
                {history?.warnings?.map((w, i) => (
                  <p key={i} className="mb-2 text-xs text-amber-500 dark:text-amber-400">⚠ {w}</p>
                ))}
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={historyData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" />
                    <XAxis
                      dataKey="date"
                      stroke="var(--muted)"
                      tick={{ fontSize: 10 }}
                      minTickGap={48}
                      tickFormatter={(v: string) => v.slice(0, 7)}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted)" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                      labelFormatter={(l) => String(l)}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine y={50} stroke="var(--grid-stroke)" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="score" name="Mega Score" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                    {overlayId && (
                      <Line type="monotone" dataKey="overlay" name={history?.indicatorNames[overlayId] ?? overlayId} stroke={scoreColor(historyData[historyData.length - 1]?.overlay ?? 50)} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </>
            )}
          </div>

          {/* ─── Contributions chart ───────────────────────────── */}
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">Top Contributions to the Mega Score</h3>
              <span className="text-xs text-[var(--muted)]">score × weight</span>
            </div>
            <ResponsiveContainer width="100%" height={Math.max(180, Math.min(360, (view?.contributions.length || 0) * 26))}>
              <BarChart data={(view?.contributions || []).slice(0, 12)} layout="vertical" margin={{ left: 80, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-stroke)" horizontal={false} />
                <XAxis type="number" stroke="var(--muted)" />
                <YAxis type="category" dataKey="name" stroke="var(--muted)" width={140} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }} />
                <Bar dataKey="contribution" radius={[0, 4, 4, 0]}>
                  {(view?.contributions || []).slice(0, 12).map((c) => (
                    <Cell key={c.id} fill={scoreColor(Math.min(100, (c.contribution / Math.max(1, (weights[c.id] ?? 1))) ))} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ─── Weight sliders grouped by category ────────────── */}
          <div className="glass rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h3 className="text-sm font-semibold">Indicator Weights</h3>
              <div className="flex items-center gap-3">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search indicator…"
                  className="px-3 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none w-48"
                />
                <span className="text-xs text-[var(--muted)]">
                  Total weight: <b className="text-[var(--foreground)]">{totalEffectiveWeight.toFixed(1)}</b> across {data?.indicators.length} indicators
                </span>
              </div>
            </div>

            <div className="space-y-3">
              {Object.entries(grouped).map(([cat, items]) => {
                const open = expandedCat === cat || search.length > 0;
                const catAvg = items.reduce((s, i) => s + i.score, 0) / items.length;
                const catWeight = items.reduce((s, i) => s + Math.max(0, weights[i.id] ?? 1), 0);
                return (
                  <div key={cat} className="border border-[var(--card-border)] rounded-xl overflow-hidden">
                    <button
                      onClick={() => setExpandedCat(open ? null : cat)}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-[var(--card-hover)] hover:bg-[var(--card-hover)]/70 transition-colors text-left"
                    >
                      <span>{categoryIcons[cat] || "•"}</span>
                      <span className="font-medium text-sm">{cat}</span>
                      <span className="text-xs text-[var(--muted)]">{items.length} indicators</span>
                      <div className="flex-1" />
                      <div className="w-24 h-2 rounded-full overflow-hidden bg-[var(--card-border)] hidden sm:block">
                        <div className="h-full rounded-full" style={{ width: `${catAvg}%`, background: scoreColor(catAvg) }} />
                      </div>
                      <span className="text-xs font-bold tabular-nums" style={{ color: scoreColor(catAvg) }}>{catAvg.toFixed(0)}</span>
                      <span className="text-[10px] text-[var(--muted)] w-16 text-right">Σw {catWeight.toFixed(1)}</span>
                      <svg className={`w-4 h-4 text-[var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    {open && (
                      <div className="divide-y divide-[var(--card-border)]">
                        {items.map((ind) => {
                          const w = weights[ind.id] ?? 1;
                          const wPct = totalEffectiveWeight > 0 ? (Math.max(0, w) / totalEffectiveWeight) * 100 : 0;
                          return (
                            <div key={ind.id} className={`px-4 py-3 transition-colors ${w <= 0 ? "opacity-50" : w > 1 ? "bg-indigo-500/[0.04]" : ""}`}>
                              <div className="flex flex-wrap items-center gap-3">
                                {/* Name + value */}
                                <div className="min-w-0 flex-1 basis-56">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium truncate">{ind.name}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card-hover)] text-[var(--muted)]">
                                      {ind.category === "Moving Averages" ? "MA" : "TA"}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-[var(--muted)] truncate">
                                    {ind.unit === "$" ? "$" : ""}{ind.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}{ind.unit !== "$" ? ` ${ind.unit}` : ""}
                                    {" · "}score {ind.score.toFixed(0)}
                                  </p>
                                </div>

                                {/* Score bar */}
                                <div className="w-20 h-2 rounded-full overflow-hidden bg-[var(--card-border)] hidden md:block">
                                  <div className="h-full rounded-full" style={{ width: `${ind.score}%`, background: scoreColor(ind.score) }} />
                                </div>

                                {/* Weight slider */}
                                <div className="flex items-center gap-2 basis-64">
                                  <input
                                    type="range" min={0} max={10} step={0.5}
                                    value={Math.min(10, w)}
                                    onChange={(e) => setWeight(ind.id, Number(e.target.value))}
                                    className="flex-1 accent-indigo-500"
                                    aria-label={`Weight for ${ind.name}`}
                                  />
                                  <input
                                    type="number" min={0} max={20} step={0.5}
                                    value={w}
                                    onChange={(e) => setWeight(ind.id, Math.max(0, Number(e.target.value)))}
                                    className="w-16 px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-xs tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                                    aria-label={`Exact weight for ${ind.name}`}
                                  />
                                  <span className="text-[10px] text-[var(--muted)] w-12 text-right tabular-nums">
                                    {wPct.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                              <p className="text-[10px] text-[var(--muted)] mt-1 line-clamp-1">{ind.description}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ─── Category roll-up table ────────────────────────── */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-4">Category Breakdown</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[var(--muted)] border-b border-[var(--card-border)]">
                    <th className="text-left py-2 font-medium">Category</th>
                    <th className="text-center py-2 font-medium">Weight Share</th>
                    <th className="text-right py-2 font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {(view?.categories || []).map((c) => (
                    <tr key={c.category} className="border-b border-[var(--card-border)] hover:bg-[var(--table-row-hover)]">
                      <td className="py-2.5 font-medium">{categoryIcons[c.category] || "•"} {c.category}</td>
                      <td className="py-2.5 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-24 h-2 rounded-full overflow-hidden bg-[var(--card-border)]">
                            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.min(100, c.weightShare)}%` }} />
                          </div>
                          <span className="text-xs tabular-nums">{c.weightShare.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-bold" style={{ color: scoreColor(c.score) }}>
                        {c.score.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
