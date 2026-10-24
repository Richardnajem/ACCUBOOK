// Technical analysis indicators — pure functions over arrays of numbers.
// All series-returning functions are aligned with the input; warm-up values are NaN.

export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      prev = sum / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) =>
    Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]
  );
  const firstIdx = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal: number[] = new Array(values.length).fill(NaN);
  if (firstIdx >= 0) {
    const compact = macdLine.slice(firstIdx);
    const sigCompact = ema(compact, signalPeriod);
    for (let i = 0; i < sigCompact.length; i++) signal[firstIdx + i] = sigCompact[i];
  }
  const histogram = signal.map((s, i) =>
    Number.isNaN(s) || Number.isNaN(macdLine[i]) ? NaN : macdLine[i] - s
  );
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const upper: number[] = new Array(values.length).fill(NaN);
  const lower: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += Math.pow(values[j] - middle[i], 2);
    const sd = Math.sqrt(variance / period);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
  }
  return { upper, middle, lower };
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number[] {
  const len = closes.length;
  const out: number[] = new Array(len).fill(NaN);
  if (len < 2) return out;
  const tr: number[] = [0];
  for (let i = 1; i < len; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  if (len <= period) return out;
  let prev = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < len; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Simple mean over the trailing `period` values.
 * Unlike sma(), this tolerates leading NaNs: a window containing any non-finite
 * value yields NaN instead of poisoning the whole running sum. Needed because
 * derived series (raw %K, smoothed %K…) start with a warm-up of NaNs.
 */
export function windowMean(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  let gaps = 0; // non-finite values currently inside the window
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) sum += v;
    else gaps++;
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) sum -= old;
      else gaps--;
    }
    if (i >= period - 1 && gaps === 0) out[i] = sum / period;
  }
  return out;
}

export interface StochasticResult {
  /** Slow %K: raw %K smoothed over `kSmooth` periods. */
  k: number[];
  /** %D: %K smoothed over `dSmooth` periods. */
  d: number[];
}

/**
 * Stochastic oscillator, slow form: raw %K → %K (smoothed) → %D.
 * raw %K = 100 × (close − lowest low) / (highest high − lowest low) over kPeriod.
 * Matches the standard (14,3,3) configuration and the workbook's
 * "Raw%k 14" → "First smoothing (3-period SMA)" → "%D" columns.
 */
export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): StochasticResult {
  const n = closes.length;
  const raw = new Array(n).fill(NaN);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const range = hh - ll;
    if (range > 0) raw[i] = ((closes[i] - ll) / range) * 100;
  }
  const k = windowMean(raw, kSmooth);
  const d = windowMean(k, dSmooth);
  return { k, d };
}

/**
 * Commodity Channel Index: (typical price − SMA of typical price) / (0.015 ×
 * mean absolute deviation), with typical price = (high + low + close) / 3.
 * The classic 20-period lookback. A perfectly flat window has zero deviation,
 * so the CCI is defined as 0 (the neutral limit) instead of 0/0.
 */
export function cci(highs: number[], lows: number[], closes: number[], period = 20): number[] {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (period <= 0) return out;
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period - 1; i < n; i++) {
    const from = i - period + 1;
    let sum = 0;
    for (let j = from; j <= i; j++) sum += tp[j];
    const mid = sum / period;
    let dev = 0;
    for (let j = from; j <= i; j++) dev += Math.abs(tp[j] - mid);
    const meanDev = dev / period;
    out[i] = meanDev > 0 ? (tp[i] - mid) / (0.015 * meanDev) : 0;
  }
  return out;
}

/**
 * Rolling sample standard deviation (n − 1 denominator, matching Excel's STDEV)
 * over the trailing `period` values. NaN during warm-up.
 */
export function stdev(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period < 2) return out;
  for (let i = period - 1; i < values.length; i++) {
    const from = i - period + 1;
    let sum = 0;
    let ok = true;
    for (let j = from; j <= i; j++) {
      if (!Number.isFinite(values[j])) { ok = false; break; }
      sum += values[j];
    }
    if (!ok) continue;
    const mean = sum / period;
    let acc = 0;
    for (let j = from; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / (period - 1));
  }
  return out;
}

