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

/** The composite score at which the baseline says buy. */
export const MEGA_BUY_ABOVE = 65;
/** Below this the baseline says sell; between the two thresholds it says hold. */
export const MEGA_SELL_BELOW = 35;

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
 * blend sitting near neutral is not a trade signal. ≥ 65 buy, 35-65 hold,
 * < 35 sell; the bands are exported so the UI and any strategy agree on them.
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
}

/**
 * Default ("balanced") weights — a research-weighted starting composite, not a
 * flat one. A flat average lets sixteen near-duplicate SMA/EMA readings outvote
 * the indicators that actually carry independent information; this map gives
 * the composite 100 weight in total and reflects what each signal is worth:
 *
 *   • RSI(14) and the Bollinger position carry 20 each — the two mean-reversion
 *     / momentum readings with the most independent signal.
 *   • MACD histogram 10: the other genuinely orthogonal momentum measure.
 *   • Trend, ATR, momentum, volume, 52-week distance, efficiency ratio and the
 *     kernel pair share 42 points — the context a single oscillator lacks.
 *   • The SMA/EMA family shares 8 points (0.5 each): sixteen correlated
 *     price-vs-average readings should not dominate the blend.
 *
 * The catalogue still starts at 0: an indicator joins the composite only when
 * the user (or a suggestion they accepted) adds it.
 */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  "ta-rsi-14": 20,
  "ta-bb-pos": 20,
  "ta-macd-hist": 10,
  "ta-trend-50-200": 4,
  "ta-atr-pct": 4,
  "ta-stoch-k": 4,
  "ta-mom-63": 4,
  "ta-stoch-d": 2,
  "ta-williams-r": 3,
  "ta-stochrsi-k": 3,
  "ta-stochrsi-d": 1,
  "ta-cci-20": 3,
  "ta-vol-3d": 1,
  "ta-vol-ratio": 2,
  "ta-dist-52w-high": 3,
  "ta-er-10": 3,
  "ta-kernel-slope": 3,
  "ta-kernel-residual": 2,
  // The SMA/EMA family (16 specs) shares the remaining 8 points.
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

/** Every spec that takes part in this computation: built-ins + any custom. */
function specsFor(input: Pick<MegaInput, "custom">): IndicatorSpec[] {
  return input.custom?.length ? [...ALL_SPECS, ...input.custom] : ALL_SPECS;
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
