// ─── What made (or lost) the money ─────────────────────────────────────────
//
// Two exact decompositions and one clearly-labelled approximation:
//
// 1. Lifetime P&L by holding — unrealised + realised + dividends per symbol.
//    Exact: it is the same lot math as the ledger, regrouped.
// 2. P&L waterfall — unrealised + realised + dividends − fees = total P&L.
//    Exact by construction (see the algebra in the comment below).
// 3. Period contribution — each symbol's total return over the window times its
//    weight. Weights are today's, which is an approximation for a window with
//    trades; the UI says so. A true Brinson attribution needs benchmark
//    constituent weights, which this app does not have and will not invent.

export interface PnlRow {
  symbol: string;
  unrealized: number;
  realized: number;
  dividends: number;
  pnl: number;
  sharePct: number;
}

export interface ContributionReport {
  rows: PnlRow[];
  totalPnl: number;
  winners: number;
  losers: number;
}

export function lifetimeContribution(
  positions: Array<{
    symbol: string;
    shares: number;
    unrealized: number;
    realized: number;
    dividends: number;
  }>,
): ContributionReport {
  const rows: PnlRow[] = positions
    .map((p) => {
      const pnl = p.unrealized + p.realized + p.dividends;
      return {
        symbol: p.symbol,
        unrealized: p.unrealized,
        realized: p.realized,
        dividends: p.dividends,
        pnl,
        sharePct: 0,
      };
    })
    .sort((a, b) => b.pnl - a.pnl);

  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const grossAbs = rows.reduce((s, r) => s + Math.abs(r.pnl), 0);
  for (const r of rows) {
    r.sharePct = grossAbs > 0 ? (r.pnl / grossAbs) * 100 : 0;
  }
  return {
    rows,
    totalPnl,
    winners: rows.filter((r) => r.pnl > 0).length,
    losers: rows.filter((r) => r.pnl < 0).length,
  };
}

export interface WaterfallItem {
  label: string;
  value: number;
  kind: "gain" | "cost" | "total";
}

/**
 * Exact P&L bridge.
 *
 * Buy commissions are capitalised into cost basis, so they are already inside
 * "unrealised P&L"; sell commissions are netted inside "realised P&L". Only
 * standalone `fee` rows reduce cash without any offsetting cost basis, so they
 * are the only fee line that belongs in the bridge. Adding totalFees here would
 * subtract the commissions twice (the original version did exactly that).
 */
export function pnlWaterfall(totals: {
  unrealized: number;
  realized: number;
  dividends: number;
  fees: number;
  totalReturn: number;
}, standaloneFeeRows = 0): { items: WaterfallItem[]; residual: number; feesTotal: number; note: string } {
  const items: WaterfallItem[] = [
    { label: "Unrealised P&L", value: totals.unrealized, kind: totals.unrealized >= 0 ? "gain" : "cost" },
    { label: "Realised P&L", value: totals.realized, kind: totals.realized >= 0 ? "gain" : "cost" },
    { label: "Dividends received", value: totals.dividends, kind: "gain" },
  ];
  if (standaloneFeeRows !== 0) {
    items.push({ label: "Standalone fees", value: -standaloneFeeRows, kind: "cost" });
  }
  items.push({ label: "Total P&L", value: totals.totalReturn, kind: "total" });

  const sum = totals.unrealized + totals.realized + totals.dividends - standaloneFeeRows;
  return {
    items,
    residual: totals.totalReturn - sum,
    feesTotal: totals.fees,
    note:
      "Buy commissions are inside cost basis and sell commissions inside realised P&L, so both are already reflected above. Only standalone fee rows are a separate line. Total commissions paid: shown on the right.",
  };
}

export interface PeriodContributionRow {
  symbol: string;
  weightPct: number;
  returnPct: number;
  contributionPct: number;
}

export interface PeriodContribution {
  startDate: string | null;
  endDate: string | null;
  rows: PeriodContributionRow[];
  totalPct: number;
  basis: string;
}

/**
 * Current-weight × window-return contribution. `series` are normalised price
 * series (value 100 at their own base) — only the endpoints are used.
 */
export function periodContribution(
  holdings: Array<{ symbol: string; weightPct: number }>,
  series: Record<string, Array<{ date: string; value: number }>>,
  startDate: string | null,
  endDate: string | null,
): PeriodContribution {
  const rows: PeriodContributionRow[] = [];
  for (const h of holdings) {
    const pts = series[h.symbol];
    if (!pts || pts.length < 2) continue;
    const inWindow = pts.filter((p) => (!startDate || p.date >= startDate) && (!endDate || p.date <= endDate));
    if (inWindow.length < 2) continue;
    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    if (!(first.value > 0)) continue;
    const ret = (last.value / first.value - 1) * 100;
    rows.push({
      symbol: h.symbol,
      weightPct: h.weightPct,
      returnPct: ret,
      contributionPct: (h.weightPct / 100) * ret,
    });
  }
  rows.sort((a, b) => b.contributionPct - a.contributionPct);
  return {
    startDate,
    endDate,
    rows,
    totalPct: rows.reduce((s, r) => s + r.contributionPct, 0),
    basis:
      "Each holding's total return over the window × its current weight. With trades inside the window this is an approximation, not an exact Brinson attribution.",
  };
}

/** Group contribution rows by a tag map (sector, account, asset class). */
export function groupContribution(
  rows: Array<{ symbol: string; contributionPct: number; pnl?: number }>,
  tags: Record<string, string>,
): Array<{ key: string; contributionPct: number; pnl: number; members: number }> {
  const map = new Map<string, { contributionPct: number; pnl: number; members: number }>();
  for (const r of rows) {
    const key = tags[r.symbol] || "Unclassified";
    const cur = map.get(key) ?? { contributionPct: 0, pnl: 0, members: 0 };
    cur.contributionPct += r.contributionPct;
    cur.pnl += r.pnl ?? 0;
    cur.members += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.contributionPct - a.contributionPct);
}
