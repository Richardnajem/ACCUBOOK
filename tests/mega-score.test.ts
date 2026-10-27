// The Mega Score time series is what the backtest regime filter, the price-chart
// overlay and mega-history plot, so the reading at bar i must depend only on bars
// 0..i. These tests pin that for the oscillators added with the newest workbook
// export (Williams %R and Stochastic RSI) as well as for the composite itself.

import { describe, it, expect } from "vitest";
import { computeMegaScoreSeries, snapshotMegaScore } from "../src/lib/mega-score";
import { evalFormula } from "../src/lib/custom-indicators";

const NEW_INDICATORS = ["ta-williams-r", "ta-stochrsi-k", "ta-stochrsi-d"];

function makeBars(n: number) {
  let seed = 20261012;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 3;
    const c = Math.max(1, px + drift);
    const h = Math.max(px, c) + rnd() * 1.4;
    const l = Math.min(px, c) - rnd() * 1.4;
    high.push(h);
    low.push(l);
    close.push(c);
    volume.push(1_000_000 + rnd() * 500_000);
    px = c;
  }
  return { high, low, close, volume };
}

const bars = makeBars(400);

describe("mega score time series", () => {
  it("carries the oscillators added for the new workbook export", () => {
    const series = computeMegaScoreSeries(bars);
    for (const id of NEW_INDICATORS) {
      const scores = series.indicators[id];
      expect(scores, `${id} missing from the series`).toBeDefined();
      expect(
        scores.filter((v) => Number.isFinite(v)).length,
        `${id} never produced a reading`
      ).toBeGreaterThan(300);
      for (const v of scores) {
        if (!Number.isFinite(v)) continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("keeps today's reading independent of every later bar", () => {
    const full = computeMegaScoreSeries(bars);
    const cut = 300;
    const truncated = computeMegaScoreSeries({
      high: bars.high.slice(0, cut + 1),
      low: bars.low.slice(0, cut + 1),
      close: bars.close.slice(0, cut + 1),
      volume: bars.volume.slice(0, cut + 1),
    });
    expect(truncated.score[cut]).toBeCloseTo(full.score[cut], 10);
    for (const id of NEW_INDICATORS) {
      const before = full.indicators[id][cut];
      const after = truncated.indicators[id][cut];
      expect(Number.isFinite(after), `${id} lost its reading when the future was cut`).toBe(true);
      expect(after, `${id} changed when the future was cut`).toBeCloseTo(before, 10);
    }
  });
});

// ─── User-edited calculations in the series ─────────────────────
// A right-click edit that replaces an indicator's formula must reach every
// consumer of this series (the history chart, the backtest's Mega Score
// strategy, the chart overlay, the trade-log breakdown) — and a formula that
// cannot run must leave the built-in series in place and say so.

describe("computeMegaScoreSeries — user-edited formulas", () => {
  const edited = { "ta-rsi-14": { formula: "rsi(close, 9)" } };

  it("replaces that indicator's series with the user's expression, bar for bar", () => {
    const builtIn = computeMegaScoreSeries(bars);
    const withEdit = computeMegaScoreSeries(bars, undefined, undefined, edited);
    // evalFormula needs every OHLCV leg; the series here has no `open`, so pass
    // the previous close (the same trick the app's daily bars use).
    const expected = evalFormula("rsi(close, 9)", {
      ...bars,
      open: bars.close.map((c, i) => (i === 0 ? c : bars.close[i - 1])),
    });

    for (let i = 0; i < bars.close.length; i++) {
      const got = withEdit.raw["ta-rsi-14"][i];
      if (!Number.isFinite(expected[i])) expect(Number.isFinite(got)).toBe(false);
      else expect(got).toBeCloseTo(expected[i], 10);
    }
    // …and it really is a different series from the built-in RSI(14).
    const builtLast = builtIn.raw["ta-rsi-14"].at(-1)!;
    const editedLast = withEdit.raw["ta-rsi-14"].at(-1)!;
    expect(Number.isFinite(builtLast) && Number.isFinite(editedLast)).toBe(true);
    expect(editedLast).not.toBeCloseTo(builtLast, 6);
  });

  it("leaves every other indicator untouched", () => {
    const builtIn = computeMegaScoreSeries(bars);
    const withEdit = computeMegaScoreSeries(bars, undefined, undefined, edited);
    for (const id of ["ta-rsi-14", "ta-macd-hist", "ta-atr-pct", "ta-williams-r"]) {
      if (id === "ta-rsi-14") continue;
      expect(withEdit.indicators[id]).toEqual(builtIn.indicators[id]);
    }
  });

  it("carries the edit into the composite", () => {
    const builtIn = computeMegaScoreSeries(bars);
    const withEdit = computeMegaScoreSeries(bars, undefined, undefined,
      { "ta-rsi-14": { formula: "rsi(close, 9)", direction: "lower", thresholds: [30, 70] } });
    const differs = builtIn.score.some((v, i) => Math.abs(v - withEdit.score[i]) > 1e-9);
    expect(differs).toBe(true);
    for (const v of withEdit.score) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the built-in series and reports a formula that cannot run", () => {
    const builtIn = computeMegaScoreSeries(bars);
    const broken = computeMegaScoreSeries(bars, undefined, undefined,
      { "ta-rsi-14": { formula: "rsi(close, 5) + unknownVar" } });
    expect(broken.raw["ta-rsi-14"]).toEqual(builtIn.raw["ta-rsi-14"]);
    expect(broken.customErrors.join(" ")).toMatch(/ta-rsi-14/);
  });

  it("ignores an edit aimed at an id that is not a built-in", () => {
    const builtIn = computeMegaScoreSeries(bars);
    const other = computeMegaScoreSeries(bars, undefined, undefined,
      { "not-an-indicator": { formula: "close * 2" } });
    expect(other.score).toEqual(builtIn.score);
    expect(other.customErrors).toEqual([]);
  });

  it("describes the run with the edited spec, not the catalogue's", () => {
    const withEdit = computeMegaScoreSeries(bars, undefined, undefined, {
      "ta-rsi-14": { name: "My RSI", unit: "pts", description: "My own momentum read", formula: "rsi(close, 9)" },
    });
    const spec = withEdit.specs.find((s) => s.id === "ta-rsi-14")!;
    expect(spec.name).toBe("My RSI");
    expect(spec.unit).toBe("pts");
    expect(spec.formula).toBe("rsi(close, 9)");

    // The trade-log snapshot reads these specs, so a log row names the user's
    // indicator and its unit rather than the built-in's.
    const snap = snapshotMegaScore(withEdit, bars.close.length - 1, "2022-01-03");
    const row = snap.readings.find((r) => r.id === "ta-rsi-14")!;
    expect(row.name).toBe("My RSI");
    expect(row.unit).toBe("pts");
  });

  it("is deterministic: the same edit scores the same run twice", () => {
    const a = computeMegaScoreSeries(bars, undefined, undefined, edited);
    const b = computeMegaScoreSeries(bars, undefined, undefined, edited);
    expect(a.raw["ta-rsi-14"]).toEqual(b.raw["ta-rsi-14"]);
    expect(a.score).toEqual(b.score);
  });
});
