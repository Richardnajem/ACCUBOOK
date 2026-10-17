"use client";

// Everything known about one ticker, in a drawer: live quote, position, watch
// target, and the trade history behind it. Sections only appear when the caller
// actually has that data — a missing reading is shown as "—", never guessed.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DetailDrawer, { DetailRow, DetailSection, toneOf } from "./DetailDrawer";

const money = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const signedMoney = (n: number | null | undefined) =>
  n == null ? "—" : `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const num = (n: number | null | undefined, dp = 4) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: dp });
const fmtSize = (v: number | null | undefined) =>
  v == null ? null : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v));

export interface SymbolMeta {
  symbol: string;
  name?: string | null;
  /** True when the symbol has an open position. */
  held?: boolean;
  /** True when the symbol is on the watchlist. */
  watched?: boolean;
  // Position
  shares?: number;
  avgCost?: number;
  costBasis?: number;
  marketValue?: number;
  unrealized?: number;
  unrealizedPct?: number;
  realized?: number;
  dividends?: number;
  weightPct?: number;
  firstBuyDate?: string | null;
  // Quote
  lastPrice?: number | null;
  prevClose?: number | null;
  dayChange?: number;
  dayChangePct?: number;
  bid?: number | null;
  ask?: number | null;
  bidSize?: number | null;
  askSize?: number | null;
  spreadPct?: number | null;
  bookSource?: string | null;
  marketState?: string | null;
  // Watch
  targetPrice?: number | null;
  distanceToTargetPct?: number | null;
  notes?: string | null;
}

interface Trade {
  id: number;
  date: string;
  type: string;
  symbol: string | null;
  shares: number | null;
  price: number | null;
  fees: number;
  notes: string | null;
}

const TYPE_TONE: Record<string, string> = {
  buy: "bg-green-500/10 text-[var(--success)]",
  sell: "bg-red-500/10 text-[var(--danger)]",
  dividend: "bg-blue-500/10 text-blue-500 dark:text-blue-400",
  deposit: "bg-indigo-500/10 text-indigo-500 dark:text-indigo-400",
  withdrawal: "bg-amber-500/10 text-[var(--warning)]",
  fee: "bg-zinc-500/10 text-[var(--muted)]",
};

export default function SymbolDetail({
  open,
  onClose,
  meta,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  meta: SymbolMeta | null;
  /** Called after an action changes data (e.g. added to the watchlist). */
  onChanged?: () => void;
}) {
  const router = useRouter();
  // Trade history is cached per symbol, so switching symbols never needs a
  // synchronous state reset inside the effect (only the async callback sets).
  const [tradesBySymbol, setTradesBySymbol] = useState<Record<string, Trade[]>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ symbol: string; text: string } | null>(null);

  const symbol = meta?.symbol ?? null;

  // Load the symbol's own trade history whenever the drawer opens on a symbol.
  useEffect(() => {
    if (!open || !symbol) return;
    let cancelled = false;
    fetch("/api/trades", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const all: Trade[] = d.trades || [];
        const mine = all.filter((t) => (t.symbol ?? "").toUpperCase() === symbol.toUpperCase());
        setTradesBySymbol((prev) => ({ ...prev, [symbol]: mine }));
      })
      .catch(() => { if (!cancelled) setTradesBySymbol((prev) => ({ ...prev, [symbol]: [] })); });
    return () => { cancelled = true; };
  }, [open, symbol]);

  if (!open || !meta) return null;

  const sections: DetailSection[] = [];

  // ── Quote ──
  const quoteRows: DetailRow[] = [];
  if (meta.lastPrice != null) {
    quoteRows.push({ label: "Live price", value: money(meta.lastPrice) });
    if (meta.prevClose != null) quoteRows.push({ label: "Prev close", value: money(meta.prevClose) });
    if (meta.dayChange != null)
      quoteRows.push({
        label: "Day change",
        value: `${signedMoney(meta.dayChange)} (${pct(meta.dayChangePct ?? 0)})`,
        tone: toneOf(meta.dayChange),
      });
    if (meta.bid != null)
      quoteRows.push({
        label: `Bid${meta.bidSize != null ? ` ×${fmtSize(meta.bidSize)}` : ""}`,
        value: `${money(meta.bid)}${meta.bookSource ? ` · ${meta.bookSource}` : ""}`,
        tone: "pos",
      });
    if (meta.ask != null)
      quoteRows.push({
        label: `Ask${meta.askSize != null ? ` ×${fmtSize(meta.askSize)}` : ""}`,
        value: `${money(meta.ask)}${meta.bookSource ? ` · ${meta.bookSource}` : ""}`,
        tone: "neg",
      });
    if (meta.spreadPct != null)
      quoteRows.push({ label: "Spread", value: `${meta.spreadPct < 0.1 ? meta.spreadPct.toFixed(3) : meta.spreadPct.toFixed(2)}%`, tone: "muted" });
  } else {
    quoteRows.push({ label: "Live price", value: "—", tone: "muted" });
  }
  if (meta.marketState) quoteRows.push({ label: "Session", value: meta.marketState, tone: "muted" });
  sections.push({ heading: "Quote", rows: quoteRows });

  // ── Position ──
  if (meta.held && meta.shares != null && meta.shares > 0) {
    const rows: DetailRow[] = [
      { label: "Shares", value: num(meta.shares) },
      { label: "Avg cost", value: money(meta.avgCost) },
      { label: "Cost basis", value: money(meta.costBasis) },
      { label: "Market value", value: money(meta.marketValue) },
    ];
    if (meta.unrealized != null)
      rows.push({
        label: "Unrealized P&L",
        value: `${signedMoney(meta.unrealized)} (${pct(meta.unrealizedPct)})`,
        tone: toneOf(meta.unrealized),
      });
    if (meta.weightPct != null) rows.push({ label: "Portfolio weight", value: `${meta.weightPct.toFixed(1)}%` });
    if (meta.firstBuyDate) rows.push({ label: "First buy", value: meta.firstBuyDate, tone: "muted" });
    sections.push({ heading: "Position", rows });
  }

  // ── Realized history ──
  const perfRows: DetailRow[] = [];
  if (meta.realized != null) perfRows.push({ label: "Realized P&L", value: signedMoney(meta.realized), tone: toneOf(meta.realized) });
  if (meta.dividends != null) perfRows.push({ label: "Dividends", value: money(meta.dividends) });
  if (perfRows.length > 0) sections.push({ heading: "Realized history", rows: perfRows });

  // ── Watch ──
  const watchRows: DetailRow[] = [];
  if (meta.targetPrice != null) watchRows.push({ label: "Target price", value: money(meta.targetPrice) });
  if (meta.distanceToTargetPct != null)
    watchRows.push({
      label: "Distance to target",
      value: `${Math.abs(meta.distanceToTargetPct).toFixed(1)}% ${meta.distanceToTargetPct > 0 ? "below" : "above"}`,
    });
  if (meta.notes) watchRows.push({ label: "Notes", value: meta.notes });
  if (meta.watched && watchRows.length === 0) watchRows.push({ label: "Watchlist", value: "no target set", tone: "muted" });
  if (watchRows.length > 0) sections.push({ heading: "Watchlist", rows: watchRows });

  // ── Trade history (body) ──
  const history = tradesBySymbol[meta.symbol];
  const loadingTrades = history === undefined;
  const tradeList = history ?? [];
  const buys = tradeList.filter((t) => t.type === "buy").length;
  const sells = tradeList.filter((t) => t.type === "sell").length;
  sections.push({
    heading: "Trade history",
    body: loadingTrades ? (        <div className="flex items-center gap-2 text-xs text-[var(--muted)] py-3">
        <div className="animate-spin w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full" />
        Loading trades…
      </div>
    ) : tradeList.length === 0 ? (
      <p className="text-xs text-[var(--muted)] py-1">No trades recorded for {meta.symbol}.</p>
    ) : (
      <div>
        <p className="text-[11px] text-[var(--muted)] mb-2">
          {tradeList.length} trade{tradeList.length === 1 ? "" : "s"} · {buys} buy{buys === 1 ? "" : "s"} · {sells} sell{sells === 1 ? "" : "s"}
        </p>
        <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--muted)] border-b border-[var(--card-border)]" style={{ background: "var(--input-bg)" }}>
                <th className="text-left py-1.5 px-2 font-medium">Date</th>
                <th className="text-left py-1.5 px-2 font-medium">Type</th>
                <th className="text-right py-1.5 px-2 font-medium">Shares</th>
                <th className="text-right py-1.5 px-2 font-medium">Price</th>
                <th className="text-right py-1.5 px-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {tradeList.map((t) => (
                <tr key={t.id} className="border-b border-[var(--card-border)] last:border-0">
                  <td className="py-1.5 px-2 text-[var(--muted)] whitespace-nowrap">{t.date}</td>
                  <td className="py-1.5 px-2">
                    <span className={`px-1.5 py-0.5 rounded capitalize ${TYPE_TONE[t.type] ?? ""}`}>{t.type}</span>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{t.shares != null ? num(t.shares) : "—"}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{money(t.price)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {t.shares != null && t.price != null ? money(t.shares * t.price) : money(t.price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  });

  const badges = (
    <>
      {meta.held && <Badge cls="bg-emerald-500/15 text-[var(--success)]">HELD</Badge>}
      {meta.watched && <Badge cls="bg-indigo-500/15 text-indigo-500 dark:text-indigo-400">WATCHED</Badge>}
      {!meta.held && !meta.watched && <Badge cls="bg-[var(--card-hover)] text-[var(--muted)]">NOT HELD</Badge>}
    </>
  );

  const addToWatchlist = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: meta.symbol }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setNote({ symbol: meta.symbol, text: d.error || "Could not add to watchlist" });
      } else {
        setNote({ symbol: meta.symbol, text: `Added ${meta.symbol} to your watchlist.` });
        onChanged?.();
      }
    } catch {
      setNote({ symbol: meta.symbol, text: "Could not add to watchlist" });
    } finally {
      setBusy(false);
    }
  };

  const analyze = () => {
    // Reuse the Mega Indicator's own persisted-ticker slot so the chosen symbol
    // is what that page restores on mount.
    try { window.localStorage.setItem("mega-indicator:ticker:v1", JSON.stringify(meta.symbol)); } catch { /* storage unavailable */ }
    onClose();
    router.push("/dashboard/mega-indicator");
  };

  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title={meta.symbol}
      subtitle={meta.name ?? undefined}
      badges={badges}
      sections={sections}
      actions={[
        ...(meta.watched ? [] : [{ label: busy ? "Adding…" : "Add to watchlist", onClick: addToWatchlist }]),
        { label: "Analyze on Mega Indicator", onClick: analyze, variant: "primary" as const },
      ]}
    >
      {note && note.symbol === meta.symbol && <p className="text-xs text-[var(--muted)]">{note.text}</p>}
    </DetailDrawer>
  );
}

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${cls}`}>{children}</span>;
}
