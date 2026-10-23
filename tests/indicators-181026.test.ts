// The indicator blocks added by "Indicators project 181026.xlsx".
//
// Two layers of proof:
//   1. Each function is checked against an INDEPENDENT reference written from
//      its published definition (Donchian, Chaikin A/D, CMF, Chaikin
//      oscillator, Balance of Power, Chande momentum, EMA slope).
//   2. When the workbook is present on the dev machine, the output is compared
//      with the workbook's own cells: CMO (col 168, quoted with the workbook's
//      reverse-time sign), smoothed BOP (col 150), EMA-20/EMA-200 slope (cols
//      170/172) and CMF (col 155, whose SUM range covers 21 rows, so the test
//      runs the function with period 21 — the app itself uses the standard 20).
//
// The workbook holds personal market data and is git-ignored, so the workbook
// suite skips on CI rather than failing a run it cannot satisfy.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  donchian, donchianPosition, rangePosition, adl, chaikinMoneyFlow,
  chaikinOscillator, balanceOfPower, cmo, percentSlope, ema, sma, adx, rsi,
  windowMean, rollingMax, rollingMin,
} from "../src/lib/ta";
import { ALL_SPECS, OPTIONAL_SPECS, defaultWeights, normalizeScore } from "../src/lib/mega-indicator";
import { computeMegaScoreSeries } from "../src/lib/mega-score";

// ─── Deterministic OHLCV with enough history for every warm-up ───
function makeBars(n: number) {
  let seed = 20261018;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = Math.max(1, o + Math.sin(i / 13) * 1.1 + (rnd() - 0.5) * 2.4);
    open.push(o);
    high.push(Math.max(o, c) + rnd() * 1.2);
    low.push(Math.min(o, c) - rnd() * 1.2);
    close.push(c);
    volume.push(1_000_000 + rnd() * 400_000);
    px = c;
  }
  return { open, high, low, close, volume };
}

const bars = makeBars(600);

function expectSeries(app: number[], ref: number[], label: string, digits = 9): void {
  let compared = 0;
  for (let i = 0; i < Math.min(app.length, ref.length); i++) {
    const a = app[i];
    const r = ref[i];
    if (Number.isNaN(a) && Number.isNaN(r)) continue;
    expect(a, `${label} diverged at ${i}: app=${a} ref=${r}`).toBeCloseTo(r, digits);
    compared++;
  }
  expect(compared, `${label}: nothing compared`).toBeGreaterThan(100);
}

// ─── Independent references ─────────────────────────────────────

function refDonchian(highs: number[], lows: number[], p: number) {
  const upper = highs.map((_, i) => (i < p - 1 ? NaN : Math.max(...highs.slice(i - p + 1, i + 1))));
  const lower = lows.map((_, i) => (i < p - 1 ? NaN : Math.min(...lows.slice(i - p + 1, i + 1))));
  return { upper, lower };
}

function refPosition(upper: number[], lower: number[], closes: number[]): number[] {
  return closes.map((c, i) =>
    Number.isFinite(upper[i]) && upper[i] > lower[i]
      ? ((c - lower[i]) / (upper[i] - lower[i])) * 100
      : NaN
  );
}

function refAdl(h: number[], l: number[], c: number[], v: number[]): number[] {
  let total = 0;
  return c.map((close, i) => {
    const range = h[i] - l[i];
    if (range !== 0) total += (((close - l[i]) - (h[i] - close)) / range) * v[i];
    return total;
  });
}

function refCmf(h: number[], l: number[], c: number[], v: number[], p: number): number[] {
  return c.map((close, i) => {
    if (i < p - 1) return NaN;
    let flow = 0;
    let volume = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const range = h[j] - l[j];
      if (range !== 0) flow += (((c[j] - l[j]) - (h[j] - c[j])) / range) * v[j];
      volume += v[j];
    }
    return volume > 0 ? flow / volume : NaN;
  });
}

function refEma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
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