// Highest/lowest over a lookback window ending at each index (NaN during warm-up).
// A window must be *full* of finite values: derived series (RSI, %K…) start with
// a warm-up of NaNs, and silently taking the extreme of the defined subset would
// report a reading several bars before the indicator is actually ready.
export function rollingMax(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) { ok = false; break; }
      if (v > m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

export function rollingMin(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (!Number.isFinite(v)) { ok = false; break; }
      if (v < m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/**
 * Williams %R: where the close sits inside the last `period` bars' high-low
 * range, quoted upside-down — −100 at the window low, 0 at the window high
 * (so below −80 reads oversold, above −20 overbought — the same numbers the
 * reference workbook keeps in its "Williams %R (14)" column).
 * A window with no range has no answer and stays NaN. The result is deliberately
 * not clamped to [−100, 0]: a close outside its own 14-bar range (adjusted
 * history, extended-hours prints) should keep its true sign and size.
 */
export function williamsR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    let ok = Number.isFinite(closes[i]);
    for (let j = i - period + 1; ok && j <= i; j++) {
      const h = highs[j];
      const l = lows[j];
      if (!Number.isFinite(h) || !Number.isFinite(l)) { ok = false; break; }
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    if (!ok) continue;
    const range = hh - ll;
    if (range > 0) out[i] = (-100 * (hh - closes[i])) / range;
  }
  return out;
}

export interface StochRsiResult {
  /** Raw StochRSI: the RSI's position inside its own `stochPeriod` range, 0-100. */
  q: number[];
  /** Fast %K: `kSmooth`-period SMA of the raw series. */
  k: number[];
  /** Fast %D: `dSmooth`-period SMA of %K. */
  d: number[];
}

/**
 * Stochastic RSI (Chande & Kroll): runs the stochastic formula on RSI itself
 * instead of on price, so the oscillator reacts far faster than RSI alone.
 *   raw = (RSI − min(RSI, stochPeriod)) / (max(RSI, stochPeriod) − min(RSI, stochPeriod))
 *   %K  = SMA(kSmooth, raw);  %D = SMA(dSmooth, %K)
 * Quoted 0-100 like the app's other oscillators — the reference workbook keeps
 * the raw quotient on a 0-1 scale, i.e. exactly this number ÷ 100.
 * A flat RSI window has zero range, so the reading stays NaN rather than
 * manufacturing a 0 or 100 out of a division by zero.
 * Readings are clamped to 0-100, which only ever trims rounding noise.
 */
export function stochRsi(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3
): StochRsiResult {
  const n = closes.length;
  const q: number[] = new Array(n).fill(NaN);
  if (rsiPeriod <= 0 || stochPeriod <= 0) {
    return { q, k: new Array(n).fill(NaN), d: new Array(n).fill(NaN) };
  }
  const r = rsi(closes, rsiPeriod);
  const lo = rollingMin(r, stochPeriod);
  const hi = rollingMax(r, stochPeriod);
  for (let i = 0; i < n; i++) {
    const range = hi[i] - lo[i];
    if (Number.isFinite(range) && range > 0) q[i] = ((r[i] - lo[i]) / range) * 100;
  }
  // The quotient is bounded by construction, but windowMean's running sum drifts
  // by ~1e-14 over a long series: clamp so a smoothed reading never reports a
  // (slightly) negative oversold value.
  const clamp = (v: number): number => (v < 0 ? 0 : v > 100 ? 100 : v);
  const k = windowMean(q, kSmooth).map(clamp);
  const d = windowMean(k, dSmooth).map(clamp);
  return { q: q.map(clamp), k, d };
}
// ─── Catalogue indicators ───────────────────────────────────────
// Computed for every ticker but left out of the composite until the user adds
// them (see lib/indicator-suggestions and the specs marked `optional`). Every
// series is causal: trailing windows only, NaN through warm-up.

export interface AdxResult {
  /** Wilder's ADX (trend strength, 0-100). */
  adx: number[];
  /** +DI and −DI: which side of the directional movement is winning. */
  plusDi: number[];
  minusDi: number[];
}

/**
 * Wilder's Average Directional Index with +DI / −DI.
 *   TR   = max(H−L, |H−close₁|, |L−close₁|)
 *   +DM  = (H−H₁ > L₁−L and H−H₁ > 0) ? H−H₁ : 0        (mirrored for −DM)
 *   +DI  = 100 · S(+DM) / S(TR)                          (S = Wilder's smoothing)
 *   DX   = 100 · |+DI − −DI| / (+DI + −DI)
 *   ADX  = S(DX)
 * S(x) is seeded with the mean of the first `period` values and then
 * Sₜ = (Sₜ₋₁·(period−1) + xₜ)/period — the same recursion lib/ta uses for ATR.
 * ADX measures how *trending* the market is, not its direction: <20 is choppy,
 * >40 is a strong trend.
 */
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): AdxResult {
  const n = closes.length;
  const adxOut: number[] = new Array(n).fill(NaN);
  const plusDi: number[] = new Array(n).fill(NaN);
  const minusDi: number[] = new Array(n).fill(NaN);
  // DX first exists at index `period`, and ADX needs `period` DX values on top.
  if (period <= 0 || n < period * 2) return { adx: adxOut, plusDi, minusDi };

  const tr: number[] = new Array(n).fill(NaN);
  const plusDm: number[] = new Array(n).fill(NaN);
  const minusDm: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (
      !Number.isFinite(highs[i]) || !Number.isFinite(lows[i]) ||
      !Number.isFinite(highs[i - 1]) || !Number.isFinite(lows[i - 1]) ||
      !Number.isFinite(closes[i - 1])
    ) continue;
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  let atrW = 0;
  let plusW = 0;
  let minusW = 0;
  for (let i = 1; i <= period; i++) {
    if (!Number.isFinite(tr[i])) return { adx: adxOut, plusDi, minusDi };
    atrW += tr[i];
    plusW += plusDm[i];
    minusW += minusDm[i];
  }
  atrW /= period;
  plusW /= period;
  minusW /= period;

  const dx: number[] = new Array(n).fill(NaN);
  const recordDx = (i: number): void => {
    if (atrW === 0) {
      plusDi[i] = 0;
      minusDi[i] = 0;
      dx[i] = 0;
      return;
    }
    plusDi[i] = (100 * plusW) / atrW;
    minusDi[i] = (100 * minusW) / atrW;
    const sum = plusDi[i] + minusDi[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDi[i] - minusDi[i])) / sum;
  };
  recordDx(period);
  for (let i = period + 1; i < n; i++) {
    atrW = (atrW * (period - 1) + tr[i]) / period;
    plusW = (plusW * (period - 1) + plusDm[i]) / period;
    minusW = (minusW * (period - 1) + minusDm[i]) / period;
    recordDx(i);
  }

  // ADX = Wilder average of DX, seeded with the first `period` DX values.
  let sum = 0;
  for (let i = period; i < period * 2; i++) sum += dx[i];
  let adxW = sum / period;
  adxOut[period * 2 - 1] = adxW;
  for (let i = period * 2; i < n; i++) {
    adxW = (adxW * (period - 1) + dx[i]) / period;
    adxOut[i] = adxW;
  }
  return { adx: adxOut, plusDi, minusDi };
}

