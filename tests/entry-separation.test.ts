import { describe, expect, it } from "vitest";
import { collectEntryOutcomes, summarizeEntrySeparation } from "../src/lib/mega-calibration";

/**
 * Two completed round trips:
 *  - entry signal at bar 2 on a score of 70, price 100 → exit at 110  (winner)
 *  - entry signal at bar 7 on a score of 56, price 110 → exit at 100  (loser)
 * No position is open when the window ends.
 */
const SCORES = [50, 50, 70, 70, 70, 40, 40, 56, 56, 56, 40, 40, 50, 50];
const PRICES = [100, 100, 100, 100, 105, 110, 110, 110, 110, 105, 100, 100, 100, 100];
const FRAME = { open: PRICES, close: PRICES };
const FREE = { commissionBps: 0, slippageBps: 0 };
const WINDOW = { from: 0, to: SCORES.length };

describe("entry-reading separation", () => {
  it("tags each completed trade with the reading on its signal bar", () => {
    const { wins, losses } = collectEntryOutcomes(SCORES, FRAME, 55, 45, { window: WINDOW, costs: FREE });
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(wins[0].score).toBe(70);
    expect(wins[0].returnPct).toBeCloseTo(10, 5);
    expect(losses[0].score).toBe(56);
    expect(losses[0].returnPct).toBeCloseTo((100 / 110 - 1) * 100, 5);
    expect(wins[0].bars).toBe(3);
    expect(losses[0].bars).toBe(3);
  });

  it("reports a full separation when winners were entered higher", () => {
    const { wins, losses } = collectEntryOutcomes(SCORES, FRAME, 55, 45, { window: WINDOW, costs: FREE });
    const sep = summarizeEntrySeparation(wins, losses);
    expect(sep.trades).toBe(2);
    expect(sep.losers).toBe(1);
    expect(sep.lossRatePct).toBe(50);
    expect(sep.meanEntryWinners).toBe(70);
    expect(sep.meanEntryLosers).toBe(56);
    expect(sep.gap).toBe(14);
    expect(sep.auc).toBe(1);
  });

  it("reports no separation when both trades were entered at the same reading", () => {
    const scores = [...SCORES];
    scores[7] = 70; // loser now also enters on a 70 reading
    const { wins, losses } = collectEntryOutcomes(scores, FRAME, 55, 45, { window: WINDOW, costs: FREE });
    const sep = summarizeEntrySeparation(wins, losses);
    expect(sep.trades).toBe(2);
    expect(sep.gap).toBe(0);
    expect(sep.auc).toBe(0.5);
  });

  it("ignores a position still open at the window's end", () => {
    const scores = [...SCORES];
    scores[10] = 70; // no exit signal, so the second trade is still open
    scores[11] = 70;
    const { wins, losses } = collectEntryOutcomes(scores, FRAME, 55, 45, { window: WINDOW, costs: FREE });
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(0);
    const sep = summarizeEntrySeparation(wins, losses);
    expect(sep.trades).toBe(1);
    expect(sep.auc).toBeNull(); // one-sided sample
    expect(sep.gap).toBeNull();
  });

  it("returns a neutral, empty summary when nothing completed", () => {
    const sep = summarizeEntrySeparation([], []);
    expect(sep.trades).toBe(0);
    expect(sep.lossRatePct).toBe(0);
    expect(sep.gap).toBeNull();
    expect(sep.auc).toBeNull();
  });

  it("charges costs the same way the calibration simulator does", () => {
    const { wins } = collectEntryOutcomes(SCORES, FRAME, 55, 45, {
      window: WINDOW,
      costs: { commissionBps: 100, slippageBps: 0 },
    });
    // 1% entry commission shrinks the position, 1% exit commission shrinks the
    // proceeds: 1.1 * 0.99 / 1.01 − 1 ≈ 7.82% on a 10% move.
    expect(wins[0].returnPct).toBeLessThan(10);
    expect(wins[0].returnPct).toBeCloseTo((1.1 * 0.99) / 1.01 * 100 - 100, 5);
  });
});
