import { describe, it, expect } from "vitest";
import {
  simulateCore,
  resolveCosts,
  type BacktestConfig,
  type ResolvedCosts,
} from "../src/lib/backtest-engine";
import type { Bar } from "../src/lib/market-data";
import { getStrategy, type StrategyDef } from "../src/lib/strategies";

// ─── Helpers ────────────────────────────────────────────────────
const META = { symbol: "TEST", name: "Test Corp", currency: "USD", exchange: "SYNTH" };
const STRATEGY = getStrategy("buy_hold") as StrategyDef;

function makeBars(closes: number[]): Bar[] {
  // open = prior close (flat gaps), high/low bracket open & close.
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      open,
      high: Math.max(open, c) + 0.5,
      low: Math.min(open, c) - 0.5,
      close: c,
      volume: 1_000_000,
    };
  });
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: "TEST",
    strategyId: "buy_hold",
    initialCapital: 10_000,
    years: 1,
    commissionBps: 0,
    slippageBps: 0,
    positionPct: 100,
    params: {},
    ...overrides,
  };
}

function run(closes: number[], overrides: Partial<BacktestConfig> = {}) {
  const config = baseConfig(overrides);
  const costs = resolveCosts(config);
  return simulateCore(makeBars(closes), META, "cache", STRATEGY, costs, config, false);
}

// ─── Buy & hold accounting (exact math) ─────────────────────────
describe("simulateCore: buy & hold accounting", () => {
  it("buys at bar 1's open and tracks equity with the close", () => {
    // closes: 100 → 110. Bar 1 open = 100 (no slippage, no commission).
    const out = run([100, 105, 110]);
    expect(out.summary.finalEquity).toBeCloseTo(10_000 * (110 / 100), 6);
    expect(out.summary.totalReturnPct).toBeCloseTo(10, 6);
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].entryPrice).toBeCloseTo(100, 6);
    expect(out.trades[0].shares).toBe(100);
    expect(out.trades[0].reason).toBe("end-of-test");
  });

  it("applies commission to both sides of the trade", () => {
    // 100 bps = 1% per side. Buy at 100: shares = floor(10000 / (100*1.01)) = 99
    // gross = 9900, cash spent = 9900*1.01 = 9999 → $1 left over.
    // Exit at 110: proceeds = 99*110 = 10890, fee 108.90 → cash 1 + 10890 - 108.90
    const out = run([100, 110], { commissionBps: 100 });
    expect(out.trades[0].shares).toBe(99);
    expect(out.summary.finalEquity).toBeCloseTo(10_782.10, 2);
  });

  it("applies slippage adversely on entry; end-of-test close is marked at market", () => {
    // 100 bps = 1% slippage: buy at 101, shares = floor(10000/101) = 99 → $1 left over.
    // The final forced exit fills at the raw close (marked to market, no slippage).
    const out = run([100, 110], { slippageBps: 100 });
    expect(out.trades[0].entryPrice).toBeCloseTo(101, 6);
    expect(out.trades[0].exitPrice).toBeCloseTo(110, 6);
    expect(out.summary.finalEquity).toBeCloseTo(1 + 99 * 110, 6);
  });

  it("respects positionPct sizing (rest stays in cash)", () => {
    // 50% deployed: 5000 at price 100 → 50 shares, final = 50*110 + 5000 cash
    const out = run([100, 105, 110], { positionPct: 50 });
    expect(out.trades[0].shares).toBe(50);
    expect(out.summary.finalEquity).toBeCloseTo(50 * 110 + 5_000, 6);
  });

  it("never buys fractional shares", () => {
    const out = run([333.33, 333.33, 333.34]); // 10000/333.33 ≈ 30.0003 → 30 shares
    expect(out.trades[0].shares).toBe(30);
  });

  it("equity curve matches final equity and benchmark is indexed to 100", () => {
    const out = run([100, 120, 90, 110]);
    const last = out.equityCurve[out.equityCurve.length - 1];
    expect(last.equity).toBeCloseTo(out.summary.finalEquity, 6);
    expect(last.benchmark).toBeCloseTo(110, 6);
    expect(out.equityCurve[0].benchmark).toBeCloseTo(120 / 100 * 100, 6);
  });
});