/**
 * Money Flow Index — RSI weighted by the money that actually changed hands.
 *   TP = (H+L+C)/3;  MF = TP · volume
 *   MFR = Σ(MF over bars whose TP rose, `period`) / Σ(MF over bars whose TP fell)
 *   MFI = 100 − 100/(1 + MFR)
 * A window with no negative flow reads 100 (all accumulation); a window with no
 * money flow at all has no answer and stays NaN.
 */
export function mfi(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period = 14
): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0 || n < period + 1) return out;
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = period; i < n; i++) {
    let positive = 0;
    let negative = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const volume = volumes[j];
      if (!Number.isFinite(tp[j]) || !Number.isFinite(tp[j - 1]) || !Number.isFinite(volume)) {
        ok = false;
        break;
      }
      const flow = tp[j] * volume;
      if (tp[j] > tp[j - 1]) positive += flow;
      else if (tp[j] < tp[j - 1]) negative += flow;
    }
    if (!ok) continue;
    if (negative === 0) {
      if (positive > 0) out[i] = 100;
      continue; // no money moved either way — no reading
    }
    out[i] = 100 - 100 / (1 + positive / negative);
  }
  return out;
}

/**
 * On-Balance Volume: a running total that adds the day's volume on an up-close
 * and removes it on a down-close (an unchanged close leaves the total alone).
 * The level is arbitrary — compare it to its own average, which is what the
 * "OBV vs 20-bar average" indicator does.
 */
export function obv(closes: number[], volumes: number[]): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  let total = 0;
  let started = false;
  for (let i = 0; i < n; i++) {
    const close = closes[i];
    const volume = volumes[i];
    if (!Number.isFinite(close) || !Number.isFinite(volume)) {
      out[i] = started ? total : NaN;
      continue;
    }
    if (!started) {
      started = true; // the first bar only establishes the baseline
    } else if (close > closes[i - 1]) {
      total += volume;
    } else if (close < closes[i - 1]) {
      total -= volume;
    }
    out[i] = total;
  }
  return out;
}

export interface KeltnerBands {
  upper: number[];
  middle: number[];
  lower: number[];
}

/**
 * Keltner channel: an EMA-20 middle with bands 2 ATR(10) away — the ATR-driven
 * cousin of the Bollinger bands (whose width follows the standard deviation).
 */
