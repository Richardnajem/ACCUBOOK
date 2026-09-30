import { describe, it, expect } from "vitest";
import { sma, ema, rsi, macd, bollinger, atr, rollingMax, rollingMin } from "../src/lib/ta";

// ─── sma ────────────────────────────────────────────────────────
describe("sma", () => {
  it("computes the arithmetic mean over the window", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("is NaN during warm-up", () => {
    const out = sma([1, 2, 3, 4], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
  });

  it("returns all NaN for period longer than input", () => {
    const out = sma([1, 2], 5);
    expect(out.every(Number.isNaN)).toBe(true);
  });

  it("returns all NaN for non-positive period", () => {
    expect(sma([1, 2, 3], 0).every(Number.isNaN)).toBe(true);
    expect(sma([1, 2, 3], -2).every(Number.isNaN)).toBe(true);
  });

  it("period 1 mirrors the input", () => {
    const out = sma([7, -3, 2.5], 1);
    expect(out).toEqual([7, -3, 2.5]);
  });
});

// ─── ema ────────────────────────────────────────────────────────
describe("ema", () => {
  it("seeds with an SMA then applies the smoothing factor", () => {
    const out = ema([2, 4, 6, 8], 2);
    // Seed at i=1: (2+4)/2 = 3. k = 2/3.
    // i=2: 6*(2/3) + 3*(1/3) = 5. i=3: 8*(2/3) + 5*(1/3) = 7.
    expect(out[1]).toBeCloseTo(3, 10);
    expect(out[2]).toBeCloseTo(5, 10);
    expect(out[3]).toBeCloseTo(7, 10);
  });

  it("is NaN before the seed index and stays defined after", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isNaN(out[2])).toBe(false);
    expect(Number.isNaN(out[4])).toBe(false);
  });

  it("converges toward the constant for flat input", () => {
    const out = ema(new Array(60).fill(10), 5);
    expect(out[out.length - 1]).toBeCloseTo(10, 6);
  });
});

// ─── rsi ────────────────────────────────────────────────────────
describe("rsi", () => {
  it("returns 100 for a strictly rising series (no losses)", () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7, 8], 4);
    expect(out[4]).toBe(100);
    expect(out[7]).toBe(100);
  });

  it("returns 0 for a strictly falling series (no gains)", () => {
    const out = rsi([9, 8, 7, 6, 5, 4, 3, 2], 4);
    expect(out[4]).toBe(0);
  });

  it("is NaN during warm-up", () => {
    const out = rsi([1, 2, 3], 14);
    expect(out.every(Number.isNaN)).toBe(true);
  });

  it("stays within [0, 100]", () => {
    const vals = Array.from({ length: 100 }, (_, i) =>
      50 + 20 * Math.sin(i / 3) + (i % 7)
    );
    for (const v of rsi(vals, 14)) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ─── macd ───────────────────────────────────────────────────────
describe("macd", () => {
  it("macd line starts at the slow EMA seed index", () => {
    const { macd: line } = macd([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2, 4, 2);
    expect(Number.isNaN(line[2])).toBe(true);  // slow=4 seeds at index 3
    expect(Number.isNaN(line[3])).toBe(false); // first defined macd value
  });

  it("histogram = macd - signal where both defined", () => {
    const vals = Array.from({ length: 60 }, (_, i) => 100 + i + Math.sin(i) * 5);
    const { macd: line, signal, histogram } = macd(vals);
    for (let i = 0; i < vals.length; i++) {
      if (!Number.isNaN(histogram[i])) {
        expect(histogram[i]).toBeCloseTo(line[i] - signal[i], 8);
      }
    }
  });

  it("signal warms up after the macd line, not from index 0", () => {
    const { macd: line, signal } = macd(new Array(40).fill(5).map((_, i) => 5 + (i % 3)));
    const firstLine = line.findIndex((v) => !Number.isNaN(v));
    const firstSignal = signal.findIndex((v) => !Number.isNaN(v));
    expect(firstSignal).toBeGreaterThanOrEqual(firstLine);
  });
});

// ─── bollinger ──────────────────────────────────────────────────
describe("bollinger", () => {
  it("middle band equals the SMA", () => {
    const vals = [3, 5, 8, 13, 21, 34, 55];
    const { middle } = bollinger(vals, 4, 2);
    const smaRef = sma(vals, 4);
    for (let i = 3; i < vals.length; i++) expect(middle[i]).toBeCloseTo(smaRef[i], 10);
  });

  it("bands are symmetric around the middle at mult × σ", () => {
    const vals = [2, 4, 4, 4, 5, 5, 7, 9];
    const { upper, middle, lower } = bollinger(vals, 5, 2);
    for (let i = 4; i < vals.length; i++) {
      expect(upper[i] - middle[i]).toBeCloseTo(middle[i] - lower[i], 10);
    }
  });

  it("constant input collapses bands onto the middle", () => {
    const { upper, middle, lower } = bollinger(new Array(30).fill(42), 20, 2);
    expect(upper[25]).toBeCloseTo(42, 10);
    expect(lower[25]).toBeCloseTo(42, 10);
    expect(middle[25]).toBeCloseTo(42, 10);
  });
});

// ─── atr ────────────────────────────────────────────────────────
describe("atr", () => {
  it("uses true range (accounts for gaps vs prior close)", () => {
    // Gap up: prior close 10, today high 15 low 12 → TR = |15-10| = 5, not 3
    const highs = [0, 15, 15];
    const lows = [0, 12, 12];
    const closes = [10, 14, 14];
    const out = atr(highs, lows, closes, 1);
    expect(out[1]).toBeCloseTo(5, 10);
  });

  it("is NaN before the period and for len <= period", () => {
    const h = [1, 2, 3, 4, 5];
    const l = [1, 1, 2, 3, 4];
    const c = [1, 1.5, 2.5, 3.5, 4.5];
    expect(atr(h, l, c, 5).every(Number.isNaN)).toBe(true); // len(5) <= period(5)
    const out = atr(h, l, c, 2);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isNaN(out[2])).toBe(false);
  });

  it("never negative", () => {
    const h = Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i) * 2);
    const l = Array.from({ length: 40 }, (_, i) => 8 + Math.sin(i) * 2);
    const c = Array.from({ length: 40 }, (_, i) => 9 + Math.cos(i) * 2);
    for (const v of atr(h, l, c, 14)) if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

// ─── rollingMax / rollingMin ────────────────────────────────────
describe("rollingMax/rollingMin", () => {
  it("finds extremes over the trailing window", () => {
    const vals = [3, 1, 4, 1, 5, 9, 2, 6];
    const mx = rollingMax(vals, 3);
    const mn = rollingMin(vals, 3);
    expect(mx[2]).toBe(4);
    expect(mx[5]).toBe(9);
    expect(mn[2]).toBe(1);
    expect(mn[6]).toBe(2);
  });

  it("is NaN during warm-up", () => {
    const mx = rollingMax([1, 2, 3, 4], 3);
    expect(Number.isNaN(mx[0])).toBe(true);
    expect(Number.isNaN(mx[1])).toBe(true);
    expect(mx[2]).toBe(3);
  });

  it("handles decreasing series (min is last element)", () => {
    const mn = rollingMin([5, 4, 3, 2, 1], 2);
    expect(mn[4]).toBe(1);
    expect(mn[3]).toBe(2);
  });
});
