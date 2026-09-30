"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import type { EnrichedPortfolio } from "@/lib/portfolio";

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

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/portfolio").then((r) => r.json()),
      fetch("/api/watchlist").then((r) => r.json()),
      fetch("/api/trades").then((r) => r.json()),
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

  const kpi = (label: string, value: string, sub?: React.ReactNode, color?: string) => (
    <div className="glass rounded-xl p-4">
      <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${color || ""}`}>{value}</p>
      {sub && <p className="text-xs mt-1">{sub}</p>}
    </div>
  );

  const returnColor = (totals?.totalReturn ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Portfolio Overview</h2>
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
            {kpi("Total Equity", fmt(totals?.equity ?? 0))}
            {kpi("Total Return", fmt(totals?.totalReturn ?? 0), pct(totals?.totalReturnPct ?? 0), returnColor)}
            {kpi(
              "Day Change",
              fmt(totals?.dayChange ?? 0),
              undefined,
              (totals?.dayChange ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]",
            )}
            {kpi("Invested Capital", fmt(totals?.invested ?? 0))}
            {kpi("Cash Available", fmt(portfolio?.snapshot.cashBalance ?? 0), `Dividends ${fmt(totals?.dividends ?? 0)}`)}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Holdings snapshot */}
            <div className="glass rounded-xl p-5 xl:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">Holdings</h3>
                <Link href="/dashboard/holdings" className="text-xs text-[var(--primary)] hover:underline">View all →</Link>
              </div>
              {positions.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-8">
                  No positions yet. Record your first trade to get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {positions.slice(0, 6).map((p) => (
                    <div key={p.symbol} className="flex items-center gap-3 text-sm">
                      <span className="font-bold w-16">{p.symbol}</span>
                      <span className="text-[var(--muted)] text-xs w-20">{p.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} sh</span>
                      <div className="flex-1 min-w-16 h-2 rounded-full overflow-hidden bg-[var(--card-border)]">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, p.weightPct)}%` }} />
                      </div>
                      <span className="w-24 text-right tabular-nums">{fmt(p.marketValue)}</span>
                      <span className={`w-20 text-right tabular-nums ${p.unrealized >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                        {pct(p.unrealizedPct)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Allocation */}
            <div className="glass rounded-xl p-5">
              <h3 className="text-sm font-semibold mb-2">Allocation</h3>
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
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Top movers */}
            <div className="glass rounded-xl p-5">
              <h3 className="text-sm font-semibold mb-4">Today&apos;s Movers</h3>
              {positions.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-6">No live positions.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-[var(--muted)] mb-2 flex items-center gap-1">▲ Gainers</p>
                    <div className="space-y-2">
                      {topGainers.map((p) => (
                        <div key={p.symbol} className="flex items-center justify-between text-sm">
                          <span className="font-medium">{p.symbol}</span>
                          <span className="text-[var(--success)] tabular-nums">{pct(p.dayChangePct)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-[var(--muted)] mb-2 flex items-center gap-1">▼ Losers</p>
                    <div className="space-y-2">
                      {topLosers.map((p) => (
                        <div key={p.symbol} className="flex items-center justify-between text-sm">
                          <span className="font-medium">{p.symbol}</span>
                          <span className="text-[var(--danger)] tabular-nums">{pct(p.dayChangePct)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Watchlist strip */}
            <div className="glass rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">Watchlist</h3>
                <Link href="/dashboard/watchlist" className="text-xs text-[var(--primary)] hover:underline">Manage →</Link>
              </div>
              {watchlist.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-6">
                  Nothing watched. Add symbols on the Watchlist page.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {watchlist.map((w) => {
                    const up = (w.quote?.changePercent ?? 0) >= 0;
                    return (
                      <div key={w.id} className="rounded-lg border border-[var(--card-border)] p-3">
                        <p className="font-bold text-sm">{w.symbol}</p>
                        <p className="text-sm tabular-nums">{w.quote?.price != null ? fmt(w.quote.price) : "—"}</p>
                        <p className={`text-xs tabular-nums ${up ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                          {w.quote?.changePercent != null ? pct(w.quote.changePercent) : "—"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Recent trades */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">Recent Activity</h3>
              <Link href="/dashboard/trades" className="text-xs text-[var(--primary)] hover:underline">Trade log →</Link>
            </div>
            {trades.length === 0 ? (
              <p className="text-sm text-[var(--muted)] text-center py-6">No activity yet.</p>
            ) : (
              <div className="space-y-2">
                {trades.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 text-sm">
                    <span className="text-[var(--muted)] text-xs w-24">{t.date}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${TYPE_STYLES[t.type] ?? ""}`}>{t.type}</span>
                    <span className="font-bold w-16">{t.symbol ?? ""}</span>
                    <span className="text-[var(--muted)]">{t.shares != null ? `${t.shares} sh @ ${fmt(t.price ?? 0)}` : fmt(t.price ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
