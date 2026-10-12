// The Mega Score time series is what the backtest regime filter, the price-chart
// overlay and mega-history plot, so the reading at bar i must depend only on bars
// 0..i. These tests pin that for the oscillators added with the newest workbook
// export (Williams %R and Stochastic RSI) as well as for the composite itself.

import { describe, it, expect } from "vitest";
import { computeMegaScoreSeries } from "../src/lib/mega-score";

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
