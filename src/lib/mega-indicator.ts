// Mega Indicator — blends every technical indicator into one composite score,
// with fully adjustable per-indicator weights.
//
// How it works:
// 1. Every raw indicator (computed from daily OHLCV via lib/ta) is assigned a
//    "direction": higher-is-better, lower-is-better, or a neutral band
//    (distance from the middle of the band is what is scored).
// 2. Raw values are normalized to a 0-100 health score using those thresholds.
// 3. Each indicator has a user-set weight (default: every indicator gets 1).
// 4. The Mega Score is the weighted average of all non-excluded indicator scores,
//    rescaled so the weights of excluded/missing indicators are redistributed.

export type Direction = "higher" | "lower" | "band";

/** Threshold spec for one indicator. */
export interface IndicatorSpec {
  id: string;
  name: string;
  category: string;
  unit: string;
  direction: Direction;
  /** For "higher": [bad, good]. For "lower": [good, bad]. For "band": [lowOk, highOk]. */
  thresholds: [number, number];
  description: string;
  /** The exact calculation, written out — shown verbatim in the UI. */
  formula: string;
}

/** One computed indicator, ready to display. */
export interface MegaIndicator {
  id: string;
  name: string;
  category: string;
  unit: string;
  value: number;
  score: number;      // 0-100 health score (normalized)
  weight: number;     // user weight (arbitrary scale, normalized across all)
  enabled: boolean;   // excluded indicators don't affect the composite
  direction: Direction;
  thresholds: [number, number];
  description: string;
  formula: string;
}

export interface MegaCategorySummary {
  category: string;
  score: number;
  weightShare: number; // percent of total effective weight
}

export interface MegaResult {
  score: number;               // 0-100 composite
  grade: string;               // A+ .. F
  verdict: string;             // human-readable verdict
  indicators: MegaIndicator[];
  categories: MegaCategorySummary[];
  contributions: Array<{ id: string; name: string; contribution: number }>; // contribution to composite (score*weight)
  meta: {
    asOf: string | null;       // last price date
    ticker: string | null;
    dataSource: "cache" | "yahoo" | "none";
    technicalCount: number;
  };
}

// ─── Indicator registry ────────────────────────────────────────
// All specs are technical: computed server-side from daily OHLCV.

const T = (id: string, name: string, unit: string, direction: Direction, thresholds: [number, number], description: string, formula: string): IndicatorSpec =>
  ({ id, name, category: "Technical", unit, direction, thresholds, description, formula });

const M = (id: string, name: string, description: string, formula: string): IndicatorSpec =>
  ({ id, name, category: "Moving Averages", unit: "%", direction: "higher", thresholds: [-1, 1], description, formula });

