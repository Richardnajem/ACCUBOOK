// The calibration engine: causal fill rules, a regime model that cannot look
// ahead, and a weight search that must actually find a planted edge.
//
// Everything here runs on synthetic bars and hand-built frames — no network, no
// database — so `npm test` stays hermetic. The live calibration against real
// market data is tests/mega-calibration-live.test.ts (opt-in, MEGA_LIVE=1).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRAINING_OPTIONS,
  SEARCH_UNITS,
  expectedMaxExcessSharpeByChance,
  expectedMaxSharpeByChance,
  normalizeWeights,
  normalQuantile,
  objectiveValue,
  prepareFrame,
  ruleBenchmarkCorrelation,
  scoreDistribution,
  shareMap,
  simulateRegime,
  trainMegaWeights,
  type CalibrationBar,
  type CalibrationFrame,
} from "../src/lib/mega-calibration";
import { computeMegaScoreSeries } from "../src/lib/mega-score";

/** Deterministic pseudo-random generator (no Math.random in tests). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeBars(n: number, drift = 0.0004, vol = 0.012, seed = 7): CalibrationBar[] {
  const rand = rng(seed);
  const bars: CalibrationBar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    // Gaussian-ish shock from the sum of two uniforms.
    const shock = (rand() + rand() - 1) * vol * 2;
    const c = Math.max(1, o * (1 + drift + shock));
    bars.push({
      date: new Date(Date.UTC(2010, 0, 4) + i * 86400_000).toISOString().slice(0, 10),
      open: o,
      high: Math.max(o, c) * (1 + rand() * 0.003),
      low: Math.min(o, c) * (1 - rand() * 0.003),
      close: c,
      volume: 1_000_000 + Math.floor(rand() * 500_000),
    });
    px = c;
  }
  return bars;
}

describe("normalQuantile / expectedMaxSharpeByChance", () => {
  it("matches the textbook quantiles", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.995)).toBeCloseTo(2.575829, 5);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 4);
  });

  it("rises with the number of trials and falls with more history", () => {
    const few = expectedMaxSharpeByChance(10, 10);
    const many = expectedMaxSharpeByChance(10, 1000);
    expect(many).toBeGreaterThan(few);
    expect(expectedMaxSharpeByChance(20, 1000)).toBeLessThan(many);
    expect(expectedMaxSharpeByChance(10, 1)).toBeGreaterThanOrEqual(0);
  });

  it("puts the luck bar at a few tenths of a Sharpe for a 70-trial search over 7 years", () => {
    // A search that tried ~70 candidates on 7 years of data can produce roughly
    // a 0.5 Sharpe from noise — the reason a train Sharpe needs a margin.
    const bar = expectedMaxSharpeByChance(7, 70);
    expect(bar).toBeGreaterThan(0.25);
    expect(bar).toBeLessThan(1.2);
  });

  it("puts the excess-Sharpe bar on the measure the search actually maximizes", () => {
    const raw = expectedMaxSharpeByChance(10, 1000);
    // Independent legs (ρ = 0): differencing two estimates is √2 noisier than either.
    expect(expectedMaxExcessSharpeByChance(10, 1000, 0)).toBeCloseTo(raw * Math.SQRT2, 9);
    // ρ = 0.5 is the break-even point, where the correction changes nothing.
    expect(expectedMaxExcessSharpeByChance(7, 70, 0.5)).toBeCloseTo(expectedMaxSharpeByChance(7, 70), 9);
    // A rule that moves with its benchmark gets a LOWER bar — this is the whole
    // point: the raw bar is the wrong scale for an excess Sharpe.
    expect(expectedMaxExcessSharpeByChance(7, 70, 0.9)).toBeLessThan(expectedMaxSharpeByChance(7, 70));
    // A rule that IS its benchmark has no excess to find, so nothing is luck.
    expect(expectedMaxExcessSharpeByChance(10, 1000, 1)).toBeCloseTo(0, 9);
    expect(expectedMaxExcessSharpeByChance(10, 1000, 2)).toBeCloseTo(0, 9);
    // Out-of-range ρ is clamped, and an unmeasurable one falls back to the
    // conservative (wider) bar rather than silently flattering the result.
    expect(expectedMaxExcessSharpeByChance(10, 1000, -2)).toBeCloseTo(
      expectedMaxExcessSharpeByChance(10, 1000, -1),
      9
    );
    expect(expectedMaxExcessSharpeByChance(10, 1000, NaN)).toBeCloseTo(raw * Math.SQRT2, 9);
    expect(expectedMaxExcessSharpeByChance(0, 1000, 0.9)).toBe(0);
  });
});

describe("simulateRegime", () => {
  const bars = makeBars(300, 0.0006, 0.01, 11);
  const frame = { open: bars.map((b) => b.open), close: bars.map((b) => b.close) };

  it("a score that never reaches entry never trades and stays flat", () => {
    const scores = new Array(bars.length).fill(40);
    const r = simulateRegime(scores, frame, 65, 35, { commissionBps: 0, slippageBps: 0 });
    expect(r.trades).toBe(0);
    expect(r.totalReturnPct).toBeCloseTo(0, 10);
    expect(r.exposurePct).toBe(0);
    expect(r.sharpe).toBe(0);
  });

  it("a score that is always above entry is buy & hold minus the round-trip costs", () => {
    const scores = new Array(bars.length).fill(80);
    const free = simulateRegime(scores, frame, 65, 35, { commissionBps: 0, slippageBps: 0 });
    // Fills at bar 1's open, closes at the final close.
    const expected = (bars[bars.length - 1].close / bars[1].open - 1) * 100;
    expect(free.totalReturnPct).toBeCloseTo(expected, 6);
    expect(free.trades).toBe(1);
    expect(free.exposurePct).toBeGreaterThan(99);

    const costly = simulateRegime(scores, frame, 65, 35, { commissionBps: 10, slippageBps: 10 });
    expect(costly.totalReturnPct).toBeLessThan(free.totalReturnPct);
  });

  it("hysteresis: a score inside the band keeps the state it already had", () => {
    // Starts at 80 (in), then sits at 50 forever (between exit 35 and entry 65).
    const inside = [80, 80, ...new Array(bars.length - 2).fill(50)];
    const r = simulateRegime(inside, frame, 65, 35, { commissionBps: 0, slippageBps: 0 });
    expect(r.trades).toBe(1);
    expect(r.exposurePct).toBeGreaterThan(99);

    // Starts at 50 (out) and never reaches entry: no trade at all.
    const outside = new Array(bars.length).fill(50);
    expect(simulateRegime(outside, frame, 65, 35).trades).toBe(0);
  });

  it("cannot look ahead: editing future scores never changes earlier equity", () => {
    const scores = bars.map((_, i) => 50 + 30 * Math.sin(i / 9));
    const base = simulateRegime(scores, frame, 65, 35, { commissionBps: 2, slippageBps: 2 });
    const tampered = scores.map((s, i) => (i >= 150 ? 100 : s));
    const after = simulateRegime(tampered, frame, 65, 35, { commissionBps: 2, slippageBps: 2 });
    for (let i = 0; i < 150; i++) {
      expect(after.equity[i]).toBeCloseTo(base.equity[i], 12);
    }
    // …and the tampering really did change the later path.
    expect(after.equity[after.equity.length - 1]).not.toBeCloseTo(base.equity[base.equity.length - 1], 6);
  });

  it("carries the benchmark series, and a fully invested rule correlates with it", () => {
    const always = simulateRegime(new Array(bars.length).fill(80), frame, 65, 35, {
      commissionBps: 0,
      slippageBps: 0,
    });
    expect(always.benchmarkEquity.length).toBe(always.equity.length);
    // Holding the stock the whole window means the rule's returns ARE the
    // benchmark's — the case where an excess Sharpe is nearly deterministic and a
    // raw-Sharpe luck bar would be far too forgiving.
    expect(ruleBenchmarkCorrelation([always])).toBeGreaterThan(0.9);

    // A rule that never trades has zero return variance, so the correlation is
    // unmeasurable: the helper must say 0 (conservative), not 1 (flattering).
    const flat = simulateRegime(new Array(bars.length).fill(40), frame, 65, 35);
    expect(flat.benchmarkEquity.length).toBe(flat.equity.length);
    expect(ruleBenchmarkCorrelation([flat])).toBe(0);
  });

  it("respects the window bounds", () => {
    const scores = new Array(bars.length).fill(90);
    const r = simulateRegime(scores, frame, 65, 35, { commissionBps: 0, slippageBps: 0 }, { from: 100, to: 200 });
    expect(r.bars).toBe(100);
    expect(r.equity.length).toBe(100);
    expect(r.trades).toBe(1);
  });
});

describe("objectiveValue", () => {
  // Minimal RegimeResult shape the objective reads: strategy stats plus the
  // buy & hold of the same window.
  const fake = (trades: number, sharpe: number, dd = 10, benchSharpe = 0, benchDD = 0) =>
    ({ trades, sharpe, maxDrawdownPct: dd, benchmarkSharpe: benchSharpe, benchmarkMaxDrawdownPct: benchDD }) as never;

  it("refuses a configuration that cannot trade on half the universe", () => {
    // Three of four symbols never clear the 4-trade floor.
    const res = [fake(1, 3), fake(1, 3), fake(1, 3), fake(9, 0.4)];
    expect(objectiveValue(res, 4).value).toBe(-Infinity);
    // Half the universe clearing it is enough to be ranked.
    const half = [fake(1, 3), fake(1, 3), fake(9, 0.4), fake(9, 0.4)];
    expect(Number.isFinite(objectiveValue(half, 4).value)).toBe(true);
  });

  it("averages the Sharpe of the symbols that cleared the floor", () => {
    const res = [fake(5, 1.0), fake(5, 0.5), fake(1, 9)];
    const { value, validSymbols } = objectiveValue(res, 4, 0);
    expect(validSymbols).toBe(2);
    expect(value).toBeCloseTo(0.75, 9);
  });

  it("penalizes drawdown and rewards beating buy & hold", () => {
    const shallow = objectiveValue([fake(5, 1, 5)], 4, 0.5).value;
    const deep = objectiveValue([fake(5, 1, 40)], 4, 0.5).value;
    expect(shallow).toBeGreaterThan(deep);
    // A rule that stays fully invested earns exactly buy & hold: no credit.
    expect(objectiveValue([fake(5, 0.8, 20, 0.8, 20)], 4, 0.5).value).toBeCloseTo(0, 9);
    // Cutting the drawdown while keeping the Sharpe is worth something.
    expect(objectiveValue([fake(5, 0.8, 10, 0.8, 20)], 4, 0.5).value).toBeGreaterThan(0);
  });
});

describe("weights and distribution helpers", () => {
  it("normalizeWeights sums to 100 and drops zeros", () => {
    const w = normalizeWeights({ a: 4, b: 4, c: 0, d: 2 });
    expect(w.c).toBeUndefined();
    const total = Object.values(w).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(100, 6);
    expect(w.a).toBeCloseTo(40, 6);
  });

  it("shareMap maps a weight map onto the frame's ids only", () => {
    const frame = fakeFrame("X", 60);
    const shares = shareMap([frame], { "ta-rsi-14": 3, "ta-cci-20": 1, "ta-mom-63": 0, "ta-unknown": 99 });
    expect(shares["ta-rsi-14"]).toBeCloseTo(0.75, 9);
    expect(shares["ta-cci-20"]).toBeCloseTo(0.25, 9);
    expect(shares["ta-unknown"]).toBeUndefined(); // not in the frame → never counted
    // An id the map omits keeps the app's default weight for that indicator.
    const withDefault = shareMap([frame], { "ta-rsi-14": 3, "ta-cci-20": 1 });
    expect(withDefault["ta-mom-63"]).toBeCloseTo(4 / 8, 9);
  });

  it("scoreDistribution reports the window's percentiles", () => {
    const scores = Array.from({ length: 101 }, (_, i) => i);
    const d = scoreDistribution(scores);
    expect(d.p50).toBe(50);
    expect(d.p10).toBe(10);
    expect(d.p90).toBe(90);
    expect(d.bars).toBe(101);
  });
});

describe("prepareFrame", () => {
  it("builds causal score series for the trainable specs", () => {
    const bars = makeBars(400);
    const frame = prepareFrame("TEST", bars);
    expect(frame.ids.length).toBeGreaterThan(20);
    // The kernel legs ARE trainable now: the engine computes them with a trailing
    // window (ta.kernelTrend), so a backtest can reproduce the live reading. What
    // matters is that they are causal — pinned by the truncation check below.
    expect(frame.ids).toContain("ta-kernel-slope");
    const cut = 300;
    const truncated = computeMegaScoreSeries({
      high: bars.slice(0, cut + 1).map((b) => b.high),
      low: bars.slice(0, cut + 1).map((b) => b.low),
      close: bars.slice(0, cut + 1).map((b) => b.close),
      volume: bars.slice(0, cut + 1).map((b) => b.volume),
      open: bars.slice(0, cut + 1).map((b) => b.open),
    });
    const full = computeMegaScoreSeries({
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      close: bars.map((b) => b.close),
      volume: bars.map((b) => b.volume),
      open: bars.map((b) => b.open),
    });
    for (const id of ["ta-kernel-slope", "ta-kernel-residual"]) {
      const before = full.indicators[id][cut];
      const after = truncated.indicators[id][cut];
      expect(Number.isFinite(after), `${id} has no reading at the cut`).toBe(true);
      expect(after, `${id} changed when the future was cut — it looks ahead`).toBeCloseTo(before, 10);
    }
    const rsi = frame.scores["ta-rsi-14"];
    expect(rsi.length).toBe(400);
    expect(Number.isNaN(rsi[3])).toBe(true); // warm-up
    expect(Number.isFinite(rsi[300])).toBe(true);
    for (const v of rsi) if (Number.isFinite(v)) expect(v >= 0 && v <= 100).toBe(true);
  });
});

// ─── A planted edge the search has to find ─────────────────────
// A hand-built frame: one indicator knows the next 5-day return, two others are
// pure noise. A weight search that works must put the weight on the informative
// indicator and beat the prior out of sample. The "edge" is genuinely present in
// the frame's scores, so this tests the search, not the market.

function fakeFrame(symbol: string, n: number): CalibrationFrame {
  const bars = makeBars(n, 0.0004, 0.012, 21);
  const rand = rng(99);
  const informative = new Array<number>(n).fill(50);
  const noiseA = new Array<number>(n).fill(50);
  const noiseB = new Array<number>(n).fill(50);
  for (let i = 0; i < n - 5; i++) {
    const fwd = bars[Math.min(n - 1, i + 5)].close / bars[i].close - 1;
    informative[i] = fwd > 0 ? 85 : 20;
    noiseA[i] = 20 + rand() * 65;
    noiseB[i] = 20 + rand() * 65;
  }
  return {
    symbol,
    dates: bars.map((b) => b.date),
    open: bars.map((b) => b.open),
    close: bars.map((b) => b.close),
    scores: { "ta-rsi-14": informative, "ta-cci-20": noiseA, "ta-mom-63": noiseB },
    ids: ["ta-rsi-14", "ta-cci-20", "ta-mom-63"],
    defaults: { "ta-rsi-14": 20, "ta-cci-20": 3, "ta-mom-63": 4 },
  };
}

describe("trainMegaWeights", () => {
  const prior = { "ta-rsi-14": 20, "ta-cci-20": 3, "ta-mom-63": 4 };
  // Needs enough bars for a usable train/test split (splitIndex floor is 60).
  const frames = [fakeFrame("EDGE", 900), fakeFrame("EDGE2", 900)];

  const result = trainMegaWeights(frames, prior, {
    entry: 60,
    exit: 40,
    passes: 2,
    minTrades: 3,
    shrink: 0.001,
  });

  it("puts the weight on the indicator that actually knows the future", () => {
    const rsi = result.weights["ta-rsi-14"] ?? 0;
    const noise = (result.weights["ta-cci-20"] ?? 0) + (result.weights["ta-mom-63"] ?? 0);
    expect(rsi).toBeGreaterThan(noise);
  });

  it("beats the prior on the training window and keeps it out of sample", () => {
    const priorRun = result.variants.find((v) => v.key === "prior")!;
    const tuned = result.variants.find((v) => v.key === "tuned")!;
    expect(tuned.train.meanSharpe).toBeGreaterThan(priorRun.train.meanSharpe);
    expect(tuned.test.meanSharpe).toBeGreaterThan(priorRun.test.meanSharpe);
  });

  it("reports both windows, the trial count and a luck bar", () => {
    expect(result.variants.map((v) => v.key)).toEqual(["prior", "equal", "bands-only", "weights-only", "tuned"]);
    expect(result.trials).toBeGreaterThan(1);
    expect(result.luckSharpe).toBeGreaterThan(0);
    // The bar the objective is judged against, plus the correlation that
    // separates it from the raw one.
    expect(result.luckExcessSharpe).toBeGreaterThanOrEqual(0);
    expect(result.luckExcessSharpe).toBeLessThanOrEqual(result.luckSharpe * Math.SQRT2 + 1e-9);
    expect(result.returnCorrelation).toBeGreaterThanOrEqual(-1);
    expect(result.returnCorrelation).toBeLessThanOrEqual(1);
    // The warning text has to name the bar that decides, or the diagnostic is
    // reported but never used.
    expect(result.warnings.some((w) => w.includes("EXCESS"))).toBe(true);
    expect(result.trainTo < result.dateTo).toBe(true);
    expect(result.distribution.train.bars).toBeGreaterThan(0);
    expect(result.distribution.test.bars).toBeGreaterThan(0);
    for (const v of result.variants) {
      expect(Number.isFinite(v.train.meanSharpe)).toBe(true);
      expect(v.perSymbol.length).toBe(frames.length);
      expect(v.curve.length).toBeGreaterThan(1);
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("is deterministic — the same frames give the same answer", () => {
    const again = trainMegaWeights(frames, prior, {
      entry: 60,
      exit: 40,
      passes: 2,
      minTrades: 3,
      shrink: 0.001,
    });
    expect(again.weights).toEqual(result.weights);
    expect(again.tuned).toEqual(result.tuned);
  });

  it("never leaves the 0-100 band the score is defined on", () => {
    for (const v of result.variants) {
      expect(v.entry).toBeGreaterThan(v.exit);
      expect(v.entry).toBeLessThanOrEqual(100);
      expect(v.exit).toBeGreaterThanOrEqual(0);
    }
  });

  it("the search units cover the SMA/EMA family once, not sixteen times", () => {
    const maUnits = SEARCH_UNITS.filter((u) => u.ids.some((id) => id.startsWith("ta-sma-")));
    expect(maUnits.length).toBe(1);
    expect(maUnits[0].ids.length).toBe(16);
    // No indicator is searched by two different axes.
    const seen = new Set<string>();
    for (const u of SEARCH_UNITS) {
      for (const id of u.ids) {
        expect(seen.has(id), `${id} appears in two search units`).toBe(false);
        seen.add(id);
      }
    }
  });

  it("refuses an empty frame set", () => {
    expect(() => trainMegaWeights([], prior)).toThrow(/nothing to train on/i);
  });

  it("defaults to the options the UI shows", () => {
    expect(DEFAULT_TRAINING_OPTIONS.trainFraction).toBe(0.7);
    expect(DEFAULT_TRAINING_OPTIONS.searchBands).toBe(true);
    expect(DEFAULT_TRAINING_OPTIONS.entryGrid.every((e) => DEFAULT_TRAINING_OPTIONS.exitGrid.some((x) => e - x >= 10))).toBe(true);
  });
});
