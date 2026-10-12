// Which indicators are worth adding to the Mega Indicator composite — or worth
// weighting up — for the ticker in front of the user.
//
// The rules are deliberately explicit: each one reads a *financial* property of
// the instrument (trend strength, trend quality, volatility regime, turnover,
// overbought/oversold) and names the indicators that carry the most signal in
// that state. Nothing here is random — the same market state always produces the
// same suggestions, which is what makes the behaviour testable.

import type { IndicatorSpec, WeightMap } from "./mega-indicator";

export interface SuggestionContext {
  /** ADX(14): trend strength, 0-100. */
  adx: number;
  /** Kaufman Efficiency Ratio (10): trend quality, 0-1. */
  efficiency: number;
  /** ATR(14) as a % of price: current volatility. */
  atrPct: number;
  /** The same measure's median over recent history: the volatility baseline. */
  atrPctMedian: number;
  /** ~3-month price change, %. */
  momentum: number;
  /** Recent volume ÷ its 20-day average. */
  volumeRatio: number;
  /** Distance from the 52-week high, % (negative = below it). */
  fromHigh: number;
}

export interface SuggestionInput {
  context: SuggestionContext;
  /** Latest raw readings, so rules can fire on extreme values too. */
  values: Record<string, number>;
  /** id → weight currently in force (0 = not in the composite). */
  weights: WeightMap;
  /** Every spec that may be proposed. */
  specs: IndicatorSpec[];
}

export type SuggestionKind = "add" | "reweight";

export interface Suggestion {
  id: string;
  name: string;
  /** "add" = put it in the composite, "reweight" = it is in but priced too low. */
  kind: SuggestionKind;
  /** Why, in plain language — shown verbatim in the UI. */
  reason: string;
  /** Weight to set if accepted. */
  weight: number;
  /** 0-1 evidence strength, used for ranking. */
  priority: number;
}

/** Most suggestions to hand back at once. */
export const MAX_SUGGESTIONS = 6;

