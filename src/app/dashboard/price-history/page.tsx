"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SymbolSuggestionList, useSymbolSuggestions } from "@/components/SymbolSearch";
import { downloadCSV } from "@/lib/export";
import {
  PRICE_CSV_HEADERS,
  priceCsvRows,
  recentPriceRows,
  summarizeBars,
  thinBars,
} from "@/lib/price-history";

interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PriceResponse {
  symbol: string;
  meta: { symbol: string; name: string; currency: string; exchange: string } | null;
  source: "cache" | "yahoo";
  yearsRequested: number;
  bars: PriceBar[];
  error?: string;
}

/** Range buttons, in years (the unit the price loader takes). */
const RANGES = [
  { label: "1M", years: 1 / 12 },
  { label: "6M", years: 0.5 },
  { label: "1Y", years: 1 },
  { label: "3Y", years: 3 },
  { label: "5Y", years: 5 },
  { label: "10Y", years: 10 },
  { label: "Max", years: 30 },
];

/** Table page sizes. 0 = every session the request loaded. */
const ROW_LIMITS = [
  { label: "60", value: 60 },
  { label: "250", value: 250 },
  { label: "1,000", value: 1000 },
  { label: "All", value: 0 },
];

const fmtPrice = (v: number | null) =>
  v == null
    ? "—"
    : v.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2,
      });

const fmtPct = (v: number | null) =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

const fmtVolume = (v: number | null) => {
  if (v == null) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
};

const tone = (v: number | null) =>
  v == null ? "" : v > 0 ? "text-emerald-500" : v < 0 ? "text-red-500" : "";

