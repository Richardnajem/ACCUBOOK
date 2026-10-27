import { describe, it, expect } from "vitest";
import { barCadence, cadenceLabel, resampleBars } from "../src/lib/bar-resample";
import type { Bar } from "../src/lib/market-data";

const day = (date: string, prices: [number, number, number, number], volume = 100): Bar => ({
  date,
  open: prices[0],
  high: prices[1],
  low: prices[2],
  close: prices[3],
  volume,
});

/** Consecutive weekdays from a Monday. */
const sessions = (start: string, n: number) => {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

describe("resampleBars", () => {
  it("returns the same array for daily (nothing to do)", () => {
    const bars = [day("2024-01-02", [1, 2, 0.5, 1.5])];
    expect(resampleBars(bars, "daily")).toBe(bars);
  });

  it("collapses two weeks of sessions into two weekly bars, dated at the period end", () => {
    // Mon 2024-01-01 … Fri 2024-01-12 = 10 sessions = 2 weeks
    const dates = sessions("2024-01-01", 10);
    const bars = dates.map((d, i) => day(d, [100 + i, 110 + i, 90 + i, 105 + i], 10 + i));
    const weekly = resampleBars(bars, "weekly");

    expect(weekly).toHaveLength(2);
    expect(weekly[0].date).toBe(dates[4]); // Friday of week 1
    expect(weekly[1].date).toBe(dates[9]); // Friday of week 2

    // open = first session's open, close = last session's close
    expect(weekly[0].open).toBe(100);
    expect(weekly[0].close).toBe(109);
    // high/low span the period
    expect(weekly[0].high).toBe(114);
    expect(weekly[0].low).toBe(90);
    // volume is summed
    expect(weekly[0].volume).toBe(10 + 11 + 12 + 13 + 14);

    expect(weekly[1].open).toBe(105);
    expect(weekly[1].close).toBe(114);
  });

  it("keeps a short week whole (a holiday does not split it)", () => {
    const bars = [
      day("2024-01-01", [1, 2, 0.5, 1.5]),
      day("2024-01-02", [1.5, 3, 1.4, 2.5]),
      // gap: next bar is the following Monday
      day("2024-01-08", [2.5, 4, 2.4, 3.5]),
    ];
    const weekly = resampleBars(bars, "weekly");
    expect(weekly).toHaveLength(2);
    expect(weekly[0].close).toBe(2.5);
    expect(weekly[1].close).toBe(3.5);
  });

  it("buckets monthly by calendar month with the correct OHLCV", () => {
    const bars = [
      day("2024-01-31", [10, 12, 9, 11]),
      day("2024-02-01", [11, 15, 10, 14]),
      day("2024-02-29", [14, 16, 13, 13]),
      day("2024-03-01", [13, 13.5, 12, 12.5]),
      day("2024-03-29", [12.5, 20, 12, 19]),
    ];
    const monthly = resampleBars(bars, "monthly");
    expect(monthly).toHaveLength(3);
    expect(monthly[0]).toMatchObject({ date: "2024-01-31", open: 10, high: 12, low: 9, close: 11, volume: 100 });
    expect(monthly[1]).toMatchObject({ date: "2024-02-29", open: 11, high: 16, low: 10, close: 13, volume: 200 });
    expect(monthly[2]).toMatchObject({ open: 13, high: 20, low: 12, close: 19, volume: 200 });
  });

  it("survives a very volatile series without losing the extremes", () => {
    // GME-style: ±25 % days, plus a gap that doubles the price
    const bars = [
      day("2024-01-02", [10, 13, 7, 12.5]),
      day("2024-01-03", [12.5, 15, 9, 9.5]),
      day("2024-01-04", [9.5, 24, 9, 23]),
      day("2024-01-05", [23, 25, 17, 18]),
      day("2024-01-08", [18, 30, 16, 29]),
    ];
    const weekly = resampleBars(bars, "weekly");
    expect(weekly).toHaveLength(2);
    expect(weekly[0]).toMatchObject({ open: 10, high: 25, low: 7, close: 18 });
    expect(weekly[1]).toMatchObject({ open: 18, high: 30, low: 16, close: 29 });
    expect(Number.isFinite(weekly[0].close)).toBe(true);
  });
});

describe("barCadence", () => {
  const series = (dates: string[]) => dates.map((d) => day(d, [1, 1, 1, 1]));

  it("reads daily bars as 252 periods a year", () => {
    const c = barCadence(series(sessions("2024-01-01", 30)));
    expect(c).toEqual({ barMinutes: 1440, periodsPerYear: 252, barUnit: "day" });
  });

  it("reads weekly bars as 52 and monthly as 12", () => {
    const weekly = barCadence(resampleBars(series(sessions("2024-01-01", 60)), "weekly"));
    expect(weekly.barUnit).toBe("week");
    expect(weekly.periodsPerYear).toBe(52);

    const monthly = barCadence(resampleBars(series(sessions("2023-01-02", 400)), "monthly"));
    expect(monthly.barUnit).toBe("month");
    expect(monthly.periodsPerYear).toBe(12);
  });

  it("reads an intraday series as its own number of bars a year", () => {
    const times = Array.from({ length: 12 }, (_, i) => {
      const mins = i * 5;
      return `2024-01-02T${String(13 + Math.floor((30 + mins) / 60)).padStart(2, "0")}:${String((30 + mins) % 60).padStart(2, "0")}:00Z`;
    });
    const c = barCadence(series(times));
    expect(c.barUnit).toBe("minute");
    expect(c.barMinutes).toBe(5);
    expect(c.periodsPerYear).toBe(252 * 78);
  });

  it("falls back to daily for an empty or single-bar series", () => {
    expect(barCadence([])).toEqual({ barMinutes: 1440, periodsPerYear: 252, barUnit: "day" });
    expect(barCadence(series(["2024-01-02"])).barUnit).toBe("day");
  });

  it("labels a cadence the way the UI prints it", () => {
    expect(cadenceLabel({ barMinutes: 1440, periodsPerYear: 252, barUnit: "day" }, 100)).toBe("100 trading days");
    expect(cadenceLabel({ barMinutes: 10080, periodsPerYear: 52, barUnit: "week" }, 20)).toBe("20 weekly bars");
    expect(cadenceLabel({ barMinutes: 43200, periodsPerYear: 12, barUnit: "month" }, 5)).toBe("5 monthly bars");
    expect(cadenceLabel({ barMinutes: 5, periodsPerYear: 19656, barUnit: "minute" }, 78)).toBe("78 bars of 5 min");
  });
});
