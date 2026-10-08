"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell,
  AreaChart, Area, LineChart, Line, Legend, ReferenceLine,
} from "recharts";
import { scoreColor, scoreLabel, WeightMap } from "@/lib/mega-indicator";
import {
  scoreWithOverride,
  mergeFormula,
  isFormulaChanged,
  loadOverrides,
  saveOverrides,
  setOverride as setFormulaOverride,
  clearOverride as clearFormulaOverride,
  formulaLabel,
  type ScoreOverrideMap,
} from "@/lib/mega-overrides";
import {
  FUNCS,
  MAX_CUSTOM,
  MAX_FORMULA_LEN,
  MAX_NAME_LEN,
  VARS,
  loadCustom,
  newCustomId,
  parseFormula,
  saveCustom,
  type CustomIndicatorDef,
} from "@/lib/custom-indicators";
import { PanelBoard, ChartPanel } from "@/components/PanelBoard";

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
  /** Exact calculation, shown in the right-click inspector. */
  formula: string;
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
  /** Per-definition failures from user-defined indicators. */
  warnings?: string[];
  /** How many user-defined indicators evaluated successfully. */
  customCount?: number;
  error?: string;
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

interface SourceReport {
  source: string;
  ok: boolean;
  error?: string;
  price: number | null;
  changePercent: number | null;
  tradeTime: number | null;
  marketState: string | null;
  extended: boolean;
  ms: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

interface Verification {
  sourceCount: number;
  agreeing: number;
  spreadPct: number | null;
  verifiedBy: string[];
  sources: SourceReport[];
}

interface LiveResponse {
  quote: {
    symbol: string;
    price: number | null;
    previousClose: number | null;
    change: number | null;
    changePercent: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    volume: number | null;
    marketState: string | null;
    lastTradeTime: number | null;
    quoteTime: number | null;
    name?: string | null;
    yearLow?: number | null;
    yearHigh?: number | null;
    /** exchange quoting decimals (sub-$1 = 4) */
    priceHint?: number | null;
    /** best bid / ask across sources (mini-NBBO) */
    bid?: number | null;
    ask?: number | null;
    bidSize?: number | null;
    askSize?: number | null;
    bidSource?: string | null;
    askSource?: string | null;
    spreadAbs?: number | null;
    spreadPct?: number | null;
    // Kept for the extended-hours session badge (session inference)
    displayPrice?: number | null;
    displayChange?: number | null;
    displayChangePercent?: number | null;
    displaySession?: "pre" | "regular" | "post" | null;
  };
  verification: Verification;
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

const pct = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

const categoryIcons: Record<string, string> = {
  Technical: "📉",
  "Moving Averages": "📈",
  Custom: "🧩",
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
  // When the current payload arrived. Quote staleness is measured against this
  // instead of Date.now() during render (which is impure — react-hooks/purity).
  const [liveReceivedAt, setLiveReceivedAt] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const weightsInitRef = useRef(false);
  const prevPriceRef = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  // Per-indicator formula overrides (right-click editor) — persisted locally.
  // Lazy-initialised (loadOverrides guards SSR) so no setState-in-effect is needed.
  const [overrides, setOverrides] = useState<ScoreOverrideMap>(() => loadOverrides());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // ─── User-defined indicators ("Add Indicator" editor) ─────────
  // Definitions live in localStorage and are sent to the API, which compiles
  // and evaluates them against the same bar history as the built-ins.
  const [custom, setCustom] = useState<CustomIndicatorDef[]>(() => loadCustom());
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<CustomIndicatorDef | null>(null);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; value: number; score: number } | null>(null);
  const [previewErr, setPreviewErr] = useState<{ key: string; message: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);

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
        if (custom.length) params.set("custom", JSON.stringify(custom));
        const res = await fetch(`/api/mega-indicator?${params.toString()}`, { cache: "no-store" });
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
  }, [ticker, custom]);

  // Persist weights / preset / ticker on every change.
  useEffect(() => {
    if (!weightsInitRef.current) return; // don't save the empty initial state
    try {
      window.localStorage.setItem(LS_WEIGHTS, JSON.stringify(weights));
      window.localStorage.setItem(LS_PRESET, JSON.stringify(preset));
      window.localStorage.setItem(LS_TICKER, JSON.stringify(ticker));
    } catch { /* storage unavailable — ignore */ }
  }, [weights, preset, ticker]);

  // Persist per-indicator formula overrides on every change.
  useEffect(() => { saveOverrides(overrides); }, [overrides]);
  // Persist user-defined indicators on every change.
  useEffect(() => { saveCustom(custom); }, [custom]);
  // Escape closes the right-click formula editor.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  // ─── User-defined indicator editor ────────────────────────────
  const openIndicatorEditor = (def: CustomIndicatorDef) => {
    setDraft({ ...def });
    setDraftErr(null);
    setPreview(null);
    setPreviewErr(null);
    setEditorOpen(true);
  };

  const startNewIndicator = () => {
    // The cap is enforced on save (where the error is actually visible).
    openIndicatorEditor({
      id: newCustomId(),
      name: "",
      formula: "",
      direction: "higher",
      thresholds: [0, 1],
      unit: "",
      description: "",
    });
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setDraft(null);
    setDraftErr(null);
    setPreview(null);
    setPreviewErr(null);
  };

  const saveDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setDraftErr("Give the indicator a name."); return; }
    const parsed = parseFormula(draft.formula);
    if (!parsed.ok) { setDraftErr(parsed.error); return; }
    const [lo, hi] = draft.thresholds;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      setDraftErr("Thresholds must be two numbers in ascending order.");
      return;
    }
    const exists = custom.some((c) => c.id === draft.id);
    if (!exists && custom.length >= MAX_CUSTOM) {
      setDraftErr(`You can define up to ${MAX_CUSTOM} indicators — remove one first.`);
      return;
    }
    const def: CustomIndicatorDef = { ...draft, name, thresholds: [lo, hi] };
    setCustom((prev) => (exists ? prev.map((c) => (c.id === def.id ? def : c)) : [...prev, def]));
    closeEditor();
  };

  const removeCustomIndicator = (id: string) => {
    setCustom((prev) => prev.filter((c) => c.id !== id));
    setWeights((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setOverrides((m) => clearFormulaOverride(m, id));
    if (overlayId === id) setOverlayId("");
  };

  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeEditor(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  // Validation is pure, so it runs during render — the effect below therefore
  // never has to setState just to report a parse error.
  const draftState = useMemo(() => {
    if (!editorOpen || !draft || !draft.formula.trim()) return { kind: "empty" as const };
    const parsed = parseFormula(draft.formula);
    if (!parsed.ok) return { kind: "invalid" as const, message: parsed.error };
    const [lo, hi] = draft.thresholds;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      return { kind: "invalid" as const, message: "Thresholds must be two numbers in ascending order." };
    }
    return { kind: "ready" as const };
  }, [editorOpen, draft]);

  // Identifies which draft a fetched preview belongs to, so results that come
  // back after the user has moved on are simply ignored instead of cleared.
  const previewKey =
    draftState.kind === "ready" && draft
      ? JSON.stringify([draft.id, draft.name.trim(), draft.formula, draft.direction, draft.thresholds])
      : "";

  // Only show a preview/error that belongs to the draft as it stands right now.
  const livePreview = preview && preview.key === previewKey ? preview : null;
  const previewMessage =
    draftState.kind === "invalid"
      ? draftState.message
      : previewErr && previewErr.key === previewKey
        ? previewErr.message
        : null;

  // Live preview: compile the draft against the real bar history (debounced),
  // so the raw value and score are verified before anything is saved.
  useEffect(() => {
    if (draftState.kind !== "ready" || !draft) return;
    const key = previewKey;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ ticker });
        params.set("custom", JSON.stringify([{ ...draft, name: draft.name.trim() || "Preview" }]));
        const res = await fetch(`/api/mega-indicator?${params.toString()}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        const ind = (json.indicators || []).find((i: { id: string }) => i.id === draft.id);
        if (ind) {
          setPreview({ key, value: ind.value as number, score: ind.score as number });
          setPreviewErr(null);
        } else {
          setPreviewErr({
            key,
            message:
              (Array.isArray(json.warnings) && json.warnings[0]) ||
              "The formula produced no value for this ticker — check the lookback period.",
          });
        }
      } catch (e) {
        if (!cancelled) {
          setPreviewErr({ key, message: e instanceof Error ? e.message : "Preview failed." });
        }
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draftState.kind, draft, previewKey, ticker]);

  // Fetch score history when ticker or horizon changes (weights intentionally
  // NOT a dependency — even-weight history is cached and instant; refetching on
  // every slider move would be slow and noisy). User-defined indicators ARE a
  // dependency: they change which series the history contains, and the server
  // caches the result keyed by their definitions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      try {
        const params = new URLSearchParams({ ticker, years: String(historyYears) });
        if (custom.length) params.set("custom", JSON.stringify(custom));
        const res = await fetch(`/api/mega-history?${params.toString()}`, { cache: "no-store" });
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
  }, [ticker, historyYears, custom]);

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
        const res = await fetch(`/api/live-quote?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setLive(json);
        setLiveReceivedAt(Date.now());
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

  // Indicators with their score re-normalized through the user's formula
  // overrides (right-click editor). No override → the server object is returned
  // unchanged, so default accuracy is identical to before.
  const scored = useMemo(() => {
    if (!data) return [];
    return data.indicators.map((i) => {
      const ov = overrides[i.id];
      if (!ov) return i;
      const s = scoreWithOverride(i.value, { direction: i.direction, thresholds: i.thresholds }, ov);
      return { ...i, score: Math.round(s * 10) / 10 };
    });
  }, [data, overrides]);

  // Local live recompute of the composite from weights (instant slider feedback),
  // while the server value is the source of truth after each fetch.
  const view = useMemo(() => {
    if (!data) return null;
    const enabled = scored.filter((i) => (weights[i.id] ?? 1) > 0);
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
  }, [data, scored, weights]);

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

  // How many indicators currently have a custom (right-click) formula.
  const customFormulaCount = useMemo(
    () =>
      (data?.indicators || []).filter((i) =>
        isFormulaChanged({ direction: i.direction, thresholds: i.thresholds }, overrides[i.id])
      ).length,
    [data, overrides]
  );

  const grouped = useMemo(() => {
    const g: Record<string, MegaIndicator[]> = {};
    for (const i of scored) {
      if (search && !i.name.toLowerCase().includes(search.toLowerCase())) continue;
      if (!g[i.category]) g[i.category] = [];
      g[i.category].push(i);
    }
    return g;
  }, [scored, search]);

  const radarData = (view?.categories || [])
    .filter((c) => c.weightShare > 0)
    .map((c) => ({ category: c.category, score: c.score }));

  const score = view?.score ?? 0;
  const col = scoreColor(score);
  const circumference = 2 * Math.PI * 50;

  const gaugeArc = (score / 100) * circumference;

  // ─── Live strip helpers ─────────────────────────────────────────
  const q = live?.quote || null;
  // The API headline is already the freshest multi-source extended-hours
  // price; derive the session label from the market state for the badge.
  const sessionOf = (ms: string | null): "pre" | "regular" | "post" => {
    const s = (ms || "").toUpperCase();
    if (s.startsWith("PRE")) return "pre";
    if (s.startsWith("POST")) return "post";
    return "regular";
  };
  const disp = q && q.price != null
    ? { price: q.displayPrice ?? q.price, change: q.displayChange ?? q.change, pct: q.displayChangePercent ?? q.changePercent, session: q.displaySession ?? sessionOf(q.marketState) }
    : null;
  const up = (disp?.change ?? 0) >= 0;
  const changeColor = disp ? ((disp.change ?? 0) >= 0 ? "text-emerald-500" : "text-red-500") : "";
  // Exchange quoting decimals: sub-$1 symbols quote at 4 dp (priceHint from
  // Yahoo meta / Nasdaq), everything else 2. Min 2 keeps big prices clean.
  const hint = live?.quote?.priceHint ?? 2;
  const fmtPrice = (v: number | null) =>
    v === null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, hint) });
  const fmtVol = (v: number | null) => {
    if (v === null) return "—";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  };
  const fmtSize = (v: number | null | undefined) =>
    v == null ? null : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v));
  const statePill = (() => {
    const s = q?.marketState || "";
    if (s === "REGULAR") return { label: "MARKET OPEN", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500 animate-pulse" };
    if (s.startsWith("PRE")) return { label: "PRE-MARKET", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" };
    if (s.startsWith("POST")) return { label: "AFTER HOURS", cls: "bg-indigo-500/15 text-indigo-500 dark:text-indigo-400", dot: "bg-indigo-400" };
    return { label: "MARKET CLOSED", cls: "bg-[var(--card-hover)] text-[var(--muted)]", dot: "bg-[var(--muted)]" };
  })();
  const sessionBadge = (() => {
    if (disp?.session === "post") return { label: "EXT · Post-market", cls: "bg-indigo-500/10 text-indigo-500 dark:text-indigo-400" };
    if (disp?.session === "pre") return { label: "EXT · Pre-market", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
    return null;
  })();
  const sparkData = (live?.spark || []).map((p) => ({ t: p.t, price: p.price }));
  // Show the newest trade time in ANY session (lastTradeTime), not the regular
  // quote time — during pre/post hours regularMarketTime points at yesterday's
  // 16:00 close, which made a live pre-market feed look a day stale.
  const lastTradeMs = q?.lastTradeTime ?? q?.quoteTime ?? null;
  const quoteTimeStr = lastTradeMs
    ? new Date(lastTradeMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  // Age relative to when THIS payload arrived, not the wall clock at render
  // time: the poll refreshes both values together, so staleness still trips
  // when a feed stops moving, without an impure call in render.
  const quoteAge = lastTradeMs && liveReceivedAt ? liveReceivedAt - lastTradeMs : null;
  const quoteStale = quoteAge != null && quoteAge > 15 * 60_000;
  const sessionNote =
    disp?.session === "pre" ? "Today's pre-market vs yesterday's close"
    : disp?.session === "post" ? "Today's after-hours vs today's close"
    : "Regular session vs yesterday's close";
  const verification = live?.verification ?? null;
  const [showSources, setShowSources] = useState(false);

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
                {fmtPrice(disp?.price ?? q.price)}
              </span>
              {sessionBadge && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${sessionBadge.cls}`}>
                  {sessionBadge.label}
                </span>
              )}
              <span className={`text-sm font-bold tabular-nums ${changeColor}`}>
                {up ? "▲" : "▼"} {fmtPrice(disp?.change === null || disp?.change === undefined ? null : Math.abs(disp.change))} ({disp?.pct == null ? "—" : Math.abs(disp.pct).toFixed(2) + "%"})
              </span>
              <span className="text-[11px] text-[var(--muted)]">{sessionNote}</span>
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
              <p className="text-[var(--muted)]">Live Price</p>
              <p className="font-semibold tabular-nums text-[var(--foreground)]">{fmtPrice(disp?.price ?? q.price)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Prev Close</p>
              <p className="font-medium tabular-nums">{fmtPrice(q.previousClose)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">
                Bid{q.bidSource ? <span className="ml-1 text-[10px] opacity-60">{q.bidSource}</span> : null}
              </p>
              <p className="font-medium tabular-nums" title={q.bidSource ? `Best bid via ${q.bidSource}` : undefined}>
                {fmtPrice(q.bid ?? null)}{q.bidSize != null && fmtSize(q.bidSize) ? <span className="text-[var(--muted)]"> ×{fmtSize(q.bidSize)}</span> : null}
              </p>
            </div>
            <div>
              <p className="text-[var(--muted)]">
                Ask{q.askSource ? <span className="ml-1 text-[10px] opacity-60">{q.askSource}</span> : null}
              </p>
              <p className="font-medium tabular-nums" title={q.spreadPct != null ? `Best ask via ${q.askSource ?? ""} · spread ${fmtPrice(q.spreadAbs ?? null)} (${q.spreadPct.toFixed(2)}%)` : undefined}>
                {fmtPrice(q.ask ?? null)}{q.askSize != null && fmtSize(q.askSize) ? <span className="text-[var(--muted)]"> ×{fmtSize(q.askSize)}</span> : null}
                {q.spreadPct != null && <span className="ml-1.5 text-[10px] text-[var(--muted)]">{q.spreadPct.toFixed(2)}% spr</span>}
              </p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Day Range</p>
              <p className="font-medium tabular-nums">{fmtPrice(q.dayLow)} – {fmtPrice(q.dayHigh)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">52W Range</p>
              <p className="font-medium tabular-nums">{fmtPrice(q.yearLow ?? null)} – {fmtPrice(q.yearHigh ?? null)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Volume</p>
              <p className="font-medium tabular-nums">{fmtVol(q.volume)}</p>
            </div>
            <div>
              <p className="text-[var(--muted)]">Last Trade</p>
              <p className={`font-medium tabular-nums ${quoteStale ? "text-amber-500 dark:text-amber-400" : ""}`}>
                {quoteTimeStr ?? "—"}{liveError ? " ⚠" : ""}
              </p>
            </div>
          </div>

          {/* ─── Multi-source verification toggle ─────────────── */}
          {verification && verification.sourceCount > 0 && (
            <div className="w-full border-t border-[var(--card-border)] pt-2">
              <button
                onClick={() => setShowSources(v => !v)}
                className="flex items-center gap-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                title="Per-source prices from five independent free feeds"
              >
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                  verification.agreeing >= 3 ? "bg-emerald-500/10 text-[var(--success)]" :
                  verification.agreeing >= 2 ? "bg-amber-500/10 text-[var(--warning)]" :
                  "bg-red-500/10 text-[var(--danger)]"
                }`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                  {verification.agreeing}/{verification.sourceCount} sources live
                </span>
                {verification.spreadPct != null && (
                  <span className="tabular-nums">spread {verification.spreadPct.toFixed(2)}%</span>
                )}
                <span className="underline decoration-dotted">details</span>
              </button>
              {showSources && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  {verification.sources.map((s) => (
                    <div key={s.source} className={`rounded-lg border p-2 text-xs ${
                      s.ok && s.price != null ? "border-[var(--card-border)] bg-[var(--card-hover)]" : "border-red-500/30 bg-red-500/5"
                    }`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{s.source}</span>
                        <span className={`w-1.5 h-1.5 rounded-full ${s.ok && s.price != null ? "bg-[var(--success)]" : "bg-[var(--danger)]"}`} />
                      </div>
                      {s.ok && s.price != null ? (
                        <>
                          <div className="tabular-nums font-medium mt-0.5">{fmtPrice(s.price)}</div>
                          <div className={`tabular-nums ${(s.changePercent ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                            {s.changePercent != null ? pct(s.changePercent) : "—"}
                          </div>
                          <div className="text-[10px] text-[var(--muted)] mt-0.5">
                            {s.tradeTime ? new Date(s.tradeTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "no time"}
                            {s.extended ? " · ext" : ""} · {s.ms}ms
                          </div>
                        </>
                      ) : (
                        <div className="text-[var(--danger)] mt-0.5 truncate" title={s.error}>{s.error ?? "failed"}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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
        <PanelBoard
          boardKey="mega-indicator"
          ids={["mega-score", "score-history", "contributions", "weights", "category"]}
          className="grid grid-cols-1 gap-6"
        >
          {/* ─── Mega gauge header ─────────────────────────────── */}
          <ChartPanel
            id="mega-score"
            title="Mega Score"
            subtitle="Composite technical health (0–100) — drag to move, ⤢ to expand"
            className="glow"
          >
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
                {view?.warnings && view.warnings.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {view.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-500 dark:text-amber-400">⚠ {w}</p>
                    ))}
                  </div>
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
          </ChartPanel>

          {/* ─── Score history over time ──────────────────────── */}
          <ChartPanel
            id="score-history"
            title="Mega Score Over Time"
            subtitle={<>Every indicator recomputed per day (trailing windows only — no look-ahead){history?.cached && " · cached"}</>}
            right={
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
                  {([
                    { y: 1 / 12, label: "1M (30d)" },
                    { y: 0.5, label: "6M" },
                    { y: 1, label: "1Y" },
                    { y: 3, label: "3Y" },
                    { y: 5, label: "5Y" },
                    { y: 10, label: "10Y" },
                  ] as Array<{ y: number; label: string }>).map(({ y, label }) => (
                    <button key={label} onClick={() => setHistoryYears(y)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        historyYears === y ? "bg-indigo-600 text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
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
          </ChartPanel>

          {/* ─── Contributions chart ───────────────────────────── */}
          <ChartPanel
            id="contributions"
            title="Top Contributions to the Mega Score"
            right={<span className="text-xs text-[var(--muted)]">score × weight</span>}
          >
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
          </ChartPanel>

          {/* ─── Weight sliders grouped by category ────────────── */}
          <ChartPanel
            id="weights"
            title="Indicator Weights"
            right={
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={startNewIndicator}
                  title="Define your own indicator from a formula over OHLCV"
                  className="text-xs px-2.5 py-1.5 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 font-medium"
                >
                  ＋ Add Indicator
                </button>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search indicator…"
                  className="px-3 py-1.5 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none w-48"
                />
                <span className="text-xs text-[var(--muted)]">
                  Total weight: <b className="text-[var(--foreground)]">{totalEffectiveWeight.toFixed(1)}</b> across {data?.indicators.length} indicators
                  <span className="hidden sm:inline"> · right-click an indicator to edit its formula</span>
                </span>
                {customFormulaCount > 0 && (
                  <button
                    onClick={() => setOverrides({})}
                    title="Reset every custom formula back to the defaults"
                    className="text-xs px-2 py-1 rounded border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10"
                  >
                    Reset {customFormulaCount} formula{customFormulaCount > 1 ? "s" : ""}
                  </button>
                )}
              </div>
            }
          >
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
                            <div key={ind.id}
                              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: ind.id, x: e.clientX, y: e.clientY }); }}
                              title="Right-click to edit this indicator's formula"
                              className={`px-4 py-3 transition-colors cursor-context-menu ${w <= 0 ? "opacity-50" : w > 1 ? "bg-indigo-500/[0.04]" : ""}`}>
                              <div className="flex flex-wrap items-center gap-3">
                                {/* Name + value */}
                                <div className="min-w-0 flex-1 basis-56">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium truncate">{ind.name}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card-hover)] text-[var(--muted)]">
                                      {ind.category === "Custom" ? "MY" : ind.category === "Moving Averages" ? "MA" : "TA"}
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
                              <p className="text-[10px] mt-0.5 flex items-center gap-1.5">
                                <span className="text-[var(--muted)]">
                                  ƒ {formulaLabel(mergeFormula({ direction: ind.direction, thresholds: ind.thresholds }, overrides[ind.id]))}
                                </span>
                                {isFormulaChanged({ direction: ind.direction, thresholds: ind.thresholds }, overrides[ind.id]) && (
                                  <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">custom</span>
                                )}
                                {ind.category === "Custom" && custom.find((c) => c.id === ind.id) && (
                                  <span className="flex items-center gap-1.5 ml-auto">
                                    <button
                                      onClick={() => openIndicatorEditor(custom.find((c) => c.id === ind.id)!)}
                                      className="px-1.5 py-0.5 rounded border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                                    >
                                      Edit formula
                                    </button>
                                    <button
                                      onClick={() => removeCustomIndicator(ind.id)}
                                      className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
                                    >
                                      Remove
                                    </button>
                                  </span>
                                )}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ChartPanel>

          {/* ─── Category roll-up table ────────────────────────── */}
          <ChartPanel id="category" title="Category Breakdown">
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
          </ChartPanel>
        </PanelBoard>
      )}

      {/* ─── Add / edit a user-defined indicator ────────────────── */}
      {editorOpen && draft && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
          onClick={closeEditor}
          onContextMenu={(e) => { e.preventDefault(); closeEditor(); }}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-[var(--card-border)] bg-[var(--card)] shadow-2xl p-5 space-y-4 my-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">{custom.some((c) => c.id === draft.id) ? "Edit Indicator" : "Add Indicator"}</h3>
                <p className="text-xs text-[var(--muted)]">
                  Your formula is compiled and evaluated on the same daily bars as the built-ins.
                </p>
              </div>
              <button onClick={closeEditor} className="text-[var(--muted)] hover:text-[var(--foreground)]" aria-label="Close">✕</button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="sm:col-span-2 block">
                <span className="text-xs text-[var(--muted)]">Name</span>
                <input
                  value={draft.name}
                  maxLength={MAX_NAME_LEN}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. Price vs 200-day EMA"
                  className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-[var(--muted)]">Unit</span>
                <input
                  value={draft.unit}
                  maxLength={8}
                  onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                  placeholder="%, x, $ …"
                  className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs text-[var(--muted)]">
                Formula — evaluated bar by bar, the latest value is scored
              </span>
              <textarea
                rows={3}
                value={draft.formula}
                maxLength={MAX_FORMULA_LEN}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, formula: e.target.value })}
                placeholder="(close - sma(close, 20)) / sma(close, 20) * 100"
                className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </label>

            <div className="flex items-start justify-between gap-3 text-xs min-h-[1.25rem]">
              {livePreview ? (
                <span className="text-emerald-500 dark:text-emerald-400">
                  ✓ <b>{draft.name.trim() || "Preview"}</b>{" "}
                  <b className="tabular-nums">{livePreview.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}</b>
                  {draft.unit && draft.unit !== "$" ? ` ${draft.unit}` : ""}
                  {" → score "}
                  <b className="tabular-nums" style={{ color: scoreColor(livePreview.score) }}>{livePreview.score.toFixed(1)}</b>
                </span>
              ) : previewMessage ? (
                <span className="text-red-500 dark:text-red-400">⚠ {previewMessage}</span>
              ) : draftState.kind === "ready" ? (
                <span className="text-[var(--muted)]">Checking against {ticker}…</span>
              ) : (
                <span className="text-[var(--muted)]">Type a formula to preview it against {ticker}…</span>
              )}
              <button
                onClick={() => setShowHelp((v) => !v)}
                className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)] underline decoration-dotted"
              >
                {showHelp ? "Hide" : "Functions"}
              </button>
            </div>

            {showHelp && (
              <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-hover)] p-3 text-[11px] space-y-2 max-h-52 overflow-y-auto">
                <p className="text-[var(--muted)]"><b>Variables</b></p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(VARS).map(([k, v]) => (
                    <button
                      key={k}
                      onClick={() => setDraft({ ...draft, formula: `${draft.formula}${draft.formula ? " " : ""}${k}` })}
                      className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 font-mono hover:bg-indigo-500/25"
                      title={v}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <p className="text-[var(--muted)] pt-1"><b>Functions</b> — click to insert</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(FUNCS).map(([k, f]) => (
                    <button
                      key={k}
                      onClick={() => setDraft({ ...draft, formula: `${draft.formula}${draft.formula ? " " : ""}${k}(` })}
                      className="px-1.5 py-0.5 rounded bg-[var(--card)] border border-[var(--card-border)] font-mono hover:border-indigo-500/50"
                      title={f.help}
                    >
                      {k}()
                    </button>
                  ))}
                </div>
                <p className="text-[var(--muted)] pt-1">
                  Operators: <b>+ − * / % ^</b> and comparisons <b>&gt; &lt; &gt;= &lt;= == !=</b> (1/0).
                  Lookback periods must be whole numbers.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs text-[var(--muted)]">What scores better</span>
                <select
                  value={draft.direction}
                  onChange={(e) => setDraft({ ...draft, direction: e.target.value as CustomIndicatorDef["direction"] })}
                  className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="higher">Higher is better</option>
                  <option value="lower">Lower is better</option>
                  <option value="band">Healthy band (peak in the middle)</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-[var(--muted)]">
                  {draft.direction === "higher" ? "Bad (→0)" : draft.direction === "lower" ? "Good (→100)" : "Band low"}
                </span>
                <input
                  type="number"
                  step="any"
                  value={draft.thresholds[0]}
                  onChange={(e) => setDraft({ ...draft, thresholds: [Number(e.target.value), draft.thresholds[1]] })}
                  className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-[var(--muted)]">
                  {draft.direction === "higher" ? "Good (→100)" : draft.direction === "lower" ? "Bad (→0)" : "Band high"}
                </span>
                <input
                  type="number"
                  step="any"
                  value={draft.thresholds[1]}
                  onChange={(e) => setDraft({ ...draft, thresholds: [draft.thresholds[0], Number(e.target.value)] })}
                  className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs text-[var(--muted)]">Description (optional)</span>
              <input
                value={draft.description}
                maxLength={160}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="How to read this indicator"
                className="w-full mt-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
              />
            </label>

            {draftErr && (
              <p className="text-xs text-red-500 dark:text-red-400">⚠ {draftErr}</p>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-[var(--muted)]">
                {custom.length} / {MAX_CUSTOM} custom indicators · saved on this device
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={closeEditor}
                  className="px-3 py-2 text-sm rounded-lg border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
                <button
                  onClick={saveDraft}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
                >
                  Save indicator
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Right-click formula editor for a single indicator */}
      {menu && data && (() => {
        const ind = data.indicators.find((i) => i.id === menu.id);
        if (!ind) return null;
        const base = { direction: ind.direction, thresholds: ind.thresholds };
        const ov = overrides[ind.id] || {};
        const eff = mergeFormula(base, ov);
        const changed = isFormulaChanged(base, ov);
        const px = typeof window !== "undefined" ? Math.min(menu.x, window.innerWidth - 300) : menu.x;
        const py = typeof window !== "undefined" ? Math.min(menu.y, window.innerHeight - 350) : menu.y;
        const w = weights[ind.id] ?? 1;
        return (
          <div
            className="fixed inset-0 z-50"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          >
            <div
              className="absolute w-80 rounded-xl border border-[var(--card-border)] bg-[var(--card)] shadow-2xl p-3 text-xs space-y-2 max-h-[85vh] overflow-y-auto"
              style={{ left: Math.max(8, px), top: Math.max(8, py) }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm truncate" title={ind.name}>{ind.name}</span>
                <button onClick={() => setMenu(null)} className="text-[var(--muted)] hover:text-[var(--foreground)]" aria-label="Close">✕</button>
              </div>

              {/* What it does */}
              <p className="text-[11px] leading-relaxed text-[var(--foreground)]">{ind.description}</p>

              {/* The exact calculation behind the number */}
              <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card-hover)] p-2">
                <p className="text-[9.5px] uppercase tracking-wider text-[var(--muted)] mb-1">How it&apos;s calculated</p>
                <p className="font-mono text-[10.5px] leading-relaxed break-words">
                  {ind.formula || "—"}
                </p>
                <p className="text-[10px] text-[var(--muted)] mt-1.5">
                  Reading: {ind.direction === "higher" ? "higher is healthier" : ind.direction === "lower" ? "lower is healthier" : "middle of the band is healthiest"}
                  {" · "}score {scoreWithOverride(ind.value, base, ov).toFixed(1)} / 100
                </p>
              </div>

              <p className="text-[10px] text-[var(--muted)]">
                Scoring rule: <b className={changed ? "text-indigo-300" : "text-[var(--foreground)]"}>{formulaLabel(eff)}</b>
              </p>

              <label className="block">
                <span className="text-[10px] text-[var(--muted)]">Weight</span>
                <div className="flex items-center gap-2">
                  <input
                    type="range" min={0} max={10} step={0.5}
                    value={Math.min(10, w)}
                    onChange={(e) => setWeight(ind.id, Number(e.target.value))}
                    className="flex-1 accent-indigo-500"
                  />
                  <input
                    type="number" min={0} max={20} step={0.5}
                    value={w}
                    onChange={(e) => setWeight(ind.id, Math.max(0, Number(e.target.value)))}
                    className="w-16 px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              </label>

              <label className="block">
                <span className="text-[10px] text-[var(--muted)]">Direction (what scores better)</span>
                <select
                  value={eff.direction}
                  onChange={(e) => setOverrides((m) => setFormulaOverride(m, ind.id, { direction: e.target.value as "higher" | "lower" | "band" }))}
                  className="w-full mt-0.5 px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  <option value="higher">Higher is better</option>
                  <option value="lower">Lower is better</option>
                  <option value="band">Healthy band (peak in the middle)</option>
                </select>
              </label>

              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className="text-[10px] text-[var(--muted)]">{eff.direction === "higher" ? "Bad (→0)" : eff.direction === "lower" ? "Good (→100)" : "Band low"}</span>
                  <input
                    type="number" step="any"
                    value={eff.thresholds[0]}
                    onChange={(e) => setOverrides((m) => setFormulaOverride(m, ind.id, { thresholds: [Number(e.target.value), eff.thresholds[1]] }))}
                    className="w-full mt-0.5 px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </label>
                <label className="flex-1">
                  <span className="text-[10px] text-[var(--muted)]">{eff.direction === "higher" ? "Good (→100)" : eff.direction === "lower" ? "Bad (→0)" : "Band high"}</span>
                  <input
                    type="number" step="any"
                    value={eff.thresholds[1]}
                    onChange={(e) => setOverrides((m) => setFormulaOverride(m, ind.id, { thresholds: [eff.thresholds[0], Number(e.target.value)] }))}
                    className="w-full mt-0.5 px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded tabular-nums focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </label>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => setOverrides((m) => clearFormulaOverride(m, ind.id))}
                  disabled={!changed}
                  className="px-2 py-1 rounded border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Reset formula
                </button>
                <button
                  onClick={() => { setWeight(ind.id, 0); setMenu(null); }}
                  className="px-2 py-1 rounded border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Exclude
                </button>
              </div>
              <p className="text-[10px] text-[var(--muted)]">
                Raw {ind.value.toLocaleString(undefined, { maximumFractionDigits: 3 })}{ind.unit !== "$" ? ` ${ind.unit}` : ""} → score {scoreWithOverride(ind.value, base, ov).toFixed(1)}
              </p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
