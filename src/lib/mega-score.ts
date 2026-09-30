// Mega Score as a TIME SERIES over daily bars — look-ahead-safe.
//
// Shared by:
//   - the "Mega Score" backtest strategy (regime filter on the composite),
//   - the backtest price chart overlay (score plotted under price),
//   - mega-history (per-indicator scores over time).
//
// Look-ahead safety: every indicator below is computed with trailing windows
// only (SMA/EMA/RSI/MACD/Bollinger/ATR/rolling-max in lib/ta are causal), and
// the centered Nadaraya-Watson kernel indicators are deliberately excluded —
// their centered variant reads future bars. The score at date D therefore uses
// exclusively data up to D, so it is safe to trade on bar-by-bar.

import { ALL_SPECS, MA_PERIODS, normalizeScore, type IndicatorSpec, type WeightMap } from "./mega-indicator";
import { sma, ema, rsi, macd, bollinger, atr, rollingMax } from "./ta";

/** Minimal OHLCV shape needed (Bar satisfies it; strategies pass zipped arrays). */
export interface MegaScoreInput {
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
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
}

/**
 * Compute the composite Mega Score (and every per-indicator score) at every bar.
 * Causal: output[i] depends only on bars[0..i].
 */
export function computeMegaScoreSeries(
  input: MegaScoreInput,
  weights?: WeightMap
): MegaScoreSeries {
  const { high, low, close, volume } = input;
  const n = close.length;

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

  // ─── Normalize + blend into the composite ─────────────────────
  const indicators: Record<string, number[]> = {};
  for (const spec of CAUSAL_SPECS) {
    const vals = raw[spec.id];
    if (!vals) continue;
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
    for (const spec of CAUSAL_SPECS) {
      const s = indicators[spec.id]?.[i];
      if (s === undefined || !Number.isFinite(s)) continue;
      const w = Math.max(0, weights?.[spec.id] ?? 1);
      if (w <= 0) continue;
      wVal += s * w;
      wSum += w;
    }
    score[i] = wSum > 0 ? Math.round((wVal / wSum) * 10) / 10 : 50;
  }

  return { score, indicators };
}