export const TECHNICAL_SPECS: IndicatorSpec[] = [
  T("ta-trend-50-200", "Trend (50/200 SMA)", "x", "higher", [0, 0.05],
    "Price vs 50/200-day moving averages. Positive = uptrend.",
    "Trend = mean( (close/SMA(50) − 1)·100 , (close/SMA(200) − 1)·100 ),  SMA(n) = (1/n)·Σ close[t−i]"),
  T("ta-rsi-14", "RSI (14)", "", "band", [30, 70],
    "Momentum oscillator. 30-70 is the normal range; <30 oversold, >70 overbought.",
    "AvgGain = (AvgGain[prev]·13 + gain)/14  (Wilder, same for AvgLoss);  RS = AvgGain/AvgLoss;  RSI = 100 − 100/(1+RS)"),
  T("ta-macd-hist", "MACD Histogram", "x", "higher", [0, 0],
    "MACD line minus signal line. Positive = bullish momentum.",
    "MACD = EMA(12,close) − EMA(26,close);  Signal = EMA(9,MACD);  Histogram% = (MACD − Signal)/close · 100"),
  T("ta-bb-pos", "Bollinger Position", "%", "band", [20, 80],
    "Where price sits inside the Bollinger Bands (0=lower, 100=upper).",
    "%B = (close − Lower)/(Upper − Lower)·100,  with Upper/Lower = SMA(20) ± 2·σ(20, close)"),
  T("ta-atr-pct", "ATR %", "%", "band", [1, 5],
    "Average True Range as % of price. Moderate volatility is ideal.",
    "TR = max(H−L, |H−close[prev]|, |L−close[prev]|);  ATR = Wilder₁₄(TR);  ATR% = ATR/close · 100"),
  T("ta-stoch-k", "Stochastic %K (14,3,3)", "%", "band", [20, 80],
    "Slow %K: close's position in the 14-day high-low range, smoothed twice. 20-80 healthy; <20 oversold, >80 overbought.",
    "Raw%K = 100·(close − LL(14))/(HH(14) − LL(14));  %K = SMA(3, Raw%K)"),
  T("ta-stoch-d", "Stochastic %D (14,3,3)", "%", "band", [20, 80],
    "Signal line of the stochastic oscillator (3-period average of %K). 20-80 healthy; crossing %K signals momentum turns.",
    "%D = SMA(3, %K)"),
  T("ta-cci-20", "CCI (20)", "", "band", [-100, 100],
    "Commodity Channel Index over 20 bars. Inside ±100 is normal; beyond = extended move.",
    "TP = (H+L+close)/3;  CCI = (TP − SMA(20,TP)) / (0.015 · MAD),  MAD = mean|TP − SMA(20,TP)| over 20 bars"),
  T("ta-vol-3d", "3-Day Volatility", "%", "band", [0.5, 3],
    "Standard deviation of the last 3 closes, as % of price. Low = calm, high = unstable.",
    "σ₃ = stdev(close, 3) with the n−1 denominator;  Volatility% = σ₃/close · 100"),
  T("ta-mom-63", "3-Month Momentum", "%", "higher", [0, 5],
    "Price change over ~3 months. Positive = sustained strength.",
    "Momentum% = (close/close[t−63] − 1) · 100"),
  T("ta-vol-ratio", "Volume vs 20-Day Avg", "x", "band", [0.6, 2.5],
    "Recent volume vs average. Extreme spikes can signal distribution.",
    "Ratio = mean(volume[t−4..t]) / SMA(20, volume)"),
  T("ta-dist-52w-high", "Distance from 52-Week High", "%", "band", [5, 25],
    "How far price is below its 52-week high. Near-high = strength, far = damage.",
    "Distance% = (close − HH(252)) / HH(252) · 100"),
  T("ta-er-10", "Efficiency Ratio (Kaufman, 10)", "", "higher", [0.15, 0.45],
    "Kaufman Efficiency Ratio: net move / total path over 10 bars. High = clean trend, low = chop.",
    "ER = |close[t] − close[t−10]| / Σᵢ₌₁..₁₀ |close[t−i+1] − close[t−i]|"),
  T("ta-kernel-slope", "Kernel Regression Slope", "%/bar", "higher", [-0.05, 0.05],
    "Slope of the Nadaraya-Watson kernel trend, in % of price per bar. Positive = BUY regime.",
    "ŷ(t) = Σᵢ wᵢ·close[t+i] / Σᵢ wᵢ with wᵢ = exp(−i²/(2·8²)),  Slope% = (ŷ(t) − ŷ(t−1))/ŷ(t−1) · 100"),
  T("ta-kernel-residual", "Kernel Residual", "%", "band", [0.5, 3],
    "Typical deviation of price from the kernel trend line. Low = smooth trend, high = choppy/unsafe.",
    "Residual% = stdev(close − ŷ, 20 bars) / |ŷ| · 100"),
];

