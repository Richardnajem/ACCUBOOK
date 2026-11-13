import { describe, it, expect } from "vitest";
import { buildPortfolio, enrichWithQuotes, type PortfolioSnapshot } from "../src/lib/portfolio";
import type { Trade } from "../src/lib/db";

let nextId = 1;
function trade(partial: Partial<Trade> & { type: Trade["type"] }): Trade {
  return {
    id: nextId++,
    date: "2024-06-01",
    symbol: null,
    shares: null,
    price: null,
    fees: 0,
    notes: null,
    created_at: "2024-06-01T00:00:00.000Z",
    ...partial,
  };
}

// ─── Positions & FIFO ───────────────────────────────────────────
describe("buildPortfolio: buys and FIFO sells", () => {
  it("opens a position with cost basis including fees", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, fees: 10 }),
    ]);
    const p = snap.positions[0];
    expect(p.shares).toBe(10);
    expect(p.costBasis).toBe(1010); // 10*100 + 10 fees
    expect(p.avgCost).toBeCloseTo(101, 10);
    expect(p.firstBuyDate).toBe("2024-06-01");
  });

  it("sells the oldest lot first (FIFO)", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, date: "2024-01-01" }),
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 200, date: "2024-02-01" }),
      trade({ type: "sell", symbol: "AAPL", shares: 12, price: 300, date: "2024-03-01" }),
    ]);
    const p = snap.positions[0];
    expect(p.shares).toBe(8);
    // Sold 10 @100 + 2 @200 = 1400 matched cost; remaining lot: 8 @200 = 1600
    expect(p.costBasis).toBe(1600);
    expect(p.avgCost).toBe(200);
    // Realized = 12*300 - 1400 = 2200
    expect(p.realized).toBeCloseTo(2200, 10);
  });

  it("closes the position and records it in closedPositions when fully sold", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "MSFT", shares: 5, price: 100 }),
      trade({ type: "sell", symbol: "MSFT", shares: 5, price: 120 }),
    ]);
    // A fully-exited symbol is kept with shares = 0 but must not appear in open positions
    const open = snap.positions.find((p) => p.symbol === "MSFT" && p.shares > 0);
    expect(open).toBeUndefined();
    const closed = snap.closedPositions.find((p) => p.symbol === "MSFT");
    expect(closed).toBeDefined();
    expect(closed!.shares).toBe(0);
    expect(closed!.realized).toBeCloseTo(100, 10); // 5*120 - 5*100
  });

  it("realized P&L nets out sell fees", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "TSLA", shares: 10, price: 50 }),
      trade({ type: "sell", symbol: "TSLA", shares: 10, price: 60, fees: 25 }),
    ]);
    expect(snap.closedPositions[0].realized).toBeCloseTo(75, 10); // 600 - 25 - 500
  });

  it("realized P&L also carries the buy fee of the shares sold", () => {
    // 20 @ 100 with a 10 fee = 5/share of fee. Selling 5 @ 120 (2 fee) realizes
    // 600 - 2 - (500 + 2.50) = 95.50 — not 98, which would have left the whole
    // buy fee with the 15 shares still held.
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "AMD", shares: 20, price: 100, fees: 10 }),
      trade({ type: "sell", symbol: "AMD", shares: 5, price: 120, fees: 2 }),
    ]);
    expect(snap.positions[0].realized).toBeCloseTo(95.5, 10);
    expect(snap.positions[0].shares).toBe(15);
    // The remaining lot still holds its own 7.50 of the buy fee.
    expect(snap.positions[0].costBasis).toBeCloseTo(1507.5, 10);
    expect(snap.positions[0].avgCost).toBeCloseTo(100.5, 10);
    expect(snap.cash.fees).toBeCloseTo(12, 10);
  });

  it("keeps avg cost stable across partial sells (fee allocated per share)", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "KO", shares: 25, price: 60, fees: 1 }),
      trade({ type: "sell", symbol: "KO", shares: 7, price: 70, fees: 1 }),
      trade({ type: "sell", symbol: "KO", shares: 3, price: 80, fees: 1 }),
    ]);
    const p = snap.positions[0];
    expect(p.shares).toBe(15);
    expect(p.avgCost).toBeCloseTo(60.04, 10);
    expect(p.costBasis).toBeCloseTo(15 * 60.04, 10);
  });

  it("an empty lot leaves no cost residue behind", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "GLD", shares: 3, price: 100, fees: 1 }),
      trade({ type: "sell", symbol: "GLD", shares: 3, price: 110, fees: 1 }),
    ]);
    const p = snap.closedPositions[0];
    expect(p.shares).toBe(0);
    expect(p.costBasis).toBe(0);
    expect(p.avgCost).toBe(0);
    expect(p.realized).toBeCloseTo(28, 10); // 330 - 1 sell fee - 300 - 1 buy fee
  });

  it("ignores oversells beyond held shares (resilient replay)", () => {
    const snap = buildPortfolio([
      trade({ type: "buy", symbol: "NVDA", shares: 5, price: 100 }),
      trade({ type: "sell", symbol: "NVDA", shares: 50, price: 120 }),
    ]);
    const p = snap.closedPositions[0];
    expect(p.shares).toBe(0);
    expect(p.realized).toBeCloseTo(5 * 120 - 5 * 100, 10); // only 5 matched
  });

  it("processes trades in date order regardless of input order", () => {
    const snap = buildPortfolio([
      trade({ type: "sell", symbol: "KO", shares: 4, price: 60, date: "2024-03-01" }),
      trade({ type: "buy", symbol: "KO", shares: 4, price: 50, date: "2024-01-01" }),
    ]);
    expect(snap.closedPositions[0].realized).toBeCloseTo(40, 10);
  });
});

