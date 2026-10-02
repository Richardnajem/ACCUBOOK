"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { SortableTable, Column } from "@/components/SortableTable";
import ImportDialog from "@/components/ImportDialog";
import { downloadCSV } from "@/lib/export";
import type { EnrichedPortfolio } from "@/lib/portfolio";
import { PanelBoard, ChartPanel } from "@/components/PanelBoard";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

type PortfolioData = EnrichedPortfolio;
type Position = PortfolioData["quoted"][number];

const ALLOCATION_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6", "#ef4444", "#0ea5e9", "#84cc16", "#f97316"];

export default function HoldingsPage() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(() => {
    fetch("/api/portfolio", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live polling: refresh quotes every 5s (idles when tab hidden)
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const totals = data?.snapshot.totals;
  const positions = useMemo(() => data?.quoted ?? [], [data]);
  const errorEntries = Object.entries(data?.errors ?? {});

  const allocation = useMemo(
    () =>
      positions
        .map((p, i) => ({ name: p.symbol, value: p.marketValue, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] }))
        .concat(
          data && data.snapshot.cashBalance > 0
            ? [{ name: "Cash", value: data.snapshot.cashBalance, color: "#64748b" }]
            : [],
        ),
    [positions, data],
  );

  const columns: Column<Position>[] = [
    { key: "symbol", header: "Symbol", render: (r) => <span className="font-bold">{r.symbol}</span> },
    { key: "shares", header: "Shares", align: "right", render: (r) => r.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }) },
    {
      key: "lastPrice", header: "Live Price", align: "right",
      render: (r) => (r.lastPrice != null ? fmt(r.lastPrice) : <span className="text-[var(--muted)]">—</span>),
    },
    {
      // Broker-ladder style: bid size × bid price (emerald side of the book)
      key: "bid", header: "Bid", align: "right",
      render: (r) =>
        r.bid != null ? (
          <span className="tabular-nums text-[var(--success)]" title={`Bid via ${r.bookSource ?? "book"}`}>
            {fmt(r.bid)}
            {r.bidSize != null && <span className="text-[10px] text-[var(--muted)] ml-1">×{fmtSize(r.bidSize)}</span>}
          </span>
        ) : (
          <span className="text-[var(--muted)]">—</span>
        ),
    },
    {
      // Ask size × ask price (rose side of the book)
      key: "ask", header: "Ask", align: "right",
      render: (r) =>
        r.ask != null ? (
          <span className="tabular-nums text-[var(--danger)]" title={`Ask via ${r.bookSource ?? "book"}`}>
            {fmt(r.ask)}
            {r.askSize != null && <span className="text-[10px] text-[var(--muted)] ml-1">×{fmtSize(r.askSize)}</span>}
          </span>
        ) : (
          <span className="text-[var(--muted)]">—</span>
        ),
    },
    {
      key: "spreadPct", header: "Spread", align: "right",
      render: (r) =>
        r.spreadPct != null ? (
          <span className="tabular-nums text-[var(--muted)]" title="Ask − bid, as % of the mid price">
            {r.spreadPct < 0.1 ? r.spreadPct.toFixed(3) : r.spreadPct.toFixed(2)}%
          </span>
        ) : (
          <span className="text-[var(--muted)]">—</span>
        ),
    },
    {
      key: "prevClose", header: "Prev Close", align: "right",
      render: (r) => (r.prevClose != null ? <span className="text-[var(--muted)]">{fmt(r.prevClose)}</span> : <span className="text-[var(--muted)]">—</span>),
    },
    { key: "avgCost", header: "Avg Cost", align: "right", render: (r) => fmt(r.avgCost) },
    { key: "costBasis", header: "Cost Basis", align: "right", render: (r) => fmt(r.costBasis) },
    { key: "marketValue", header: "Market Value", align: "right", render: (r) => fmt(r.marketValue) },
    {
      key: "dayChangePct", header: "Day", align: "right",
      render: (r) => (
        <span className={r.dayChangePct >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>
          {pct(r.dayChangePct)}
        </span>
      ),
    },
    {
      key: "unrealized", header: "Unrealized P&L", align: "right",
      render: (r) => (
        <span className={r.unrealized >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}>
          {fmt(r.unrealized)} <span className="text-xs">({pct(r.unrealizedPct)})</span>
        </span>
      ),
    },
    { key: "realized", header: "Realized", align: "right", render: (r) => fmt(r.realized) },
    { key: "dividends", header: "Dividends", align: "right", render: (r) => fmt(r.dividends) },
    { key: "weightPct", header: "Weight", align: "right", render: (r) => `${r.weightPct.toFixed(1)}%` },
  ];

  const fmtSize = (v: number | null | undefined) =>
    v == null ? null : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v));

  const exportCSV = () => {
    const headers = ["Symbol", "Shares", "Avg Cost", "Cost Basis", "Market Value", "Live Price", "Bid", "Bid Size", "Ask", "Ask Size", "Spread %", "Prev Close", "Unrealized P&L", "Realized", "Dividends", "Weight %"];
    const rows = positions.map((p) => [
      p.symbol, p.shares, p.avgCost, p.costBasis, p.marketValue, p.lastPrice, p.bid, p.bidSize, p.ask, p.askSize,
      p.spreadPct, p.prevClose, p.unrealized, p.realized, p.dividends, p.weightPct,
    ]);
    downloadCSV("holdings.csv", headers, rows);
  };

  const kpi = (label: string, value: string, sub?: string, color?: string) => (
    <div className="glass rounded-xl p-4">
      <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${color || ""}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--muted)] mt-1">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            Holdings
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-[var(--success)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
              LIVE · 5s
            </span>
          </h2>
          <p className="text-sm text-[var(--muted)]">Live positions, cost basis, and P&L (FIFO lots)</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)]">
            Export CSV
          </button>
          <button onClick={() => setImportOpen(true)} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
            Import Trades
          </button>
        </div>
      </div>

      {errorEntries.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
          Quote errors: {errorEntries.map(([sym, err]) => `${sym} — ${err}`).join("; ")}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {kpi("Total Equity", fmt(totals?.equity ?? 0))}
            {kpi("Total Return", fmt(totals?.totalReturn ?? 0), pct(totals?.totalReturnPct ?? 0), (totals?.totalReturn ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]")}
            {kpi("Day Change", fmt(totals?.dayChange ?? 0), undefined, (totals?.dayChange ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]")}
            {kpi("Unrealized P&L", fmt(totals?.unrealized ?? 0), undefined, (totals?.unrealized ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]")}
            {kpi("Realized P&L", fmt(totals?.realized ?? 0), undefined, (totals?.realized ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]")}
            {kpi("Cash", fmt(data?.snapshot.cashBalance ?? 0), `Dividends ${fmt(totals?.dividends ?? 0)}`)}
          </div>

          <PanelBoard
            boardKey="holdings"
            ids={["positions", "allocation", "closed"]}
            className="grid grid-cols-1 xl:grid-cols-3 gap-6"
          >
            {/* Positions table */}
            <ChartPanel id="positions" title="Open Positions" className="xl:col-span-2">
              {positions.length === 0 ? (
                <p className="text-sm text-[var(--muted)] text-center py-8">
                  No open positions. Record a buy on the Trades page or import from your broker.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <SortableTable columns={columns} data={positions} searchKey="symbol" searchPlaceholder="Search symbol…" />
                </div>
              )}
            </ChartPanel>

            {/* Allocation donut */}
            <ChartPanel id="allocation" title="Allocation">
              {allocation.length > 0 ? (
                <>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={allocation} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                          {allocation.map((a) => <Cell key={a.name} fill={a.color} stroke="none" />)}
                        </Pie>
                        <Tooltip
                          contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                          formatter={(v) => fmt(Number(v))}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="space-y-1.5 mt-3">
                    {allocation.map((a) => (
                      <div key={a.name} className="flex items-center gap-2 text-xs">
                        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: a.color }} />
                        <span className="font-medium">{a.name}</span>
                        <span className="ml-auto text-[var(--muted)]">{fmt(a.value)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-[var(--muted)] text-center py-8">Nothing to allocate yet.</p>
              )}
            </ChartPanel>

            {/* Closed positions */}
            {data && data.snapshot.closedPositions.length > 0 && (
            <ChartPanel id="closed" title="Closed Positions" className="xl:col-span-3">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[var(--muted)] border-b border-[var(--card-border)] text-left">
                      <th className="py-2 font-medium">Symbol</th>
                      <th className="py-2 font-medium text-right">Realized P&L</th>
                      <th className="py-2 font-medium text-right">Dividends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.snapshot.closedPositions.map((p) => (
                      <tr key={p.symbol} className="border-b border-[var(--card-border)] last:border-0">
                        <td className="py-2.5 font-medium">{p.symbol}</td>
                        <td className={`py-2.5 text-right ${p.realized >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>{fmt(p.realized)}</td>
                        <td className="py-2.5 text-right">{fmt(p.dividends)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartPanel>
            )}
          </PanelBoard>
        </>
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={load} />
    </div>
  );
}
