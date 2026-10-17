"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import type { EnrichedPortfolio } from "@/lib/portfolio";
import { PanelBoard, ChartPanel } from "@/components/PanelBoard";
import DetailDrawer, { DetailSection, toneOf } from "@/components/DetailDrawer";
import SymbolDetail, { SymbolMeta } from "@/components/SymbolDetail";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

const ALLOCATION_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6", "#ef4444", "#0ea5e9", "#84cc16", "#f97316", "#64748b"];

type PortfolioData = EnrichedPortfolio;

interface WatchRow {
  id: number;
  symbol: string;
  target_price: number | null;
  quote: { price: number | null; changePercent: number | null } | null;
  distanceToTargetPct: number | null;
}

interface Trade {
  id: number;
  date: string;
  type: string;
  symbol: string | null;
  shares: number | null;
  price: number | null;
}

const TYPE_STYLES: Record<string, string> = {
  buy: "bg-green-500/10 text-[var(--success)]",
  sell: "bg-red-500/10 text-[var(--danger)]",
  dividend: "bg-blue-500/10 text-blue-500 dark:text-blue-400",
  deposit: "bg-indigo-500/10 text-indigo-500 dark:text-indigo-400",
  withdrawal: "bg-amber-500/10 text-[var(--warning)]",
  fee: "bg-zinc-500/10 text-[var(--muted)]",
};