// ─── Cash ledger ────────────────────────────────────────────────
describe("buildPortfolio: cash ledger", () => {
  it("tracks deposits, withdrawals, dividends and fees in the balance", () => {
    const snap = buildPortfolio([
      trade({ type: "deposit", price: 10_000 }),
      trade({ type: "withdrawal", price: 1_000 }),
      trade({ type: "dividend", symbol: "SPY", price: 100 }),
      trade({ type: "fee", price: 50 }),
    ]);
    expect(snap.cashBalance).toBeCloseTo(9_050, 10);
    expect(snap.totals.invested).toBe(9_000);
    expect(snap.totals.dividends).toBe(100);
    expect(snap.totals.fees).toBe(50);
  });

  it("buys reduce cash and sells add proceeds", () => {
    const snap = buildPortfolio([
      trade({ type: "deposit", price: 10_000, date: "2024-01-01" }),
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, fees: 5, date: "2024-01-02" }),
      trade({ type: "sell", symbol: "AAPL", shares: 10, price: 120, fees: 5, date: "2024-01-03" }),
    ]);
    // 10000 - 1000 - 5 + 1200 - 5 = 10190
    expect(snap.cashBalance).toBeCloseTo(10_190, 10);
  });

  it("realized + unrealized + dividends equals the total return (fees included)", () => {
    // The identity the three P&L figures have to satisfy. Before buy fees were
    // allocated to the sold shares, realized came out gross of them and this
    // failed by exactly those fees.
    const snap = enrichWithQuotes(
      buildPortfolio([
        trade({ type: "deposit", symbol: null, price: 50_000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "AAPL", shares: 100, price: 150, fees: 7, date: "2024-01-02" }),
        trade({ type: "buy", symbol: "MSFT", shares: 20, price: 300, fees: 5, date: "2024-02-01" }),
        trade({ type: "sell", symbol: "AAPL", shares: 40, price: 190, fees: 6, date: "2024-03-01" }),
        trade({ type: "dividend", symbol: "MSFT", price: 22, date: "2024-04-01" }),
      ]),
      {
        AAPL: { price: 200, change: 1, changePercent: 0.5, name: null, currency: "USD" },
        MSFT: { price: 320, change: -2, changePercent: -0.6, name: null, currency: "USD" },
      },
    ).snapshot;
    const t = snap.totals;
    expect(t.realized + t.unrealized + t.dividends).toBeCloseTo(t.totalReturn, 6);
  });

  it("a standalone fee is the only thing between the P&L parts and total return", () => {
    // Trade fees live inside realized/unrealized; a cash `fee` event does not, so
    // it is the one line that makes the three parts add up short of the total.
    const snap = enrichWithQuotes(
      buildPortfolio([
        trade({ type: "deposit", price: 10_000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "SPY", shares: 10, price: 100, fees: 4, date: "2024-01-02" }),
        trade({ type: "sell", symbol: "SPY", shares: 4, price: 120, fees: 2, date: "2024-02-01" }),
        trade({ type: "dividend", symbol: "SPY", price: 5, date: "2024-03-01" }),
        trade({ type: "fee", price: 3, date: "2024-04-01" }),
      ]),
      { SPY: { price: 130, change: 0, changePercent: 0, name: null, currency: "USD" } },
    ).snapshot;
    const t = snap.totals;
    expect(t.realized + t.unrealized + t.dividends - 3).toBeCloseTo(t.totalReturn, 6);
  });

  it("attributes dividends per symbol and to cash", () => {
    const snap = buildPortfolio([
      trade({ type: "dividend", symbol: "SPY", price: 78.6 }),
      trade({ type: "dividend", symbol: "AAPL", price: 24.5 }),
    ]);
    expect(snap.positions.find((p) => p.symbol === "SPY")!.dividends).toBeCloseTo(78.6, 10);
    expect(snap.totals.dividends).toBeCloseTo(103.1, 10);
  });
});

