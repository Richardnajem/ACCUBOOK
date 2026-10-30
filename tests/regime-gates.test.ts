import { describe, expect, it } from "vitest";
import { megaRegimePosition } from "../src/lib/strategies";

/** 200 bars so a 200-day SMA is defined for the trend-filter cases. */
const flatClose = (n: number, value = 100) => new Array(n).fill(value);

/** Score that crosses 70 on bar 100 and holds; exits below 25 never happen. */
function scoreSeries(n = 260, crossAt = 100, value = 72) {
  return Array.from({ length: n }, (_, i) => (i >= crossAt ? value : 50));
}

describe("megaRegimePosition entry gates", () => {
  it("keeps the shipped behaviour when no gates are passed", () => {
    const score = scoreSeries();
    const pos = megaRegimePosition(score, 70, 25);
    expect(pos[99]).toBe(0);
    expect(pos[100]).toBe(1); // first reading at/above the band buys
    expect(pos[259]).toBe(1);
  });

  it("waits for N consecutive readings before buying", () => {
    const score = scoreSeries();
    const pos = megaRegimePosition(score, 70, 25, { confirmDays: 3 });
    expect(pos[100]).toBe(0);
    expect(pos[101]).toBe(0);
    expect(pos[102]).toBe(1); // third reading at/above 70
  });

  it("does not confirm when a reading dips back under the band", () => {
    const score = scoreSeries();
    score[101] = 65; // dip resets the streak
    const pos = megaRegimePosition(score, 70, 25, { confirmDays: 3 });
    expect(pos[102]).toBe(0);
    expect(pos[103]).toBe(0); // 65 is still inside the 3-bar window
    expect(pos[104]).toBe(1); // first window with three readings at/above 70
  });

  it("blocks entries below the trend SMA and allows them above it", () => {
    // Falling then recovering close: the 20-day SMA is above price on bar 120.
    const close = Array.from({ length: 260 }, (_, i) => (i < 120 ? 120 - i * 0.5 : 60 + (i - 120) * 0.2));
    const score = scoreSeries(260, 100, 72);

    const blocked = megaRegimePosition(score, 70, 25, { trendMa: 20, close });
    expect(blocked[120]).toBe(0); // score is ready but price is under its SMA

    const above = megaRegimePosition(score, 70, 25, { trendMa: 20, close: flatClose(260, 100) });
    expect(above[100]).toBe(1); // price sits on its SMA
  });

  it("leaves exits ungated: the score still sells below the exit band", () => {
    const score = scoreSeries(260, 100, 72);
    score[200] = 10;
    const pos = megaRegimePosition(score, 70, 25, {
      confirmDays: 5,
      trendMa: 20,
      close: flatClose(260, 100),
    });
    expect(pos[199]).toBe(1);
    expect(pos[200]).toBe(0);
  });

  it("gates only entries: a confirmed position is not re-confirmed each bar", () => {
    const score = scoreSeries();
    score[150] = 71;
    const pos = megaRegimePosition(score, 70, 25, { confirmDays: 3 });
    expect(pos[150]).toBe(1);
  });
});
