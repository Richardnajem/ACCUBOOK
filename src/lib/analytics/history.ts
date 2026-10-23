// ─── Portfolio history from the trade ledger + cached price bars ────────────
//
// Why this is a *return* series rather than a dollar equity curve:
// the cached Yahoo bars are split- and dividend-adjusted closes, i.e. a total
// return index per symbol — not the price level that was on screen in 2015.
// Valuing 2015 holdings at an adjusted price would invent a P&L that never
// happened. So the history is built as a flow-free total-return index
// ("growth of 100"), and dollar figures elsewhere come from the live snapshot.
//
// Daily portfolio return:
//   r_t = Σ w_{i,t−1} · r_{i,t} − fees_t / V_{t−1}
// where w are share-weighted portfolio weights, r_i is each symbol's adjusted
// close return, and fees are the ledger's commission rows. Deposits and
// withdrawals change weights (cash is an asset with zero return) but never the
// return itself — that is what makes this a time-weighted measure.
//
// Price levels are anchored at each symbol's first purchase price so that the
// weights are on a real dollar scale; the drift between that anchored level and
// the true historical close is the dividend reinvestment, which is exactly the
// total-return convention being applied. Dividend cash rows are therefore NOT
// added again (they are already inside the adjusted return).

import type { Trade } from "../db";
import type { DatedReturn, DatedValue } from "./returns";

export interface BarLite {
  date: string;
  close: number;
}

export interface HistoryResult {
  /** Flow-free daily total returns, first date = second valuation date. */
  daily: DatedReturn[];
  /** Growth of 100 from the first valuation date. */
  levels: DatedValue[];
  /** Each symbol's adjusted close normalised to 100 at the first shared date. */
  symbolSeries: Record<string, DatedValue[]>;
  symbolsUsed: string[];
  missingSymbols: string[];
  startDate: string | null;
  endDate: string | null;
  warnings: string[];
}

interface LedgerState {
  shares: Map<string, number>;
  cash: number;
}

/**
 * Build the daily portfolio return index.
 *
 * `bars` must be sorted ascending by date. Symbols without any bars are
 * reported in `missingSymbols` and excluded from the index — the caller shows
 * which ones so the user can refresh their price history.
 */
