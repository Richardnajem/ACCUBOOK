// ─── Numerical primitives for the analytics engine ─────────────────────────
//
// Every helper returns `null` instead of NaN/Infinity when the input cannot
// support an answer (too few observations, zero variance, no positive value).
// A null is rendered as "—" with a reason; it is never silently turned into 0.
// That rule is what keeps the risk and performance screens honest.

export const TRADING_DAYS = 252;
export const DAYS_PER_YEAR = 365;

/** Arithmetic mean, or null for an empty sample. */
export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n−1). Needs two observations. */
export function sampleStd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (m === null) return null;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  const v = s / (xs.length - 1);
  return v >= 0 ? Math.sqrt(v) : null;
}

/** Sample covariance (n−1) of two equal-length series. */
export function sampleCov(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  if (ma === null || mb === null) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

/** Pearson correlation. Null when either side has no variance. */
export function correlation(a: number[], b: number[]): number | null {
  const cov = sampleCov(a, b);
  const sa = sampleStd(a.slice(0, Math.min(a.length, b.length)));
  const sb = sampleStd(b.slice(0, Math.min(a.length, b.length)));
  if (cov === null || sa === null || sb === null || sa === 0 || sb === 0) return null;
  const r = cov / (sa * sb);
  return Math.max(-1, Math.min(1, r));
}

/** Linear-interpolated quantile of a sample (q in 0..1). */
export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/** Simple (non-log) period returns from a value series. */
export function returnsFromValues(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    out.push(curr / prev - 1);
  }
  return out;
}

/** Compound a return series: ∏(1+r) − 1. */
export function linkReturns(rs: number[]): number | null {
  if (rs.length === 0) return null;
  let f = 1;
  for (const r of rs) {
    if (!Number.isFinite(r) || r <= -1) return null;
    f *= 1 + r;
  }
  return f - 1;
}

/** Annualise a cumulative return over `years`. */
export function annualize(total: number, years: number): number | null {
  if (!Number.isFinite(total) || !Number.isFinite(years) || years <= 0) return null;
  if (total <= -1) return -1;
  return Math.pow(1 + total, 1 / years) - 1;
}

/** Fractional years between two ISO dates (365-day convention). */
export function yearsBetween(startISO: string, endISO: string): number {
  const a = Date.parse(startISO);
  const b = Date.parse(endISO);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
}

/** Calendar days between two ISO dates. */
export function daysBetween(startISO: string, endISO: string): number {
  const a = Date.parse(startISO);
  const b = Date.parse(endISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Shift an ISO date by whole days. */
export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Standard-normal quantile (Acklam's rational approximation, |error| < 1.15e-9).
 * Used for parametric VaR; no dependency needed for one constant.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Sum, or 0 for an empty list (only for weights that are defined as summing). */
export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Herfindahl–Hirschman index of weights expressed as fractions summing to 1. */
export function hhi(weights: number[]): number | null {
  const total = sum(weights);
  if (weights.length === 0 || total <= 0) return null;
  let s = 0;
  for (const w of weights) {
    const f = w / total;
    s += f * f;
  }
  return s;
}

/** Deterministic PRNG (mulberry32) so Monte-Carlo results are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal draw from a uniform generator. */
export function normalDraw(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Round for display without losing numeric type (null stays null). */
export function roundOrNull(x: number | null, dp = 4): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Safe division: null when either side is null or the denominator is 0. */
export function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/** Compound annual growth rate from first/last values over `years`. */
export function cagr(startValue: number | null, endValue: number | null, years: number): number | null {
  if (startValue === null || endValue === null || startValue <= 0 || endValue <= 0 || years <= 0) return null;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

/** Standard error of the mean, used to flag statistically thin samples. */
export function standardError(xs: number[]): number | null {
  const sd = sampleStd(xs);
  if (sd === null) return null;
  return sd / Math.sqrt(xs.length);
}
