// Financial-correctness tests for the catalogue indicators and the suggester.
//
// Every formula here is checked against an INDEPENDENT reference written from the
// published definition — never against another copy of the app's code path:
//   • ADX / +DI / −DI  — J. Welles Wilder, "New Concepts in Technical Trading
//                        Systems": TR = max(H−L, |H−C₁|, |L−C₁|), +DM/−DM with
//                        Wilder's smoothing, DX = 100·|+DI−−DI|/(+DI+−DI).
//   • MFI              — (H+L+C)/3 · volume split by the direction of the typical
//                        price, then the RSI formula on the two flow sums.
//   • OBV              — cumulative ±volume by close direction (Granville).
//   • Keltner          — EMA(20) ± 2·ATR(10) with the %B-style position inside.
//   • Aroon            — 100·(period − bars since the window extreme)/period over
//                        the latest period+1 bars (TradingView's ta.aroon).
//   • SuperTrend       — (H+L)/2 ± 3·ATR(10) with the standard ratcheting final
//                        bands and a close-based flip.
// Plus the rules that let the app suggest indicators for the ticker at hand.

import { describe, it, expect } from "vitest";
import {
  adx, mfi, obv, keltner, keltnerPosition, aroon, superTrend, atr, sma, rsi,
} from "../src/lib/ta";
import {
  ALL_SPECS, OPTIONAL_SPECS, actionFor, computeMegaIndicator, defaultWeightFor, defaultWeights,
  effectiveWeight, evenWeights, percentShares,
} from "../src/lib/mega-indicator";
import { suggestIndicators, median, MAX_SUGGESTIONS, type SuggestionContext } from "../src/lib/indicator-suggestions";
import { isEvenWeights } from "../src/lib/mega-prefs";
import { computeMegaScoreSeries } from "../src/lib/mega-score";

// ─── Deterministic OHLCV with enough history for every warm-up ───
function makeBars(n: number) {
  let seed = 20261012;
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
    const c = Math.max(1, o + Math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 3);
    high.push(Math.max(o, c) + rnd() * 1.4);
    low.push(Math.min(o, c) - rnd() * 1.4);
    open.push(o);
    close.push(c);
    volume.push(1_000_000 + rnd() * 500_000);
    px = c;
  }
  return { open, high, low, close, volume };
}

const bars = makeBars(600);

function expectSeries(app: number[], ref: number[], label: string, digits = 8): void {
  let compared = 0;
  for (let i = 0; i < Math.min(app.length, ref.length); i++) {
    const a = app[i];
    const r = ref[i];
    if (Number.isNaN(r) && Number.isNaN(a)) continue;
    expect(a, `${label} diverged at ${i}: app=${a} ref=${r}`).toBeCloseTo(r, digits);
    compared++;
  }
  expect(compared, `${label}: nothing compared`).toBeGreaterThan(100);
}

// ─── Independent references ─────────────────────────────────────

/** Wilder average seeded with the mean of the values at `start..start+p−1`. */
function refWilder(values: number[], start: number, p: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = start; i < start + p; i++) sum += values[i];
  let prev = sum / p;
  out[start + p - 1] = prev;
  for (let i = start + p; i < values.length; i++) {
    prev = (prev * (p - 1) + values[i]) / p;
    out[i] = prev;
  }
  return out;
}

function refAdx(h: number[], l: number[], c: number[], p: number): number[] {
  const tr: number[] = [NaN];
  const pdm: number[] = [NaN];
  const mdm: number[] = [NaN];
  for (let i = 1; i < c.length; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const trS = refWilder(tr, 1, p);
  const pS = refWilder(pdm, 1, p);
  const mS = refWilder(mdm, 1, p);
  const dx = c.map((_, i) => {
    if (![trS[i], pS[i], mS[i]].every(Number.isFinite)) return NaN;
    if (trS[i] === 0) return 0;
    const pdi = (100 * pS[i]) / trS[i];
    const mdi = (100 * mS[i]) / trS[i];
    const sum = pdi + mdi;
    return sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
  });
  // ADX is Wilder's average of the DX series, seeded with the first `p` of them.
  const out = new Array(c.length).fill(NaN);
  let sum = 0;
  for (let i = p; i < p + p; i++) sum += dx[i];
  let prev = sum / p;
  out[2 * p - 1] = prev;
  for (let i = 2 * p; i < c.length; i++) {
    prev = (prev * (p - 1) + dx[i]) / p;
    out[i] = prev;
  }
  return out;
}

function refMfi(h: number[], l: number[], c: number[], v: number[], p: number): number[] {
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  return c.map((_, i) => {
    if (i < p) return NaN;
    let positive = 0;
    let negative = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const flow = tp[j] * v[j];
      if (tp[j] > tp[j - 1]) positive += flow;
      else if (tp[j] < tp[j - 1]) negative += flow;
    }
    if (negative === 0) return positive > 0 ? 100 : NaN;
    return 100 - 100 / (1 + positive / negative);
  });
}

