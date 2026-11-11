// ─── The Price History tab's arithmetic ─────────────────────────────────────
//
// The Excel workbook with every trading day and every indicator is built
// server-side by lib/price-export.ts. This module describes the price series
// itself, so the tab can chart it, table it and export the window as CSV — and
// so tests/price-history.test.ts can pin that arithmetic on synthetic bars.
//
// Rules kept here, not in the page:
//   · weekends and holidays have no bar because there was no session — nothing
//     is forward-filled, ever;
//   · a 52-week figure needs 252 bars; before that it is null, not a partial
//     year dressed up as a reading;
//   · the first bar has no change vs a previous close (null), which the CSV
//     writes as an empty cell rather than 0.

import type { Bar } from "./market-data";
import { rollingMax, rollingMin } from "./ta";

/** One display row per session, with the change already derived from the bars. */
export interface PriceRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Close minus the previous session's close; null on the first bar. */
  change: number | null;
  changePct: number | null;
  volume: number;
  dollarVolume: number;
}

export interface RangeSummary {
  firstDate: string | null;
  lastDate: string | null;
  bars: number;
  firstClose: number | null;
  lastClose: number | null;
  change: number | null;
  changePct: number | null;
  /** Highest high / lowest low inside the window. */
  high: number | null;
  low: number | null;
  /** Trailing 252-close high/low; null until 252 bars exist. */
  high52: number | null;
  low52: number | null;
  distanceFromHigh52Pct: number | null;
  distanceAboveLow52Pct: number | null;
  avgVolume: number | null;
  /** Sessions that closed above / below the prior session's close. */
  upDays: number;
  downDays: number;
  spanYears: number | null;
}

const yearsBetween = (from: string, to: string): number | null => {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / (365.25 * 86400_000);
};

const pctChange = (from: number, to: number): number | null =>
  Number.isFinite(from) && from !== 0 ? ((to - from) / from) * 100 : null;

/** Every session with its day-over-day change, oldest → newest. */
export function priceRows(bars: Bar[]): PriceRow[] {
  return bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1].close : null;
    return {
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      change: prev === null ? null : b.close - prev,
      changePct: prev === null ? null : pctChange(prev, b.close),
      volume: b.volume,
      dollarVolume: b.close * b.volume,
    };
  });
}

/** Newest first — what the table shows. `limit` 0 means every loaded session. */
export function recentPriceRows(bars: Bar[], limit: number): PriceRow[] {
  const newestFirst = priceRows(bars).reverse();
  return limit > 0 ? newestFirst.slice(0, limit) : newestFirst;
}

/**
 * The summary cards. High/low are measured inside the requested window; the
 * 52-week pair is a trailing 252-close reading and stays null on a shorter
 * series, because a partial year is not a 52-week figure.
 */
export function summarizeBars(bars: Bar[]): RangeSummary {
  const empty: RangeSummary = {
    firstDate: null,
    lastDate: null,
    bars: 0,
    firstClose: null,
    lastClose: null,
    change: null,
    changePct: null,
    high: null,
    low: null,
    high52: null,
    low52: null,
    distanceFromHigh52Pct: null,
    distanceAboveLow52Pct: null,
    avgVolume: null,
    upDays: 0,
    downDays: 0,
    spanYears: null,
  };
  if (bars.length === 0) return empty;

  const first = bars[0];
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);

  let high = -Infinity;
  let low = Infinity;
  let volumeSum = 0;
  let upDays = 0;
  let downDays = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volumeSum += b.volume;
    if (i > 0) {
      if (b.close > bars[i - 1].close) upDays++;
      else if (b.close < bars[i - 1].close) downDays++;
    }
  }

  const hi52Series = rollingMax(closes, 252);
  const lo52Series = rollingMin(closes, 252);
  const hi52 = Number.isFinite(hi52Series[bars.length - 1]) ? hi52Series[bars.length - 1] : null;
  const lo52 = Number.isFinite(lo52Series[bars.length - 1]) ? lo52Series[bars.length - 1] : null;

  return {
    firstDate: first.date,
    lastDate: last.date,
    bars: bars.length,
    firstClose: first.close,
    lastClose: last.close,
    change: last.close - first.close,
    changePct: pctChange(first.close, last.close),
    high,
    low,
    high52: hi52,
    low52: lo52,
    distanceFromHigh52Pct: hi52 !== null ? pctChange(hi52, last.close) : null,
    distanceAboveLow52Pct: lo52 !== null ? pctChange(lo52, last.close) : null,
    avgVolume: volumeSum / bars.length,
    upDays,
    downDays,
    spanYears: yearsBetween(first.date, last.date),
  };
}

export const PRICE_CSV_HEADERS = [
  "Date",
  "Open",
  "High",
  "Low",
  "Close",
  "Change",
  "Change %",
  "Volume",
  "Dollar volume",
];

/** CSV body, oldest → newest. A missing change is an empty cell, never 0. */
export function priceCsvRows(bars: Bar[]): (string | number)[][] {
  return priceRows(bars).map((r) => [
    r.date,
    r.open,
    r.high,
    r.low,
    r.close,
    r.change ?? "",
    r.changePct ?? "",
    r.volume,
    r.dollarVolume,
  ]);
}

/**
 * Evenly thins a long series for the chart only. The first and last sessions
 * are always kept, so the drawn line still ends on the real last close; the
 * table and both exports keep every session.
 */
export function thinBars(bars: Bar[], maxPoints = 900): Bar[] {
  if (maxPoints < 2 || bars.length <= maxPoints) return bars;
  const step = (bars.length - 1) / (maxPoints - 1);
  const out: Bar[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const bar = bars[Math.round(i * step)];
    if (out.length === 0 || out[out.length - 1] !== bar) out.push(bar);
  }
  return out;
}
