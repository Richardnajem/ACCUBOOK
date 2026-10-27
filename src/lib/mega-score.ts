// Mega Score as a TIME SERIES over daily bars — look-ahead-safe.
//
// Shared by:
//   - the "Mega Score" backtest strategy (regime filter on the composite),
//   - the backtest price chart overlay (score plotted under price),
//   - mega-history (per-indicator scores over time).
//
// Look-ahead safety: every indicator below is computed with trailing windows
// only (SMA/EMA/RSI/MACD/Bollinger/ATR/Stochastic/CCI/Williams %R/StochRSI in
// lib/ta are causal; rolling windows are trailing), and
// the centered Nadaraya-Watson kernel indicators are deliberately excluded —
// their centered variant reads future bars. The score at date D therefore uses
// exclusively data up to D, so it is safe to trade on bar-by-bar.

import { ALL_SPECS, MA_PERIODS, effectiveWeight, normalizeScore, specsWithOverrides, type IndicatorSpec, type IndicatorOverrideMap, type WeightMap } from "./mega-indicator";
import {
  sma, ema, rsi, macd, bollinger, atr, rollingMax, stochastic, cci, stdev, williamsR, stochRsi,
  adx, mfi, obv, keltnerPosition, aroon, superTrend, windowMean,
  donchianPosition, rangePosition, adl, chaikinMoneyFlow, chaikinOscillator,
  balanceOfPower, cmo, percentSlope,
  connorsRsi, coppock, pmo, dpo, emv, atrStop, rollingMin,
} from "./ta";
import { evaluateCustomSeries, evalFormula, type CustomIndicatorDef } from "./custom-indicators";

/** Minimal OHLCV shape needed (Bar satisfies it; strategies pass zipped arrays). */
export interface MegaScoreInput {
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** Optional — required only when evaluating custom formulas that use `open`. */
  open?: number[];
}

/** Specs computable causally at every bar (kernel indicators excluded). */
export const CAUSAL_SPECS: IndicatorSpec[] = ALL_SPECS.filter(
  (s) => s.id !== "ta-kernel-slope" && s.id !== "ta-kernel-residual"
);

export interface MegaScoreSeries {
  /** Composite 0-100 at each bar (50 = neutral where no indicator is ready yet). */
  score: number[];
  /** Per-indicator 0-100 score series keyed by spec id (NaN during warm-up). */
  indicators: Record<string, number[]>;
  /** Per-indicator RAW values keyed by spec id (RSI points, % distance, ratios …), NaN during warm-up. */
  raw: Record<string, number[]>;
  /** Specs of the custom definitions that evaluated successfully. */
  customSpecs: IndicatorSpec[];
  /**
   * Every spec that was scored, with the user's per-indicator overrides already
   * applied — names, units and scoring rules included. `snapshotMegaScore`
   * reads these so a log row describes the indicators the run actually used.
   */
  specs: IndicatorSpec[];
  /** Readable failures from custom definitions (empty when none were passed). */
  customErrors: string[];
}

/** One indicator's contribution to the composite on a single bar. */
export interface IndicatorReading {
  id: string;
  name: string;
  category: string;
  unit: string;
  /** What the indicator measures, in one line (shown as the row's tooltip). */
  description: string;
  /** Weight used in the composite (0 = not in it). */
  weight: number;
  /** The indicator's own value on the bar, in its natural units. */
  raw: number | null;
  /** Normalized 0-100 health score on the bar. */
  score: number | null;
  /** Points of the 0-100 composite this indicator added (null when it had no reading). */
  contribution: number | null;
}

/** Everything the composite was made of on one bar — what the trade log shows. */
export interface MegaScoreSnapshot {
  date: string;
  index: number;
  /** The composite printed for this bar (0-100, unrounded by the caller). */
  composite: number | null;
  /** Sum of the weights that actually contributed on this bar. */
  totalWeight: number;
  /** Every causal indicator (plus any custom ones), whether it contributed or not. */
  readings: IndicatorReading[];
  /** How many indicators had no reading yet (warm-up) on this bar. */
  missing: number;
}

/**
 * Compute the composite Mega Score (and every per-indicator score) at every bar.
 * Causal: output[i] depends only on bars[0..i].
 */
