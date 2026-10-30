import { describe, expect, it } from "vitest";
import { optimizerAxes } from "../src/lib/backtest-engine";
import { getStrategy } from "../src/lib/strategies";

describe("optimizer axes", () => {
  it("sweeps the Mega Score bands, not the research gates", () => {
    const strategy = getStrategy("mega_score");
    expect(strategy).toBeDefined();
    const axes = optimizerAxes(strategy!);
    expect(axes.x.key).toBe("entry");
    expect(axes.y.key).toBe("exit");
    const keys = [axes.x.key, axes.y.key, axes.z?.key].filter(Boolean);
    // The gate params declare a 0-400 / 1-20 range; without the sweep flag they
    // would outrank the 10-90 bands and replace the optimization's subject.
    expect(keys).not.toContain("trendMa");
    expect(keys).not.toContain("confirm");
  });

  it("keeps sweeping the fast rule's own tuning params", () => {
    const axes = optimizerAxes(getStrategy("mega_score_fast")!);
    expect(axes.x.key).toBeTruthy();
    expect([axes.x.key, axes.y.key]).not.toContain("trendMa");
  });

  it("refuses a strategy with nothing sweepable", () => {
    expect(() => optimizerAxes(getStrategy("buy_hold")!)).toThrow(/no sweepable parameters/i);
  });
});
