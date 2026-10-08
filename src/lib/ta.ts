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
export function rollingMax(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function rollingMin(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}