export function keltner(
  highs: number[],
  lows: number[],
  closes: number[],
  emaPeriod = 20,
  atrPeriod = 10,
  mult = 2
): KeltnerBands {
  const n = closes.length;
  const middle = ema(closes, emaPeriod);
  const range = atr(highs, lows, closes, atrPeriod);
  const upper: number[] = new Array(n).fill(NaN);
  const lower: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(middle[i]) || !Number.isFinite(range[i])) continue;
    upper[i] = middle[i] + mult * range[i];
    lower[i] = middle[i] - mult * range[i];
  }
  return { upper, middle, lower };
}

/**
 * Where the close sits inside the Keltner channel, 0-100 (0 = on the lower
 * band, 100 = on the upper band). A channel with no width has no position.
 */
export function keltnerPosition(
  highs: number[],
  lows: number[],
  closes: number[],
  emaPeriod = 20,
  atrPeriod = 10,
  mult = 2
): number[] {
  const { upper, lower } = keltner(highs, lows, closes, emaPeriod, atrPeriod, mult);
  return closes.map((close, i) => {
    if (!Number.isFinite(close) || !Number.isFinite(upper[i]) || !Number.isFinite(lower[i])) {
      return NaN;
    }
    const width = upper[i] - lower[i];
    return width > 0 ? ((close - lower[i]) / width) * 100 : NaN;
  });
}

export interface AroonResult {
  /** 100 when the highest high of the window is the current bar, 0 when it is `period` bars old. */
  up: number[];
  down: number[];
  /** Up − Down: positive = the highs are fresher than the lows. */
  osc: number[];
}

/**
 * Aroon (Chande): how recently price made its window's high and low.
 *   Up   = 100 · (period − bars since the highest high) / period
 *   Down = 100 · (period − bars since the lowest low) / period
 * The window is the latest `period + 1` bars (the convention TradingView's
 * ta.aroon and StockCharts describe), so a high that is `period` bars old
 * scores 0 and a fresh high scores 100. Ties resolve to the most recent bar.
 */
export function aroon(highs: number[], lows: number[], period = 25): AroonResult {
  const n = highs.length;
  const up: number[] = new Array(n).fill(NaN);
  const down: number[] = new Array(n).fill(NaN);
  const osc: number[] = new Array(n).fill(NaN);
  if (period <= 0) return { up, down, osc };
  for (let i = period; i < n; i++) {
    const from = i - period;
    let hiIdx = -1;
    let loIdx = -1;
    let ok = true;
    for (let j = i; j >= from; j--) {
      if (!Number.isFinite(highs[j]) || !Number.isFinite(lows[j])) { ok = false; break; }
      if (hiIdx < 0 || highs[j] > highs[hiIdx]) hiIdx = j;
      if (loIdx < 0 || lows[j] < lows[loIdx]) loIdx = j;
    }
    if (!ok) continue;
    up[i] = (100 * (period - (i - hiIdx))) / period;
    down[i] = (100 * (period - (i - loIdx))) / period;
    osc[i] = up[i] - down[i];
  }
  return { up, down, osc };
}

export interface SuperTrendResult {
  /** The trailing stop line (a lower band in an uptrend, an upper band in a downtrend). */
  line: number[];
  /** +1 while the close holds above the line, −1 once it breaks it. */
  direction: number[];
}

/**
 * SuperTrend (ATR period 10, multiplier 3).
 *   upper/lower = (H+L)/2 ± 3·ATR
 * Each band ratchets toward price and only gives way when the close crosses it:
 *   finalUpperₜ = (upperₜ < finalUpperₜ₋₁ || closeₜ₋₁ > finalUpperₜ₋₁) ? upperₜ : finalUpperₜ₋₁
 *   finalLowerₜ = (lowerₜ > finalLowerₜ₋₁ || closeₜ₋₁ < finalLowerₜ₋₁) ? lowerₜ : finalLowerₜ₋₁
 * The trend is up while the close stays above finalLower, and flips to up only
 * when the close closes back above finalUpper — so the line trails the trend.
 */
