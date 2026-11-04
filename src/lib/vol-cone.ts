// ─── Realized-volatility price cone ─────────────────────────────────────────
//
// A RANGE, not a forecast. Given trailing realized volatility it answers "how
// far can this price plausibly travel by date X", and deliberately contains no
// directional information:
//
//   p16 / p50 / p84 of a driftless lognormal with σ = trailing realized vol.
//   The median is TODAY'S PRICE by construction — it is not a predicted price.
//
// Two assumptions, both approximations, both stated in `note`:
//   • log returns are roughly normal (real returns have fatter tails, so the true
//     p16/p84 are a little further out than this shows),
//   • volatility persists at its trailing level (it clusters, so it often does,
//     until it doesn't).
//
// Nothing here should ever be rendered as a target or a direction: the cone is
// for sizing a position and placing stops, which is what an uncertainty band is
// actually good for.

export interface ConeHorizon {
  /** Trading sessions ahead. */
  horizon: number;
  label: string;
  /** Price at p16 — 16 % of outcomes below this under the assumptions. */
  low: number;
  /** Today's price: the driftless median, not a prediction. */
  median: number;
  /** Price at p84 — 16 % of outcomes above this. */
  high: number;
  lowPct: number;
  highPct: number;
}

export interface VolatilityCone {
  spot: number;
  /** Annualised realized volatility, in percent. */
  volPct: number;
  /** Daily log returns behind the estimate. */
  sample: number;
  from: string;
  to: string;
  horizons: ConeHorizon[];
  note: string;
}

export const TRADING_DAYS = 252;
/** ±1σ — the p16 / p84 points of a normal distribution. */
const Z = 1;
export const DEFAULT_HORIZONS = [21, 63, 252];
const MIN_RETURNS = 30;

const HORIZON_LABELS: Record<number, string> = {
  5: "~1 week (5d)",
  10: "~2 weeks (10d)",
  21: "~1 month (21d)",
  63: "~3 months (63d)",
  126: "~6 months (126d)",
  252: "~12 months (252d)",
};

/**
 * Annualised realized volatility from daily log returns of the last `lookback`
 * sessions (sample sd, n − 1).
 *
 * Returns null rather than a number when the tail is short or contains a
 * non-positive close: splicing over a bad bar would invent a return, and a vol
 * built on invented returns is worse than no vol.
 */
export function realizedVol(
  closes: number[],
  lookback = TRADING_DAYS
): { volPct: number; sample: number } | null {
  const window = Math.max(2, Math.min(lookback + 1, closes.length));
  const tail = closes.slice(-window);
  if (tail.length - 1 < MIN_RETURNS) return null;
  if (tail.some((c) => !(typeof c === "number" && Number.isFinite(c) && c > 0))) return null;

  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) rets.push(Math.log(tail[i] / tail[i - 1]));
  const n = rets.length;
  const mean = rets.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  if (!Number.isFinite(sd)) return null;
  return { volPct: sd * Math.sqrt(TRADING_DAYS) * 100, sample: n };
}

/**
 * Build the cone. Bars may be in any order; the last positive close is the spot.
 * Null when there is not enough clean history to estimate volatility.
 */
export function buildVolatilityCone(
  bars: Array<{ date: string; close: number }>,
  options: { lookback?: number; horizons?: number[] } = {}
): VolatilityCone | null {
  const lookback = options.lookback ?? TRADING_DAYS;
  const horizons = (options.horizons ?? DEFAULT_HORIZONS).filter((h) => Number.isFinite(h) && h > 0);
  if (bars.length === 0 || horizons.length === 0) return null;

  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let spot: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (Number.isFinite(sorted[i].close) && sorted[i].close > 0) {
      spot = sorted[i].close;
      break;
    }
  }
  if (spot === null) return null;

  const vol = realizedVol(sorted.map((b) => b.close), lookback);
  if (!vol) return null;

  const sigma = vol.volPct / 100;
  const coneHorizons: ConeHorizon[] = horizons.map((horizon) => {
    // Driftless: the σ√t term is the whole band, so the median stays at spot.
    const scale = Z * sigma * Math.sqrt(horizon / TRADING_DAYS);
    const low = spot! * Math.exp(-scale);
    const high = spot! * Math.exp(scale);
    return {
      horizon,
      label: HORIZON_LABELS[horizon] ?? `${horizon} sessions`,
      low,
      median: spot!,
      high,
      lowPct: (low / spot! - 1) * 100,
      highPct: (high / spot! - 1) * 100,
    };
  });

  const firstIndex = Math.max(0, sorted.length - vol.sample - 1);
  return {
    spot,
    volPct: vol.volPct,
    sample: vol.sample,
    from: sorted[firstIndex].date,
    to: sorted[sorted.length - 1].date,
    horizons: coneHorizons,
    note:
      "Driftless ±1σ band from realized volatility: the middle line is today's price by construction, so this is an uncertainty range, not a forecast. It assumes returns are roughly normal (real tails are fatter, so the true band is a little wider) and that volatility persists. It says nothing about direction.",
  };
}
