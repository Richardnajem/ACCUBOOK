// Accuracy tests for every indicator formula the Mega Indicator uses.
//
// Each check compares src/lib/ta against an INDEPENDENT reference written
// straight from the published definition — not another copy of our code path.
// Sources for those definitions:
//   • RSI / ATR   — J. Welles Wilder's smoothing: ATR = (Prior ATR × 13 + TR) / 14,
//                   RSI avg gain = (Prior × 13 + gain) / 14
//                   (Investopedia, StockCharts ChartSchool, OANDA, thinkorswim)
//   • MACD        — 12/26 EMA difference, 9-period signal EMA (Investopedia)
//   • Bollinger   — 20-period SMA ± 2 population σ (John Bollinger / ChartSchool)
//   • Stochastic  — %K = 100·(C − LL)/(HH − LL); Slow %K = SMA3(%K);
//                   Slow %D = SMA3(Slow %K) (Fidelity, ChartSchool)
//   • CCI         — (TP − SMA20(TP)) / (0.015 × Mean Deviation)
//                   (Investopedia, Fidelity)
//   • ER          — Kaufman: |net move| / Σ|each step|
//
// Also verifies that every spec carries a formula string (the right-click
// inspector renders it), that scoring can never leave 0-100, and that the
// composite is a correct weighted average.

import { describe, it, expect } from "vitest";
import {
  sma, ema, rsi, macd, bollinger, atr, stochastic, cci, stdev, rollingMax, rollingMin,
} from "../src/lib/ta";
import {
  ALL_SPECS, TECHNICAL_SPECS, MA_PERIODS, normalizeScore, computeMegaIndicator,
} from "../src/lib/mega-indicator";

// ─── Deterministic, realistic OHLCV (no external data needed) ───
function makeBars(n: number) {
  let seed = 20261008;
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
    const drift = Math.sin(i / 17) * 1.2 + (rnd() - 0.5) * 3;
    const o = px;
    const c = Math.max(1, o + drift);
    const h = Math.max(o, c) + rnd() * 1.4;
    const l = Math.min(o, c) - rnd() * 1.4;
    open.push(o); high.push(h); low.push(l); close.push(c);
    volume.push(1_000_000 + rnd() * 500_000);
    px = c;
  }
  return { open, high, low, close, volume };
}

const bars = makeBars(600);

// ─── Independent references ─────────────────────────────────────

function refSma(v: number[], p: number): number[] {
  return v.map((_, i) => {
    if (i < p - 1) return NaN;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += v[j];
    return s / p;
  });
}

function refEma(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  const k = 2 / (p + 1);
  let s = 0;
  for (let i = 0; i < p; i++) s += v[i];
  let prev = s / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function refRsi(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / p;
  let al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function refAtr(h: number[], l: number[], c: number[], p: number): number[] {
  const out = new Array(c.length).fill(NaN);
  const tr = c.map((_, i) =>
    i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))
  );
  let s = 0;
  for (let i = 1; i <= p; i++) s += tr[i];
  let prev = s / p;
  out[p] = prev;
  for (let i = p + 1; i < c.length; i++) {
    prev = (prev * (p - 1) + tr[i]) / p;
    out[i] = prev;
  }
  return out;
}

function refStoch(h: number[], l: number[], c: number[]) {
  const raw = c.map((_, i) => {
    if (i < 13) return NaN; // not a full 14-bar window yet
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - 13; j <= i; j++) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    return hh > ll ? ((c[i] - ll) / (hh - ll)) * 100 : NaN;
  });
  const avg = (v: number[], i: number) => {
    if (i < 2) return NaN;
    const w = [v[i - 2], v[i - 1], v[i]];
    return w.every(Number.isFinite) ? (w[0] + w[1] + w[2]) / 3 : NaN;
  };
  const k = raw.map((_, i) => avg(raw, i));
  const d = k.map((_, i) => avg(k, i));
  return { raw, k, d };
}

function refCci(h: number[], l: number[], c: number[], p: number): number[] {
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  const out = new Array(c.length).fill(NaN);
  for (let i = p - 1; i < c.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += tp[j];
    const mid = s / p;
    let dev = 0;
    for (let j = i - p + 1; j <= i; j++) dev += Math.abs(tp[j] - mid);
    const mad = dev / p;
    out[i] = mad > 0 ? (tp[i] - mid) / (0.015 * mad) : 0;
  }
  return out;
}

function refStdev(v: number[], p: number): number[] {
  return v.map((_, i) => {
    if (i < p - 1) return NaN;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += v[j];
    const mean = s / p;
    let acc = 0;
    for (let j = i - p + 1; j <= i; j++) acc += (v[j] - mean) ** 2;
    return Math.sqrt(acc / (p - 1));
  });
}

function expectSeriesMatch(app: number[], ref: number[], label: string, digits = 9): void {
  let compared = 0;
  for (let i = 0; i < app.length; i++) {
    const a = app[i];
    const r = ref[i];
    if (Number.isNaN(r) && Number.isNaN(a)) continue;
    expect(a, `${label} diverged at index ${i}: app=${a} ref=${r}`).toBeCloseTo(r, digits);
    compared++;
  }
  expect(compared, `${label}: nothing compared`).toBeGreaterThan(100);
}