// ─── Quote enrichment ───────────────────────────────────────────
describe("enrichWithQuotes", () => {
  const base = (): PortfolioSnapshot =>
    buildPortfolio([
      trade({ type: "deposit", price: 10_000, date: "2024-01-01" }),
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, date: "2024-01-02" }),
      trade({ type: "buy", symbol: "MSFT", shares: 5, price: 200, date: "2024-01-02" }),
    ]);

  it("computes market value, unrealized P&L and weights", () => {
    const { snapshot, quoted } = enrichWithQuotes(base(), {
      AAPL: { price: 150, change: 1, changePercent: 0.7, name: "Apple", currency: "USD" },
      MSFT: { price: 180, change: -2, changePercent: -1.1, name: "Microsoft", currency: "USD" },
    });
    const aapl = quoted.find((p) => p.symbol === "AAPL")!;
    const msft = quoted.find((p) => p.symbol === "MSFT")!;
    expect(aapl.marketValue).toBe(1500);
    expect(aapl.unrealized).toBe(500);
    expect(aapl.unrealizedPct).toBeCloseTo(50, 10);
    expect(msft.unrealized).toBe(-100);
    // Weight is the share of TOTAL EQUITY (cash included) — same unit as the
    // allocation donut: mv 2400, cash 8000, equity 10400.
    expect(aapl.weightPct).toBeCloseTo((1500 / 10_400) * 100, 6);
    expect(msft.weightPct).toBeCloseTo((900 / 10_400) * 100, 6);
    const cashShare = (8_000 / 10_400) * 100;
    expect(aapl.weightPct + msft.weightPct + cashShare).toBeCloseTo(100, 6);
    expect(snapshot.totals.marketValue).toBe(2400);
    expect(snapshot.totals.unrealized).toBe(400);
    // cash: 10000 - (10*100) - (5*200) = 8000; equity = 2400 + 8000
    expect(snapshot.cashBalance).toBeCloseTo(8_000, 10);
    expect(snapshot.totals.equity).toBeCloseTo(10_400, 10);
    expect(snapshot.totals.totalReturn).toBeCloseTo(400, 10);
    expect(snapshot.totals.totalReturnPct).toBeCloseTo(4, 10);
  });

  it("day change is per-share change × shares, summed across positions", () => {
    const { snapshot, quoted } = enrichWithQuotes(base(), {
      AAPL: { price: 150, change: 2, changePercent: 1.3, name: null, currency: "USD" },
      MSFT: { price: 180, change: -1, changePercent: -0.5, name: null, currency: "USD" },
    });
    expect(quoted[0].dayChange + quoted[1].dayChange).toBeCloseTo(2 * 10 - 1 * 5, 10);
    expect(snapshot.totals.dayChange).toBeCloseTo(15, 10);
  });

  it("values an unquoted position at cost but marks it unpriced", () => {
    const { snapshot, quoted } = enrichWithQuotes(base(), {
      AAPL: { price: 150, change: 0, changePercent: 0, name: null, currency: "USD" },
    });
    const msft = quoted.find((p) => p.symbol === "MSFT")!;
    expect(msft.priced).toBe(false);
    expect(msft.lastPrice).toBeNull();
    expect(msft.marketValue).toBe(1000); // cost placeholder, labelled "at cost"
    expect(msft.unrealized).toBe(0);
    expect(msft.dayChange).toBe(0);
    expect(snapshot.totals.marketValue).toBe(2500);
    expect(snapshot.totals.unpricedCount).toBe(1);
    expect(snapshot.totals.unpricedValue).toBe(1000);
  });

  it("never treats a zero or non-finite quote price as a market price", () => {
    // A feed that answers with 0 used to value the position at $0 and report a
    // −100 % loss as if it were real.
    const { snapshot, quoted } = enrichWithQuotes(base(), {
      AAPL: { price: 0, change: 0, changePercent: 0, name: null, currency: "USD" },
      MSFT: { price: Number.NaN, change: 0, changePercent: 0, name: null, currency: "USD" },
    });
    for (const p of quoted) {
      expect(p.priced).toBe(false);
      expect(p.lastPrice).toBeNull();
      expect(p.unrealized).toBe(0);
    }
    expect(snapshot.totals.unrealized).toBe(0);
    expect(snapshot.totals.unpricedCount).toBe(2);
    expect(snapshot.totals.marketValue).toBe(2000); // both at cost, not 0
    expect(quoted.every((p) => p.dayChangePct === 0)).toBe(true);
  });

  it("handles an empty portfolio without NaNs", () => {
    const snap = buildPortfolio([]);
    const { snapshot, quoted } = enrichWithQuotes(snap, {});
    expect(quoted).toHaveLength(0);
    expect(snapshot.totals.marketValue).toBe(0);
    expect(snapshot.totals.totalReturnPct).toBe(0);
    expect(Number.isNaN(snapshot.totals.equity)).toBe(false);
  });
});