export function buildPortfolioHistory(
  trades: Trade[],
  bars: Record<string, BarLite[]>,
): HistoryResult {
  const warnings: string[] = [];
  const symbolsUsed: string[] = [];
  const missingSymbols: string[] = [];

  const buySymbols = [...new Set(trades.filter((t) => t.type === "buy" && t.symbol).map((t) => t.symbol as string))].sort();
  const usableBars: Record<string, BarLite[]> = {};
  for (const sym of buySymbols) {
    const list = (bars[sym] ?? []).filter((b) => b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (list.length >= 2) {
      usableBars[sym] = list;
      symbolsUsed.push(sym);
    } else {
      missingSymbols.push(sym);
    }
  }
  if (missingSymbols.length > 0) {
    warnings.push(`No cached daily history for ${missingSymbols.join(", ")} — excluded from performance and risk.`);
  }
  if (symbolsUsed.length === 0) {
    return {
      daily: [],
      levels: [],
      symbolSeries: {},
      symbolsUsed,
      missingSymbols,
      startDate: null,
      endDate: null,
      warnings: [...warnings, "No price history available for any holding."],
    };
  }

  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const firstTradeDate = sortedTrades.find((t) => t.type === "buy" || t.type === "deposit")?.date ?? sortedTrades[0]?.date;

  // Calendar of valuation dates: union of every used symbol's bar dates.
  const dateSet = new Set<string>();
  for (const sym of symbolsUsed) for (const b of usableBars[sym]) {
    if (!firstTradeDate || b.date >= firstTradeDate) dateSet.add(b.date);
  }
  const dates = [...dateSet].sort();
  if (dates.length < 2) {
    return {
      daily: [],
      levels: [],
      symbolSeries: {},
      symbolsUsed,
      missingSymbols,
      startDate: dates[0] ?? null,
      endDate: dates[0] ?? null,
      warnings: [...warnings, "Less than two valuation dates after the first trade."],
    };
  }

  // Anchors: first purchase price per symbol, snapped to the nearest bar on or
  // after the purchase date (a buy on a weekend has no bar of its own).
  const anchors = new Map<string, { price: number; date: string }>();
  for (const sym of symbolsUsed) {
    const firstBuy = sortedTrades.find((t) => t.type === "buy" && t.symbol === sym && t.price);
    if (!firstBuy || !firstBuy.price) {
      warnings.push(`${sym}: no purchase price in the ledger — weight anchored at its first cached close.`);
      const b = usableBars[sym][0];
      anchors.set(sym, { price: b.close, date: b.date });
      continue;
    }
    const snapped = usableBars[sym].find((b) => b.date >= firstBuy.date) ?? usableBars[sym][0];
    anchors.set(sym, { price: firstBuy.price, date: snapped.date });
  }

  const barIndex: Record<string, Map<string, number>> = {};
  const lastPrice: Record<string, number> = {};
  for (const sym of symbolsUsed) {
    const map = new Map<string, number>();
    for (const b of usableBars[sym]) map.set(b.date, b.close);
    barIndex[sym] = map;
    lastPrice[sym] = anchors.get(sym)!.price;
  }

  // Synthetic price level for a symbol on a date: anchor price × total return
  // since the anchor date. Flat until the symbol's first bar.
  const priceAt = (sym: string, date: string): number | null => {
    const map = barIndex[sym];
    const anchor = anchors.get(sym)!;
    const anchorAdj = map.get(anchor.date);
    const today = map.get(date);
    if (today === undefined) {
      // No bar on this date: use the most recent price we have seen.
      return lastPrice[sym] ?? null;
    }
    if (anchorAdj === undefined || anchorAdj <= 0) return today;
    return (anchor.price * today) / anchorAdj;
  };

  const state: LedgerState = { shares: new Map(), cash: 0 };
  let tradeIdx = 0;
  const feeByDate = new Map<string, number>();

  // Pre-apply trades dated before the first valuation date.
  const applyTradesThrough = (date: string) => {
    while (tradeIdx < sortedTrades.length && sortedTrades[tradeIdx].date <= date) {
      const t = sortedTrades[tradeIdx++];
      const fees = t.fees ?? 0;
      // A trade on a non-valuation date accrues its fee on the next date it can
      // be seen; fees dated exactly today are applied today.
      if (fees !== 0) feeByDate.set(date, (feeByDate.get(date) ?? 0) + fees);
      switch (t.type) {
        case "buy":
          if (!t.symbol || !t.shares || !t.price) break;
          state.shares.set(t.symbol, (state.shares.get(t.symbol) ?? 0) + t.shares);
          state.cash -= t.shares * t.price + fees;
          break;
        case "sell":
          if (!t.symbol || !t.shares) break;
          state.shares.set(t.symbol, Math.max(0, (state.shares.get(t.symbol) ?? 0) - t.shares));
          state.cash += t.shares * (t.price ?? 0) - fees;
          break;
        case "deposit":
          state.cash += t.price ?? 0;
          break;
        case "withdrawal":
          state.cash -= t.price ?? 0;
          break;
        case "fee":
          state.cash -= t.price ?? 0;
          // A standalone fee row is a real cost with no offsetting cost basis,
          // so it belongs in the day's return, not only in the cash balance.
          if (t.price) feeByDate.set(date, (feeByDate.get(date) ?? 0) + t.price);
          break;
        case "dividend":
          // Deliberately ignored: total return is already in the adjusted close.
          break;
      }
    }
  };

  // Total portfolio value on a date, using the shares held at end of the prior
  // date and today's synthetic prices.
  const valueWithShares = (shares: Map<string, number>, date: string): number => {
    let total = state.cash;
    for (const [sym, qty] of shares) {
      if (qty <= 0) continue;
      const p = priceAt(sym, date);
      if (p !== null) total += qty * p;
    }
    return total;
  };

  const prevShares = new Map<string, number>();
  let prevValue: number | null = null;
  let prevCash = 0;
  let level = 100;
  const levels: DatedValue[] = [];
  const daily: DatedReturn[] = [];
  let prevDate: string | null = null;

  for (const date of dates) {
    // Consume every trade dated on or before this valuation date. Trades on a
    // weekend land on the next trading day, and their fees land with them.
    applyTradesThrough(date);

    // Today's return is earned by *yesterday's* holdings and yesterday's cash;
    // trades executed today change tomorrow's weights, not today's return.
    // Fees are already debited from cash, so they are NOT subtracted again
    // here — doing both would charge the same commission twice.
    const feesToday = feeByDate.get(date) ?? 0;
    feeByDate.delete(date);

    if (prevDate !== null && prevValue !== null && prevValue > 0) {
      let holdingsValueToday = 0;
      for (const [sym, qty] of prevShares) {
        if (qty <= 0) continue;
        const p = priceAt(sym, date);
        if (p !== null) holdingsValueToday += qty * p;
      }
      const net = (holdingsValueToday + prevCash) / prevValue - 1;
      const bounded = Math.max(-1, net);
      daily.push({ date, ret: bounded });
      level *= 1 + bounded;
      levels.push({ date, value: level });
    } else {
      levels.push({ date, value: level });
    }

    // Roll the ledger forward: today's trades are already in `state`.
    prevShares.clear();
    for (const [sym, qty] of state.shares) prevShares.set(sym, qty);
    // On the anchor date the index is pinned at 100, so a commission paid that
    // day would be swallowed by the anchor. Re-add it to the baseline instead:
    // the next day's return then carries the drag exactly once.
    prevValue = valueWithShares(state.shares, date) + (prevDate === null ? feesToday : 0);
    prevCash = state.cash;
    prevDate = date;
  }

  const symbolSeries: Record<string, DatedValue[]> = {};
  for (const sym of symbolsUsed) {
    const base = usableBars[sym].find((b) => b.date >= (firstTradeDate ?? dates[0]));
    if (!base || base.close <= 0) continue;
    symbolSeries[sym] = usableBars[sym]
      .filter((b) => b.date >= base.date)
      .map((b) => ({ date: b.date, value: (b.close / base.close) * 100 }));
  }

  if (state.cash < 0) {
    warnings.push(
      "The ledger's cash balance is negative (buys without a recorded deposit). Returns are still time-weighted, but add the funding deposit so money-weighted return is meaningful.",
    );
  }

  return {
    daily,
    levels,
    symbolSeries,
    symbolsUsed,
    missingSymbols,
    startDate: levels[0]?.date ?? null,
    endDate: levels[levels.length - 1]?.date ?? null,
    warnings,
  };
}