// ─── The tests ──────────────────────────────────────────────────

describe("indicator formulas match the published definitions", () => {
  it("SMA", () => {
    expectSeriesMatch(sma(bars.close, 20), refSma(bars.close, 20), "SMA-20");
    expectSeriesMatch(sma(bars.close, 200), refSma(bars.close, 200), "SMA-200");
  });

  it("EMA (SMA seed, k = 2/(n+1))", () => {
    expectSeriesMatch(ema(bars.close, 20), refEma(bars.close, 20), "EMA-20");
    expectSeriesMatch(ema(bars.close, 200), refEma(bars.close, 200), "EMA-200");
  });

  it("RSI (Wilder smoothing)", () => {
    expectSeriesMatch(rsi(bars.close, 14), refRsi(bars.close, 14), "RSI-14", 8);
  });

  it("ATR (Wilder smoothing of true range)", () => {
    expectSeriesMatch(
      atr(bars.high, bars.low, bars.close, 14),
      refAtr(bars.high, bars.low, bars.close, 14),
      "ATR-14"
    );
  });

  it("Bollinger Bands (20 SMA ± 2 population σ)", () => {
    const app = bollinger(bars.close, 20, 2);
    const mid = refSma(bars.close, 20);
    expectSeriesMatch(app.middle, mid, "BB middle");
    for (let i = 19; i < bars.close.length; i++) {
      let varr = 0;
      for (let j = i - 19; j <= i; j++) varr += (bars.close[j] - mid[i]) ** 2;
      const sd = Math.sqrt(varr / 20); // population
      expect(app.upper[i]).toBeCloseTo(mid[i] + 2 * sd, 8);
      expect(app.lower[i]).toBeCloseTo(mid[i] - 2 * sd, 8);
    }
  });

  it("MACD (12/26 EMA difference, 9-period signal)", () => {
    const { macd: line, signal, histogram } = macd(bars.close, 12, 26, 9);
    const f = refEma(bars.close, 12);
    const s = refEma(bars.close, 26);
    let firstDefined = -1;
    for (let i = 0; i < bars.close.length; i++) {
      if (Number.isFinite(f[i]) && Number.isFinite(s[i])) { firstDefined = i; break; }
    }
    expect(firstDefined).toBeGreaterThanOrEqual(25);
    for (let i = firstDefined; i < bars.close.length; i++) {
      expect(line[i]).toBeCloseTo(f[i] - s[i], 8);
      if (Number.isFinite(histogram[i])) {
        expect(histogram[i]).toBeCloseTo(line[i] - signal[i], 8);
      }
    }
  });

  it("Stochastic (14,3,3) — slow %K and %D", () => {
    const app = stochastic(bars.high, bars.low, bars.close, 14, 3, 3);
    const ref = refStoch(bars.high, bars.low, bars.close);
    expectSeriesMatch(app.k, ref.k, "Slow %K");
    expectSeriesMatch(app.d, ref.d, "Slow %D");
    for (const v of app.k) if (Number.isFinite(v)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("CCI (20) — (TP − SMA) / (0.015 × mean deviation)", () => {
    expectSeriesMatch(
      cci(bars.high, bars.low, bars.close, 20),
      refCci(bars.high, bars.low, bars.close, 20),
      "CCI-20"
    );
  });

  it("3-day volatility (sample stdev, n−1 denominator)", () => {
    expectSeriesMatch(stdev(bars.close, 3), refStdev(bars.close, 3), "stdev-3");
  });

  it("rolling extremes", () => {
    const mx = rollingMax(bars.close, 50);
    const mn = rollingMin(bars.close, 50);
    for (let i = 49; i < bars.close.length; i++) {
      const w = bars.close.slice(i - 49, i + 1);
      expect(mx[i]).toBe(Math.max(...w));
      expect(mn[i]).toBe(Math.min(...w));
    }
  });
});

describe("hand-computed worked examples", () => {
  it("CCI matches an exact rational worked example", () => {
    // TP = [9, 37/3, 12] over a 3-bar window ending at the last bar.
    const h = [10, 14, 13];
    const l = [8, 10, 11];
    const c = [9, 13, 12];
    const out = cci(h, l, c, 3);
    // SMA(TP) = 100/9, MAD = 38/27 → (12 − 100/9) / (0.015 × 38/27) = 24/0.57
    expect(out[2]).toBeCloseTo(24 / 0.57, 10);
  });

  it("Stochastic raw %K matches an exact worked example", () => {
    const h = [10, 12, 14];
    const l = [8, 9, 11];
    const c = [9, 13, 12];
    const st = stochastic(h, l, c, 3, 1, 1);
    // HH = 14, LL = 8, close = 12 → 100 × (12 − 8) / (14 − 8)
    expect(st.k[2]).toBeCloseTo((100 * 4) / 6, 10);
    expect(st.d[2]).toBeCloseTo((100 * 4) / 6, 10);
  });

  it("ATR with period 1 equals raw true range", () => {
    const h = [0, 15, 15];
    const l = [0, 12, 12];
    const c = [10, 14, 14];
    expect(atr(h, l, c, 1)[1]).toBeCloseTo(5, 10); // gap-aware TR
  });

  it("RSI is 100 on a strictly rising series and 0 on a strictly falling one", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14)[14]).toBe(100);
    expect(rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14)[14]).toBe(0);
  });
});