export function superTrend(
  highs: number[],
  lows: number[],
  closes: number[],
  atrPeriod = 10,
  mult = 3
): SuperTrendResult {
  const n = closes.length;
  const line: number[] = new Array(n).fill(NaN);
  const direction: number[] = new Array(n).fill(NaN);
  const range = atr(highs, lows, closes, atrPeriod);
  let upper = NaN;
  let lower = NaN;
  let up = true;
  let prevClose = NaN;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(range[i]) || !Number.isFinite(closes[i])) continue;
    const mid = (highs[i] + lows[i]) / 2;
    const basicUpper = mid + mult * range[i];
    const basicLower = mid - mult * range[i];
    if (Number.isFinite(upper)) {
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      up = up ? closes[i] > lower : closes[i] > upper;
    } else {
      upper = basicUpper;
      lower = basicLower;
      up = closes[i] >= mid;
    }
    line[i] = up ? lower : upper;
    direction[i] = up ? 1 : -1;
    prevClose = closes[i];
  }
  return { line, direction };
}

// ─── "Indicators project 181026" additions ──────────────────────
// The reference workbook's later blocks: Donchian, swing/Fibonacci range,
// accumulation/distribution, Chaikin money flow & oscillator, Balance of
// Power, Chande momentum and the EMA slopes. All causal (trailing windows),
// NaN through warm-up.

export interface DonchianResult {
  /** Highest high over the window. */
  upper: number[];
  /** Lowest low over the window. */
  lower: number[];
  /** Midpoint of the two channels. */
  middle: number[];
}

/** Donchian channel: the highest high and lowest low of the last `period` bars. */
export function donchian(highs: number[], lows: number[], period = 20): DonchianResult {
  const upper = rollingMax(highs, period);
  const lower = rollingMin(lows, period);
  const middle = lower.map((lo, i) =>
    Number.isFinite(lo) && Number.isFinite(upper[i]) ? (lo + upper[i]) / 2 : NaN
  );
  return { upper, lower, middle };
}

/**
 * Where the close sits inside the Donchian channel, 0-100 (0 = on the lower
 * channel, 100 = on the upper). A channel with no width has no position.
 */
export function donchianPosition(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 20
): number[] {
  const { upper, lower } = donchian(highs, lows, period);
  return closes.map((close, i) => {
    if (!Number.isFinite(close) || !Number.isFinite(upper[i]) || !Number.isFinite(lower[i])) {
      return NaN;
    }
    const width = upper[i] - lower[i];
    return width > 0 ? ((close - lower[i]) / width) * 100 : NaN;
  });
}

/**
 * Position of the close inside its `period`-bar high-low range, 0-100.
 * This is the range the workbook draws its Fibonacci retracements on: 100 at
 * the range high, 0 at the range low. Unlike a rolling channel it uses the
 * window's extremes directly, so it also answers "how much of the range has
 * this move retraced?".
 */
export function rangePosition(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number
): number[] {
  const upper = rollingMax(highs, period);
  const lower = rollingMin(lows, period);
  return closes.map((close, i) => {
    if (!Number.isFinite(close) || !Number.isFinite(upper[i]) || !Number.isFinite(lower[i])) {
      return NaN;
    }
    const width = upper[i] - lower[i];
    return width > 0 ? ((close - lower[i]) / width) * 100 : NaN;
  });
}

/**
 * Chaikin Accumulation/Distribution line.
 *   MFM = ((C − L) − (H − C)) / (H − L)          (0 when H = L)
 *   MFV = MFM · volume
 *   ADLₜ = ADLₜ₋₁ + MFVₜ
 * The level is arbitrary — compare it with its own average, which is what the
 * "ADL vs 20-bar average" indicator does. Note that the reference workbook's
 * ADL column stores only the day's MFV, not the running total; the cumulative
 * definition above is the standard one (and the one its CMF column implies).
 */
export function adl(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[]
): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  let total = 0;
  let started = false;
  for (let i = 0; i < n; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    const v = volumes[i];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) {
      out[i] = started ? total : NaN;
      continue;
    }
    started = true;
    if (h !== l) total += (((c - l) - (h - c)) / (h - l)) * v;
    out[i] = total;
  }
  return out;
}

/**
 * Chaikin Money Flow over `period` bars:
 *   CMF = Σ(MFV, period) / Σ(volume, period),   MFV = MFM · volume
 * Range −1…+1; positive means the closes are accumulating on strength.
 * A window with no volume has no reading (NaN) rather than a fabricated 0.
 */
export function chaikinMoneyFlow(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period = 20
): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < n; i++) {
    let flow = 0;
    let volume = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const h = highs[j];
      const l = lows[j];
      const c = closes[j];
      const v = volumes[j];
      if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      if (h !== l) flow += (((c - l) - (h - c)) / (h - l)) * v;
      volume += v;
    }
    if (ok && volume > 0) out[i] = flow / volume;
  }
  return out;
}

/**
 * Chaikin Oscillator: EMA(fast, ADL) − EMA(slow, ADL). Positive when the
 * shorter money-flow average is pulling away from the longer one (accumulation
 * accelerating). The raw value scales with volume, so the app divides it by
 * average volume before scoring it — days of average volume.
 */
