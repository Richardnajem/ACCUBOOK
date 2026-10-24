// The indicator blocks added from "technicals richard.xlsx".
//
// Two layers of proof:
//   1. Each function is checked against an INDEPENDENT reference written from
//      its published definition (Connors RSI, Coppock, PMO, DPO, Ease of
//      Movement, the EMA-200 filtered ATR stop).
//   2. When the workbook is present on the dev machine, the pieces whose cells
//      are trustworthy are compared with the workbook itself: ROC(14)/ROC(11)
//      (cols 198-200), the 1-bar ROC behind PMO (col 203), the ATR bands
//      (cols 126-128) and the ATR stop line (col 131). The workbook holds
//      personal market data and is git-ignored, so that suite skips on CI.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  rateOfChange, wma, connorsRsi, coppock, pmo, dpo, emv, easeOfMovement,
  atrStop, atr, ema, windowMean, rollingMin,
} from "../src/lib/ta";
import {
  ALL_SPECS, OPTIONAL_SPECS, defaultWeights, getSpec, normalizeScore,
} from "../src/lib/mega-indicator";
import { computeMegaScoreSeries } from "../src/lib/mega-score";

// ─── Deterministic OHLCV with enough history for every warm-up ───
function makeBars(n: number) {
  let seed = 20261024;
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
    const c = Math.max(1, o + Math.sin(i / 11) * 1.4 + (rnd() - 0.5) * 2.6);
    open.push(o);
    high.push(Math.max(o, c) + rnd() * 1.2);
    low.push(Math.min(o, c) - rnd() * 1.2);
    close.push(c);
    volume.push(900_000 + rnd() * 600_000);
    px = c;
  }
  return { open, high, low, close, volume };
}

const bars = makeBars(700);

function expectSeries(app: number[], ref: number[], label: string, digits = 10): void {
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

function refRoc(values: number[], period: number): number[] {
  return values.map((v, i) =>
    i < period || !Number.isFinite(values[i - period]) || values[i - period] === 0
      ? NaN
      : ((v - values[i - period]) / values[i - period]) * 100
  );
}

function refWma(values: number[], period: number): number[] {
  const denom = (period * (period + 1)) / 2;
  return values.map((_, i) => {
    if (i < period - 1) return NaN;
    let sum = 0;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (!Number.isFinite(v)) return NaN;
      sum += (j + 1) * v;
    }
    return sum / denom;
  });
}

function refRsi(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period && i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  if (period < values.length) out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function refStreak(closes: number[]): number[] {
  return closes.map((c, i) => {
    if (i === 0) return 0;
    let s = 0;
    let j = i;
    while (j > 0) {
      const ch = closes[j] - closes[j - 1];
      if (ch > 0 && s >= 0) { s++; j--; }
      else if (ch < 0 && s <= 0) { s--; j--; }
      else break;
    }
    return s;
  });
}

function refPercentRank(values: number[], period: number): number[] {
  return values.map((v, i) => {
    if (i < period) return NaN;
    let lower = 0;
    for (let j = i - period; j < i; j++) {
      if (!Number.isFinite(values[j])) return NaN;
      if (values[j] < v) lower++;
    }
    return (lower / period) * 100;
  });
}

function refEma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
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

/** EMA that starts at the first full window after the leading NaNs. */
function refAlignedEma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  const start = values.findIndex(Number.isFinite);
  if (start < 0) return out;
  const compact = refEma(values.slice(start), period);
  for (let i = 0; i < compact.length; i++) out[start + i] = compact[i];
  return out;
}

function refPmo(closes: number[], period = 35, signalPeriod = 20, scale = 10) {
  const roc1 = closes.map((c, i) =>
    i === 0 || closes[i - 1] === 0 ? NaN : ((c - closes[i - 1]) / closes[i - 1]) * 100
  );
  const line = refAlignedEma(roc1, period).map((v) => (Number.isFinite(v) ? v * scale : NaN));
  const signal = refAlignedEma(line, signalPeriod);
  const histogram = line.map((v, i) =>
    Number.isFinite(v) && Number.isFinite(signal[i]) ? v - signal[i] : NaN
  );
  return { pmo: line, signal, histogram };
}

function refEmv(highs: number[], lows: number[], volumes: number[], period: number): number[] {
  const raw = volumes.map((_, i) => {
    if (i === 0) return NaN;
    const h = highs[i];
    const l = lows[i];
    if (!(h > l) || !(volumes[i] > 0)) return NaN;
    const mid = (h + l) / 2;
    const prev = (highs[i - 1] + lows[i - 1]) / 2;
    return ((mid - prev) / (volumes[i] / (h - l))) * 100_000;
  });
  return windowMean(raw, period);
}