function refChaikinOscillator(h: number[], l: number[], c: number[], v: number[], fast: number, slow: number): number[] {
  const line = refAdl(h, l, c, v);
  const f = refEma(line, fast);
  const s = refEma(line, slow);
  return line.map((_, i) => (Number.isFinite(f[i]) && Number.isFinite(s[i]) ? f[i] - s[i] : NaN));
}

function refBop(open: number[], h: number[], l: number[], c: number[]): number[] {
  return c.map((close, i) => {
    const range = h[i] - l[i];
    return range > 0 ? (close - open[i]) / range : NaN;
  });
}

function refCmo(closes: number[], p: number): number[] {
  return closes.map((_, i) => {
    if (i < p) return NaN;
    let up = 0;
    let down = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const ch = closes[j] - closes[j - 1];
      if (ch > 0) up += ch;
      else down -= ch;
    }
    return up + down > 0 ? (100 * (up - down)) / (up + down) : 0;
  });
}

// ─── The new functions ──────────────────────────────────────────

describe("181026 indicator functions match their definitions", () => {
  it("Donchian channel and position", () => {
    const { upper, lower } = refDonchian(bars.high, bars.low, 20);
    const app = donchian(bars.high, bars.low, 20);
    expectSeries(app.upper, upper, "Donchian upper");
    expectSeries(app.lower, lower, "Donchian lower");
    const middle = upper.map((v, i) => (v + lower[i]) / 2);
    expectSeries(app.middle, middle, "Donchian middle");
    expectSeries(
      donchianPosition(bars.high, bars.low, bars.close, 20),
      refPosition(upper, lower, bars.close),
      "Donchian position"
    );
    // Position is bounded 0-100 inside a real channel.
    for (const v of donchianPosition(bars.high, bars.low, bars.close, 20)) {
      if (Number.isNaN(v)) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("Fibonacci range position is the same 0-100 position over the window's extremes", () => {
    expectSeries(
      rangePosition(bars.high, bars.low, bars.close, 252),
      refPosition(rollingMax(bars.high, 252), rollingMin(bars.low, 252), bars.close),
      "range position"
    );
    // Close at the window high reads 100; at the window low reads 0.
    const highs = new Array(260).fill(200);
    const lows = new Array(260).fill(100);
    const atHigh = new Array(260).fill(200);
    const atLow = new Array(260).fill(100);
    expect(rangePosition(highs, lows, atHigh, 252)[259]).toBeCloseTo(100, 10);
    expect(rangePosition(highs, lows, atLow, 252)[259]).toBeCloseTo(0, 10);
  });

  it("Chaikin A/D line is the running total of money flow volume", () => {
    expectSeries(
      adl(bars.high, bars.low, bars.close, bars.volume),
      refAdl(bars.high, bars.low, bars.close, bars.volume),
      "ADL"
    );
    // Worked example: H=11, L=9, C=10.5, V=1000 → MFM 0.5 → MFV 500.
    expect(adl([11], [9], [10.5], [1000])[0]).toBeCloseTo(500, 10);
    // A bar with no range adds nothing rather than dividing by zero.
    expect(adl([10], [10], [10], [500])[0]).toBe(0);
  });

  it("Chaikin Money Flow is money flow volume over total volume", () => {
    expectSeries(
      chaikinMoneyFlow(bars.high, bars.low, bars.close, bars.volume, 20),
      refCmf(bars.high, bars.low, bars.close, bars.volume, 20),
      "CMF(20)"
    );
    for (const v of chaikinMoneyFlow(bars.high, bars.low, bars.close, bars.volume, 20)) {
      if (Number.isNaN(v)) continue;
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("Chaikin Oscillator is the fast EMA minus the slow EMA of the A/D line", () => {
    expectSeries(
      chaikinOscillator(bars.high, bars.low, bars.close, bars.volume, 3, 10),
      refChaikinOscillator(bars.high, bars.low, bars.close, bars.volume, 3, 10),
      "Chaikin oscillator"
    );
  });

  it("Balance of Power is (close − open)/(high − low), smoothed by windowMean", () => {
    expectSeries(
      balanceOfPower(bars.open, bars.high, bars.low, bars.close),
      refBop(bars.open, bars.high, bars.low, bars.close),
      "BOP"
    );
    expectSeries(
      windowMean(balanceOfPower(bars.open, bars.high, bars.low, bars.close), 14),
      windowMean(refBop(bars.open, bars.high, bars.low, bars.close), 14),
      "smoothed BOP(14)"
    );
    // Open at the low and close at the high = +1; the reverse = −1.
    expect(balanceOfPower([0], [10], [0], [10])[0]).toBeCloseTo(1, 10);
    expect(balanceOfPower([10], [10], [0], [0])[0]).toBeCloseTo(-1, 10);
  });

  it("Chande Momentum Oscillator uses the last 14 close changes", () => {
    expectSeries(cmo(bars.close, 14), refCmo(bars.close, 14), "CMO(14)");
    // All up-moves → +100; all down-moves → −100; a flat tape is neutral 0.
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(cmo(up, 14)[19]).toBeCloseTo(100, 10);
    expect(cmo(up.map((v) => 200 - v), 14)[19]).toBeCloseTo(-100, 10);
    expect(cmo(new Array(20).fill(100), 14)[19]).toBe(0);
  });

  it("percentSlope is the one-bar change against the base", () => {
    expectSeries(
      percentSlope(ema(bars.close, 20), bars.close),
      ema(bars.close, 20).map((v, i) =>
        i && Number.isFinite(v) && Number.isFinite(ema(bars.close, 20)[i - 1])
          ? ((v - ema(bars.close, 20)[i - 1]) / bars.close[i]) * 100
          : NaN
      ),
      "EMA-20 slope"
    );
    expect(percentSlope([10, 11], [100, 100])[1]).toBeCloseTo(1, 10);
  });
});

// ─── Catalogue + causal series ─────────────────────────────────

const NEW_IDS = [
  "ta-donchian-pos", "ta-fib-pos", "ta-adl-20", "ta-di-spread", "ta-bop-14",
  "ta-cmf-20", "ta-chaikin-osc", "ta-cmo-14", "ta-ema20-slope",
  "ta-ema200-slope", "ta-ctm",
];

describe("181026 additions are catalogue indicators", () => {
  it("registers every new id as optional, out of the composite by default", () => {
    const ids = new Set(OPTIONAL_SPECS.map((s) => s.id));
    const weights = defaultWeights(ALL_SPECS);
    for (const id of NEW_IDS) {
      const spec = OPTIONAL_SPECS.find((s) => s.id === id);
      expect(spec, `${id} is not registered`).toBeDefined();
      expect(ids.has(id), `${id} is not optional`).toBe(true);
      expect(weights[id], `${id} should start at weight 0`).toBe(0);
      expect(spec!.formula.length).toBeGreaterThan(20);
      expect(spec!.description.length).toBeGreaterThan(20);
    }
  });

  it("produces a causal reading for each new indicator", () => {
    const series = computeMegaScoreSeries(bars);
    for (const id of NEW_IDS) {
      const scores = series.indicators[id];
      expect(scores, `${id} missing from the causal series`).toBeDefined();
      expect(scores.filter(Number.isFinite).length, `${id} never produced a reading`).toBeGreaterThan(300);
    }
  });

  it("Balance of Power is honestly absent when open prices are unavailable", () => {
    const series = computeMegaScoreSeries({ high: bars.high, low: bars.low, close: bars.close, volume: bars.volume });
    expect(series.indicators["ta-bop-14"]).toBeUndefined();
    // Everything that does not need `open` is still there.
    expect(series.indicators["ta-cmo-14"]).toBeDefined();
    expect(series.indicators["ta-ctm"]).toBeDefined();
  });

  it("every new threshold pair is ordered and scores its documented ends", () => {
    for (const id of NEW_IDS) {
      const spec = ALL_SPECS.find((s) => s.id === id)!;
      const [a, b] = spec.thresholds;
      expect(a, `${id} has a reversed threshold pair`).toBeLessThanOrEqual(b);
      expect(["higher", "lower", "band"]).toContain(spec.direction);
      const mid = (a + b) / 2;
      for (const v of [a, b, mid]) {
        const score = normalizeScore(v, spec);
        expect(Number.isFinite(score), `${id} scored ${score} at ${v}`).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
      if (spec.direction === "higher") {
        expect(normalizeScore(a, spec), `${id} lower end`).toBe(0);
        expect(normalizeScore(b, spec), `${id} upper end`).toBe(100);
      } else if (spec.direction === "lower") {
        expect(normalizeScore(a, spec), `${id} good end`).toBe(100);
        expect(normalizeScore(b, spec), `${id} bad end`).toBe(0);
      } else {
        expect(normalizeScore(mid, spec), `${id} band middle`).toBe(100);
        expect(normalizeScore(a, spec), `${id} band edge`).toBe(60);
      }
    }
  });

  it("Donchian is a breakout reading, not a mean-reversion one", () => {
    const spec = ALL_SPECS.find((s) => s.id === "ta-donchian-pos")!;
    expect(spec.direction).toBe("higher");
    expect(normalizeScore(0, spec)).toBe(0);
    expect(normalizeScore(100, spec)).toBe(100);
  });
});

// ─── Workbook regression (skipped when the file is absent) ─────

const WORKBOOK = fileURLToPath(new URL("../../Indicators project 181026.xlsx", import.meta.url));
const hasWorkbook = existsSync(WORKBOOK);
const suite = hasWorkbook ? describe : describe.skip;

suite("Indicators project 181026.xlsx columns", () => {
  // Vitest still runs a skipped suite's factory to register its tests, so the
  // workbook must only be opened when it exists — CI never has this git-ignored
  // file, and reading it here failed the whole run before any test ran.
  const wb = hasWorkbook ? XLSX.read(readFileSync(WORKBOOK), { type: "buffer" }) : null;
  const matrix = (wb
    ? XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
        header: 1,
        defval: "",
      })
    : []) as unknown[][];

  // Keep rows with a complete OHLCV record and put them oldest → newest,
  // which is the order lib/ta computes on. The workbook itself is newest-first.
  const rows = matrix
    .slice(1)
    .filter((r) =>
      [1, 2, 3, 4, 5].every((c) => typeof r[c] === "number" && Number.isFinite(r[c] as number))
    )
    .reverse();
  const col = (c: number): number[] =>
    rows.map((r) => (typeof r[c] === "number" && Number.isFinite(r[c] as number) ? (r[c] as number) : NaN));
  const close = col(1);
  const volume = col(2);
  const open = col(3);
  const high = col(4);
  const low = col(5);

  it("smoothed Balance of Power reproduces column 150", () => {
    const app = windowMean(balanceOfPower(open, high, low, close), 14);
    const expected = col(150);
    let compared = 0;
    for (let i = 0; i < app.length; i++) {
      if (!Number.isFinite(expected[i])) continue;
      expect(app[i], `BOP diverged at bar ${i}`).toBeCloseTo(expected[i], 10);
      compared++;
    }
    expect(compared).toBeGreaterThan(2400);
  });

  it("CMO reproduces column 168 (the workbook quotes it on a reversed series, so the sign flips)", () => {
    const app = cmo(close, 14);
    const expected = col(168);
    let compared = 0;
    for (let i = 0; i < app.length; i++) {
      // The workbook's rate-of-change blocks are defined from its first row;
      // the app needs 14 changes first, so its warm-up is honestly NaN.
      if (!Number.isFinite(expected[i]) || !Number.isFinite(app[i])) continue;
      expect(app[i], `CMO diverged at bar ${i}`).toBeCloseTo(-expected[i], 9);
      compared++;
    }
    expect(compared).toBeGreaterThan(2400);
  });

  it("CMF reproduces column 155 when the window is the workbook's 21 rows", () => {
    // The workbook's SUM(E?2:E?22) covers 21 bars; the app's standard reading
    // is 20. Checking 21 here pins the money-flow arithmetic, not the period.
    const app = chaikinMoneyFlow(high, low, close, volume, 21);
    const expected = col(155);
    let compared = 0;
    for (let i = 0; i < app.length; i++) {
      if (!Number.isFinite(expected[i])) continue;
      expect(app[i], `CMF diverged at bar ${i}`).toBeCloseTo(expected[i], 9);
      compared++;
    }
    expect(compared).toBeGreaterThan(2400);
  });

  it("scores the directional additions across their range, not at the rails", () => {
    // With the first thresholds these indicators saturated at 0/100 on most
    // bars of the workbook. A median score near the middle proves the
    // normalisation uses the readings' real distribution.
    const volAvg = sma(volume, 20);
    const adlSeries = adl(high, low, close, volume);
    const adlAvg = sma(adlSeries, 20);
    const a14 = adx(high, low, close, 14);
    const cmo14 = cmo(close, 14);
    const r = rsi(close, 14);
    const e20 = ema(close, 20);
    const e200 = ema(close, 200);
    const emaScore = (ma: number, i: number): number => {
      if (!Number.isFinite(ma) || ma === 0) return NaN;
      const pct = ((close[i] - ma) / ma) * 100;
      return Math.max(0, Math.min(100, ((pct + 1) / 2) * 100));
    };
    const ctm = close.map((_, i) => {
      const parts = [r[i], cmo14[i], emaScore(e20[i], i), emaScore(e200[i], i), a14.adx[i]];
      return parts.every(Number.isFinite) ? parts.reduce((s, v) => s + v, 0) / parts.length : NaN;
    });
    const readings: Record<string, number[]> = {
      "ta-adl-20": adlSeries.map((v, i) =>
        Number.isFinite(adlAvg[i]) && volAvg[i] > 0 ? (v - adlAvg[i]) / volAvg[i] : NaN),
      "ta-di-spread": a14.plusDi.map((v, i) => v - a14.minusDi[i]),
      "ta-bop-14": windowMean(balanceOfPower(open, high, low, close), 14),
      "ta-cmf-20": chaikinMoneyFlow(high, low, close, volume, 20),
      "ta-chaikin-osc": chaikinOscillator(high, low, close, volume, 3, 10).map((v, i) =>
        Number.isFinite(v) && volAvg[i] > 0 ? v / volAvg[i] : NaN),
      "ta-ema20-slope": percentSlope(e20, close),
      "ta-ema200-slope": percentSlope(e200, close),
      "ta-ctm": ctm,
    };
    for (const [id, values] of Object.entries(readings)) {
      const spec = ALL_SPECS.find((s) => s.id === id)!;
      const scores = values.filter(Number.isFinite).map((v) => normalizeScore(v, spec));
      const sorted = [...scores].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      expect(median, `${id} median score ${median.toFixed(1)} is stuck at a rail`).toBeGreaterThan(20);
      expect(median, `${id} median score ${median.toFixed(1)} is stuck at a rail`).toBeLessThan(80);
    }
  });

  it("EMA slopes reproduce columns 170 and 172", () => {
    for (const [period, column] of [[20, 170], [200, 172]] as const) {
      const app = percentSlope(ema(close, period), close);
      const expected = col(column);
      // Both EMAs are seeded differently by the workbook, so compare once the
      // recursion has forgotten the seed (the last 100 bars).
      let compared = 0;
      for (let i = app.length - 100; i < app.length; i++) {
        if (!Number.isFinite(expected[i])) continue;
        expect(app[i], `EMA-${period} slope diverged at bar ${i}`).toBeCloseTo(expected[i], 8);
        compared++;
      }
      expect(compared).toBeGreaterThan(90);
    }
  });
});