export function chaikinOscillator(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  fast = 3,
  slow = 10
): number[] {
  const line = adl(highs, lows, closes, volumes);
  const emaAligned = (values: number[], period: number): number[] => {
    const out: number[] = new Array(values.length).fill(NaN);
    const start = values.findIndex(Number.isFinite);
    if (start < 0) return out;
    const compact = ema(values.slice(start), period);
    for (let i = 0; i < compact.length; i++) out[start + i] = compact[i];
    return out;
  };
  const fastEma = emaAligned(line, fast);
  const slowEma = emaAligned(line, slow);
  return line.map((_, i) =>
    Number.isFinite(fastEma[i]) && Number.isFinite(slowEma[i]) ? fastEma[i] - slowEma[i] : NaN
  );
}

/**
 * Balance of Power: where the close finished inside the bar's range, from the
 * open. (C − O)/(H − L): +1 = buyers closed at the high, −1 = sellers closed at
 * the low. A bar with no range has no answer and stays NaN. The workbook's
 * "Smoothed BOP (14)" is simply windowMean(bop(...), 14).
 */
export function balanceOfPower(
  opens: number[],
  highs: number[],
  lows: number[],
  closes: number[]
): number[] {
  return closes.map((close, i) => {
    const open = opens[i];
    const high = highs[i];
    const low = lows[i];
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return NaN;
    }
    const range = high - low;
    return range > 0 ? (close - open) / range : NaN;
  });
}

/**
 * Chande Momentum Oscillator:
 *   CMO = 100 · (Σup − Σdown) / (Σup + Σdown)   over `period` close changes
 * Range −100…+100. Unlike RSI it uses no smoothing, so it turns faster; a flat
 * window has no momentum and reads 0 (the exact neutral value).
 */
export function cmo(closes: number[], period = 14): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(NaN);
  if (period <= 0) return out;
  for (let i = period; i < n; i++) {
    let up = 0;
    let down = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const ch = closes[j] - closes[j - 1];
      if (!Number.isFinite(ch)) {
        ok = false;
        break;
      }
      if (ch > 0) up += ch;
      else down -= ch;
    }
    if (!ok) continue;
    out[i] = up + down > 0 ? (100 * (up - down)) / (up + down) : 0;
  }
  return out;
}

/**
 * One-bar percent slope of a series, expressed against a base series:
 *   slopeᵢ = (vᵢ − vᵢ₋₁) / baseᵢ · 100
 * Used for the EMA-20 / EMA-200 slopes (base = close), matching the workbook's
 * "EMA20 slope" / "EMA200 slope" columns.
 */
export function percentSlope(values: number[], base: number[]): number[] {
  return values.map((v, i) => {
    if (i === 0) return NaN;
    const prev = values[i - 1];
    const denom = base[i];
    if (!Number.isFinite(v) || !Number.isFinite(prev) || !Number.isFinite(denom) || denom === 0) {
      return NaN;
    }
    return ((v - prev) / denom) * 100;
  });
}

// ─── "technicals richard" additions ─────────────────────────────
// The blocks that workbook carries and the app had yet to compute: the
// momentum family (Connors RSI, Coppock, PMO, DPO), Ease of Movement, the
// EMA-200 filtered ATR stop and the distance above the 52-week low.
// All causal (trailing windows only), NaN through warm-up.

/**
 * Rate of change over `period` bars, in percent: (v − v[t−period])/v[t−period]·100.
 * A zero base has no answer and stays NaN rather than reporting an infinite jump.
 */
export function rateOfChange(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = period; i < values.length; i++) {
    const base = values[i - period];
    if (!Number.isFinite(values[i]) || !Number.isFinite(base) || base === 0) continue;
    out[i] = ((values[i] - base) / base) * 100;
  }
  return out;
}

/**
 * Linearly weighted moving average: the most recent bar carries weight
 * `period`, the oldest weight 1 (the standard WMA, and the one the Coppock
 * curve is defined on). NaN during warm-up; a window with a gap stays NaN.
 */
export function wma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (!Number.isFinite(v)) { ok = false; break; }
      sum += (j + 1) * v;
    }
    if (ok) out[i] = sum / denom;
  }
  return out;
}

export interface ConnorsRsiResult {
  /** RSI of the close over `rsiPeriod` bars (short — 3 by default). */
  rsi: number[];
  /** RSI of the up/down streak length over `streakPeriod` bars. */
  streakRsi: number[];
  /** Percent rank (0-100) of the 1-bar return among the prior `rankPeriod` bars. */
  percentRank: number[];
  /** The average of the three legs — ConnorsRSI, 0-100. */
  value: number[];
}