export function computeMegaScoreSeries(
  input: MegaScoreInput,
  weights?: WeightMap,
  custom?: CustomIndicatorDef[],
  overrides?: IndicatorOverrideMap,
): MegaScoreSeries {
  const { high, low, close, volume } = input;
  const n = close.length;
  /** Open prices — needed for Balance of Power; absent in some callers. */
  const open = input.open && input.open.length === n ? input.open : null;

  // ─── User-defined indicators (evaluated over the same bars) ──
  let customSpecs: IndicatorSpec[] = [];
  let customErrors: string[] = [];
  const customRaw: Record<string, number[]> = {};
  if (custom?.length) {
    if (input.open && input.open.length === n) {
      const res = evaluateCustomSeries(custom, {
        open: input.open, high, low, close, volume,
      });
      customSpecs = res.specs;
      customErrors = res.errors;
      Object.assign(customRaw, res.series);
    } else {
      customErrors = ["Open prices are unavailable for this data set — custom indicators were skipped."];
    }
  }

  // Raw indicator values, aligned with the bars (NaN during warm-up).
  const raw: Record<string, number[]> = {};
  const put = (key: string): number[] => (raw[key] ??= new Array(n).fill(NaN));

  const sma50 = sma(close, 50);
  const sma200 = sma(close, 200);
  const rsi14 = rsi(close, 14);
  const macdRes = macd(close, 12, 26, 9);
  const bb = bollinger(close, 20, 2);
  const atr14 = atr(high, low, close, 14);
  const volAvg = sma(volume, 20);
  const hi52 = rollingMax(close, 252);
  const stoch14 = stochastic(high, low, close, 14, 3, 3);
  const cci20 = cci(high, low, close, 20);
  const wr14 = williamsR(high, low, close, 14);
  const sr14 = stochRsi(close, 14, 14, 3, 3);
  const adx14 = adx(high, low, close, 14);
  const mfi14 = mfi(high, low, close, volume, 14);
  const obvSeries = obv(close, volume);
  const obvAvg = sma(obvSeries, 20);
  const kcPos = keltnerPosition(high, low, close, 20, 10, 2);
  const aroon25 = aroon(high, low, 25);
  const stTrend = superTrend(high, low, close, 10, 3);
  const vol3d = stdev(close, 3);

  // Workbook 181026 additions — all causal.
  const donchian20 = donchianPosition(high, low, close, 20);
  const fibPos = rangePosition(high, low, close, Math.min(252, n));
  const adlSeries = adl(high, low, close, volume);
  const adlAvg = sma(adlSeries, 20);
  const bop14 = open ? windowMean(balanceOfPower(open, high, low, close), 14) : null;
  const cmf20 = chaikinMoneyFlow(high, low, close, volume, 20);
  const chaikinOsc = chaikinOscillator(high, low, close, volume, 3, 10);
  const cmo14 = cmo(close, 14);
  const ema20 = ema(close, 20);
  const ema200 = ema(close, 200);
  const ema20Slope = percentSlope(ema20, close);
  const ema200Slope = percentSlope(ema200, close);

  // "technicals richard" additions — all causal.
  const connors = connorsRsi(close, 3, 2, 100);
  const coppockCurve = coppock(close, 10, 14, 11);
  const pmoRes = pmo(close, 35, 20, 10);
  const dpo20 = dpo(close, 20);
  const dpoPct = dpo20.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(close[i]) && close[i] !== 0 ? (v / close[i]) * 100 : NaN
  );
  const emv14 = emv(high, low, volume, 14);
  const atrTrail = atrStop(high, low, close, 14, 3, 200);
  const low52 = rollingMin(close, Math.min(252, n));

  for (let i = 0; i < n; i++) {
    const px = close[i];
    if (!Number.isFinite(px)) continue;

    // Trend: average % distance to the 50/200 SMAs
    const parts: number[] = [];
    if (Number.isFinite(sma50[i])) parts.push((px / sma50[i] - 1) * 100);
    if (Number.isFinite(sma200[i])) parts.push((px / sma200[i] - 1) * 100);
    if (parts.length) put("ta-trend-50-200")[i] = parts.reduce((s, v) => s + v, 0) / parts.length;

    if (Number.isFinite(rsi14[i])) put("ta-rsi-14")[i] = rsi14[i];

    // MACD histogram normalized to % of price so the scale is comparable
    if (Number.isFinite(macdRes.histogram[i])) put("ta-macd-hist")[i] = (macdRes.histogram[i] / px) * 100;

    // Bollinger position: 0 = lower band, 100 = upper band
    if (Number.isFinite(bb.upper[i]) && Number.isFinite(bb.lower[i]) && bb.upper[i] !== bb.lower[i]) {
      put("ta-bb-pos")[i] = ((px - bb.lower[i]) / (bb.upper[i] - bb.lower[i])) * 100;
    }

    if (Number.isFinite(atr14[i])) put("ta-atr-pct")[i] = (atr14[i] / px) * 100;

    // Stochastic (14,3,3) — slow %K and %D, 0-100
    if (Number.isFinite(stoch14.k[i])) put("ta-stoch-k")[i] = stoch14.k[i];
    if (Number.isFinite(stoch14.d[i])) put("ta-stoch-d")[i] = stoch14.d[i];

    // Commodity Channel Index (20)
    if (Number.isFinite(cci20[i])) put("ta-cci-20")[i] = cci20[i];

    // Williams %R (14) — 0 at the window high, −100 at the window low
    if (Number.isFinite(wr14[i])) put("ta-williams-r")[i] = wr14[i];

    // Stochastic RSI (14,14,3) — fast %K and %D, 0-100
    if (Number.isFinite(sr14.k[i])) put("ta-stochrsi-k")[i] = sr14.k[i];
    if (Number.isFinite(sr14.d[i])) put("ta-stochrsi-d")[i] = sr14.d[i];

    // Catalogue indicators (weight 0 until the user adds them)
    if (Number.isFinite(adx14.adx[i])) put("ta-adx-14")[i] = adx14.adx[i];
    if (Number.isFinite(mfi14[i])) put("ta-mfi-14")[i] = mfi14[i];
    if (Number.isFinite(obvAvg[i]) && Number.isFinite(volAvg[i]) && volAvg[i] > 0) {
      put("ta-obv-20")[i] = (obvSeries[i] - obvAvg[i]) / volAvg[i];
    }
    if (Number.isFinite(kcPos[i])) put("ta-kc-pos")[i] = kcPos[i];
    if (Number.isFinite(aroon25.osc[i])) put("ta-aroon-osc")[i] = aroon25.osc[i];
    if (Number.isFinite(stTrend.line[i]) && stTrend.line[i] !== 0) {
      put("ta-supertrend")[i] = ((px - stTrend.line[i]) / stTrend.line[i]) * 100;
    }

    // Donchian / Fibonacci range position, 0-100
    if (Number.isFinite(donchian20[i])) put("ta-donchian-pos")[i] = donchian20[i];
    if (Number.isFinite(fibPos[i])) put("ta-fib-pos")[i] = fibPos[i];

    // A/D line vs its 20-bar average, in average days of volume
    if (Number.isFinite(adlAvg[i]) && Number.isFinite(volAvg[i]) && volAvg[i] > 0) {
      put("ta-adl-20")[i] = (adlSeries[i] - adlAvg[i]) / volAvg[i];
    }

    // +DI − −DI, in the same 0-100 units as the directional indices
    if (Number.isFinite(adx14.plusDi[i]) && Number.isFinite(adx14.minusDi[i])) {
      put("ta-di-spread")[i] = adx14.plusDi[i] - adx14.minusDi[i];
    }

    // Smoothed Balance of Power (needs open prices)
    if (bop14 && Number.isFinite(bop14[i])) put("ta-bop-14")[i] = bop14[i];

    // Chaikin money flow, and the oscillator in days of average volume
    if (Number.isFinite(cmf20[i])) put("ta-cmf-20")[i] = cmf20[i];
    if (Number.isFinite(chaikinOsc[i]) && Number.isFinite(volAvg[i]) && volAvg[i] > 0) {
      put("ta-chaikin-osc")[i] = chaikinOsc[i] / volAvg[i];
    }

    // Chande momentum and the EMA slopes
    if (Number.isFinite(cmo14[i])) put("ta-cmo-14")[i] = cmo14[i];
    if (Number.isFinite(ema20Slope[i])) put("ta-ema20-slope")[i] = ema20Slope[i];
    if (Number.isFinite(ema200Slope[i])) put("ta-ema200-slope")[i] = ema200Slope[i];

    // "technicals richard": Connors RSI, Coppock, PMO, DPO, EMV, the ATR stop
    // and the distance above the 52-week low.
    if (Number.isFinite(connors.value[i])) put("ta-connors-rsi")[i] = connors.value[i];
    if (Number.isFinite(coppockCurve[i])) put("ta-coppock")[i] = coppockCurve[i];
    if (Number.isFinite(pmoRes.pmo[i])) put("ta-pmo")[i] = pmoRes.pmo[i];
    if (Number.isFinite(dpoPct[i])) put("ta-dpo-pct")[i] = dpoPct[i];
    if (Number.isFinite(emv14[i])) put("ta-emv-14")[i] = emv14[i];
    if (Number.isFinite(atrTrail.line[i]) && px !== 0) {
      put("ta-atr-stop")[i] = ((px - atrTrail.line[i]) / px) * 100;
    }
    if (Number.isFinite(low52[i]) && low52[i] > 0) {
      put("ta-dist-52w-low")[i] = ((px - low52[i]) / low52[i]) * 100;
    }

    // CTM: mean of RSI, CMO, EMA-20, EMA-200 and ADX. The workbook averages
    // the EMA price levels raw; score them as price-vs-EMA first so CTM stays a
    // bounded 0-100 reading instead of tracking the share price.
    const emaScore = (ma: number): number => {
      if (!Number.isFinite(ma) || ma === 0) return NaN;
      const pct = ((px - ma) / ma) * 100;
      return Math.max(0, Math.min(100, ((pct + 1) / 2) * 100));
    };
    const ctmParts = [rsi14[i], cmo14[i], emaScore(ema20[i]), emaScore(ema200[i]), adx14.adx[i]];
    if (ctmParts.every(Number.isFinite)) {
      put("ta-ctm")[i] = ctmParts.reduce((s, v) => s + v, 0) / ctmParts.length;
    }

    // 3-day volatility: sample stdev of closes, as % of price
    if (Number.isFinite(vol3d[i]) && px !== 0) put("ta-vol-3d")[i] = (vol3d[i] / px) * 100;

    // ~3-month momentum
    if (i >= 63) put("ta-mom-63")[i] = (px / close[i - 63] - 1) * 100;

    // Volume: last 5 days vs 20-day average
    const recentVol = volume.slice(Math.max(0, i - 4), i + 1).reduce((s, v) => s + v, 0) / Math.min(5, i + 1);
    if (Number.isFinite(volAvg[i]) && volAvg[i] > 0) put("ta-vol-ratio")[i] = recentVol / volAvg[i];

    // Distance below the 52-week high (%)
    if (Number.isFinite(hi52[i]) && hi52[i] > 0) put("ta-dist-52w-high")[i] = ((px - hi52[i]) / hi52[i]) * 100;

    // Kaufman Efficiency Ratio (10), trailing
    if (i >= 10) {
      let path = 0;
      for (let j = i - 9; j <= i; j++) path += Math.abs(close[j] - close[j - 1]);
      const net = Math.abs(px - close[i - 10]);
      if (path > 0) put("ta-er-10")[i] = net / path;
    }
  }

  // SMA/EMA family (10-200): price distance in % (above the MA = bullish)
  for (const p of MA_PERIODS) {
    const s = sma(close, p);
    const e = ema(close, p);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(s[i])) put(`ta-sma-${p}`)[i] = ((close[i] - s[i]) / s[i]) * 100;
      if (Number.isFinite(e[i])) put(`ta-ema-${p}`)[i] = ((close[i] - e[i]) / e[i]) * 100;
    }
  }

  // ─── User-edited calculations ─────────────────────────────────
  // An override whose `formula` is set REPLACES that indicator's built-in
  // series, evaluated over the same bars by the same sandbox as a custom
  // indicator. A failed or non-compiling expression keeps the built-in series
  // and says so, rather than silently scoring something else.
  if (overrides) {
    for (const [id, ov] of Object.entries(overrides)) {
      const formula = ov?.formula?.trim();
      if (!formula) continue;
      if (!ALL_SPECS.some((s) => s.id === id)) continue;
      try {
        const edited = evalFormula(formula, {
          open: open ?? new Array(n).fill(NaN),
          high, low, close, volume,
        });
        if (!edited.some((v) => Number.isFinite(v))) {
          customErrors.push(`Your formula for ${id} produced no value — the built-in calculation is still being used.`);
          continue;
        }
        raw[id] = edited.map((v) => (Number.isFinite(v) ? v : NaN));
        // A formula edit wins over a custom definition of the same id.
        delete customRaw[id];
      } catch (e) {
        customErrors.push(
          `Your formula for ${id} could not be evaluated (${e instanceof Error ? e.message : "invalid"}) — the built-in calculation is still being used.`
        );
      }
    }
  }

  // ─── Normalize + blend into the composite ─────────────────────
  const specsToScore: IndicatorSpec[] = specsWithOverrides([...CAUSAL_SPECS, ...customSpecs], overrides);
  const indicators: Record<string, number[]> = {};
  const rawValues: Record<string, number[]> = {};
  for (const spec of specsToScore) {
    const vals = spec.id in customRaw ? customRaw[spec.id] : raw[spec.id];
    if (!vals) continue;
    rawValues[spec.id] = vals;
    const scores = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(vals[i])) scores[i] = normalizeScore(vals[i], spec);
    }
    indicators[spec.id] = scores;
  }

  const score = new Array(n).fill(50);
  for (let i = 0; i < n; i++) {
    let wSum = 0;
    let wVal = 0;
    for (const spec of specsToScore) {
      const s = indicators[spec.id]?.[i];
      if (s === undefined || !Number.isFinite(s)) continue;
      const w = effectiveWeight(spec, weights);
      if (w <= 0) continue;
      wVal += s * w;
      wSum += w;
    }
    score[i] = wSum > 0 ? Math.round((wVal / wSum) * 10) / 10 : 50;
  }

  return { score, indicators, raw: rawValues, customSpecs, specs: specsToScore, customErrors };
}

