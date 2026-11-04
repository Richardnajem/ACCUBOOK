// The realized-volatility cone is an uncertainty band, not a forecast. These
// tests pin the properties that make that true — the median IS spot, the band is
// symmetric in log space, it widens with √time, and it refuses to estimate from
// too little (or dirty) history instead of inventing a range.

import { describe, it, expect } from "vitest";
import {
  buildVolatilityCone,
  realizedVol,
  DEFAULT_HORIZONS,
  TRADING_DAYS,
} from "../src/lib/vol-cone";

/** Daily bars from a list of closes, one calendar day apart. */
const series = (closes: number[]) => {
  const start = Date.parse("2020-01-01T00:00:00Z");
  return closes.map((close, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    close,
  }));
};

describe("realizedVol", () => {
  it("annualises the sample sd of log returns", () => {
    // Alternating ±1 % log returns: mean ≈ 0, sample sd ≈ 1 % (×√(n/(n−1))).
    const closes = [100];
    for (let i = 1; i <= 252; i++) closes.push(closes[i - 1] * Math.exp(i % 2 === 0 ? 0.01 : -0.01));
    const vol = realizedVol(closes)!;
    expect(vol.sample).toBe(252);
    // sd of the alternating series is 0.01·√(252/251), annualised by √252.
    const expected = 0.01 * Math.sqrt(252 / 251) * Math.sqrt(TRADING_DAYS) * 100;
    expect(vol.volPct).toBeCloseTo(expected, 8);
  });

  it("is zero for a series with no dispersion", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.001, i));
    expect(realizedVol(closes)!.volPct).toBeCloseTo(0, 10);
  });

  it("refuses short or dirty history", () => {
    expect(realizedVol(Array.from({ length: 20 }, () => 100))).toBeNull();
    const withZero = Array.from({ length: 60 }, () => 100);
    withZero[30] = 0; // a bad bar must not be spliced out
    expect(realizedVol(withZero)).toBeNull();
  });

  it("uses the last `lookback` sessions", () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 * Math.pow(1.002, i));
    expect(realizedVol(closes, 100)!.sample).toBe(100);
  });
});

describe("buildVolatilityCone", () => {
  const closes = [100];
  for (let i = 1; i <= 300; i++) closes.push(closes[i - 1] * Math.exp(i % 2 === 0 ? 0.02 : -0.018));

  it("puts the median exactly at spot — no direction is claimed", () => {
    const cone = buildVolatilityCone(series(closes))!;
    for (const h of cone.horizons) {
      expect(h.median).toBe(cone.spot);
      expect(h.low).toBeLessThan(cone.spot);
      expect(h.high).toBeGreaterThan(cone.spot);
      expect(h.lowPct).toBeLessThan(0);
      expect(h.highPct).toBeGreaterThan(0);
    }
  });

  it("is symmetric in log space (low × high = spot²)", () => {
    const cone = buildVolatilityCone(series(closes))!;
    for (const h of cone.horizons) {
      expect(h.low * h.high).toBeCloseTo(cone.spot * cone.spot, 6);
    }
  });

  it("widens with the square root of the horizon", () => {
    const cone = buildVolatilityCone(series(closes), { horizons: [21, 252] })!;
    const [short, long] = cone.horizons;
    const shortWidth = Math.log(short.high / short.low);
    const longWidth = Math.log(long.high / long.low);
    expect(longWidth / shortWidth).toBeCloseTo(Math.sqrt(252 / 21), 6);
  });

  it("sorts unordered bars and uses the last positive close as spot", () => {
    const bars = series(closes);
    const shuffled = [...bars].reverse();
    const cone = buildVolatilityCone(shuffled)!;
    expect(cone.spot).toBe(bars[bars.length - 1].close);
    expect(cone.to).toBe(bars[bars.length - 1].date);
    expect(cone.from < cone.to).toBe(true);
  });

  it("returns the horizons the page shows, and null without enough data", () => {
    const cone = buildVolatilityCone(series(closes))!;
    expect(cone.horizons.map((h) => h.horizon)).toEqual(DEFAULT_HORIZONS);
    expect(cone.sample).toBe(252); // trailing year, not the whole series

    expect(buildVolatilityCone(series(closes.slice(-20)))).toBeNull();
    expect(buildVolatilityCone([])).toBeNull();
  });

  it("says what it is in its note", () => {
    const cone = buildVolatilityCone(series(closes))!;
    expect(cone.note).toContain("not a forecast");
    expect(cone.note).toContain("nothing about direction");
  });
});