function refObv(c: number[], v: number[]): number[] {
  let total = 0;
  return c.map((close, i) => {
    if (i > 0) {
      if (close > c[i - 1]) total += v[i];
      else if (close < c[i - 1]) total -= v[i];
    }
    return total;
  });
}

function refKeltnerPosition(h: number[], l: number[], c: number[], p: number): number[] {
  // Independent EMA (SMA seed) and Wilder ATR, then the %B-style position.
  const k = 2 / (20 + 1);
  const emaOut: number[] = new Array(c.length).fill(NaN);
  let seed = 0;
  for (let i = 0; i < 20; i++) seed += c[i];
  emaOut[19] = seed / 20;
  for (let i = 20; i < c.length; i++) emaOut[i] = c[i] * k + emaOut[i - 1] * (1 - k);

  const tr: number[] = [NaN];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const atrOut = refWilder(tr, 1, p);

  return c.map((close, i) => {
    if (![emaOut[i], atrOut[i]].every(Number.isFinite)) return NaN;
    const upper = emaOut[i] + 2 * atrOut[i];
    const lower = emaOut[i] - 2 * atrOut[i];
    return upper > lower ? ((close - lower) / (upper - lower)) * 100 : NaN;
  });
}

function refAroon(h: number[], l: number[], p: number): number[] {
  return h.map((_, i) => {
    if (i < p) return NaN;
    let hiIdx = i;
    let loIdx = i;
    for (let j = i - 1; j >= i - p; j--) {
      if (h[j] > h[hiIdx]) hiIdx = j;
      if (l[j] < l[loIdx]) loIdx = j;
    }
    const up = (100 * (p - (i - hiIdx))) / p;
    const down = (100 * (p - (i - loIdx))) / p;
    return up - down;
  });
}

function refSuperTrendDirection(h: number[], l: number[], c: number[], atrPeriod: number, mult: number): number[] {
  const range = atr(h, l, c, atrPeriod); // the same ATR the app uses; the bands below are the reference
  const dir = new Array(c.length).fill(NaN);
  let upper = NaN;
  let lower = NaN;
  let up = true;
  for (let i = 0; i < c.length; i++) {
    if (![range[i], c[i], h[i], l[i]].every(Number.isFinite)) continue;
    const mid = (h[i] + l[i]) / 2;
    const nextUpper = mid + mult * range[i];
    const nextLower = mid - mult * range[i];
    if (Number.isFinite(upper)) {
      const keepUpper = nextUpper < upper || c[i - 1] > upper;
      const keepLower = nextLower > lower || c[i - 1] < lower;
      const finalUpper = keepUpper ? nextUpper : upper;
      const finalLower = keepLower ? nextLower : lower;
      up = up ? c[i] > finalLower : c[i] > finalUpper;
      upper = finalUpper;
      lower = finalLower;
    } else {
      upper = nextUpper;
      lower = nextLower;
      up = c[i] >= mid;
    }
    dir[i] = up ? 1 : -1;
  }
  return dir;
}

// ─── The indicators ─────────────────────────────────────────────