/**
 * Connors RSI (Connors & Alvarez): the mean of three short-term readings —
 *   1. RSI(3) of the close
 *   2. RSI(2) of the streak length (how many consecutive up/down closes)
 *   3. the percent rank of today's 1-bar return in the last 100 bars
 * Because every leg is short and bounded, it turns far faster than RSI(14);
 * the conventional extremes are 90 (overbought) and 10 (oversold).
 * A flat close resets the streak to 0; percent rank counts prior returns that
 * are strictly lower, so a tie scores the lower rank rather than a fake one.
 */
export function connorsRsi(
  closes: number[],
  rsiPeriod = 3,
  streakPeriod = 2,
  rankPeriod = 100
): ConnorsRsiResult {
  const n = closes.length;
  const r = rsi(closes, rsiPeriod);

  const streak: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) { streak[i] = 0; continue; }
    const change = closes[i] - closes[i - 1];
    if (!Number.isFinite(change)) continue;
    if (change > 0) streak[i] = (Number.isFinite(streak[i - 1]) && streak[i - 1] > 0 ? streak[i - 1] : 0) + 1;
    else if (change < 0) streak[i] = (Number.isFinite(streak[i - 1]) && streak[i - 1] < 0 ? streak[i - 1] : 0) - 1;
    else streak[i] = 0;
  }
  const streakRsi = rsi(streak, streakPeriod);

  const returns: number[] = closes.map((c, i) =>
    i === 0 || !Number.isFinite(closes[i - 1]) || closes[i - 1] === 0
      ? NaN
      : c / closes[i - 1] - 1
  );
  const percentRank: number[] = new Array(n).fill(NaN);
  if (rankPeriod > 0) {
    for (let i = rankPeriod; i < n; i++) {
      if (!Number.isFinite(returns[i])) continue;
      let lower = 0;
      let ok = true;
      for (let j = i - rankPeriod; j < i; j++) {
        if (!Number.isFinite(returns[j])) { ok = false; break; }
        if (returns[j] < returns[i]) lower++;
      }
      if (ok) percentRank[i] = (lower / rankPeriod) * 100;
    }
  }

  const value = closes.map((_, i) =>
    Number.isFinite(r[i]) && Number.isFinite(streakRsi[i]) && Number.isFinite(percentRank[i])
      ? (r[i] + streakRsi[i] + percentRank[i]) / 3
      : NaN
  );
  return { rsi: r, streakRsi, percentRank, value };
}

/**
 * Coppock Curve: a 10-month WMA of the sum of the 14- and 11-bar rates of
 * change — designed for monthly bars, applied here to daily closes. A move
 * through zero marks the end of a bear phase (the only signal Edwin Coppock
 * intended); on daily data it is a medium-term momentum turn.
 * ROC is in percent (the workbook keeps it as a fraction); the WMA weights the
 * newest bar most, while the workbook's own final smoothing weights the oldest
 * bar most, so its curve is the mirror image of a real Coppock.
 */
export function coppock(closes: number[], wmaPeriod = 10, longRoc = 14, shortRoc = 11): number[] {
  const long = rateOfChange(closes, longRoc);
  const short = rateOfChange(closes, shortRoc);
  const sum = long.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(short[i]) ? v + short[i] : NaN
  );
  return wma(sum, wmaPeriod);
}

export interface PmoResult {
  /** Price Momentum Oscillator: 10 · EMA(35, 1-bar ROC %). */
  pmo: number[];
  /** Signal line: EMA(20, PMO). */
  signal: number[];
  /** PMO − signal: positive while momentum is accelerating. */
  histogram: number[];
}

/**
 * Price Momentum Oscillator (StockCharts): smooth the 1-bar rate of change with
 * a 35-period EMA, scale by 10, then take a 20-period EMA of that as the signal.
 * The EMA is seeded on the first 35 finite returns, so the line starts exactly
 * when its own smoothing is ready. The reference workbook seeds its EMAs on the
 * very first return instead, which makes its early values differ; the two
 * converge as the recursion forgets the seed.
 */