// SMA/EMA family (SMA/EMA 10-200 with BUY/SELL signals). Scored as
// price-vs-MA distance: above the MA = bullish.
export const MA_PERIODS = [10, 20, 30, 40, 50, 100, 150, 200] as const;
for (const p of MA_PERIODS) {
  TECHNICAL_SPECS.push(
    M(`ta-sma-${p}`, `Price vs SMA-${p}`,
      `Price distance to the ${p}-day simple moving average. Above = BUY, below = SELL.`,
      `SMA(${p}) = (1/${p})·Σ close[t−i];  Δ% = (close − SMA(${p}))/SMA(${p}) · 100`),
    M(`ta-ema-${p}`, `Price vs EMA-${p}`,
      `Price distance to the ${p}-day exponential moving average. Above = BUY, below = SELL.`,
      `EMA(${p}) = close·k + EMA[prev]·(1−k) with k = 2/${p + 1};  Δ% = (close − EMA(${p}))/EMA(${p}) · 100`),
  );
}

export const ALL_SPECS: IndicatorSpec[] = [...TECHNICAL_SPECS];

/**
 * Build an IndicatorSpec for a user-defined (custom) indicator. Custom
 * indicators are computed from OHLCV by lib/custom-indicators and flow through
 * the exact same scoring/weighting path as the built-ins above.
 */
export function customSpec(def: {
  id: string;
  name: string;
  category?: string;
  unit?: string;
  direction: Direction;
  thresholds: [number, number];
  description: string;
  formula: string;
}): IndicatorSpec {
  return {
    id: def.id,
    name: def.name,
    category: def.category ?? "Custom",
    unit: def.unit ?? "",
    direction: def.direction,
    thresholds: def.thresholds,
    description: def.description,
    formula: def.formula,
  };
}

export function getSpec(id: string): IndicatorSpec | undefined {
  return ALL_SPECS.find((s) => s.id === id);
}

// ─── Normalization ─────────────────────────────────────────────

/** Normalize a raw value to a 0-100 health score using the spec. */
export function normalizeScore(value: number, spec: IndicatorSpec): number {
  if (!Number.isFinite(value)) return 50;
  const [a, b] = spec.thresholds;
  // Defensive: a REVERSED pair would otherwise produce scores outside 0-100
  // (the band branch divides by b − a). A degenerate pair (a === b) is still
  // meaningful — it's a clean step function, e.g. MACD hist [0, 0] = bullish
  // scores 100, bearish scores 0 — so only reject a > b.
  if (b < a) return 50;
  if (spec.direction === "higher") {
    // a = bad, b = good
    if (value <= a) return 0;
    if (value >= b) return 100;
    return ((value - a) / (b - a)) * 100;
  }
  if (spec.direction === "lower") {
    // a = good, b = bad
    if (value <= a) return 100;
    if (value >= b) return 0;
    return 100 - ((value - a) / (b - a)) * 100;
  }
  // band: peak at the middle of [a, b], falls off outside; hard floor at ±50% beyond
  if (value >= a && value <= b) {
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    return half === 0 ? 100 : 100 - (Math.abs(value - mid) / half) * 40; // 60-100 inside band
  }
  const edge = value < a ? a : b;
  const beyond = Math.abs(value - edge);
  const bandWidth = b - a;
  const pct = Math.min(1, beyond / (bandWidth * 0.75)); // reaches 0 at 75% of a band-width outside
  return Math.max(0, 60 - pct * 60);
}

function gradeFor(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  if (score >= 35) return "E";
  return "F";
}

function verdictFor(score: number): string {
  if (score >= 80) return "Excellent — strong technical picture.";
  if (score >= 65) return "Healthy — generally solid with a few soft spots.";
  if (score >= 50) return "Mixed — signals conflict; trend quality is average.";
  if (score >= 35) return "Weak — bearish or choppy across weighted indicators.";
  return "Critical — the weighted indicators paint a poor picture.";
}

export interface WeightMap {
  /** indicator id -> weight (any non-negative number; 0 = effectively excluded) */
  [id: string]: number;
}