describe("scoring is always in range and documented", () => {
  it("every spec declares a formula for the right-click inspector", () => {
    expect(ALL_SPECS.length).toBeGreaterThan(30);
    for (const s of ALL_SPECS) {
      expect(s.formula, `${s.id} has no formula`).toBeTruthy();
      expect(s.formula.length, `${s.id} formula too short`).toBeGreaterThan(10);
      expect(s.description, `${s.id} has no description`).toBeTruthy();
    }
  });

  it("specs are unique and thresholds are never reversed", () => {
    const ids = new Set<string>();
    for (const s of ALL_SPECS) {
      expect(ids.has(s.id), `duplicate id ${s.id}`).toBe(false);
      ids.add(s.id);
      // Equal is allowed — it makes a step function (MACD hist [0, 0]).
      expect(s.thresholds[0], `${s.id} thresholds reversed`).toBeLessThanOrEqual(s.thresholds[1]);
    }
  });

  it("normalizeScore never leaves 0-100 for extreme or odd inputs", () => {
    const probes = [-1e12, -1000, -100, -1, -0.001, 0, 0.5, 1, 10, 100, 1000, 1e12];
    for (const spec of ALL_SPECS) {
      for (const v of probes) {
        const s = normalizeScore(v, spec);
        expect(Number.isFinite(s), `${spec.id}(${v}) → ${s}`).toBe(true);
        expect(s, `${spec.id}(${v}) → ${s}`).toBeGreaterThanOrEqual(0);
        expect(s, `${spec.id}(${v}) → ${s}`).toBeLessThanOrEqual(100);
      }
      expect(normalizeScore(NaN, spec)).toBe(50);
      expect(normalizeScore(Infinity, spec)).toBe(50);
    }
  });

  it("a value squarely inside a healthy band scores at least as well as one outside it", () => {
    for (const spec of ALL_SPECS) {
      const [a, b] = spec.thresholds;
      const mid = (a + b) / 2;
      const inside = normalizeScore(mid, spec);
      const outside = normalizeScore(a - (b - a) * 2, spec);
      expect(inside, spec.id).toBeGreaterThanOrEqual(outside);
    }
  });
});

describe("composite Mega Score math", () => {
  const technical: Record<string, number> = {};
  for (const s of TECHNICAL_SPECS) technical[s.id] = (s.thresholds[0] + s.thresholds[1]) / 2;

  it("equals the weighted average of the indicator scores", () => {
    const weights: Record<string, number> = {};
    for (const s of ALL_SPECS) weights[s.id] = 1;
    weights["ta-rsi-14"] = 3;

    const res = computeMegaIndicator({ technical, weights });
    const enabled = res.indicators.filter((i) => i.enabled);
    const tw = enabled.reduce((s, i) => s + i.weight, 0);
    const expected = enabled.reduce((s, i) => s + i.score * i.weight, 0) / tw;
    expect(res.score).toBeCloseTo(Math.round(expected * 10) / 10, 6);
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
  });

  it("weight 0 excludes an indicator and redistributes the remainder", () => {
    const all = computeMegaIndicator({ technical });
    const oneOff = computeMegaIndicator({
      technical,
      weights: Object.fromEntries(ALL_SPECS.map((s) => [s.id, s.id === "ta-rsi-14" ? 0 : 1])),
    });
    expect(oneOff.indicators.find((i) => i.id === "ta-rsi-14")!.enabled).toBe(false);
    expect(oneOff.meta.technicalCount).toBe(all.meta.technicalCount);
    expect(oneOff.score).not.toBe(all.score);
    expect(oneOff.score).toBeGreaterThanOrEqual(0);
    expect(oneOff.score).toBeLessThanOrEqual(100);
  });

  it("falls back to 50 when everything is excluded", () => {
    const res = computeMegaIndicator({
      technical,
      weights: Object.fromEntries(ALL_SPECS.map((s) => [s.id, 0])),
    });
    expect(res.score).toBe(50);
    expect(res.indicators.every((i) => !i.enabled)).toBe(true);
  });

  it("ignores missing / non-finite raw values instead of poisoning the total", () => {
    const res = computeMegaIndicator({ technical: { "ta-rsi-14": 55, "ta-cci-20": NaN } });
    expect(res.indicators.some((i) => i.id === "ta-rsi-14")).toBe(true);
    expect(res.indicators.some((i) => i.id === "ta-cci-20")).toBe(false);
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
  });

  it("MA specs cover exactly the periods the app computes", () => {
    for (const p of MA_PERIODS) {
      expect(ALL_SPECS.some((s) => s.id === `ta-sma-${p}`)).toBe(true);
      expect(ALL_SPECS.some((s) => s.id === `ta-ema-${p}`)).toBe(true);
    }
  });
});
