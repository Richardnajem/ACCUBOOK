// Both mega strategies trade the SMOOTHED composite, so both must LOG the
// smoothed reading on the signal bar.
//
// Regression: the engine smoothed `mega_score` only. A `mega_score_fast` run
// therefore recorded the raw score on each trade while the Excel export wrote a
// smoothed "signal" column for the same bar — two numbers for one decision.

import { describe, it, expect } from "vitest";
import type { Bar } from "../src/lib/market-data";
import {
  simulateCore,
  resolveCosts,
  type BacktestConfig,
} from "../src/lib/backtest-engine";
import { getStrategy, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { sma } from "../src/lib/ta";

const META = { symbol: "TEST", name: "Test Corp", currency: "USD", exchange: "TEST" };

function makeBars(n: number): Bar[] {
  let seed = 20261030;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = Math.max(1, open + Math.sin(i / 9) * 2.4 + (rnd() - 0.5) * 1.6);
    const high = Math.max(open, close) + rnd() * 1.2;
    const low = Math.min(open, close) - rnd() * 1.2;
    const d = new Date(Date.UTC(2020, 0, 1 + i));
    bars.push({
      date: d.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: 900_000 + rnd() * 400_000,
    });
    px = close;
  }
  return bars;
}

function config(params: Record<string, number>): BacktestConfig {
  return {
    symbol: "TEST",
    strategyId: "mega_score_fast",
    initialCapital: 100_000,
    years: 5,
    commissionBps: 2,
    slippageBps: 2,
    positionPct: 100,
    params,
  };
}

describe("mega_score_fast logs the smoothed score it actually trades", () => {
  const bars = makeBars(700);
  const close = bars.map((b) => b.close);
  const score = computeMegaScoreSeries({
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close,
    volume: bars.map((b) => b.volume),
  }).score;
  const smooth5 = sma(score, 5);

  // velMin 0 / no trail keeps this a pure band test: every entry is caused by
  // the smoothed score, which is what the assertion is about.
  const params = { entry: 50, exit: 40, smooth: 5, velWindow: 5, velMin: 0, trailAtr: 0, atrPeriod: 14 };
  const cfg = config(params);
  const strategy = getStrategy("mega_score_fast") as StrategyDef;
  const out = simulateCore(bars, META, "cache", strategy, resolveCosts(cfg), cfg, true);
  const index = new Map(bars.map((b, i) => [b.date, i]));

  it("produces at least one trade to annotate", () => {
    expect(out.trades.length).toBeGreaterThan(0);
  });

  it("records the smoothed reading on the signal bar (not the raw score)", () => {
    let checked = 0;
    for (const t of out.trades) {
      const i = index.get(t.entryDate);
      expect(i, `entry ${t.entryDate} is a real bar`).toBeTypeOf("number");
      expect(t.entryScore).toBeCloseTo(Math.round(smooth5[i! - 1] * 10) / 10, 6);
      // And that reading is what the entry gate checked.
      expect(smooth5[i! - 1]).toBeGreaterThanOrEqual(50);
      if (t.exitDate) {
        const x = index.get(t.exitDate);
        expect(t.exitScore).toBeCloseTo(Math.round(smooth5[x! - 1] * 10) / 10, 6);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("differs from the raw composite somewhere, so the fix is observable", () => {
    const anyDifference = out.trades.some((t) => {
      const i = index.get(t.entryDate)!;
      return Math.abs((t.entryScore ?? 0) - Math.round(score[i - 1] * 10) / 10) > 0.05;
    });
    expect(anyDifference).toBe(true);
  });
});
