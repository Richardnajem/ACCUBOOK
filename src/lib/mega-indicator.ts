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
  /** Computed for every ticker but kept out of the composite until it is added. */
  optional?: boolean;
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
  optional?: boolean; // catalogue indicator: starts outside the composite
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
  action: MegaAction;          // baseline decision for this score (buy / hold / sell)
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
  T("ta-williams-r", "Williams %R (14)", "%", "band", [-80, -20],
    "Where the close sits inside the 14-day high-low range, quoted upside-down: −100 at the low, 0 at the high. Below −80 oversold, above −20 overbought.",
    "%R = −100 · (HH(14) − close)/(HH(14) − LL(14)),  HH = max(H, 14),  LL = min(L, 14)"),
  T("ta-stochrsi-k", "StochRSI %K (14,14,3)", "%", "band", [20, 80],
    "RSI's own position inside its 14-day range — reacts far faster than RSI. 20-80 healthy; below 20 oversold, above 80 overbought.",
    "raw = (RSI(14) − min(RSI, 14))/(max(RSI, 14) − min(RSI, 14));  %K = SMA(3, raw)"),
  T("ta-stochrsi-d", "StochRSI %D (14,14,3)", "%", "band", [20, 80],
    "Signal line of the Stochastic RSI (3-period average of %K). Its crossings with %K mark momentum turns earlier than RSI.",
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

// ─── Catalogue: optional indicators ─────────────────────────────
// Every indicator below is computed for every ticker and listed in the weights
// panel, but stays out of the composite until it is added (its default weight is
// 0 — see defaultWeights). lib/indicator-suggestions ranks which of them are
// worth adding for the ticker at hand, and the page offers a one-click "Add".
// O() is the T()/M() pair above plus the `optional` flag.

const O = (
  id: string,
  name: string,
  category: string,
  unit: string,
  direction: Direction,
  thresholds: [number, number],
  description: string,
  formula: string
): IndicatorSpec => ({
  id, name, category, unit, direction, thresholds, description, formula, optional: true,
});

export const OPTIONAL_SPECS: IndicatorSpec[] = [
  // ─── The kernel pair: available, but NOT in the balanced default ────────
  // They used to carry 3 + 2 of the default weight while the score history and
  // every backtest excluded them, so the number on the Mega Indicator page was a
  // composite nobody had measured (up to ±2 points away from the one the 70/25
  // bands were fitted on). They are now catalogue indicators: weight 0 until you
  // add one, and both the live reading and the series come from the same
  // trailing-window estimator (ta.kernelTrend), so adding one keeps the page, the
  // history and a backtest in step.
  O("ta-kernel-slope", "Kernel Regression Slope", "Technical", "%/bar", "higher", [-0.05, 0.05],
    "Slope of the Nadaraya-Watson kernel trend, in % of price per bar. Positive = BUY regime. Computed from a trailing window (the kernel sits 8 bars back), which is what lets the score history and backtests reproduce this reading exactly.",
    "ŷ(t) = Σᵢ wᵢ·close[t+i] / Σᵢ wᵢ with wᵢ = exp(−i²/(2·8²)), i ∈ [−16, 0] (trailing);  Slope% = (ŷ(t) − ŷ(t−1))/ŷ(t−1) · 100"),
  O("ta-kernel-residual", "Kernel Residual", "Technical", "%", "band", [0.5, 3],
    "Typical deviation of price from the kernel trend line. Low = smooth trend, high = choppy/unsafe. Same trailing window as the slope, so it is backtestable.",
    "Residual% = stdev(close − ŷ, last 20 bars) / |ŷ(t)| · 100, ŷ from the trailing window above"),

  O("ta-adx-14", "ADX (14)", "Trend", "", "higher", [20, 40],
    "Trend strength, not direction. Under 20 the market is choppy, over 40 it is trending hard. Pair it with +DI/−DI from the same calculation to see which side is winning.",
    "TR = max(H−L, |H−close₁|, |L−close₁|);  +DM = (H−H₁ > L₁−L and H−H₁ > 0) ? H−H₁ : 0 (mirrored for −DM);  +DI = 100·S(+DM)/S(TR), −DI likewise, S = Wilder smoothing;  DX = 100·|+DI − −DI|/(+DI + −DI);  ADX = S(DX)"),
  O("ta-supertrend", "SuperTrend (10, 3)", "Trend", "%", "higher", [-2, 2],
    "How far price sits from the ATR-trailing SuperTrend line, in % of price. Holding above the line is an uptrend regime, dropping below it is a downtrend — one of the cleanest trend/stop signals there is.",
    "Upper/Lower = (H+L)/2 ± 3·ATR(10);  each band ratchets toward price and flips only when the close crosses it;  value = (close − line)/line · 100"),
  O("ta-aroon-osc", "Aroon Oscillator (25)", "Trend", "", "band", [-50, 50],
    "Whether the 25-bar highs or the 25-bar lows are fresher. Above 50 the highs are recent (uptrend building), below −50 the lows are — a quick read on trend age.",
    "Up = 100·(25 − bars since the highest high)/25 over the latest 26 bars;  Down likewise for the lowest low;  Oscillator = Up − Down"),
  O("ta-mfi-14", "Money Flow Index (14)", "Momentum", "", "band", [20, 80],
    "RSI weighted by the money that actually changed hands. 20-80 is normal; above 80 is an overbought move with volume behind it, below 20 an oversold one.",
    "TP = (H+L+C)/3;  MF = TP·volume;  MFR = Σ(MF over up-TP bars, 14) / Σ(MF over down-TP bars, 14);  MFI = 100 − 100/(1 + MFR)"),
  O("ta-obv-20", "OBV vs 20-Bar Average", "Volume", "d", "higher", [-1, 1],
    "On-Balance Volume against its own 20-bar average, measured in average days of volume. Positive means volume is accumulating on up days (buying pressure), negative means it is being distributed.",
    "OBVₜ = OBVₜ₋₁ + volume on an up-close, − volume on a down-close;  value = (OBV − SMA(20, OBV)) / SMA(20, volume)"),
  O("ta-kc-pos", "Keltner Position (20, 10, 2)", "Volatility", "%", "band", [20, 80],
    "Where price sits inside the Keltner channel — the ATR-driven cousin of the Bollinger bands. 0 is the lower band, 100 the upper.",
    "%K = (close − Lower)/(Upper − Lower)·100,  Middle = EMA(20, close),  Upper/Lower = Middle ± 2·ATR(10)"),

  // ─── Added from "Indicators project 181026.xlsx" ────────────
  O("ta-donchian-pos", "Donchian Position (20)", "Trend", "%", "higher", [20, 80],
    "Where the close sits inside the 20-bar Donchian channel: 0 is the lowest low of the window, 100 the highest high. A close pushing the upper channel is a breakout, so nearer the high scores higher.",
    "Upper = max(H, 20),  Lower = min(L, 20);  Position% = (close − Lower)/(Upper − Lower)·100"),
  O("ta-fib-pos", "Fibonacci Range Position (52w)", "Swing", "%", "higher", [20, 80],
    "Position of the close inside its 52-week high–low range: 100 at the high, 0 at the low. The workbook draws its Fibonacci levels on the same high/low framing (there: since inception); a close sitting on its 61.8% retracement line reads 38.2 here, because the line is 61.8% down from the high.",
    "Upper = max(H, 252),  Lower = min(L, 252);  Position% = (close − Lower)/(Upper − Lower)·100  (the workbook's Fib levels are Upper − (Upper−Lower)·ratio)"),
  O("ta-adl-20", "Accumulation/Distribution vs 20-Bar Avg", "Volume", "d", "higher", [-5, 5],
    "The cumulative Chaikin A/D line against its own 20-bar average, in average days of volume. Positive means money is accumulating on up-closes (buying pressure), negative means it is being distributed. The workbook's ADL column stores only the day's money-flow volume, not the running total; the app uses the standard cumulative line.",
    "MFM = ((C−L) − (H−C))/(H−L),  MFV = MFM·volume,  ADLₜ = ADLₜ₋₁ + MFVₜ;  value = (ADL − SMA(20, ADL))/SMA(20, volume)"),
  O("ta-di-spread", "Directional Spread (+DI − −DI, 14)", "Trend", "", "higher", [-25, 25],
    "How far +DI leads −DI from the same Wilder calculation behind ADX. Positive means up-moves dominate, negative means down-moves do; it gives ADX a direction.",
    "TR, ±DM as in ADX;  +DI = 100·S(±DM)/S(TR),  S = Wilder smoothing;  Spread = +DI − −DI"),
  O("ta-bop-14", "Balance of Power (14)", "Momentum", "", "higher", [-0.5, 0.5],
    "Buyers versus sellers inside each bar — (close − open)/(high − low) — averaged over 14 bars. Positive means buyers keep finishing near the high; negative means sellers keep finishing near the low.",
    "BOPₜ = (Cₜ − Oₜ)/(Hₜ − Lₜ);  value = SMA(14, BOP)  (0 when a bar has no range)"),
  O("ta-cmf-20", "Chaikin Money Flow (20)", "Volume", "", "higher", [-0.25, 0.25],
    "Money flow volume over the last 20 bars divided by total volume, −1…+1. Positive = the closes are accumulating on strength; negative = distribution. ±0.25 is the conventional strong-reading threshold.",
    "MFM = ((C−L) − (H−C))/(H−L),  MFV = MFM·volume;  CMF = Σ(MFV, 20)/Σ(volume, 20)"),
  O("ta-chaikin-osc", "Chaikin Oscillator (3, 10)", "Volume", "d", "higher", [-2, 2],
    "The 3-period EMA of the A/D line minus its 10-period EMA, in days of average volume. Positive means accumulation is accelerating; negative means distribution is. The workbook's oscillator runs on its daily-MFV ADL column; the app uses the standard cumulative A/D line.",
    "ADL = Σ(MFM·volume),  Osc = EMA(3, ADL) − EMA(10, ADL);  value = Osc/SMA(20, volume)"),
  O("ta-cmo-14", "Chande Momentum Oscillator (14)", "Momentum", "", "band", [-50, 50],
    "Momentum on a −100…+100 scale, without RSI's smoothing: (sum of up-moves − sum of down-moves)/(sum of all moves). Beyond ±50 the move is stretched.",
    "CMO = 100·(Σup − Σdown)/(Σup + Σdown) over the last 14 close changes"),
  O("ta-ema20-slope", "EMA-20 Slope", "Moving Averages", "%/bar", "higher", [-0.5, 0.5],
    "One-bar change of the 20-day EMA as a percentage of price. Positive = the short-term mean is rising; the workbook uses the same close-denominated slope. ±0.5%/bar is a strong one-month trend.",
    "EMA(20) as usual;  Slope% = (EMA20ₜ − EMA20ₜ₋₁)/closeₜ·100"),
  O("ta-ema200-slope", "EMA-200 Slope", "Moving Averages", "%/bar", "higher", [-0.2, 0.2],
    "One-bar change of the 200-day EMA as a percentage of price — the direction of the long-term trend, independent of where price trades around it. ±0.2%/bar is already a strong yearly trend.",
    "EMA(200) as usual;  Slope% = (EMA200ₜ − EMA200ₜ₋₁)/closeₜ·100"),
  O("ta-ctm", "CTM (Combined Trend–Momentum)", "Composite", "", "higher", [20, 70],
    "The workbook's CTM: the mean of RSI(14), CMO(14), EMA-20, EMA-200 and ADX(14). The workbook averages the two EMA price levels raw, which makes its CTM drift with the share price; here those legs are converted to the same 0–100 price-vs-EMA readings used elsewhere first, so CTM is a real 0–100 signal. The workbook's 60/40 BUY/SELL levels sit inside this continuous 20–70 scoring band.",
    "CTM = mean( RSI(14), CMO(14), EMA20-score, EMA200-score, ADX(14) ),  where EMA-score = clamp(0,100, ((close/EMA − 1)·100 + 1)/2·100)  — the workbook's raw mean uses the EMA levels in place of those two scores"),

  // ─── Added from "technicals richard.xlsx" ───────────────────
  O("ta-connors-rsi", "Connors RSI (3, 2, 100)", "Momentum", "", "band", [20, 80],
    "Three fast readings averaged: RSI(3), RSI(2) of the current up/down streak and the percent rank of today's 1-bar return over the last 100 bars. It turns far faster than RSI(14); the conventional extremes are 90 overbought / 10 oversold, well outside this healthy 20-80 band.",
    "ConnorsRSI = ( RSI(3, close) + RSI(2, streak) + PercentRank(ROC(1), 100) ) / 3,  streak = consecutive up (+n) or down (−n) closes, 0 on a flat close"),
  O("ta-coppock", "Coppock Curve (10, 14, 11)", "Momentum", "", "higher", [-5, 5],
    "A 10-bar weighted average of the 14- and 11-bar rates of change. Designed to mark the end of a bear phase when it turns up through zero; on daily bars it is a medium-term momentum turn. The workbook smooths with its weights reversed (oldest bar heaviest); the app uses the standard WMA, newest bar heaviest.",
    "Coppock = WMA(10, ROC(14) + ROC(11)),  ROC(n) in percent,  WMA weights the newest bar 10 and the oldest 1"),
  O("ta-pmo", "PMO (35, 20)", "Momentum", "", "higher", [-3, 3],
    "Price Momentum Oscillator: the 1-bar return, smoothed by a 35-day EMA and scaled ×10. Its 20-day EMA is the signal line; holding above it means momentum is still building. The workbook seeds its EMAs on the first return, the app on the first full window — they converge as the recursion forgets the seed.",
    "PMO = 10 · EMA(35, ROC(1)%);  Signal = EMA(20, PMO)"),
  O("ta-dpo-pct", "DPO (20)", "Momentum", "%", "band", [-5, 5],
    "Detrended Price Oscillator: the close from 11 bars ago minus today's 20-bar SMA, as a percentage of price. It strips the trend out so the cycle shows; a reading far outside ±5% is stretched relative to its own average.",
    "DPO = close[t − 11] − SMA(20, close);  value = DPO/close · 100"),
  O("ta-emv-14", "Ease of Movement (14)", "Volume", "", "higher", [-0.02, 0.02],
    "How far the bar's midpoint travelled for the volume it took to move it, smoothed over 14 bars and scaled ×100 000 (the workbook's \"Scaled EMV\"). Positive means price is rising on comparatively light volume; negative means it is falling easily.",
    "mid = (H+L)/2;  box = volume/(H−L);  EMV = (mid − mid₁)/box;  value = SMA(14, EMV · 100 000)"),
  O("ta-atr-stop", "ATR Stop vs EMA-200 (14, 3)", "Trend", "%", "higher", [-3, 3],
    "Where price sits relative to an ATR stop that respects the primary trend: above the 200-day EMA the stop is 3·ATR below price, below it the stop is 3·ATR above. Positive values are a long regime, negative values a short/avoid one — the EMA-200 filter stops the stop flipping on every spike.",
    "line = close ± 3·ATR(14) (minus above EMA(200), plus below);  value = (close − line)/close · 100"),
  O("ta-dist-52w-low", "Distance above 52-Week Low", "Swing", "%", "higher", [10, 100],
    "How far price has risen above its 52-week low. The companion to \"distance from the 52-week high\": a market 50%+ above its low is in a different regime from one sitting on it. The workbook computes the same distance from its own low column.",
    "Distance% = (close − LL(252, close))/LL(252, close) · 100"),
];

/** Catalogue ids, for quick membership checks. */
export const OPTIONAL_IDS: ReadonlySet<string> = new Set(OPTIONAL_SPECS.map((s) => s.id));

/** Every spec the app knows about: the built-ins plus the catalogue. */
export const ALL_SPECS: IndicatorSpec[] = [...TECHNICAL_SPECS, ...OPTIONAL_SPECS];

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

// ─── User overrides: edit an indicator's formula and its other fields ──
//
// Every indicator — built-in or user-defined — can be edited in place: any
// field of its spec, and optionally its FORMULA, which replaces the built-in
// calculation with the user's own expression (compiled by the same sandbox as
// a custom indicator). An override is a PATCH: a field it omits keeps the
// built-in's value, so clearing one field never wipes the others.

/** Longest accepted override text fields (mirrors the custom-indicator limits). */
export const MAX_OVERRIDE_NAME = 40;
export const MAX_OVERRIDE_UNIT = 8;
export const MAX_OVERRIDE_DESC = 160;

/** A user edit to one indicator. Missing fields keep the built-in's value. */
export interface IndicatorOverride {
  direction?: Direction;
  thresholds?: [number, number];
  name?: string;
  unit?: string;
  description?: string;
  /** A user expression that REPLACES this indicator's calculation, e.g. "rsi(close, 9)". */
  formula?: string;
}

/** indicator id -> override. */
export type IndicatorOverrideMap = Record<string, IndicatorOverride>;

function isDirection(v: unknown): v is Direction {
  return v === "higher" || v === "lower" || v === "band";
}

/**
 * Patch a spec with one override. Invalid or empty parts keep the base value,
 * so a half-typed or corrupted override can never produce an invalid spec
 * (a reversed threshold pair would otherwise score above 100).
 */
export function applyIndicatorOverride(spec: IndicatorSpec, override?: IndicatorOverride): IndicatorSpec {
  if (!override) return spec;
  const text = (v: unknown, cap: number): string =>
    typeof v === "string" ? v.trim().slice(0, cap) : "";
  const name = text(override.name, MAX_OVERRIDE_NAME);
  const unit = text(override.unit, MAX_OVERRIDE_UNIT);
  const description = text(override.description, MAX_OVERRIDE_DESC);
  const formula = text(override.formula, 400);
  const t = override.thresholds;
  const thresholds: [number, number] =
    Array.isArray(t) && t.length === 2 && Number.isFinite(Number(t[0])) && Number.isFinite(Number(t[1])) && Number(t[0]) <= Number(t[1])
      ? [Number(t[0]), Number(t[1])]
      : spec.thresholds;
  return {
    ...spec,
    direction: isDirection(override.direction) ? override.direction : spec.direction,
    thresholds,
    name: name || spec.name,
    unit: unit || spec.unit,
    description: description || spec.description,
    // The formula field is what the UI shows as "how it's calculated" — once the
    // user replaces the calculation, that text is the user's expression.
    formula: formula || spec.formula,
  };
}

/** Patch a whole spec list, leaving untouched indicators untouched. */
export function specsWithOverrides(
  specs: IndicatorSpec[],
  overrides?: IndicatorOverrideMap | null,
): IndicatorSpec[] {
  if (!overrides || Object.keys(overrides).length === 0) return specs;
  return specs.map((s) => (overrides[s.id] ? applyIndicatorOverride(s, overrides[s.id]) : s));
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

/**
 * The composite score at which the baseline says buy.
 *
 * 70 (was 65) — calibrated Oct 2026 against the composite's own distribution:
 * on 16 tickers × 15 years the score sits at p10 ≈ 50, median ≈ 65, p90 ≈ 75,
 * so a 65 entry is the median and a 35 exit is below the 10th percentile —
 * "always long, never sell". The trained pair 70 / 25 is the best of the tested
 * grid on the training window in every split and keeps the highest out-of-sample
 * win rate (94-97%) with ~1.2 trades per symbol per 4 years.
 *
 * Re-checked Oct 2026 on the 24-ticker universe (volatile block included), 3
 * universes × 3 splits, held-out tail — the whole entry 55-85 × exit 20-50 grid:
 * NOTHING STRICTER PAYS. Every cell above 70/25 lowers excess Sharpe, because
 * each early exit has to be re-entered later and the re-entries give back more
 * than the drawdown they avoid: 75/35 −0.15 (drawdown cut 2.4 pt), 80/40 −0.48
 * (9.8 pt), 85/50 −0.67 (32 pt). 70/25 is the top of that trade-off curve at
 * −0.02, i.e. a drawdown filter that costs about nothing. The band search in
 * the Training tab does pick 75-77.5 / 27.5 on the training window, and the
 * held-out result is indistinguishable from 70/25 (−0.06 to +0.04) — so the
 * entry may rise a little without cost, but it does not gain anything either.
 * On the volatile block alone the band search is actively dangerous: it chose
 * exits of 45-50 and lost 0.16-0.28 excess Sharpe out of sample against 0.02-0.09
 * for 70/25. Do not adopt a band pair that the held-out column does not support.
 */
export const MEGA_BUY_ABOVE = 70;
/**
 * Below this the baseline says sell; between the two thresholds it says hold.
 *
 * 25 (was 35). This is the number that was producing the bad trades: at 35 the
 * regime rule exits on ordinary pullbacks (score p25 ≈ 55 is not reached, but a
 * 35 exit fires on ~8-11 whipsaws per symbol), and those re-entries won only
 * 50% of the time and cost 0.11-0.17 Sharpe against buy & hold. At 25 the rule
 * only leaves the market in a genuine breakdown.
 *
 * WHAT THE EXIT ACTUALLY DOES (measured Oct 2026, 24 tickers × 15 years, cached
 * daily bars, 2 bps each way): on the full window 70/25 closed exactly ONE trade
 * on 22 of the 24 tickers — a single entry in late 2011 held to the end of the
 * test. AMD (exited 2014-10-16) and NFLX (2022-01-27) are the only names that
 * ever sold and re-entered. The reason is the score's own floor: smoothed on
 * 5 days it bottomed at 23-34 on those tickers (median 63-67) and spent 0-8
 * sessions under 30 in fifteen years. So a 25 exit is not "a slow filter", it is
 * a filter that mostly never fires — this rule is buy & hold with a tail
 * guardrail, and it earns that description. Loosening it is what changes
 * behaviour, and the fast variant (`mega_score_fast` in lib/strategies.ts) shows
 * what that costs: ~40× the trades, a third off the drawdown, 0.20-0.36 Sharpe
 * behind buy & hold against +0.01 / +0.08 here.
 */
export const MEGA_SELL_BELOW = 25;

/**
 * The Mega Score baseline in one object: the entry/exit bands the app
 * recommends before anyone changes them. The Mega Indicator page's BUY/HOLD/SELL
 * readout, the backtest's "Mega Score Regime" strategy and the Backtest page's
 * baseline panel all start — and reset — from these two numbers.
 */
export const MEGA_BASELINE = { entry: MEGA_BUY_ABOVE, exit: MEGA_SELL_BELOW } as const;

export type MegaBandKey = "entry" | "exit";

/** True when the bands are the untouched baseline (MEGA_BASELINE). */
export function isMegaBaseline(entry: number, exit: number): boolean {
  return Math.round(entry) === Math.round(MEGA_BASELINE.entry) && Math.round(exit) === Math.round(MEGA_BASELINE.exit);
}

export interface BaselineExplanation {
  /** One-line summary of the bands. */
  summary: string;
  /** What the entry score means, in plain language. */
  entry: string;
  /** What the exit score means, in plain language. */
  exit: string;
  /** What happens between the two bands. */
  hold: string;
  /** entry − exit: how wide the no-trade band is. */
  bandWidth: number;
  /** Non-null when the pair cannot be traded (entry below exit). */
  error: string | null;
}

/**
 * Explain a pair of Mega Score bands: what the entry score does, what the exit
 * score does, and what the space between them means. The Backtest page prints
 * this next to the inputs so "entry score" and "exit score" are never just two
 * bare numbers, and the strategy description says the same thing in one line.
 */
export function explainBaseline(entry: number, exit: number): BaselineExplanation {
  const e = Number.isFinite(entry) ? Math.round(entry) : MEGA_BASELINE.entry;
  const x = Number.isFinite(exit) ? Math.round(exit) : MEGA_BASELINE.exit;
  const bandWidth = e - x;

  const gapNote =
    bandWidth < 0
      ? ""
      : bandWidth < 5
        ? ` The band is only ${bandWidth} point${bandWidth === 1 ? "" : "s"} wide, so small score wobbles will flip the position in and out.`
        : bandWidth >= 40
          ? ` The band is ${bandWidth} points wide — a very wide no-trade zone, so expect few, long-held trades.`
          : "";

  return {
    summary: `Buy when the composite is ${e} or above · Sell when it is below ${x}`,
    entry: `Entry score (${e}): the composite Mega Score a trade needs to reach before a long position is opened. Once the score is at or above ${e}, the backtest buys on the next day's open. Lower = buys earlier and more often; higher = waits for a stronger technical reading.`,
    exit: `Exit score (${x}): the level the score has to fall strictly below before an open position is closed — also at the next day's open. A reading of exactly ${x} keeps the position open (the Mega Indicator baseline treats that as HOLD). Higher = leaves sooner; lower = rides out more weakness.`,
    hold:
      bandWidth < 0
        ? "There is no no-trade band here: with the entry score below the exit score the rule contradicts itself, so nothing sits between buying and selling."
        : `Between ${x} and ${e} nothing happens: a flat strategy stays flat and an open position stays open. That ${bandWidth}-point gap is the no-trade band that keeps the strategy from flipping on noise.${gapNote}`,
    bandWidth,
    error:
      bandWidth < 0
        ? `Entry score ${e} is below exit score ${x} — the same reading would be both a buy and a sell. Raise the entry score or lower the exit score.`
        : null,
  };
}

export type MegaActionKey = "buy" | "hold" | "sell";

export interface MegaAction {
  key: MegaActionKey;
  label: string;
  /** Why this action, in plain language — shown under the score. */
  detail: string;
  /** The score band that would change the action. */
  next: string;
}

/**
 * The Mega Score baseline: what the composite says to do, not just how healthy
 * it looks. The bands are deliberately wide — the composite is a blend, and a
 * blend sitting near neutral is not a trade signal. ≥ 70 buy, 25-70 hold,
 * < 25 sell; the bands are exported so the UI and any strategy agree on them.
 */
export function actionFor(score: number): MegaAction {
  if (!Number.isFinite(score)) {
    return { key: "hold", label: "HOLD", detail: "No composite score yet — hold until there is enough data.", next: `Buy ≥ ${MEGA_BUY_ABOVE} · Sell < ${MEGA_SELL_BELOW}` };
  }
  if (score >= MEGA_BUY_ABOVE) {
    return {
      key: "buy",
      label: "BUY",
      detail: `Score ${score.toFixed(1)} is at or above ${MEGA_BUY_ABOVE} — the weighted technical picture is bullish.`,
      next: `Holds until the score falls below ${MEGA_BUY_ABOVE}`,
    };
  }
  if (score < MEGA_SELL_BELOW) {
    return {
      key: "sell",
      label: "SELL",
      detail: `Score ${score.toFixed(1)} is below ${MEGA_SELL_BELOW} — the weighted technical picture is bearish.`,
      next: `Holds until the score reaches ${MEGA_SELL_BELOW}`,
    };
  }
  return {
    key: "hold",
    label: "HOLD",
    detail: `Score ${score.toFixed(1)} is between ${MEGA_SELL_BELOW} and ${MEGA_BUY_ABOVE} — mixed signals, no edge either way.`,
    next: `Buy at ${MEGA_BUY_ABOVE} · Sell below ${MEGA_SELL_BELOW}`,
  };
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
  /** Per-indicator field/formula edits, applied to the specs before scoring. */
  overrides?: IndicatorOverrideMap;
}

/**
 * Default ("balanced") weights — a research-weighted composite, not a flat one.
 * A flat average lets sixteen near-duplicate SMA/EMA readings outvote the
 * indicators that actually carry independent information; this map reflects what
 * each signal is worth:
 *
 *   • RSI(14) and the Bollinger position carry 20 each — the two mean-reversion
 *     / momentum readings with the most independent signal.
 *   • MACD histogram 10: the other genuinely orthogonal momentum measure.
 *   • Momentum, stochastic, ATR, volume, 52-week distance and the efficiency
 *     ratio share the rest — the context a single oscillator lacks.
 *   • The SMA/EMA family shares 8 points (0.5 each): sixteen correlated
 *     price-vs-average readings should not dominate the blend.
 *
 * The catalogue still starts at 0: an indicator joins the composite only when
 * the user (or a suggestion they accepted) adds it. **That includes the kernel
 * pair** (slope + residual): they are catalogue entries now, because every
 * number below was measured on the composite WITHOUT them — the live page used
 * to add 3 + 2 points of centred-kernel signal the history and the backtest
 * could not reproduce (`lib/ta.ts` `kernelTrend` gives them a causal estimator
 * if you do add them).
 *
 * Calibrated Oct 2026 (`tests/mega-calibration-live.test.ts`, 16 tickers × 15y,
 * 2 bps commission + 2 bps slippage, chronological 60/40 · 70/30 · 80/20 splits):
 * the trio above is load-bearing — at identical 70/25 bands a flat average scores
 * −0.23, an RSI-only blend −0.29, and this blend −0.02 to +0.06 excess Sharpe vs
 * buy & hold. The calibration moved redundancy out of the blend: trend 4 → 1,
 * CCI 3 → 1, ATR 4 → 3, 3-day volatility 1 → 0.5, which improved excess Sharpe
 * on all three splits (+0.04, +0.05, +0.09). Re-verify with the Training tab —
 * do not edit these numbers from memory. Only the SHARES matter: the map totals
 * 88.5 (93.5 with the two kernel legs switched back on), and the composite
 * divides by the weight it actually summed.
 *
 * Re-derived Oct 2026 on the 24-ticker universe (the 16 above plus TSLA, AMD,
 * NFLX, MU, FSLR, GME, MSTR, SMCI — 47-99% annualized vol each), same costs and
 * splits, bands frozen at 70/25. Two results, both measured before this map was
 * left alone:
 *
 *   • THIS MAP SURVIVES. Training on the large-cap-only half now *loses* out of
 *     sample (−0.09 to −0.12 excess Sharpe across the three splits, against
 *     −0.02 to +0.02 for this map): slow uptrends mostly reward staying long, so
 *     the search there trims the trend/momentum legs and pays for it. Trained on
 *     the volatile block or on all 24 the result is −0.01 mean, i.e. inside the
 *     noise band of this map rather than a different map.
 *   • NO MOVE IS STABLE ENOUGH TO ADOPT. 12 retrains (2 universes × 3 splits ×
 *     catalogue off/on) moved 19 search axes; every axis except volume-vs-20-day
 *     flipped in both directions across runs, and volume-vs-20-day only drifts
 *     2 → 0.5-1 on half of them. With ~1.4 trades per symbol on the held-out
 *     tail the objective cannot tell two weight maps apart by much more than
 *     noise, so a "trained" map here would be a copy of this one plus luck.
 *     That is why the numbers below did not move: re-running the tab on a few
 *     dozen tickers is not evidence for a new map.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  "ta-rsi-14": 20,
  "ta-bb-pos": 20,
  "ta-macd-hist": 10,
  "ta-trend-50-200": 1,
  "ta-atr-pct": 3,
  "ta-stoch-k": 4,
  "ta-mom-63": 4,
  "ta-stoch-d": 2,
  "ta-williams-r": 3,
  "ta-stochrsi-k": 3,
  "ta-stochrsi-d": 1,
  "ta-cci-20": 1,
  "ta-vol-3d": 0.5,
  "ta-vol-ratio": 2,
  "ta-dist-52w-high": 3,
  "ta-er-10": 3,
  // The two kernel legs are deliberately absent: they are catalogue indicators
  // now (weight 0 until added), because this map and MEGA_BASELINE were measured
  // on the composite WITHOUT them. See OPTIONAL_SPECS.
  // The SMA/EMA family (16 specs) shares 8 points.
  ...Object.fromEntries(
    MA_PERIODS.flatMap((p) => [[`ta-sma-${p}`, 0.5], [`ta-ema-${p}`, 0.5]])
  ),
};

/** The default weight for one id (0 for catalogue entries, 1 if unknown). */
export function defaultWeightFor(id: string, optional?: boolean): number {
  return optional ? 0 : DEFAULT_WEIGHTS[id] ?? 1;
}

/**
 * Default weights for a set of specs. Every built-in gets its balanced default
 * (see DEFAULT_WEIGHTS — RSI and Bollinger at 20 each, 100 in total), and the
 * catalogue gets 0: a composite should only contain what the user — or a
 * suggestion they accepted — put there.
 */
export function defaultWeights(specs: Array<{ id: string; optional?: boolean }>): WeightMap {
  const w: WeightMap = {};
  for (const s of specs) w[s.id] = defaultWeightFor(s.id, s.optional);
  return w;
}

/** Preset — spread weight evenly across all indicators. */
export function evenWeights(specs: IndicatorSpec[]): WeightMap {
  const w: WeightMap = {};
  for (const s of specs) w[s.id] = 1;
  return w;
}

/**
 * The single rule for what a weight means, shared by the API route, the
 * dashboard's instant recompute and the backtest series: built-ins count 1
 * out of the box, the catalogue counts 0 until something adds it, and an
 * explicit weight always wins. Reading it from one place is what stops the
 * displayed composite and the server's composite from disagreeing when a
 * saved weight map predates an indicator.
 */
export function effectiveWeight(
  spec: { id: string; optional?: boolean },
  weights: WeightMap | null | undefined,
): number {
  const raw = weights?.[spec.id];
  return Math.max(0, raw ?? defaultWeightFor(spec.id, spec.optional));
}

/** Every spec that takes part in this computation: built-ins + any custom, with
 *  the user's per-indicator edits applied on top. */
function specsFor(input: Pick<MegaInput, "custom" | "overrides">): IndicatorSpec[] {
  const base = input.custom?.length ? [...ALL_SPECS, ...input.custom] : ALL_SPECS;
  return specsWithOverrides(base, input.overrides);
}

export function computeMegaIndicator(input: MegaInput): MegaResult {
  const specs = specsFor(input);
  const weights = input.weights || defaultWeights(specs);
  const excludedSet = new Set(input.excluded || []);

  const indicators: MegaIndicator[] = [];
  for (const spec of specs) {
    const raw = input.technical[spec.id];
    const w = effectiveWeight(spec, weights);
    if (raw === undefined || !Number.isFinite(raw)) continue; // missing data
    indicators.push({
      id: spec.id,
      name: spec.name,
      category: spec.category,
      unit: spec.unit,
      value: raw,
      optional: spec.optional ?? false,
      score: Math.round(normalizeScore(raw, spec) * 10) / 10,
      weight: w,
      enabled: !excludedSet.has(spec.id) && w > 0,
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
    action: actionFor(score),
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

/**
 * Percent shares that add up to exactly 100.0 even after rounding: the raw
 * shares are floored to one decimal and the leftover tenths are handed to the
 * largest remainders. Without this, six equal weights display as 16.7 % each
 * (100.2 % total) and the panel's own percentages look broken.
 */
export function percentShares(weights: number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = clean.reduce((s, w) => s + w, 0);
  if (total <= 0) return clean.map(() => 0);
  // Work in tenths of a percent so the rounding step is exact.
  const tenths = clean.map((w) => (w / total) * 1000);
  const out = tenths.map(Math.floor);
  const left = 1000 - out.reduce((s, v) => s + v, 0);
  const byRemainder = tenths
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  if (left > 0) {
    for (let k = 0; k < left; k++) out[byRemainder[k % byRemainder.length].i] += 1;
  } else if (left < 0) {
    // Floating-point drift only — trim from the smallest remainders.
    for (let k = 0; k < -left; k++) {
      out[byRemainder[byRemainder.length - 1 - (k % byRemainder.length)].i] -= 1;
    }
  }
  return out.map((v) => v / 10);
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

/**
 * Re-blend a score history under one weight map: the same weighted mean the live
 * composite uses (`Σ score × weight ÷ Σ weight`), run over a series that already
 * holds each indicator's own 0-100 score per bar.
 *
 * Why this exists. The charted history is deliberately computed and cached on the
 * shipped weights, so moving a slider changes the *view* and never redraws the
 * past — but that also means the series is not the composite on screen once a
 * user has custom weights. Anything that compares a current reading with its
 * history (the percentile badge) has to compare like with like, so it re-blends
 * the history's per-indicator scores through the same `effectiveWeight` rule the
 * live score uses. Bars where no indicator has a reading yet are skipped rather
 * than scored as 50.
 */
export function blendScoreHistory(
  points: Array<{ indicators: Record<string, number> }>,
  weights?: WeightMap | null
): number[] {
  const out: number[] = [];
  for (const p of points) {
    let sum = 0;
    let total = 0;
    for (const [id, score] of Object.entries(p.indicators ?? {})) {
      if (!Number.isFinite(score)) continue;
      const w = effectiveWeight({ id, optional: OPTIONAL_IDS.has(id) }, weights);
      if (w <= 0) continue;
      sum += score * w;
      total += w;
    }
    if (total > 0) out.push(sum / total);
  }
  return out;
}

/**
 * Where one reading sits inside a history of the same score, as a percentile
 * (0-100): the share of that history at or below the reading. `minReadings`
 * guards against answering from a handful of bars — below it the result is null
 * and callers show nothing rather than a number built on noise.
 *
 * This is a *relative* statement about a ticker's own past, which is the point:
 * the composite's distribution is not the same across instruments (its low decile
 * sits several points lower on high-volatility names), so the same 0-100 reading
 * means different things on different tickers.
 */
export function scorePercentile(
  history: number[],
  score: number,
  minReadings = 20
): { percentile: number; readings: number } | null {
  if (!Number.isFinite(score)) return null;
  let readings = 0;
  let atOrBelow = 0;
  for (const v of history) {
    if (!Number.isFinite(v)) continue;
    readings++;
    if (v <= score) atOrBelow++;
  }
  if (readings < minReadings) return null;
  return { percentile: Math.round((atOrBelow / readings) * 100), readings };
}