/**
 * Decompose the composite on one bar: every indicator's raw reading, its
 * normalized 0-100 score, the weight it carried and the points it added. This
 * is what lets the trade log answer "why did the score cross the buy band?"
 * with the indicators themselves instead of just the total.
 */
export function snapshotMegaScore(
  series: MegaScoreSeries,
  barIndex: number,
  date: string,
  weights?: WeightMap
): MegaScoreSnapshot {
  // The series carries the specs it scored with (overrides applied), so the
  // snapshot describes the same indicators the run used.
  const specs: IndicatorSpec[] = series.specs?.length
    ? series.specs
    : [...CAUSAL_SPECS, ...series.customSpecs];
  const round2 = (v: number) => Math.round(v * 100) / 100;

  const scored = specs.map((spec) => {
    const s = series.indicators[spec.id]?.[barIndex];
    const r = series.raw[spec.id]?.[barIndex];
    return {
      spec,
      weight: effectiveWeight(spec, weights),
      score: s !== undefined && Number.isFinite(s) ? s : null,
      raw: r !== undefined && Number.isFinite(r) ? r : null,
    };
  });

  // Only indicators that have both a reading and a weight enter the average —
  // the same rule the composite itself uses, so contributions add up to it.
  const totalWeight = scored.reduce(
    (sum, x) => (x.score !== null && x.weight > 0 ? sum + x.weight : sum),
    0
  );

  const readings: IndicatorReading[] = scored.map((x) => ({
    id: x.spec.id,
    name: x.spec.name,
    category: x.spec.category,
    unit: x.spec.unit,
    description: x.spec.description,
    weight: x.weight,
    raw: x.raw,
    score: x.score === null ? null : Math.round(x.score * 10) / 10,
    contribution:
      x.score === null
        ? null
        : x.weight > 0 && totalWeight > 0
          ? round2((x.score * x.weight) / totalWeight)
          : 0,
  }));

  return {
    date,
    index: barIndex,
    composite: Number.isFinite(series.score[barIndex]) ? series.score[barIndex] : null,
    totalWeight: round2(totalWeight),
    readings,
    missing: readings.filter((r) => r.score === null).length,
  };
}
