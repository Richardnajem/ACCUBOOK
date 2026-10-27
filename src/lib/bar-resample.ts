// ─── Timeframe resampling ────────────────────────────────────────────────
//
// The engine consumes one `Bar[]` and does not care how long a bar is, so
// "trade daily vs weekly vs monthly" is a question about which series is fed to
// it. This module turns a daily series into weekly or monthly bars, and answers
// a second, easier-to-get-wrong question: how many bars of this series are there
// in a year? Annualizing a weekly Sharpe with sqrt(252) overstates it by 2.2×,
// and a monthly one by 4.6×, so the number has to travel with the data.
//
// Buckets are convention-standard: a period's bar is dated at its LAST session,
// opens at the period's first open, closes at the period's last close, and
// carries the period's high, low, and summed volume.

import type { Bar } from "./market-data";

export type BarInterval = "daily" | "weekly" | "monthly";

export const BAR_INTERVALS: BarInterval[] = ["daily", "weekly", "monthly"];

/** How long one bar is, for labels and annualization ("day" ⇒ 252 a year). */
export type BarUnit = "minute" | "day" | "week" | "month";

const DAY_MS = 86_400_000;

/** Monday of the week a session belongs to (UTC) — the weekly bucket key. */
function weekKey(date: string): string {
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return date.slice(0, 10);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(ms - dow * DAY_MS).toISOString().slice(0, 10);
}

function bucketKeys(bars: Bar[], interval: BarInterval): string[] {
  if (interval === "monthly") return bars.map((b) => b.date.slice(0, 7));
  if (interval === "weekly") return bars.map((b) => weekKey(b.date));
  return bars.map((b) => b.date);
}

/**
 * Collapse a series into `interval` bars. `daily` is returned by reference, so
 * callers that never change frequency pay nothing.
 */
export function resampleBars(bars: Bar[], interval: BarInterval): Bar[] {
  if (interval === "daily" || bars.length === 0) return bars;
  const keys = bucketKeys(bars, interval);
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = "";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (cur && keys[i] === curKey) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.date = b.date; // dated at the period's end
    } else {
      cur = { ...b };
      curKey = keys[i];
      out.push(cur);
    }
  }
  return out;
}

export interface BarCadence {
  /** Median minutes between bars (1440 = daily, 10080 = weekly, ~43200 = monthly). */
  barMinutes: number;
  /** Bars per year used for Sharpe/Sortino/volatility. */
  periodsPerYear: number;
  barUnit: BarUnit;
}

/**
 * Cadence of a series, derived from its median spacing. Median rather than mean
 * so a few holiday gaps cannot reclassify a weekly series as monthly; sampled so
 * a 100k-bar intraday series does not pay for a full scan.
 */
export function barCadence(bars: Bar[]): BarCadence {
  if (bars.length < 3) return { barMinutes: 1440, periodsPerYear: 252, barUnit: "day" };
  const diffs: number[] = [];
  const step = Math.max(1, Math.floor((bars.length - 1) / 400));
  for (let i = 1; i < bars.length; i += step) {
    const mins = (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 60_000;
    if (Number.isFinite(mins) && mins > 0) diffs.push(mins);
  }
  if (diffs.length === 0) return { barMinutes: 1440, periodsPerYear: 252, barUnit: "day" };
  diffs.sort((a, b) => a - b);
  const barMinutes = Math.round(diffs[Math.floor(diffs.length / 2)]);

  // 6.5-hour regular session = 390 minutes; 252 sessions a year on every branch.
  if (barMinutes < 12 * 60) {
    return { barMinutes, periodsPerYear: Math.max(1, Math.round(252 * (390 / barMinutes))), barUnit: "minute" };
  }
  if (barMinutes <= 2 * 1440) return { barMinutes, periodsPerYear: 252, barUnit: "day" };
  if (barMinutes <= 9 * 1440) return { barMinutes, periodsPerYear: 52, barUnit: "week" };
  return { barMinutes, periodsPerYear: 12, barUnit: "month" };
}

/** Human label for a cadence: "weekly bars (52 a year)". */
export function cadenceLabel(c: BarCadence, count: number): string {
  switch (c.barUnit) {
    case "minute": return `${count} bars of ${c.barMinutes} min`;
    case "week": return `${count} weekly bars`;
    case "month": return `${count} monthly bars`;
    default: return `${count} trading days`;
  }
}