export default function DashboardPage() {
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [watchlist, setWatchlist] = useState<WatchRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  // Click-to-detail state: a symbol, a metric, or one trade.
  const [detail, setDetail] = useState<SymbolMeta | null>(null);
  const [metric, setMetric] = useState<{ title: string; subtitle?: string; sections: DetailSection[] } | null>(null);
  const [tradeDetail, setTradeDetail] = useState<Trade | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/portfolio", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/watchlist", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/trades", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([pf, wl, tr]) => {
        setPortfolio(pf);
        setWatchlist((wl.items || []).slice(0, 6));
        setTrades((tr.trades || []).slice(0, 8));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live polling: refresh quotes/positions every 5s (idles when tab hidden)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const totals = portfolio?.snapshot.totals;
  const positions = portfolio?.quoted ?? [];
  const movers = [...positions].sort((a, b) => b.dayChangePct - a.dayChangePct);
  const topGainers = movers.slice(0, 4);
  const topLosers = movers.slice(-4).reverse();

  const allocation = positions
    .map((p, i) => ({ name: p.symbol, value: p.marketValue, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }))
    .concat(
      portfolio && portfolio.snapshot.cashBalance > 0
        ? [{ name: "Cash", value: portfolio.snapshot.cashBalance, color: "#64748b" }]
        : [],
    );

  // Everything the symbol drawer needs, from data this page already holds.
  const metaOfPosition = (p: PortfolioData["quoted"][number]): SymbolMeta => ({
    symbol: p.symbol,
    name: portfolio?.quotes[p.symbol]?.name ?? null,
    held: p.shares > 0,
    shares: p.shares, avgCost: p.avgCost, costBasis: p.costBasis, marketValue: p.marketValue,
    unrealized: p.unrealized, unrealizedPct: p.unrealizedPct, realized: p.realized, dividends: p.dividends,
    weightPct: p.weightPct, firstBuyDate: p.firstBuyDate,
    lastPrice: p.lastPrice, prevClose: p.prevClose, dayChange: p.dayChange, dayChangePct: p.dayChangePct,
    bid: p.bid, ask: p.ask, bidSize: p.bidSize, askSize: p.askSize, spreadPct: p.spreadPct, bookSource: p.bookSource,
  });

  const metaOfWatch = (w: WatchRow): SymbolMeta => ({
    symbol: w.symbol,
    watched: true,
    lastPrice: w.quote?.price ?? null,
    dayChangePct: w.quote?.changePercent ?? undefined,
    targetPrice: w.target_price,
    distanceToTargetPct: w.distanceToTargetPct,
  });

  const openMetric = (title: string, subtitle: string, sections: DetailSection[]) =>
    setMetric({ title, subtitle, sections });

  const kpi = (label: string, value: string, sub?: React.ReactNode, color?: string, onOpen?: () => void) => {
    const inner = (
      <>
        <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
        <p className={`text-xl font-bold ${color || ""}`}>{value}</p>
        {sub && <p className="text-xs mt-1">{sub}</p>}
      </>
    );
    return onOpen ? (
      <button onClick={onOpen} title={`Details for ${label}`} className="glass rounded-xl p-4 text-left border border-transparent hover:border-indigo-500/40 transition-colors">
        {inner}
      </button>
    ) : (
      <div className="glass rounded-xl p-4">{inner}</div>
    );
  };

  const returnColor = (totals?.totalReturn ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            Portfolio Overview
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-[var(--success)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
              LIVE · 5s
            </span>
          </h2>
          <p className="text-sm text-[var(--muted)]">Live view of your investments</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/trades" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
            + Record Trade
          </Link>
          <Link href="/dashboard/holdings" className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)]">
            View Holdings
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            {kpi("Total Equity", fmt(totals?.equity ?? 0), undefined, undefined, () =>
              openMetric("Total Equity", "Market value + cash balance", [
                { heading: "Composition", rows: [
                  { label: "Market value", value: fmt(totals?.marketValue ?? 0) },
                  { label: "Cash balance", value: fmt(portfolio?.snapshot.cashBalance ?? 0) },
                  { label: "Total equity", value: fmt(totals?.equity ?? 0) },
                ] },
              ]))}
            {kpi("Total Return", fmt(totals?.totalReturn ?? 0), pct(totals?.totalReturnPct ?? 0), returnColor, () =>
              openMetric("Total Return", "Equity − net invested", [
                { heading: "Return", rows: [
                  { label: "Equity", value: fmt(totals?.equity ?? 0) },
                  { label: "Invested (deposits − withdrawals)", value: fmt(totals?.invested ?? 0) },
                  { label: "Total return", value: fmt(totals?.totalReturn ?? 0), tone: toneOf(totals?.totalReturn ?? 0) },
                  { label: "Return %", value: pct(totals?.totalReturnPct ?? 0), tone: toneOf(totals?.totalReturn ?? 0) },
                ] },
              ]))}
            {kpi(
              "Day Change",
              fmt(totals?.dayChange ?? 0),
              undefined,
              (totals?.dayChange ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]",
              () => openMetric("Day Change", "Each holding's move today, vs yesterday's close", [
                { heading: "By position", rows: positions.map((p) => ({ label: `${p.symbol} (${pct(p.dayChangePct)})`, value: fmt(p.dayChange), tone: toneOf(p.dayChange) })) },
                { heading: "Total", rows: [{ label: "Day change", value: fmt(totals?.dayChange ?? 0), tone: toneOf(totals?.dayChange ?? 0) }] },
              ]),
            )}
            {kpi("Invested Capital", fmt(totals?.invested ?? 0), undefined, undefined, () =>
              openMetric("Invested Capital", "Deposits − withdrawals", [
                { heading: "Capital", rows: [
                  { label: "Deposits", value: fmt(portfolio?.snapshot.cash.deposits ?? 0) },
                  { label: "Withdrawals", value: fmt(-(portfolio?.snapshot.cash.withdrawals ?? 0)) },
                  { label: "Invested capital", value: fmt(totals?.invested ?? 0) },
                ] },
              ]))}
            {kpi("Cash Available", fmt(portfolio?.snapshot.cashBalance ?? 0), `Dividends ${fmt(totals?.dividends ?? 0)}`, undefined, () =>
              openMetric("Cash balance", "Deposits − withdrawals + dividends − fees − buys + sells", [
                { heading: "Cash ledger", rows: [
                  { label: "Deposits", value: fmt(portfolio?.snapshot.cash.deposits ?? 0) },
                  { label: "Withdrawals", value: fmt(-(portfolio?.snapshot.cash.withdrawals ?? 0)) },
                  { label: "Dividends", value: fmt(portfolio?.snapshot.cash.dividends ?? 0) },
                  { label: "Fees", value: fmt(-(portfolio?.snapshot.cash.fees ?? 0)) },
                  { label: "Buy costs", value: fmt(-(portfolio?.snapshot.cash.buyCosts ?? 0)) },
                  { label: "Sell proceeds", value: fmt(portfolio?.snapshot.cash.sellProceeds ?? 0) },
                  { label: "Cash balance", value: fmt(portfolio?.snapshot.cashBalance ?? 0) },
                ] },
              ]))}
          </div>

          <PanelBoard
            boardKey="dashboard"
            ids={["holdings", "allocation", "movers", "watchlist", "activity"]}
            className="grid grid-cols-1 xl:grid-cols-6 gap-6"
          >
            {/* Holdings snapshot */}
            <ChartPanel
              id="holdings"
              title="Holdings"
              className="xl:col-span-4"
              right={<Link href="/dashboard/holdings" className="text-xs text-[var(--primary)] hover:underline">View all →</Link>}
            >
              {positions.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-8">
                  No positions yet. Record your first trade to get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {positions.slice(0, 6).map((p) => (
                    <button
                      key={p.symbol}
                      onClick={() => setDetail(metaOfPosition(p))}
                      title={`Details for ${p.symbol}`}
                      className="w-full flex items-center gap-3 text-sm px-1 -mx-1 rounded hover:bg-[var(--card-hover)] transition-colors text-left"
                    >
                      <span className="font-bold w-16">{p.symbol}</span>
                      <span className="text-[var(--muted)] text-xs w-20">{p.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} sh</span>
                      <div className="flex-1 min-w-16 h-2 rounded-full overflow-hidden bg-[var(--card-border)]">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, p.weightPct)}%` }} />
                      </div>
                      <span className="w-24 text-right tabular-nums">{fmt(p.marketValue)}</span>
                      <span className={`w-20 text-right tabular-nums ${p.unrealized >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                        {pct(p.unrealizedPct)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </ChartPanel>

            {/* Allocation */}
            <ChartPanel id="allocation" title="Allocation" className="xl:col-span-2">
              {allocation.length > 0 ? (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={allocation} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {allocation.map((a) => <Cell key={a.name} fill={a.color} stroke="none" />)}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                        formatter={(v) => fmt(Number(v))}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)] text-center py-16">Nothing allocated yet.</p>
              )}
            </ChartPanel>

            {/* Top movers */}
            <ChartPanel id="movers" title="Today's Movers" className="xl:col-span-3">
              {positions.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-6">No live positions.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-[var(--muted)] mb-2 flex items-center gap-1">▲ Gainers</p>
                    <div className="space-y-2">
                      {topGainers.map((p) => (
                        <button
                          key={p.symbol}
                          onClick={() => setDetail(metaOfPosition(p))}
                          title={`Details for ${p.symbol}`}
                          className="w-full flex items-center justify-between text-sm px-1 -mx-1 rounded hover:bg-[var(--card-hover)] transition-colors"
                        >
                          <span className="font-medium">{p.symbol}</span>
                          <span className="text-[var(--success)] tabular-nums">{pct(p.dayChangePct)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--muted)] mb-2 flex items-center gap-1">▼ Losers</p>
                    <div className="space-y-2">
                      {topLosers.map((p) => (
                        <button
                          key={p.symbol}
                          onClick={() => setDetail(metaOfPosition(p))}
                          title={`Details for ${p.symbol}`}
                          className="w-full flex items-center justify-between text-sm px-1 -mx-1 rounded hover:bg-[var(--card-hover)] transition-colors"
                        >
                          <span className="font-medium">{p.symbol}</span>
                          <span className="text-[var(--danger)] tabular-nums">{pct(p.dayChangePct)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </ChartPanel>

            {/* Watchlist strip */}
            <ChartPanel
              id="watchlist"
              title="Watchlist"
              className="xl:col-span-3"
              right={<Link href="/dashboard/watchlist" className="text-xs text-[var(--primary)] hover:underline">Manage →</Link>}
            >
              {watchlist.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-6">
                  Nothing watched. Add symbols on the Watchlist page.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {watchlist.map((w) => {
                    const up = (w.quote?.changePercent ?? 0) >= 0;
                    return (
                      <button
                        key={w.id}
                        onClick={() => setDetail(metaOfWatch(w))}
                        title={`Details for ${w.symbol}`}
                        className="rounded-lg border border-[var(--card-border)] p-3 text-left hover:border-indigo-500/40 transition-colors"
                      >
                        <p className="font-bold text-sm">{w.symbol}</p>
                        <p className="text-sm tabular-nums">{w.quote?.price != null ? fmt(w.quote.price) : "—"}</p>
                        <p className={`text-xs tabular-nums ${up ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                          {w.quote?.changePercent != null ? pct(w.quote.changePercent) : "—"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </ChartPanel>

            {/* Recent trades */}
            <ChartPanel
              id="activity"
              title="Recent Activity"
              className="xl:col-span-6"
              right={<Link href="/dashboard/trades" className="text-xs text-[var(--primary)] hover:underline">Trade log →</Link>}
            >
              {trades.length === 0 ? (
              <p className="text-sm text-[var(--muted)] text-center py-6">No activity yet.</p>
            ) : (
              <div className="space-y-2">
                {trades.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTradeDetail(t)}
                    title="Trade details"
                    className="w-full flex items-center gap-3 text-sm px-1 -mx-1 rounded hover:bg-[var(--card-hover)] transition-colors text-left"
                  >
                    <span className="text-[var(--muted)] text-xs w-24">{t.date}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${TYPE_STYLES[t.type] ?? ""}`}>{t.type}</span>
                    <span className="font-bold w-16">{t.symbol ?? ""}</span>
                    <span className="text-[var(--muted)]">{t.shares != null ? `${t.shares} sh @ ${fmt(t.price ?? 0)}` : fmt(t.price ?? 0)}</span>
                  </button>
                ))}
              </div>
            )}
            </ChartPanel>
          </PanelBoard>
        </>
      )}

      {/* Click-to-detail drawers */}
      <SymbolDetail open={!!detail} meta={detail} onClose={() => setDetail(null)} onChanged={load} />
      <DetailDrawer
        open={!!metric}
        onClose={() => setMetric(null)}
        title={metric?.title ?? ""}
        subtitle={metric?.subtitle}
        sections={metric?.sections}
      />
      <DetailDrawer
        open={!!tradeDetail}
        onClose={() => setTradeDetail(null)}
        title={tradeDetail ? `${tradeDetail.type} ${tradeDetail.symbol ?? ""}`.trim() : ""}
        subtitle={tradeDetail?.date}
        sections={tradeDetail ? [
          { heading: "Trade", rows: [
            { label: "Date", value: tradeDetail.date },
            { label: "Type", value: <span className="capitalize">{tradeDetail.type}</span> },
            { label: "Symbol", value: tradeDetail.symbol ?? "—" },
            { label: "Shares", value: tradeDetail.shares != null ? tradeDetail.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—" },
            { label: "Price / Amount", value: fmt(tradeDetail.price ?? 0) },
            { label: "Value", value: fmt(tradeDetail.shares != null && tradeDetail.price != null ? tradeDetail.shares * tradeDetail.price : tradeDetail.price ?? 0) },
          ] },
        ] : []}
      />
    </div>
  );
}
