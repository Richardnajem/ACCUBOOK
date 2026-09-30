// Portfolio engine: turns a raw trade ledger into holdings, cost basis,
// realized/unrealized P&L and portfolio analytics.
//
// Rules:
// - Buys create tax lots (FIFO matching on sells).
// - Sells reduce the oldest lots first and realize P&L.
// - Dividends and fees are cash events; deposits/withdrawals move the cash
//   ledger without affecting positions.
// - No shorting: a sell that exceeds held shares is rejected upstream.

import type { Trade } from "./db";

export interface Lot {
  symbol: string;
  shares: number;
  price: number;      // per-share cost
  date: string;
  remaining: number;
}

export interface Position {
  symbol: string;
  shares: number;          // currently held
  avgCost: number;         // per-share average cost (net of fees)
  costBasis: number;       // total cost incl. buy fees
  realized: number;        // cumulative realized P&L (net of sell fees)
  dividends: number;       // cumulative dividends received
  firstBuyDate: string | null;
}

export interface CashLedger {
  deposits: number;
  withdrawals: number;
  dividends: number;
  fees: number;
  realized: number;
  buyCosts: number;      // cash spent on buys (excl. fees)
  sellProceeds: number;  // cash received from sells (excl. fees)
}

export interface PortfolioSnapshot {
  positions: Position[];
  closedPositions: Position[]; // symbols fully exited (realized history)
  cash: CashLedger;
  cashBalance: number;
  totals: {
    marketValue: number;
    costBasis: number;
    unrealized: number;
    realized: number;
    dividends: number;
    fees: number;
    equity: number;          // marketValue + cashBalance
    invested: number;        // deposits - withdrawals
    totalReturn: number;     // equity - invested
    totalReturnPct: number;
    dayChange: number;       // sum of quote.change
  };
}

export function buildPortfolio(trades: Trade[]): PortfolioSnapshot {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const lotMap = new Map<string, Lot[]>();
  const meta = new Map<string, Position>();
  const cash: CashLedger = { deposits: 0, withdrawals: 0, dividends: 0, fees: 0, realized: 0, buyCosts: 0, sellProceeds: 0 };

  const ensure = (symbol: string): Position => {
    let m = meta.get(symbol);
    if (!m) {
      m = {
        symbol, shares: 0, avgCost: 0, costBasis: 0,
        realized: 0, dividends: 0, firstBuyDate: null,
      };
      meta.set(symbol, m);
    }
    return m;
  };

  for (const t of sorted) {
    switch (t.type) {
      case "deposit": cash.deposits += t.price ?? 0; break;
      case "withdrawal": cash.withdrawals += t.price ?? 0; break;
      case "dividend": {
        const amt = t.price ?? 0;
        cash.dividends += amt;
        if (t.symbol) ensure(t.symbol).dividends += amt;
        break;
      }
      case "fee": {
        const amt = t.price ?? 0;
        cash.fees += amt;
        break;
      }
      case "buy": {
        if (!t.symbol || !t.shares || !t.price) break;
        const fees = t.fees ?? 0;
        const lots = lotMap.get(t.symbol) ?? [];
        lots.push({
          symbol: t.symbol, shares: t.shares, price: t.price,
          date: t.date, remaining: t.shares,
        });
        lotMap.set(t.symbol, lots);
        const p = ensure(t.symbol);
        p.shares += t.shares;
        p.costBasis += t.shares * t.price + fees;
        p.avgCost = p.shares > 0 ? p.costBasis / p.shares : 0;
        if (!p.firstBuyDate) p.firstBuyDate = t.date;
        cash.buyCosts += t.shares * t.price;
        cash.fees += fees;
        break;
      }
      case "sell": {
        if (!t.symbol || !t.shares || !t.price) break;
        let remaining = t.shares;
        const lots = lotMap.get(t.symbol) ?? [];
        let matchedCost = 0;
        let matchedShares = 0;
        for (const lot of lots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.remaining, remaining);
          if (take > 0) {
            matchedCost += take * lot.price;
            matchedShares += take;
            lot.remaining -= take;
            remaining -= take;
          }
        }
        // Resilient replay: if the ledger has a sell dated before its buy
        // (or an oversell), only the matched shares count. The API validates
        // sells on insert; this keeps historical/bad data from corrupting math.
        if (matchedShares > 0) {
          cash.sellProceeds += matchedShares * t.price;
          const realized = matchedShares * t.price - (t.fees ?? 0) - matchedCost;
          const p = ensure(t.symbol);
          p.realized += realized;
          cash.realized += realized;
          p.shares -= matchedShares;
          p.costBasis -= matchedCost;
          p.avgCost = p.shares > 0 ? p.costBasis / p.shares : 0;
          cash.fees += t.fees ?? 0;
          if (p.shares < 0) p.shares = 0;
        }
        break;
      }
    }
  }

  const positions = [...meta.values()]
    .filter((p) => p.shares > 0 || p.realized !== 0 || p.dividends !== 0)
    .sort((a, b) => b.costBasis - a.costBasis);

  const open = positions.filter((p) => p.shares > 0);
  const closed = positions.filter((p) => p.shares <= 0);

  const cashBalance =
    cash.deposits - cash.withdrawals + cash.dividends - cash.fees
    - cash.buyCosts + cash.sellProceeds;

  const totals = {
    marketValue: 0,       // filled by caller with live quotes
    costBasis: open.reduce((s, p) => s + p.costBasis, 0),
    unrealized: 0,        // filled by caller
    realized: cash.realized,
    dividends: cash.dividends,
    fees: cash.fees,
    equity: 0,            // filled by caller
    invested: cash.deposits - cash.withdrawals,
    totalReturn: 0,       // filled by caller
    totalReturnPct: 0,    // filled by caller
    dayChange: 0,         // filled by caller
  };

  return { positions, closedPositions: closed, cash, cashBalance, totals };
}