export default function PriceHistoryPage() {
  const [symbol, setSymbol] = useState("AAPL");
  const [input, setInput] = useState("AAPL");
  const [years, setYears] = useState(5);
  const [data, setData] = useState<PriceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowLimit, setRowLimit] = useState(250);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { suggestions, loading: suggestLoading, error: suggestError } =
    useSymbolSuggestions(input);
  const visibleSuggestions = suggestions
    .filter((s) => s.symbol !== input.trim().toUpperCase())
    .slice(0, 6);
  const showSuggestions = input.trim().length >= 2 && input.trim().toUpperCase() !== symbol;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/prices?symbol=${encodeURIComponent(symbol)}&years=${years}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as PriceResponse;
        if (cancelled) return;
        if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
        setData(json);
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : "Could not load price history.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, years]);

  const bars = useMemo(() => data?.bars ?? [], [data]);
  const summary = useMemo(() => summarizeBars(bars), [bars]);
  const chartPoints = useMemo(
    () => thinBars(bars, 900).map((b) => ({ date: b.date, close: b.close, volume: b.volume })),
    [bars],
  );
  const rows = useMemo(() => recentPriceRows(bars, rowLimit), [bars, rowLimit]);

  const commitSymbol = (next: string) => {
    const clean = next.trim().toUpperCase();
    if (!clean) return;
    setInput(clean);
    setSymbol(clean);
    setNote(null);
  };

  const exportCsv = () => {
    if (bars.length === 0) return;
    const rangeLabel = RANGES.find((r) => r.years === years)?.label ?? `${years}Y`;
    downloadCSV(`price-history-${symbol}-${rangeLabel}.csv`, PRICE_CSV_HEADERS, priceCsvRows(bars));
    setNote(`Saved price-history-${symbol}-${rangeLabel}.csv (${bars.length} sessions)`);
  };

  // Excel keeps every day the source has, plus one column per indicator — built
  // by the same route the Mega Indicator page uses, on the app's default weights.
  const exportWorkbook = async () => {
    setExporting(true);
    setNote(null);
    try {
      const params = new URLSearchParams({ symbol, years: "30" });
      const res = await fetch(`/api/export/prices?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `Export failed (HTTP ${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          /* the body was not JSON — keep the status line */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fromHeader = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];
      const name = fromHeader ?? `price-history-${symbol}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setNote(`Saved ${name}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not build the workbook.");
    } finally {
      setExporting(false);
    }
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
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Price History</h2>
          <p className="text-sm text-[var(--muted)]">
            Every recorded session for one ticker — chart it, read it, export it
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={bars.length === 0}
            title="The sessions loaded on this page, oldest to newest, as a CSV"
            className="px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)] disabled:opacity-40"
          >
            Export CSV
          </button>
          <button
            onClick={exportWorkbook}
            disabled={exporting || bars.length === 0}
            title="Every trading day the source has, with one column per indicator at the app's default weights"
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg disabled:opacity-50"
          >
            {exporting ? "Building workbook…" : "Export Excel (all days + indicators)"}
          </button>
        </div>
      </div>

      {/* ─── Controls ──────────────────────────────────────────── */}
      <div className="glass rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commitSymbol(input);
          }}
          className="relative flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="Ticker (AAPL)"
            aria-label="Ticker symbol"
            className="w-32 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm uppercase tracking-wide focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 transition-colors"
          >
            Load
          </button>
          {showSuggestions && (visibleSuggestions.length > 0 || suggestLoading) && (
            <div className="absolute left-0 top-full mt-1 w-72 z-30 rounded-xl border border-[var(--card-border)] shadow-xl overflow-hidden py-1"
              style={{ background: "var(--card)" }}>
              {suggestLoading && visibleSuggestions.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--muted)]">Searching…</p>
              ) : (
                <SymbolSuggestionList
                  items={visibleSuggestions}
                  onPick={(item) => commitSymbol(item.symbol)}
                />
              )}
            </div>
          )}
        </form>

        {showSuggestions && suggestError && (
          <span className="text-[11px] text-amber-500 dark:text-amber-400">
            Ticker search unavailable ({suggestError}) — type the symbol and press Enter.
          </span>
        )}

        <div className="flex items-center gap-1 bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-1 flex-wrap">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setYears(r.years)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                years === r.years
                  ? "bg-indigo-600 text-white"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {data?.meta && (
          <div className="text-xs text-[var(--muted)] min-w-0">
            <span className="font-semibold text-[var(--foreground)]">{data.meta.symbol}</span>
            {data.meta.name ? ` · ${data.meta.name}` : ""}
            {data.meta.exchange ? ` · ${data.meta.exchange}` : ""}
            {data.meta.currency ? ` · ${data.meta.currency}` : ""}
          </div>
        )}
      </div>

      {note && <p className="text-xs text-[var(--muted)] font-mono break-all">{note}</p>}

      {error && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : data && bars.length > 0 ? (
        <>
          {/* ─── Summary ───────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {kpi(
              "Last close",
              fmtPrice(summary.lastClose),
              summary.lastDate ?? undefined,
            )}
            {kpi(
              "Change in window",
              fmtPct(summary.changePct),
              summary.change == null ? undefined : `${summary.change >= 0 ? "+" : "−"}${fmtPrice(Math.abs(summary.change))}`,
              tone(summary.change),
            )}
            {kpi("Window high", fmtPrice(summary.high), `Low ${fmtPrice(summary.low)}`)}
            {kpi(
              "52-week range",
              summary.high52 == null ? "—" : `${fmtPrice(summary.low52)} – ${fmtPrice(summary.high52)}`,
              summary.high52 == null
                ? "Needs 252 sessions"
                : `${fmtPct(summary.distanceFromHigh52Pct)} from the high`,
            )}
            {kpi(
              "Sessions",
              String(summary.bars),
              summary.spanYears == null ? undefined : `${summary.spanYears.toFixed(1)} years · ${summary.upDays} up / ${summary.downDays} down`,
            )}
            {kpi(
              "Avg volume (window)",
              fmtVolume(summary.avgVolume),
              `Mean of the ${summary.bars} loaded sessions · ${data.source === "yahoo" ? "Yahoo" : "local cache"}`,
            )}
          </div>

          {/* ─── Chart ─────────────────────────────────────────── */}
          <div className="glass rounded-2xl p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold">Close price</h3>
              <span className="text-[11px] text-[var(--muted)]">
                {chartPoints.length < bars.length
                  ? `Chart thinned to ${chartPoints.length} of ${bars.length} sessions — the table and exports keep every session`
                  : `${bars.length} sessions`}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartPoints} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid-stroke)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--muted)" }}
                  minTickGap={48}
                  stroke="var(--grid-stroke)"
                />
                <YAxis
                  yAxisId="price"
                  domain={["auto", "auto"]}
                  tick={{ fontSize: 10, fill: "var(--muted)" }}
                  stroke="var(--grid-stroke)"
                  width={64}
                />
                <YAxis yAxisId="volume" orientation="right" hide />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--card-border)",
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "var(--muted)" }}
                />
                <Bar
                  yAxisId="volume"
                  dataKey="volume"
                  fill="var(--grid-stroke)"
                  opacity={0.5}
                  name="Volume"
                />
                <Area
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  name="Close"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fill="var(--primary)"
                  fillOpacity={0.12}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* ─── Daily table ───────────────────────────────────── */}
          <div className="glass rounded-2xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-[var(--card-border)]">
              <div>
                <h3 className="text-sm font-semibold">Daily prices</h3>
                <p className="text-[11px] text-[var(--muted)]">
                  Newest first · showing {rows.length} of {bars.length} sessions
                </p>
              </div>
              <div className="flex items-center gap-1 bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-1">
                {ROW_LIMITS.map((l) => (
                  <button
                    key={l.label}
                    onClick={() => setRowLimit(l.value)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      rowLimit === l.value
                        ? "bg-indigo-600 text-white"
                        : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10" style={{ background: "var(--card)" }}>
                  <tr className="text-[11px] uppercase tracking-wider text-[var(--muted)] text-right">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Open</th>
                    <th className="px-3 py-2 font-medium">High</th>
                    <th className="px-3 py-2 font-medium">Low</th>
                    <th className="px-3 py-2 font-medium">Close</th>
                    <th className="px-3 py-2 font-medium">Change</th>
                    <th className="px-3 py-2 font-medium">Change %</th>
                    <th className="px-4 py-2 font-medium">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.date}
                      className="border-t border-[var(--card-border)]/60 hover:bg-[var(--table-row-hover)] text-right"
                    >
                      <td className="px-4 py-2 text-left whitespace-nowrap font-mono text-xs">{r.date}</td>
                      <td className="px-3 py-2">{fmtPrice(r.open)}</td>
                      <td className="px-3 py-2">{fmtPrice(r.high)}</td>
                      <td className="px-3 py-2">{fmtPrice(r.low)}</td>
                      <td className="px-3 py-2 font-medium">{fmtPrice(r.close)}</td>
                      <td className={`px-3 py-2 ${tone(r.change)}`}>
                        {r.change == null ? "—" : `${r.change >= 0 ? "+" : "−"}${fmtPrice(Math.abs(r.change))}`}
                      </td>
                      <td className={`px-3 py-2 ${tone(r.changePct)}`}>{fmtPct(r.changePct)}</td>
                      <td className="px-4 py-2 text-[var(--muted)]">{fmtVolume(r.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            One row per trading session — weekends and market holidays have no bar because there was no
            session, and nothing here is forward-filled.{" "}
            {data.source === "yahoo"
              ? "Yahoo history is dividend-adjusted."
              : "Served from the local price cache."}{" "}
            A series imported from a workbook keeps its own basis, so the same ticker can differ between
            sources. The 52-week pair needs 252 sessions and stays blank until it has them.
          </p>
        </>
      ) : (
        !error && <p className="text-sm text-[var(--muted)]">No sessions loaded for {symbol}.</p>
      )}
    </div>
  );
}
