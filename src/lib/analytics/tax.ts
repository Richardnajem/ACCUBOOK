// ─── Tax lots, realized gains and harvesting ────────────────────────────────
//
// FIFO by default (the ledger already matches sells FIFO, so the tax view
// agrees with the holdings view); average cost is offered as an alternative
// because several jurisdictions require it. A sell whose shares exceed the open
// lots only realises the matched part — same resilience rule as portfolio.ts.
//
// Holding period uses > 365 calendar days for long-term (US convention). This
// is a reporting aid, not tax advice: jurisdiction rules differ and no rate is
// applied here.

import type { Trade } from "../db";
import { addDays, daysBetween } from "./stats";

export type CostBasisMethod = "fifo" | "average";

export interface OpenLot {
  symbol: string;
  acquired: string;
  shares: number;
  remaining: number;
  costPerShare: number;
  tradeId: number;
}

export interface RealizedGain {
  symbol: string;
  acquired: string;
  sold: string;
  shares: number;
  proceeds: number;
  costBasis: number;
  gain: number;
  holdingDays: number;
  term: "short" | "long";
  sellTradeId: number;
}

export interface WashSaleFlag {
  symbol: string;
  sold: string;
  lossAmount: number;
  repurchaseDate: string;
  daysApart: number;
  reason: string;
}

export interface TaxYearSummary {
  year: number;
  shortTermGain: number;
  longTermGain: number;
  netGain: number;
  proceeds: number;
  costBasis: number;
  trades: number;
  dividends: number;
}

export interface TaxReport {
  method: CostBasisMethod;
  openLots: OpenLot[];
  realized: RealizedGain[];
  washSales: WashSaleFlag[];
  years: TaxYearSummary[];
  warnings: string[];
}

export function buildTaxReport(trades: Trade[], method: CostBasisMethod = "fifo"): TaxReport {
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const warnings: string[] = [];
  const lotsBySymbol = new Map<string, OpenLot[]>();
  const avg = new Map<string, { shares: number; costBasis: number }>();
  const realized: RealizedGain[] = [];

  for (const t of sorted) {
    if (t.type === "buy" && t.symbol && t.shares && t.price) {
      const cost = t.shares * t.price + (t.fees ?? 0);
      const list = lotsBySymbol.get(t.symbol) ?? [];
      list.push({
        symbol: t.symbol,
        acquired: t.date,
        shares: t.shares,
        remaining: t.shares,
        costPerShare: cost / t.shares,
        tradeId: t.id,
      });
      lotsBySymbol.set(t.symbol, list);
      const a = avg.get(t.symbol) ?? { shares: 0, costBasis: 0 };
      a.shares += t.shares;
      a.costBasis += cost;
      avg.set(t.symbol, a);
    } else if (t.type === "sell" && t.symbol && t.shares) {
      let remaining = t.shares;
      const list = lotsBySymbol.get(t.symbol) ?? [];
      const fee = t.fees ?? 0;
      let matched = 0;
      let proceedsTotal = 0;
      let costTotal = 0;

      if (method === "average") {
        const a = avg.get(t.symbol);
        if (a && a.shares > 0) {
          const take = Math.min(remaining, a.shares);
          const perShare = a.costBasis / a.shares;
          // Realised FIFO dates for reporting: consume lots in order, but value
          // them at the average cost per share.
          let toConsume = take;
          for (const lot of list) {
            if (toConsume <= 0) break;
            const used = Math.min(lot.remaining, toConsume);
            if (used > 0) {
              lot.remaining -= used;
              toConsume -= used;
              realized.push({
                symbol: t.symbol,
                acquired: lot.acquired,
                sold: t.date,
                shares: used,
                proceeds: used * (t.price ?? 0) - (fee * used) / take,
                costBasis: used * perShare,
                gain: used * (t.price ?? 0) - used * perShare,
                holdingDays: daysBetween(lot.acquired, t.date),
                term: daysBetween(lot.acquired, t.date) > 365 ? "long" : "short",
                sellTradeId: t.id,
              });
            }
          }
          a.shares -= take;
          a.costBasis -= take * perShare;
          matched = take;
          proceedsTotal = take * (t.price ?? 0);
          costTotal = take * perShare;
          remaining -= take;
        }
      } else {
        for (const lot of list) {
          if (remaining <= 0) break;
          const take = Math.min(lot.remaining, remaining);
          if (take <= 0) continue;
          const proceeds = take * (t.price ?? 0);
          const cost = take * lot.costPerShare;
          lot.remaining -= take;
          remaining -= take;
          matched += take;
          proceedsTotal += proceeds;
          costTotal += cost;
          const days = daysBetween(lot.acquired, t.date);
          realized.push({
            symbol: t.symbol,
            acquired: lot.acquired,
            sold: t.date,
            shares: take,
            proceeds,
            costBasis: cost,
            gain: proceeds - cost,
            holdingDays: days,
            term: days > 365 ? "long" : "short",
            sellTradeId: t.id,
          });
        }
      }

      if (matched > 0) {
        // Fees are realised against the matched shares only.
        const last = realized.filter((r) => r.sellTradeId === t.id && r.sold === t.date);
        if (fee > 0 && last.length > 0) {
          const share = fee / matched;
          for (const r of last) {
            r.proceeds -= share * r.shares;
            r.gain -= share * r.shares;
          }
        }
      }
      if (remaining > 0) {
        warnings.push(
          `${t.symbol}: sell of ${t.shares} shares on ${t.date} exceeded open lots by ${remaining}; only matched shares are realised.`,
        );
      }
    }
  }

  const openLots: OpenLot[] = [];
  for (const list of lotsBySymbol.values()) {
    for (const lot of list) if (lot.remaining > 0.000001) openLots.push(lot);
  }
  openLots.sort((a, b) => a.acquired.localeCompare(b.acquired));

  for (const r of realized) {
    // Average-cost branch already netted fees per slice; FIFO branch netted the
    // whole sell fee above, so nothing else to do.
    if (!Number.isFinite(r.gain)) warnings.push(`${r.symbol}: non-finite realised gain on ${r.sold}.`);
  }

  // ── Wash sales: a loss sale with a purchase of the same symbol within 30
  // calendar days before or after. Flagged, not adjusted — the disallowed
  // amount depends on jurisdiction and on replacement-lot matching order.
  const washSales: WashSaleFlag[] = [];
  const buys = sorted.filter((t) => t.type === "buy" && t.symbol);
  for (const r of realized) {
    if (r.gain >= 0) continue;
    const near = buys
      .filter((b) => b.symbol === r.symbol && b.date !== r.sold)
      .map((b) => ({ date: b.date, apart: daysBetween(r.sold, b.date) }))
      .filter((b) => Math.abs(b.apart) <= 30)
      .sort((a, b) => Math.abs(a.apart) - Math.abs(b.apart))[0];
    if (!near) continue;
    washSales.push({
      symbol: r.symbol,
      sold: r.sold,
      lossAmount: r.gain,
      repurchaseDate: near.date,
      daysApart: near.apart,
      reason: near.apart < 0 ? "purchased within 30 days before the loss sale" : "purchased within 30 days after the loss sale",
    });
  }

  // ── Per-tax-year summary, including dividends dated by payment.
  const yearMap = new Map<number, TaxYearSummary>();
  const getYear = (year: number) => {
    let v = yearMap.get(year);
    if (!v) {
      v = { year, shortTermGain: 0, longTermGain: 0, netGain: 0, proceeds: 0, costBasis: 0, trades: 0, dividends: 0 };
      yearMap.set(year, v);
    }
    return v;
  };
  for (const r of realized) {
    const y = getYear(Number(r.sold.slice(0, 4)));
    if (r.term === "long") y.longTermGain += r.gain;
    else y.shortTermGain += r.gain;
    y.proceeds += r.proceeds;
    y.costBasis += r.costBasis;
    y.trades += 1;
  }
  for (const t of sorted) {
    if (t.type === "dividend" && t.date) {
      const y = getYear(Number(t.date.slice(0, 4)));
      y.dividends += t.price ?? 0;
    }
  }
  for (const y of yearMap.values()) y.netGain = y.shortTermGain + y.longTermGain;

  return {
    method,
    openLots,
    realized: realized.sort((a, b) => b.sold.localeCompare(a.sold)),
    washSales,
    years: [...yearMap.values()].sort((a, b) => b.year - a.year),
    warnings,
  };
}