/** Middle value of the finite entries (the mean of the middle pair when even). */
export function median(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return NaN;
  const mid = finite.length >> 1;
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Rank the indicators worth adding (or weighting up) for this market state.
 * Deterministic: same context and weights in, same list out.
 */
export function suggestIndicators(input: SuggestionInput): Suggestion[] {
  const { context: ctx, values } = input;
  const byId = new Map(input.specs.map((s) => [s.id, s]));
  const weightOf = (id: string): number => {
    const set = input.weights[id];
    if (set !== undefined) return Math.max(0, set);
    return byId.get(id)?.optional ? 0 : 1;
  };

  // Priority-ordered merge: a repeated id keeps the strongest reason and never
  // ends up weighted below what any rule asked for.
  const merged = new Map<string, Suggestion>();
  const propose = (
    id: string,
    weight: number,
    reason: string,
    priority: number
  ): void => {
    const spec = byId.get(id);
    if (!spec) return;
    const current = weightOf(id);
    if (current >= weight) return; // already at least this strong — nothing to do
    const candidate: Suggestion = {
      id,
      name: spec.name,
      kind: current > 0 ? "reweight" : "add",
      reason,
      weight,
      priority: clamp01(priority),
    };
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, candidate);
      return;
    }
    const winner = candidate.priority > existing.priority ? candidate : existing;
    merged.set(id, {
      ...winner,
      weight: Math.max(existing.weight, candidate.weight),
      kind: existing.kind === "reweight" || candidate.kind === "reweight" ? "reweight" : "add",
    });
  };

  // ─── 1. Trend strength: ADX says how much trend there is to follow ───
  if (Number.isFinite(ctx.adx)) {
    if (ctx.adx >= 25) {
      const strength = clamp01((ctx.adx - 25) / 25); // 25 → 0, 50 → 1
      const where = `ADX ${ctx.adx.toFixed(0)}`;
      propose("ta-adx-14", 1,
        `${where} — the market is trending, so trend strength is worth tracking directly.`,
        0.6 + 0.35 * strength);
      propose("ta-supertrend", 1,
        `${where} — a trending market suits a trailing ATR stop: it stays long (or short) instead of flipping on noise.`,
        0.55 + 0.35 * strength);
      propose("ta-aroon-osc", 1,
        `${where} — Aroon shows whether the trend's highs are still fresh or the trend is ageing.`,
        0.45 + 0.3 * strength);
      propose("ta-trend-50-200", 2,
        `${where} — with a real trend in place, the 50/200-day trend reading deserves more weight.`,
        0.5 + 0.3 * strength);
      propose("ta-er-10", 2,
        `${where} — the efficiency ratio keeps telling you whether the trend is still clean.`,
        0.4 + 0.3 * strength);
    } else if (ctx.adx < 20) {
      const flat = clamp01((20 - ctx.adx) / 20);
      const where = `ADX ${ctx.adx.toFixed(0)}`;
      propose("ta-mfi-14", 1,
        `${where} — no trend to follow, so a volume-weighted oscillator reads the range better than trend rules do.`,
        0.6 + 0.35 * flat);
      propose("ta-kc-pos", 1,
        `${where} — range-bound: where price sits between the Keltner bands is the useful reading.`,
        0.5 + 0.3 * flat);
      propose("ta-williams-r", 2,
        `${where} — in a range, the overbought/oversold oscillators are the ones that matter.`,
        0.45 + 0.3 * flat);
      propose("ta-stochrsi-k", 2,
        `${where} — StochRSI turns fast enough to catch range extremes.`,
        0.4 + 0.3 * flat);
      propose("ta-bb-pos", 2,
        `${where} — mean reversion: the Bollinger position is the range map.`,
        0.45 + 0.3 * flat);
    }
  }

  // ─── 2. Trend quality: Kaufman's efficiency ratio ───
  if (Number.isFinite(ctx.efficiency)) {
    if (ctx.efficiency >= 0.3) {
      propose("ta-supertrend", 1,
        `Efficiency ratio ${ctx.efficiency.toFixed(2)} — price is moving in a straight line, which is exactly what a trailing stop is built for.`,
        0.55 + 0.3 * clamp01((ctx.efficiency - 0.3) / 0.4));
    } else if (ctx.efficiency < 0.2) {
      propose("ta-mfi-14", 1,
        `Efficiency ratio ${ctx.efficiency.toFixed(2)} — price is covering distance without going anywhere; oscillators beat trend followers here.`,
        0.5 + 0.3 * clamp01((0.2 - ctx.efficiency) / 0.2));
    }
  }

  // ─── 3. Volatility regime: ATR% against its own recent median ───
  if (Number.isFinite(ctx.atrPct) && Number.isFinite(ctx.atrPctMedian) && ctx.atrPctMedian > 0) {
    const ratio = ctx.atrPct / ctx.atrPctMedian;
    if (ratio >= 1.5) {
      const heat = clamp01((ratio - 1.5) / 1.5);
      propose("ta-kc-pos", 1,
        `Volatility is ${ratio.toFixed(1)}× its usual level — ATR-based bands adapt to that, fixed-percentage levels do not.`,
        0.5 + 0.3 * heat);
      propose("ta-atr-pct", 2,
        `Volatility is ${ratio.toFixed(1)}× its usual level — the ATR reading itself is carrying information right now.`,
        0.45 + 0.3 * heat);
    } else if (ratio <= 0.7) {
      propose("ta-kc-pos", 1,
        `Volatility is only ${ratio.toFixed(1)}× its usual level — a quiet tape, so the bands sit tight around price.`,
        0.45);
    }
  }

  // ─── 4. Turnover: is anyone actually trading this? ───
  if (Number.isFinite(ctx.volumeRatio) && ctx.volumeRatio >= 1.5) {
    const participation = clamp01((ctx.volumeRatio - 1.5) / 1.5);
    propose("ta-obv-20", 1,
      `Volume is ${ctx.volumeRatio.toFixed(1)}× its 20-day average — OBV shows which side of the tape that volume is on.`,
      0.55 + 0.3 * participation);
    propose("ta-mfi-14", 1,
      `Volume is ${ctx.volumeRatio.toFixed(1)}× its 20-day average — money flow tells you whether the move has real participation.`,
      0.45 + 0.3 * participation);
  }

  // ─── 5. Extremes: an overbought/oversold reading wants confirmation ───
  const rsi = values["ta-rsi-14"];
  if (Number.isFinite(rsi) && (rsi >= 70 || rsi <= 30)) {
    const extreme = clamp01((Math.abs(rsi - 50) - 20) / 30);
    propose("ta-mfi-14", 1,
      `RSI ${rsi.toFixed(0)} is ${rsi >= 70 ? "overbought" : "oversold"} — money flow confirms whether the move is backed by volume.`,
      0.5 + 0.3 * extreme);
  }

  // ─── 6. Distance from the 52-week high: broken or extended? ───
  if (Number.isFinite(ctx.fromHigh) && ctx.fromHigh <= -25) {
    propose("ta-supertrend", 1,
      `Price is ${Math.abs(ctx.fromHigh).toFixed(0)}% below its 52-week high — a trailing stop is the honest way to test whether the downtrend is still intact.`,
      0.5);
  }

  return [...merged.values()]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, MAX_SUGGESTIONS);
}