// ─── Live enrichment ────────────────────────────────────────────
export interface QuotedPosition extends Position {
  lastPrice: number | null;
  marketValue: number;
  unrealized: number;
  unrealizedPct: number;
  dayChange: number;
  dayChangePct: number;
  weightPct: number;
}

export interface EnrichedPortfolio {
  snapshot: PortfolioSnapshot;
  quoted: QuotedPosition[];
  quotes: Record<string, { price: number; change: number; changePercent: number; name: string | null; currency: string }>;
  errors: Record<string, string>;
}

export function enrichWithQuotes(
  snapshot: PortfolioSnapshot,
  quotes: Record<string, { price: number; change: number; changePercent: number; name: string | null; currency: string }>,
  errors: Record<string, string> = {},
): EnrichedPortfolio {
  const quoted: QuotedPosition[] = snapshot.positions.map((p) => {
    const q = quotes[p.symbol];
    const lastPrice = q?.price ?? null;
    const marketValue = lastPrice != null ? p.shares * lastPrice : p.costBasis; // fallback to cost
    const unrealized = lastPrice != null ? marketValue - p.costBasis : 0;
    return {
      ...p,
      lastPrice,
      marketValue,
      unrealized,
      unrealizedPct: p.costBasis > 0 ? (unrealized / p.costBasis) * 100 : 0,
      dayChange: q ? (q.change ?? 0) * p.shares : 0,
      dayChangePct: q?.changePercent ?? 0,
      weightPct: 0, // filled below
    };
  });

  const totalMv = quoted.reduce((s, p) => s + p.marketValue, 0);
  for (const p of quoted) {
    p.weightPct = totalMv > 0 ? (p.marketValue / totalMv) * 100 : 0;
  }

  const marketValue = quoted.reduce((s, p) => s + p.marketValue, 0);
  const dayChange = quoted.reduce((s, p) => s + p.dayChange, 0);
  const equity = marketValue + snapshot.cashBalance;
  const invested = snapshot.totals.invested;

  snapshot.totals.marketValue = marketValue;
  snapshot.totals.unrealized = quoted.reduce((s, p) => s + p.unrealized, 0);
  snapshot.totals.equity = equity;
  snapshot.totals.totalReturn = equity - invested;
  snapshot.totals.totalReturnPct = invested > 0 ? ((equity - invested) / invested) * 100 : 0;
  snapshot.totals.dayChange = dayChange;

  return { snapshot, quoted, quotes, errors };
}