export function pmo(
  closes: number[],
  emaPeriod = 35,
  signalPeriod = 20,
  scale = 10
): PmoResult {
  const roc1: number[] = closes.map((c, i) =>
    i === 0 || !Number.isFinite(closes[i - 1]) || closes[i - 1] === 0
      ? NaN
      : ((c - closes[i - 1]) / closes[i - 1]) * 100
  );
  // EMA that starts at the first full window of finite values instead of
  // treating a leading NaN as part of the seed.
  const alignedEma = (values: number[], period: number): number[] => {
    const out: number[] = new Array(values.length).fill(NaN);
    const start = values.findIndex(Number.isFinite);
    if (start < 0 || period <= 0) return out;
    const compact = ema(values.slice(start), period);
    for (let i = 0; i < compact.length; i++) out[start + i] = compact[i];
    return out;
  };
  const pmoLine = alignedEma(roc1, emaPeriod).map((v) => (Number.isFinite(v) ? v * scale : NaN));
  const signal = alignedEma(pmoLine, signalPeriod);
  const histogram = pmoLine.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(signal[i]) ? v - signal[i] : NaN
  );
  return { pmo: pmoLine, signal, histogram };
}

/**
 * Detrended Price Oscillator (period 20 by default): the close from
 * `period/2 + 1` bars ago minus the current `period`-bar SMA. Shifting the
 * close back removes the trend without an average of averages, leaving the
 * cycle; positive = the earlier price was above today's average.
 * Warm-up stays NaN until both inputs exist.
 */
export function dpo(values: number[], period = 20): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  const shift = Math.floor(period / 2) + 1;
  const average = sma(values, period);
  for (let i = 0; i < values.length; i++) {
    if (i < shift || !Number.isFinite(average[i]) || !Number.isFinite(values[i - shift])) continue;
    out[i] = values[i - shift] - average[i];
  }
  return out;
}

/**
 * Ease of Movement, raw per bar (Arms): how far the midpoint travelled for the
 * volume that bar needed to move it.
 *   mid  = (H + L)/2;   box = volume / (H − L)
 *   EMV  = (mid − mid[prev]) / box
 * A bar with no range or no volume has no reading (NaN). Positive = price rose
 * on comparatively light volume. The units are price per (volume/price); the
 * smoothed, ×100 000 form below is the one the workbook quotes.
 */
export function easeOfMovement(highs: number[], lows: number[], volumes: number[]): number[] {
  const n = volumes.length;
  const out: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const h = highs[i];
    const l = lows[i];
    const v = volumes[i];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(v) || v <= 0 || h <= l) {
      continue;
    }
    const mid = (h + l) / 2;
    const prevMid = (highs[i - 1] + lows[i - 1]) / 2;
    if (!Number.isFinite(prevMid)) continue;
    out[i] = ((mid - prevMid) / (v / (h - l)));
  }
  return out;
}

/**
 * Ease of Movement smoothed over `period` bars and scaled ×100 000 — the
 * "Scaled EMV" the reference workbook quotes. Smoothing is what makes it
 * readable; the raw per-bar value is dominated by single-bar range noise.
 * A window with a gap stays NaN (windowMean never averages a partial window).
 */
export function emv(
  highs: number[],
  lows: number[],
  volumes: number[],
  period = 14
): number[] {
  const scaled = easeOfMovement(highs, lows, volumes).map((v) =>
    Number.isFinite(v) ? v * 100_000 : NaN
  );
  return windowMean(scaled, period);
}

export interface AtrStopResult {
  /** The stop line: 3·ATR below price above the EMA-200, 3·ATR above it below. */
  line: number[];
  /** +1 while price holds above the EMA-200, −1 while it does not. */
  direction: number[];
}

/**
 * EMA-200 filtered ATR stop: when the close holds above its 200-day EMA the
 * stop sits 3·ATR(14) *below* price (a long regime), otherwise 3·ATR above it
 * (a short/avoid regime) — the workbook's "ATR Trailing Stop with EMA 200
 * filtered" line. The filter is the point: an ATR band alone flips with every
 * spike, the EMA-200 keeps the stop on the side of the primary trend.
 * Both inputs must be ready; before then the reading is honestly NaN.
 */
export function atrStop(
  highs: number[],
  lows: number[],
  closes: number[],
  atrPeriod = 14,
  mult = 3,
  emaPeriod = 200
): AtrStopResult {
  const n = closes.length;
  const line: number[] = new Array(n).fill(NaN);
  const direction: number[] = new Array(n).fill(NaN);
  const range = atr(highs, lows, closes, atrPeriod);
  const trend = ema(closes, emaPeriod);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(range[i]) || !Number.isFinite(trend[i]) || !Number.isFinite(closes[i])) {
      continue;
    }
    const up = closes[i] >= trend[i];
    line[i] = up ? closes[i] - mult * range[i] : closes[i] + mult * range[i];
    direction[i] = up ? 1 : -1;
  }
  return { line, direction };
}