// ─── Harvesting ────────────────────────────────────────────────────────────

export interface HarvestCandidate {
  symbol: string;
  shares: number;
  unrealized: number;
  unrealizedPct: number;
  marketValue: number;
  /** True when a purchase within 30 days would disallow the loss. */
  washSaleRisk: boolean;
  lastBuyDate: string | null;
  note: string;
}

/**
 * Current unrealised losses large enough to be worth harvesting.
 * `recentBuyWithinDays` flags names bought recently (wash-sale window).
 */
export function harvestCandidates(
  positions: Array<{
    symbol: string;
    shares: number;
    unrealized: number;
    unrealizedPct: number;
    marketValue: number;
  }>,
  trades: Trade[],
  minLossUsd = 100,
  washWindowDays = 30,
): HarvestCandidate[] {
  const out: HarvestCandidate[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const p of positions) {
    if (p.shares <= 0 || p.unrealized > -Math.abs(minLossUsd)) continue;
    const lastBuy = trades
      .filter((t) => t.type === "buy" && t.symbol === p.symbol)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const daysSinceBuy = lastBuy ? daysBetween(lastBuy.date, today) : null;
    const risk = daysSinceBuy !== null && daysSinceBuy <= washWindowDays;
    out.push({
      symbol: p.symbol,
      shares: p.shares,
      unrealized: p.unrealized,
      unrealizedPct: p.unrealizedPct,
      marketValue: p.marketValue,
      washSaleRisk: risk,
      lastBuyDate: lastBuy?.date ?? null,
      note: risk
        ? `Bought ${lastBuy!.date} — selling now and rebuying within 30 days would disallow the loss.`
        : "No purchase in the wash-sale window; a repurchase after 31 days is clean.",
    });
  }
  return out.sort((a, b) => a.unrealized - b.unrealized);
}

/** First date a harvested position can be repurchased without wash-sale risk. */
export function cleanRepurchaseDate(soldDate: string): string {
  return addDays(soldDate, 31);
}