export interface MegaInput {
  /** id -> raw value (technical indicators; computed server-side) */
  technical: Record<string, number>;
  /** Specs for user-defined indicators whose raw values are in `technical`. */
  custom?: IndicatorSpec[];
  /** id -> { value, ... } fallback when a raw value is unavailable */
  meta?: {
    asOf?: string | null;
    ticker?: string | null;
    dataSource?: "cache" | "yahoo" | "none";
  };
  weights?: WeightMap;
  /** ids of indicators the user toggled off (excluded from the composite) */
  excluded?: string[];
}

/** Preset — spread weight evenly across all indicators. */
export function evenWeights(specs: IndicatorSpec[]): WeightMap {
  const w: WeightMap = {};
  for (const s of specs) w[s.id] = 1;
  return w;
}

/** Every spec that takes part in this computation: built-ins + any custom. */
function specsFor(input: Pick<MegaInput, "custom">): IndicatorSpec[] {
  return input.custom?.length ? [...ALL_SPECS, ...input.custom] : ALL_SPECS;
}

export function computeMegaIndicator(input: MegaInput): MegaResult {
  const specs = specsFor(input);
  const weights = input.weights || evenWeights(specs);
  const excludedSet = new Set(input.excluded || []);

  const indicators: MegaIndicator[] = [];
  for (const spec of specs) {
    const raw = input.technical[spec.id];
    if (raw === undefined || !Number.isFinite(raw)) continue; // missing data
    indicators.push({
      id: spec.id,
      name: spec.name,
      category: spec.category,
      unit: spec.unit,
      value: raw,
      score: Math.round(normalizeScore(raw, spec) * 10) / 10,
      weight: Math.max(0, weights[spec.id] ?? 1),
      enabled: !excludedSet.has(spec.id) && (weights[spec.id] ?? 1) > 0,
      direction: spec.direction,
      thresholds: spec.thresholds,
      description: spec.description,
      formula: spec.formula,
    });
  }

  // ─── Composite ────────────────────────────────────────────────
  let totalWeight = 0;
  let weightedSum = 0;
  const contributions: Array<{ id: string; name: string; contribution: number }> = [];
  for (const ind of indicators) {
    if (!ind.enabled) continue;
    totalWeight += ind.weight;
    const contribution = (ind.score * ind.weight);
    weightedSum += contribution;
    contributions.push({ id: ind.id, name: ind.name, contribution: Math.round(contribution * 10) / 10 });
  }

  const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 50;

  // ─── Category roll-up (uses the same normalized weights) ──────
  const catMap: Record<string, { ws: number; wsum: number }> = {};
  for (const ind of indicators) {
    if (!ind.enabled) continue;
    if (!catMap[ind.category]) catMap[ind.category] = { ws: 0, wsum: 0 };
    catMap[ind.category].ws += ind.score * ind.weight;
    catMap[ind.category].wsum += ind.weight;
  }
  const categories: MegaCategorySummary[] = Object.entries(catMap)
    .map(([category, d]) => ({
      category,
      score: d.wsum > 0 ? Math.round((d.ws / d.wsum) * 10) / 10 : 0,
      weightShare: totalWeight > 0 ? Math.round((d.wsum / totalWeight) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.weightShare - a.weightShare);

  contributions.sort((a, b) => b.contribution - a.contribution);

  return {
    score,
    grade: gradeFor(score),
    verdict: verdictFor(score),
    indicators,
    categories,
    contributions,
    meta: {
      asOf: input.meta?.asOf ?? null,
      ticker: input.meta?.ticker ?? null,
      dataSource: input.meta?.dataSource ?? "none",
      technicalCount: indicators.length,
    },
  };
}

/** Score → color for UI use. */
export function scoreColor(score: number): string {
  if (score >= 80) return "#22c55e";
  if (score >= 65) return "#84cc16";
  if (score >= 50) return "#eab308";
  if (score >= 35) return "#f97316";
  return "#ef4444";
}

export function scoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 65) return "Healthy";
  if (score >= 50) return "Mixed";
  if (score >= 35) return "Weak";
  return "Critical";
}