// ─── Risk exits ─────────────────────────────────────────────────
describe("simulateCore: stop-loss and take-profit", () => {
  it("exits at the stop when price falls through it intrabar", () => {
    // Entry at open=100. Stop 10% → 90. Bar 2: low 80 touches the stop.
    const closes = [100, 100, 95];
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], low: 80, close: 95, high: 96 };
    const config = baseConfig({ stopLossPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("stop-loss");
    expect(out.trades[0].exitPrice).toBeCloseTo(90, 6);
  });

  it("fills at the (gapped) open when price gaps below the stop", () => {
    const closes = [100, 100, 70]; // bar 2 opens at 100 prior close? no: open = closes[1] = 100... 
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], open: 70, high: 75, low: 65, close: 72 };
    const config = baseConfig({ stopLossPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("stop-loss");
    expect(out.trades[0].exitPrice).toBeCloseTo(70, 6); // min(stop, open)
  });

  it("exits at the target price on take-profit", () => {
    const closes = [100, 100, 105];
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], high: 120, close: 115 };
    const config = baseConfig({ takeProfitPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("take-profit");
    expect(out.trades[0].exitPrice).toBeCloseTo(110, 6); // entry * 1.10
  });
});

// ─── Drawdown & metrics sanity ──────────────────────────────────
describe("simulateCore: metrics", () => {
  it("computes max drawdown from peak equity", () => {
    // 100 → 120 (equity 12000) → 90 (equity 9000): DD = 25%
    const out = run([100, 120, 90, 95]);
    expect(out.summary.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("win rate & profit factor reflect the single forced exit", () => {
    const out = run([100, 110]);
    expect(out.summary.totalTrades).toBe(1);
    expect(out.summary.winRate).toBe(100);
    expect(out.summary.profitFactor).toBeGreaterThan(90); // no losses → capped at 99
  });

  it("time in market is 100% for buy & hold", () => {
    const out = run([100, 110, 120]);
    expect(out.summary.timeInMarketPct).toBeCloseTo(100, 6);
  });

  it("benchmark return matches price return", () => {
    const out = run([100, 110, 125]);
    expect(out.summary.benchmarkReturnPct).toBeCloseTo(25, 6);
  });

  it("monthly returns chain back to total return", () => {
    const bars = Array.from({ length: 70 }, (_, i) => {
      const c = 100 * (1 + i * 0.01);
      return {
        date: i < 31 ? `2024-01-${String(i + 1).padStart(2, "0")}` : `2024-03-${String(i - 30).padStart(2, "0")}`,
        open: i === 0 ? c : 100 * (1 + (i - 1) * 0.01),
        high: c + 1, low: c - 1, close: c, volume: 1e6,
      };
    });
    const config = baseConfig();
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.monthlyReturns.length).toBeGreaterThanOrEqual(2);
    const chained = out.monthlyReturns.reduce((acc, m) => acc * (1 + m.ret / 100), 1);
    expect(chained).toBeCloseTo(out.summary.finalEquity / 10_000, 4);
  });
});

// ─── Input validation ───────────────────────────────────────────
describe("resolveCosts", () => {
  it("clamps nonsense values into sane ranges", () => {
    const r = resolveCosts({
      ...baseConfig(),
      initialCapital: -5,
      commissionBps: 5000,
      slippageBps: -10,
      positionPct: 0,
      years: 100,
    });
    expect(r.initialCapital).toBe(1000);
    expect(r.commissionBps).toBe(100);
    expect(r.slippageBps).toBe(0);
    expect(r.positionPct).toBe(1);
    expect(r.years).toBe(30);
  });

  it("applies documented defaults", () => {
    const r = resolveCosts({ ...baseConfig(), initialCapital: 0, positionPct: undefined as unknown as number });
    expect(r.initialCapital).toBe(100000);
    expect(r.positionPct).toBe(100);
  });
});

// ─── An active strategy end-to-end ──────────────────────────────
describe("simulateCore: SMA crossover strategy", () => {
  it("produces round-trip trades with consistent accounting", () => {
    const smaCross = getStrategy("sma_cross") as StrategyDef;
    // Series engineered to cross: rally then crash
    const closes = [
      ...Array(30).fill(0).map((_, i) => 100 + i),        // up
      ...Array(30).fill(0).map((_, i) => 129 - i * 2),    // down
    ];
    const bars = makeBars(closes);
    const config = baseConfig({ strategyId: "sma_cross", params: { fast: 5, slow: 20 } });
    const costs: ResolvedCosts = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", smaCross, costs, config, false);

    expect(out.summary.totalTrades).toBeGreaterThanOrEqual(1);
    // Every closed trade must have coherent math: pnl = proceeds - cost - fees
    for (const t of out.trades) {
      if (t.exitDate !== null) {
        const gross = t.shares * (t.exitPrice ?? 0);
        const cost = t.shares * t.entryPrice;
        expect(t.returnPct).toBeCloseTo(((gross - cost) / cost) * 100, 6);
      }
    }
    // Cash conservation: final equity = initial + sum of trade P&L
    const totalPnl = out.trades.reduce((s, t) => s + t.pnl, 0);
    expect(out.summary.finalEquity).toBeCloseTo(10_000 + totalPnl, 4);
  });
});