function refAtrStop(highs: number[], lows: number[], closes: number[], atrPeriod: number, mult: number, emaPeriod: number) {
  const a = atr(highs, lows, closes, atrPeriod);
  const trend = refEma(closes, emaPeriod);
  const line = closes.map((c, i) => {
    if (!Number.isFinite(a[i]) || !Number.isFinite(trend[i])) return NaN;
    return c >= trend[i] ? c - mult * a[i] : c + mult * a[i];
  });
  const direction = closes.map((c, i) => {
    if (!Number.isFinite(line[i])) return NaN;
    return c >= trend[i] ? 1 : -1;
  });
  return { line, direction };
}

// ─── The new functions ──────────────────────────────────────────

describe("technicals-richard indicator functions match their definitions", () => {
  it("rateOfChange is the percent change over the lookback", () => {
    expectSeries(rateOfChange(bars.close, 14), refRoc(bars.close, 14), "ROC(14)");
    expect(rateOfChange([100, 110], 1)[1]).toBeCloseTo(10, 10);
    expect(rateOfChange([0, 110], 1)[1]).toBeNaN();
  });

  it("wma weights the newest bar most", () => {
    expectSeries(wma(bars.close, 10), refWma(bars.close, 10), "WMA(10)");
    // Worked example: 1,2,3 with weights 1,2,3 → (1+4+9)/6 = 2.333…
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo(14 / 6, 10);
  });

  it("Connors RSI averages RSI(3), the streak RSI(2) and the ROC percentile", () => {
    const app = connorsRsi(bars.close, 3, 2, 100);
    const r = refRsi(bars.close, 3);
    const streak = refStreak(bars.close);
    const streakRsi = refRsi(streak, 2);
    const roc1 = bars.close.map((c, i) => (i ? c / bars.close[i - 1] - 1 : NaN));
    const rank = refPercentRank(roc1, 100);
    expectSeries(app.rsi, r, "Connors leg 1 (RSI-3)");
    expectSeries(app.streakRsi, streakRsi, "Connors leg 2 (streak RSI-2)");
    expectSeries(app.percentRank, rank, "Connors leg 3 (ROC percentile)");
    expectSeries(
      app.value,
      r.map((v, i) => (Number.isFinite(v) && Number.isFinite(streakRsi[i]) && Number.isFinite(rank[i])
        ? (v + streakRsi[i] + rank[i]) / 3
        : NaN)),
      "ConnorsRSI"
    );
    // A flat tape has no return dispersion, so the percentile leg is the lowest
    // rank (0), not a fabricated mid-point.
    expect(connorsRsi(new Array(150).fill(100), 3, 2, 100).percentRank[149]).toBe(0);
    for (const v of app.value.filter(Number.isFinite)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("Coppock is a WMA-10 of ROC(14) + ROC(11)", () => {
    const sum = refRoc(bars.close, 14).map((v, i) =>
      Number.isFinite(v) && Number.isFinite(refRoc(bars.close, 11)[i]) ? v + refRoc(bars.close, 11)[i] : NaN
    );
    expectSeries(coppock(bars.close, 10, 14, 11), refWma(sum, 10), "Coppock");
  });

  it("PMO is 10 × EMA-35 of the 1-bar ROC, with its 20-day signal", () => {
    const app = pmo(bars.close, 35, 20, 10);
    const ref = refPmo(bars.close, 35, 20, 10);
    expectSeries(app.pmo, ref.pmo, "PMO line");
    expectSeries(app.signal, ref.signal, "PMO signal");
    expectSeries(app.histogram, ref.histogram, "PMO histogram");
    // The line is exactly 10× its pre-scaled input.
    expectSeries(
      app.pmo.map((v) => v / 10),
      refAlignedEma(refRoc(bars.close, 1), 35),
      "PMO pre-scale"
    );
  });

  it("DPO is the shifted close minus the current SMA", () => {
    const app = dpo(bars.close, 20);
    const ref = bars.close.map((c, i) => {
      if (i < 11) return NaN;
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += bars.close[j];
      return bars.close[i - 11] - sum / 20;
    });
    expectSeries(app, ref, "DPO(20)");
    // A constant series has no cycle to detrend.
    expect(dpo(new Array(60).fill(50), 20)[59]).toBeCloseTo(0, 12);
  });

  it("Ease of Movement is midpoint travel per unit of volume-per-range", () => {
    const app = emv(bars.high, bars.low, bars.volume, 14);
    expectSeries(app, refEmv(bars.high, bars.low, bars.volume, 14), "EMV(14)");
    const raw = easeOfMovement([10, 11], [8, 9], [0, 1000]);
    // mid 9 → 10 = +1; box = 1000/(11−9) = 500 → EMV = 1/500.
    expect(raw[1]).toBeCloseTo(1 / 500, 12);
    // A bar with no range has no box ratio and therefore no reading.
    expect(easeOfMovement([10, 10], [10, 10], [1000, 1000])[1]).toBeNaN();
  });

  it("ATR stop sits 3·ATR on the EMA-200 side of the trend", () => {
    const app = atrStop(bars.high, bars.low, bars.close, 14, 3, 200);
    const ref = refAtrStop(bars.high, bars.low, bars.close, 14, 3, 200);
    expectSeries(app.line, ref.line, "ATR stop line");
    expectSeries(app.direction, ref.direction, "ATR stop direction");

    const last = bars.close.length - 1;
    const range = atr(bars.high, bars.low, bars.close, 14);
    const trend = ema(bars.close, 200);
    expect(app.line[last]).toBeCloseTo(
      bars.close[last] >= trend[last] ? bars.close[last] - 3 * range[last] : bars.close[last] + 3 * range[last],
      10
    );
    // Before the EMA-200 is ready the filter cannot answer, so there is no line.
    expect(app.line[150]).toBeNaN();
    expect(app.direction[150]).toBeNaN();
    expect(app.line[199]).not.toBeNaN();
  });
});

// ─── Catalogue + causal series ─────────────────────────────────

const NEW_IDS = [
  "ta-connors-rsi", "ta-coppock", "ta-pmo", "ta-dpo-pct", "ta-emv-14",
  "ta-atr-stop", "ta-dist-52w-low",
];

describe("technicals-richard additions are catalogue indicators", () => {
  it("registers every new id as optional, out of the composite by default", () => {
    const weights = defaultWeights(ALL_SPECS);
    for (const id of NEW_IDS) {
      const spec = OPTIONAL_SPECS.find((s) => s.id === id);
      expect(spec, `${id} is not registered`).toBeDefined();
      expect(weights[id], `${id} should start at weight 0`).toBe(0);
      expect(spec!.formula.length).toBeGreaterThan(20);
      expect(spec!.description.length).toBeGreaterThan(20);
      const [a, b] = spec!.thresholds;
      expect(a, `${id} has a reversed threshold pair`).toBeLessThanOrEqual(b);
      expect(["higher", "lower", "band"]).toContain(spec!.direction);
    }
  });

  it("produces a causal reading for each new indicator", () => {
    const series = computeMegaScoreSeries(bars);
    for (const id of NEW_IDS) {
      const scores = series.indicators[id];
      expect(scores, `${id} missing from the causal series`).toBeDefined();
      expect(scores.filter(Number.isFinite).length, `${id} never produced a reading`)
        .toBeGreaterThan(300);
    }
  });

  it("distance above the 52-week low is measured from the rolling low", () => {
    const series = computeMegaScoreSeries(bars);
    const low = rollingMin(bars.close, 252);
    const i = bars.close.length - 1;
    const expected = ((bars.close[i] - low[i]) / low[i]) * 100;
    const spec = getSpec("ta-dist-52w-low")!;
    expect(series.indicators["ta-dist-52w-low"][i]).toBeCloseTo(
      normalizeScore(expected, spec),
      6
    );
  });
});

// ─── Workbook regression (skipped when the file is absent) ─────

const WORKBOOK = fileURLToPath(new URL("../../technicals richard.xlsx", import.meta.url));
const hasWorkbook = existsSync(WORKBOOK);
const suite = hasWorkbook ? describe : describe.skip;

suite("technicals richard.xlsx columns", () => {
  const wb = hasWorkbook ? XLSX.read(readFileSync(WORKBOOK), { type: "buffer" }) : null;
  const matrix = (wb
    ? XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" })
    : []) as unknown[][];

  // Complete OHLCV rows, oldest → newest (the workbook stores newest first).
  const rows = matrix
    .slice(1)
    .filter((r) => [1, 2, 3, 4, 5].every((c) => typeof r[c] === "number" && Number.isFinite(r[c] as number)))
    .reverse();
  const col = (c: number): number[] =>
    rows.map((r) => (typeof r[c] === "number" && Number.isFinite(r[c] as number) ? (r[c] as number) : NaN));
  const close = col(1);
  const volume = col(2);
  const high = col(4);
  const low = col(5);

  it("ROC(14) and ROC(11) reproduce columns 198 and 199 (the workbook stores fractions)", () => {
    for (const [period, column] of [[14, 198], [11, 199]] as const) {
      const app = rateOfChange(close, period).map((v) => v / 100);
      const expected = col(column);
      let compared = 0;
      for (let i = 0; i < app.length; i++) {
        if (!Number.isFinite(expected[i]) || !Number.isFinite(app[i])) continue;
        expect(app[i], `ROC(${period}) diverged at bar ${i}`).toBeCloseTo(expected[i], 10);
        compared++;
      }
      expect(compared).toBeGreaterThan(2400);
    }
    // The workbook's "Sum ROC" is the two fractional ROCs added, which is our
    // percent sum / 100.
    const sum = rateOfChange(close, 14).map((v, i) => {
      const short = rateOfChange(close, 11)[i];
      return Number.isFinite(v) && Number.isFinite(short) ? (v + short) / 100 : NaN;
    });
    let compared = 0;
    for (let i = 0; i < sum.length; i++) {
      if (!Number.isFinite(col(200)[i]) || !Number.isFinite(sum[i])) continue;
      expect(sum[i], `Sum ROC diverged at bar ${i}`).toBeCloseTo(col(200)[i], 10);
      compared++;
    }
    expect(compared).toBeGreaterThan(2400);
  });

  it("PMO's 1-bar ROC reproduces column 203 (there quoted in percent)", () => {
    const app = rateOfChange(close, 1);
    const expected = col(203);
    let compared = 0;
    for (let i = 0; i < app.length; i++) {
      if (!Number.isFinite(expected[i]) || !Number.isFinite(app[i])) continue;
      expect(app[i], `ROC(1) diverged at bar ${i}`).toBeCloseTo(expected[i], 10);
      compared++;
    }
    expect(compared).toBeGreaterThan(2400);
  });

  it("the workbook's ATR bands and stop line are the shapes the app implements", () => {
    const a = col(126);
    let bands = 0;
    let stops = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!Number.isFinite(a[i])) continue;
      expect(col(127)[i], `upper band at ${i}`).toBeCloseTo(close[i] + a[i], 8);
      expect(col(128)[i], `lower band at ${i}`).toBeCloseTo(close[i] - a[i], 8);
      bands++;
      const stop = col(131)[i];
      if (!Number.isFinite(stop)) continue;
      const off = stop - close[i];
      // Long regime: 3·ATR below price; short regime: 3·ATR above.
      expect(
        Math.abs(off - 3 * a[i]) < 1e-6 || Math.abs(off + 3 * a[i]) < 1e-6,
        `stop line at ${i} is not close ± 3·ATR`
      ).toBe(true);
      stops++;
    }
    expect(bands).toBeGreaterThan(2400);
    expect(stops).toBeGreaterThan(2400);
    // The app's own line is built from its ATR and EMA-200, so it must respect
    // the same ±3·ATR relationship (the reference test pins the values).
    const app = atrStop(high, low, close, 14, 3, 200);
    const appAtr = atr(high, low, close, 14);
    let compared = 0;
    for (let i = 0; i < close.length; i++) {
      if (!Number.isFinite(app.line[i])) continue;
      const off = app.line[i] - close[i];
      expect(Math.abs(Math.abs(off) - 3 * appAtr[i]), `app stop at ${i}`).toBeLessThan(1e-9);
      compared++;
    }
    // The app needs its EMA-200 first, so ~199 bars of the workbook's stop
    // column have no counterpart to compare against.
    expect(compared).toBeGreaterThan(2200);
  });

  it("the workbook's EMV block is box ratio = volume/range, scaled ×100 000", () => {
    let boxes = 0;
    let scales = 0;
    for (let i = 0; i < rows.length; i++) {
      const box = col(226)[i];
      const emvRaw = col(227)[i];
      const scaled = col(228)[i];
      if (!Number.isFinite(box)) continue;
      if (high[i] > low[i] && volume[i] > 0) {
        expect(box, `box ratio at ${i}`).toBeCloseTo(volume[i] / (high[i] - low[i]), 6);
        boxes++;
      }
      if (Number.isFinite(emvRaw) && Number.isFinite(scaled)) {
        expect(scaled, `scaled EMV at ${i}`).toBeCloseTo(emvRaw * 100_000, 6);
        scales++;
      }
    }
    expect(boxes).toBeGreaterThan(2400);
    expect(scales).toBeGreaterThan(2400);
    // The workbook computes its midpoint move from the NEWER bar (a one-row
    // look-ahead in a newest-first sheet), so its per-bar EMV column is not a
    // causal series and is deliberately not used as a value reference.
    const mid = high.map((h, i) => (h + low[i]) / 2);
    let ahead = 0;
    let behind = 0;
    for (let i = 1; i < rows.length - 1; i++) {
      const mm = col(225)[i];
      if (!Number.isFinite(mm)) continue;
      if (Math.abs(mm - (mid[i] - mid[i + 1])) < 1e-6) ahead++;
      else if (Math.abs(mm - (mid[i] - mid[i - 1])) < 1e-6) behind++;
    }
    expect(ahead).toBeGreaterThan(2400);
    expect(behind).toBe(0);
  });
});
