// Exit reachability: a band is only an exit if the signal can actually reach it.
//
// This is the measurement behind the run-time warning added in Oct 2026. On the
// cached universe 70/25 fires on ~0.0-0.1 % of sessions, and a 10+ bar smoothing
// window makes 25 unreachable — a run that looks like a strategy but cannot sell.

import { describe, it, expect } from "vitest";
import { exitReachability, smoothsScore } from "../src/lib/backtest-engine";

describe("exitReachability", () => {
  it("counts the sessions below the exit and reports the lowest reading", () => {
    const signal = [NaN, 60, 50, 40, 30, 20, 70];
    const r = exitReachability(signal, 45);
    expect(r.readings).toBe(6);
    expect(r.below).toBe(3); // 40, 30, 20
    expect(r.share).toBeCloseTo(0.5, 10);
    expect(r.min).toBe(20);
  });

  it("treats a reading exactly on the band as held, not sold", () => {
    // The rule exits strictly BELOW its band, so 25 is still a hold.
    const r = exitReachability([25, 25, 25], 25);
    expect(r.below).toBe(0);
    expect(r.share).toBe(0);
    expect(r.min).toBe(25);
  });

  it("reports an unreachable band for what it is", () => {
    const r = exitReachability([70, 72, 68, 75], 25);
    expect(r.readings).toBe(4);
    expect(r.below).toBe(0);
    expect(r.share).toBe(0);
    expect(r.min).toBe(68);
  });

  it("ignores warm-up bars instead of counting them as readings", () => {
    const r = exitReachability([NaN, NaN, Infinity, 50, 30], 40);
    expect(r.readings).toBe(2);
    expect(r.below).toBe(1);
    expect(r.min).toBe(30);
  });

  it("returns a neutral result when nothing has a reading yet", () => {
    const r = exitReachability([NaN, NaN], 25);
    expect(r.readings).toBe(0);
    expect(r.share).toBe(0);
    expect(r.min).toBeNaN();
  });
});

describe("smoothsScore", () => {
  it("is the single rule for which strategies read the smoothed composite", () => {
    expect(smoothsScore("mega_score")).toBe(true);
    expect(smoothsScore("mega_score_fast")).toBe(true);
    expect(smoothsScore("buy_hold")).toBe(false);
    expect(smoothsScore("sma_cross")).toBe(false);
  });
});
