// The Price History tab's arithmetic: window summary, CSV body, newest-first
// rows and chart thinning. Hermetic — synthetic bars, no network, no database.
//
// Rules these tests protect:
//   · the first bar has no change vs a previous close (blank in the CSV, not 0);
//   · a 52-week figure needs 252 sessions and is null before that;
//   · the chart may thin a long series but always ends on the real last session;
//   · the CSV keeps every session the window loaded, oldest → newest.

import { describe, expect, it } from "vitest";
import type { Bar } from "../src/lib/market-data";
import {
  PRICE_CSV_HEADERS,
  priceCsvRows,
  priceRows,
  recentPriceRows,
  summarizeBars,
  thinBars,
} from "../src/lib/price-history";

const bars: Bar[] = [
  { date: "2026-01-02", open: 100, high: 104, low: 99, close: 102, volume: 1000 },
  { date: "2026-01-05", open: 102, high: 103, low: 98, close: 99, volume: 1200 },
  { date: "2026-01-06", open: 99, high: 101, low: 97, close: 100.5, volume: 900 },
];

/** 300 rising sessions: closes 1…300, one bar per calendar day (synthetic). */
const long: Bar[] = Array.from({ length: 300 }, (_, i) => {
  const close = i + 1;
  const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  return { date, open: close, high: close + 0.5, low: close - 0.5, close, volume: 100 + i };
});

describe("summarizeBars", () => {
  it("describes the window from the bars themselves", () => {
    const s = summarizeBars(bars);
    expect(s.firstDate).toBe("2026-01-02");
    expect(s.lastDate).toBe("2026-01-06");
    expect(s.bars).toBe(3);
    expect(s.firstClose).toBe(102);
    expect(s.lastClose).toBe(100.5);
    expect(s.change).toBeCloseTo(-1.5, 10);
    expect(s.changePct).toBeCloseTo(-1.470588, 5);
    expect(s.high).toBe(104);
    expect(s.low).toBe(97);
    expect(s.avgVolume).toBeCloseTo(1033.333, 3);
    // 102 → 99 is down; 99 → 100.5 is up. The first bar has no prior close.
    expect(s.upDays).toBe(1);
    expect(s.downDays).toBe(1);
    expect(s.spanYears).toBeCloseTo(4 / 365.25, 6);
  });

  it("leaves the 52-week pair blank until 252 sessions exist", () => {
    expect(summarizeBars(bars).high52).toBeNull();
    expect(summarizeBars(bars).distanceFromHigh52Pct).toBeNull();
    expect(summarizeBars([]).bars).toBe(0);
    expect(summarizeBars([]).changePct).toBeNull();
  });

  it("reads 52-week high/low from the trailing 252 closes", () => {
    const s = summarizeBars(long);
    expect(s.high52).toBe(300);
    expect(s.low52).toBe(49); // closes 49…300 are the last 252 sessions
    expect(s.distanceFromHigh52Pct).toBe(0);
    expect(s.distanceAboveLow52Pct).toBeCloseTo(((300 - 49) / 49) * 100, 6);
  });
});

describe("priceRows / recentPriceRows", () => {
  it("derives the change from the previous close and stays blank on the first bar", () => {
    const rows = priceRows(bars);
    expect(rows[0].change).toBeNull();
    expect(rows[0].changePct).toBeNull();
    expect(rows[1].change).toBe(-3);
    expect(rows[2].change).toBe(1.5);
    expect(rows[2].changePct).toBeCloseTo((1.5 / 99) * 100, 8);
    expect(rows[2].dollarVolume).toBeCloseTo(100.5 * 900, 6);
  });

  it("gives the table newest first, limited to the chosen page size", () => {
    const rows = recentPriceRows(bars, 2);
    expect(rows.map((r) => r.date)).toEqual(["2026-01-06", "2026-01-05"]);
    expect(recentPriceRows(bars, 0)).toHaveLength(3);
  });
});

describe("priceCsvRows", () => {
  it("keeps every session oldest → newest and writes a missing change as empty", () => {
    const rows = priceCsvRows(bars);
    expect(PRICE_CSV_HEADERS).toHaveLength(9);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe("2026-01-02");
    expect(rows[0][5]).toBe("");
    expect(rows[0][6]).toBe("");
    expect(rows[1][5]).toBe(-3);
  });
});

describe("thinBars", () => {
  it("returns the series untouched when it already fits", () => {
    expect(thinBars(bars, 900)).toBe(bars);
  });

  it("thins a long series but keeps the first and last session", () => {
    const thinned = thinBars(long, 50);
    expect(thinned.length).toBeLessThanOrEqual(50);
    expect(thinned[0]).toBe(long[0]);
    expect(thinned[thinned.length - 1]).toBe(long[long.length - 1]);
    // Strictly increasing dates — no duplicated or reordered sessions.
    const dates = thinned.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });
});