describe("catalogue indicators match their published definitions", () => {
  it("ADX (14) — Wilder's directional movement", () => {
    const app = adx(bars.high, bars.low, bars.close, 14);
    expectSeries(app.adx, refAdx(bars.high, bars.low, bars.close, 14), "ADX(14)");
    expect(app.adx.findIndex(Number.isFinite)).toBe(27); // 14 DX values after the first DI
    for (const v of app.adx) {
      if (Number.isNaN(v)) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    for (const series of [app.plusDi, app.minusDi]) {
      for (const v of series) {
        if (Number.isNaN(v)) continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("ADX is 100 on a perfectly one-sided trend and 0 when every step is equal", () => {
    // Straight up: all the movement is +DM, so −DI is 0 and DX pins at 100.
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const res = adx(up.map((v) => v + 1), up.map((v) => v - 1), up, 14);
    expect(res.minusDi[40]).toBeCloseTo(0, 8);
    expect(res.adx[40]).toBeCloseTo(100, 6);
    // A flat tape has no directional movement at all.
    const flat = new Array(60).fill(100);
    expect(adx(flat, flat, flat, 14).adx[40]).toBe(0);
  });

  it("Money Flow Index (14) — and an exact worked example", () => {
    expectSeries(
      mfi(bars.high, bars.low, bars.close, bars.volume, 14),
      refMfi(bars.high, bars.low, bars.close, bars.volume, 14),
      "MFI(14)"
    );
    // Two bars of period 2: TP 10 with 200 shares in, then TP 25/3 with 100 out.
    // MFR = 2000 / (2500/3) = 2.4 → MFI = 100 − 100/3.4.
    const h = [10, 11, 10];
    const l = [8, 9, 7];
    const c = [9, 10, 8];
    const v = [100, 200, 100];
    expect(mfi(h, l, c, v, 2)[2]).toBeCloseTo(100 - 100 / 3.4, 8);
  });

  it("On-Balance Volume follows close direction, and an exact worked example", () => {
    expectSeries(obv(bars.close, bars.volume), refObv(bars.close, bars.volume), "OBV");
    // 10 → 11 (+200), → 10.5 (−300), → 12 (+400)
    expect(obv([10, 11, 10.5, 12], [100, 200, 300, 400])).toEqual([0, 200, -100, 300]);
  });

  it("Keltner position sits in its channel and agrees with an independent channel", () => {
    expectSeries(
      keltnerPosition(bars.high, bars.low, bars.close, 20, 10, 2),
      refKeltnerPosition(bars.high, bars.low, bars.close, 10),
      "Keltner position"
    );
    const { upper, middle, lower } = keltner(bars.high, bars.low, bars.close, 20, 10, 2);
    for (let i = 200; i < bars.close.length; i++) {
      expect(upper[i]).toBeGreaterThan(middle[i]);
      expect(middle[i]).toBeGreaterThan(lower[i]);
      expect(upper[i] - middle[i]).toBeCloseTo(middle[i] - lower[i], 10);
    }
    // A close exactly on the lower band reads 0, on the upper band 100.
    const flat = new Array(40).fill(100);
    const pos = keltnerPosition(flat, flat, flat, 20, 10, 2);
    expect(Number.isNaN(pos[39])).toBe(true); // no width → no position
  });

  it("Aroon Oscillator (25) — fresh highs against fresh lows", () => {
    expectSeries(aroon(bars.high, bars.low, 25).osc, refAroon(bars.high, bars.low, 25), "Aroon oscillator");
    const { up, down, osc } = aroon(bars.high, bars.low, 25);
    for (let i = 0; i < bars.high.length; i++) {
      if (!Number.isFinite(osc[i])) continue;
      expect(up[i] - down[i]).toBeCloseTo(osc[i], 10);
      expect(Math.abs(osc[i])).toBeLessThanOrEqual(100);
    }
    // High today, low three bars ago, period 3 → +100.
    const res = aroon([1, 1, 1, 5], [1, 8, 8, 8], 3);
    expect(res.up[3]).toBeCloseTo(100, 10);
    expect(res.down[3]).toBeCloseTo(0, 10);
    expect(res.osc[3]).toBeCloseTo(100, 10);
    // A high exactly `period` bars old scores 0, not 100 (window = period+1).
    expect(aroon([5, 1, 1, 1], [1, 1, 1, 1], 3).up[3]).toBeCloseTo(0, 10);
  });

  it("SuperTrend (10, 3) tracks the direction and trails the trend", () => {
    expectSeries(
      superTrend(bars.high, bars.low, bars.close, 10, 3).direction,
      refSuperTrendDirection(bars.high, bars.low, bars.close, 10, 3),
      "SuperTrend direction"
    );
    // Rising market: long, with the line trailing below price. A crash flips it.
    const closes = [...Array.from({ length: 40 }, (_, i) => 100 + i), 100, 90, 80, 70];
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 1);
    const res = superTrend(highs, lows, closes, 10, 3);
    const last = closes.length - 1;
    expect(res.direction[35]).toBe(1);
    expect(res.line[35]).toBeLessThan(closes[35]);
    expect(res.direction[last]).toBe(-1);
    expect(res.line[last]).toBeGreaterThan(closes[last]);
  });

  it("every catalogue indicator is a spec, and each spec is optional by default", () => {
    expect(OPTIONAL_SPECS.length).toBe(24);
    const ids = OPTIONAL_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of OPTIONAL_SPECS) {
      expect(spec.optional, `${spec.id} is not marked optional`).toBe(true);
      expect(spec.formula.length, `${spec.id} formula`).toBeGreaterThan(20);
      expect(spec.description.length, `${spec.id} description`).toBeGreaterThan(20);
      expect(ALL_SPECS.some((s) => s.id === spec.id)).toBe(true);
    }
    const weights = defaultWeights(ALL_SPECS);
    for (const spec of ALL_SPECS) {
      expect(weights[spec.id], `${spec.id} default weight`).toBe(
        defaultWeightFor(spec.id, spec.optional)
      );
    }
  });

  it("the default composite is balanced: 100 weight, RSI and Bollinger 20 each", () => {
    const weights = defaultWeights(ALL_SPECS);
    const total = ALL_SPECS.reduce((s, spec) => s + weights[spec.id], 0);
    expect(total).toBeCloseTo(100, 10);
    expect(weights["ta-rsi-14"]).toBe(20);
    expect(weights["ta-bb-pos"]).toBe(20);
    for (const spec of OPTIONAL_SPECS) expect(weights[spec.id]).toBe(0);
    for (const spec of ALL_SPECS.filter((s) => !s.optional)) {
      expect(weights[spec.id], `${spec.id} is switched off by default`).toBeGreaterThan(0);
    }
    // The displayed shares are rounded but still add up to exactly 100.
    const shares = percentShares(ALL_SPECS.map((s) => weights[s.id]));
    expect(shares.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 10);
  });

  it("percentShares keeps the displayed shares at exactly 100 after rounding", () => {
    const six = percentShares([1, 1, 1, 1, 1, 1]);
    expect(six.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 10);
    for (const v of six) expect(v).toBeGreaterThanOrEqual(16.6);
    // 16.6 × 6 = 99.6; the four leftover tenths go to the largest remainders.
    expect(six.filter((v) => v === 16.7).length).toBe(4);
    expect(six.filter((v) => v === 16.6).length).toBe(2);

    const skewed = percentShares([20, 20, 10, 4, 3, 2, 1, 0.5]);
    expect(skewed.reduce((s, v) => s + v, 0)).toBeCloseTo(100, 10);
    // A fully-off weight contributes nothing, and an all-off map is all zeros.
    expect(percentShares([0, 0])).toEqual([0, 0]);
  });

  it("the catalogue stays out of the composite until it is added", () => {
    const technical: Record<string, number> = {};
    for (const spec of ALL_SPECS) technical[spec.id] = (spec.thresholds[0] + spec.thresholds[1]) / 2;
    const withDefaults = computeMegaIndicator({ technical, weights: defaultWeights(ALL_SPECS) });
    const everything = computeMegaIndicator({ technical, weights: evenWeights(ALL_SPECS) });

    // Defaults enable only the built-ins; every catalogue id starts disabled.
    const builtInCount = ALL_SPECS.length - OPTIONAL_SPECS.length;
    expect(withDefaults.indicators.filter((i) => i.enabled).length).toBe(builtInCount);
    expect(everything.indicators.filter((i) => i.enabled).length).toBe(ALL_SPECS.length);
    expect(withDefaults.score).not.toBeCloseTo(everything.score, 6);
    for (const spec of OPTIONAL_SPECS) {
      const ind = withDefaults.indicators.find((i) => i.id === spec.id);
      expect(ind, `${spec.id} missing from the payload`).toBeDefined();
      expect(ind!.enabled, `${spec.id} should start disabled`).toBe(false);
    }
    // Adding one changes the composite.
    const added = computeMegaIndicator({
      technical,
      weights: { ...defaultWeights(ALL_SPECS), "ta-adx-14": 4 },
    });
    expect(added.indicators.find((i) => i.id === "ta-adx-14")!.enabled).toBe(true);
    expect(added.score).not.toBeCloseTo(withDefaults.score, 6);
  });

  it("the causal series carries every catalogue indicator", () => {
    const series = computeMegaScoreSeries(bars);
    for (const spec of OPTIONAL_SPECS) {
      const scores = series.indicators[spec.id];
      expect(scores, `${spec.id} missing from the series`).toBeDefined();
      expect(scores.filter(Number.isFinite).length, `${spec.id} never produced a reading`)
        .toBeGreaterThan(300);
    }
  });
});

// ─── The suggester ──────────────────────────────────────────────

describe("indicator suggestions", () => {
  const base: SuggestionContext = {
    adx: 22,
    efficiency: 0.25,
    atrPct: 2,
    atrPctMedian: 2,
    momentum: 4,
    volumeRatio: 1,
    fromHigh: -3,
  };
  const ids = ALL_SPECS.map((s) => s.id);
  const defaults = defaultWeights(ALL_SPECS);

  const suggest = (context: Partial<SuggestionContext>, values: Record<string, number> = {}) =>
    suggestIndicators({
      context: { ...base, ...context },
      values,
      weights: defaults,
      specs: ALL_SPECS,
    });

  it("suggests trend tools when the market is trending", () => {
    const out = suggest({ adx: 45, efficiency: 0.5 });
    expect(out[0].id).toBe("ta-adx-14");
    const byId = new Map(out.map((s) => [s.id, s]));
    expect(byId.get("ta-supertrend")?.kind).toBe("add");
    expect(byId.get("ta-supertrend")!.reason).toContain("ADX 45");
    // Built-ins are already in the composite, so they come back as a reweight.
    expect(byId.get("ta-trend-50-200")?.kind).toBe("reweight");
    // Balanced default is 4; a level-2 rule asks for 4 more points.
    expect(byId.get("ta-trend-50-200")?.weight).toBe(8);
    expect(out.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it("suggests oscillators when the market is choppy", () => {
    const out = suggest({ adx: 12, efficiency: 0.1 });
    const byId = new Map(out.map((s) => [s.id, s]));
    expect(out[0].id).toBe("ta-mfi-14");
    expect(byId.get("ta-mfi-14")?.kind).toBe("add");
    expect(byId.get("ta-kc-pos")?.kind).toBe("add");
    expect(byId.get("ta-williams-r")?.kind).toBe("reweight");
    expect(byId.get("ta-supertrend")).toBeUndefined();
  });

  it("suggests volume tools when turnover surges", () => {
    const out = suggest({ volumeRatio: 3 });
    expect(out[0].id).toBe("ta-obv-20");
    expect(out[0].reason).toContain("3.0×");
    expect(out.map((s) => s.id)).toContain("ta-mfi-14");
  });

  it("asks for money-flow confirmation of an overbought or oversold RSI", () => {
    expect(suggest({}, { "ta-rsi-14": 78 }).map((s) => s.id)).toContain("ta-mfi-14");
    expect(suggest({}, { "ta-rsi-14": 22 }).map((s) => s.id)).toContain("ta-mfi-14");
    expect(suggest({}, { "ta-rsi-14": 50 })).toHaveLength(0);
  });

  it("notices a volatility regime change and a broken downtrend", () => {
    expect(suggest({ atrPct: 5, atrPctMedian: 2 }).map((s) => s.id)).toContain("ta-atr-pct");
    expect(suggest({ fromHigh: -40 }).map((s) => s.id)).toContain("ta-supertrend");
  });

  it("says nothing when the market state is unremarkable", () => {
    expect(suggest({})).toHaveLength(0);
  });

  it("never proposes an indicator that is already at least that strong", () => {
    // A level-1 rule asks for 2 points, so weight 2 is already enough.
    const weights = { ...defaults, "ta-supertrend": 2 };
    const out = suggestIndicators({
      context: { ...base, adx: 45 },
      values: {},
      weights,
      specs: ALL_SPECS,
    });
    expect(out.some((s) => s.id === "ta-supertrend")).toBe(false);
    expect(out.some((s) => s.id === "ta-adx-14")).toBe(true);
  });

  it("is deterministic, keeps ids real, and ranks by priority", () => {
    const context = { ...base, adx: 40, efficiency: 0.45, volumeRatio: 2 };
    const first = suggestIndicators({ context, values: {}, weights: defaults, specs: ALL_SPECS });
    const second = suggestIndicators({ context, values: {}, weights: defaults, specs: ALL_SPECS });
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (let i = 0; i < first.length; i++) {
      expect(ids, `${first[i].id} is not a real spec`).toContain(first[i].id);
      expect(seen.has(first[i].id)).toBe(false);
      seen.add(first[i].id);
      expect(first[i].kind === "add" || first[i].kind === "reweight").toBe(true);
      expect(first[i].reason.length).toBeGreaterThan(20);
      expect(first[i].priority).toBeGreaterThanOrEqual(0);
      expect(first[i].priority).toBeLessThanOrEqual(1);
      if (i > 0) expect(first[i - 1].priority).toBeGreaterThanOrEqual(first[i].priority);
    }
  });

  it("median ignores junk and handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([NaN, 5, Infinity])).toBe(5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it("suggests an overbought RSI reading only when the RSI is real", () => {
    expect(suggest({}, { "ta-rsi-14": NaN })).toHaveLength(0);
    // rsi() and sma() stay wired to the same catalogue the suggester reads.
    expect(rsi(bars.close, 14).length).toBe(bars.close.length);
    expect(sma(bars.close, 20).length).toBe(bars.close.length);
  });
});


describe("weight fallbacks — one rule for the server, the page and the backtest", () => {
  const technical: Record<string, number> = {};
  for (const spec of ALL_SPECS) technical[spec.id] = (spec.thresholds[0] + spec.thresholds[1]) / 2;

  // A map written before the catalogue existed: built-ins at 1, no catalogue keys.
  const builtInsOnly: Record<string, number> = {};
  for (const spec of ALL_SPECS) if (!spec.optional) builtInsOnly[spec.id] = 1;

  it("a saved map from before the catalogue does not pull the catalogue in", () => {
    const partial = computeMegaIndicator({ technical, weights: builtInsOnly });
    const builtInCount = ALL_SPECS.length - OPTIONAL_SPECS.length;
    expect(partial.indicators.length).toBe(ALL_SPECS.length);
    expect(partial.indicators.filter((i) => i.enabled).length).toBe(builtInCount);
    for (const spec of OPTIONAL_SPECS) {
      const ind = partial.indicators.find((i) => i.id === spec.id);
      expect(ind, spec.id + " is in the payload").toBeDefined();
      expect(ind!.weight).toBe(0);
      expect(ind!.enabled).toBe(false);
    }
  });

  it("effectiveWeight: balanced built-in default, catalogue 0, an explicit weight always wins", () => {
    expect(effectiveWeight({ id: "ta-rsi-14" }, null)).toBe(20);
    expect(effectiveWeight({ id: "ta-bb-pos" }, null)).toBe(20);
    expect(effectiveWeight({ id: "ta-trend-50-200" }, null)).toBe(4);
    expect(effectiveWeight({ id: "ta-adx-14", optional: true }, null)).toBe(0);
    expect(effectiveWeight({ id: "ta-adx-14", optional: true }, { "ta-adx-14": 3 })).toBe(3);
    expect(effectiveWeight({ id: "ta-rsi-14" }, { "ta-rsi-14": 0 })).toBe(0);
    expect(effectiveWeight({ id: "ta-rsi-14" }, { "ta-rsi-14": -2 })).toBe(0);
  });

  it("the baseline action follows the score bands — buy ≥ 65, hold 35-65, sell < 35", () => {
    expect(actionFor(100).key).toBe("buy");
    expect(actionFor(65).key).toBe("buy");
    expect(actionFor(64.9).key).toBe("hold");
    expect(actionFor(50).key).toBe("hold");
    expect(actionFor(35).key).toBe("hold");
    expect(actionFor(34.9).key).toBe("sell");
    expect(actionFor(0).key).toBe("sell");
    expect(actionFor(NaN).key).toBe("hold");
    // The payload carries the same action the UI derives from the score.
    const res = computeMegaIndicator({ technical, weights: defaultWeights(ALL_SPECS) });
    expect(res.action.key).toBe(actionFor(res.score).key);
  });

  it("the payload says which indicators are catalogue ones", () => {
    const res = computeMegaIndicator({ technical, weights: defaultWeights(ALL_SPECS) });
    for (const spec of OPTIONAL_SPECS) {
      const ind = res.indicators.find((i) => i.id === spec.id);
      expect(ind?.optional, spec.id).toBe(true);
    }
    expect(res.indicators.find((i) => i.id === "ta-rsi-14")?.optional).toBe(false);
  });

  it("isEvenWeights means 'the same as defaultWeights', not merely all-ones", () => {
    expect(isEvenWeights(null)).toBe(true);
    expect(isEvenWeights(defaultWeights(ALL_SPECS))).toBe(true);
    // A flat all-ones map is the "Everything" preset, not the balanced default:
    // it has to travel to the API, or the page and the server would disagree.
    expect(isEvenWeights({ ...builtInsOnly })).toBe(false);
    expect(isEvenWeights(evenWeights(ALL_SPECS))).toBe(false);
    // So is switching a built-in off.
    expect(isEvenWeights({ ...defaultWeights(ALL_SPECS), "ta-rsi-14": 0 })).toBe(false);
  });
});
