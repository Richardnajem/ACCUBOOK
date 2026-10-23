"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  researchToCsv,
  type AnnualRow,
  type CompanyMatch,
  type CompanyResearch,
  type MetricKey,
  type RatioRow,
  type ResearchFiling,
  type ValuationMetric,
} from "@/lib/research";

// ─── formatting — every null prints as an em dash, never as zero ────────────

const money = (n: number | null | undefined, currency = "USD"): string =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(n);

const moneyExact = (n: number | null | undefined, currency = "USD"): string =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);

const ratio = (n: number | null | undefined): string =>
  n == null ? "—" : n.toFixed(2);

const percent = (n: number | null | undefined): string =>
  n == null ? "—" : `${(n * 100).toFixed(1)}%`;

const signedPercent = (n: number | null | undefined): string =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

const metricValue = (m: ValuationMetric): string =>
  m.kind === "money" ? moneyExact(m.value) : m.kind === "percent" ? percent(m.value) : ratio(m.value);

const quoteTime = (ms: number | null): string =>
  ms == null ? "time not stamped by the source" : new Date(ms).toLocaleString();

const fetchedAt = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

// ─── statement layout ──────────────────────────────────────────────────────

type MoneyFormat = (n: number | null, currency: string) => string;

const INCOME_ROWS: { key: MetricKey; label: string; format: MoneyFormat }[] = [
  { key: "revenue", label: "Revenue", format: money },
  { key: "grossProfit", label: "Gross profit", format: money },
  { key: "operatingIncome", label: "Operating income", format: money },
  { key: "netIncome", label: "Net income", format: money },
  { key: "epsDiluted", label: "EPS (diluted)", format: moneyExact },
];

const BALANCE_ROWS: { key: MetricKey; label: string; format: MoneyFormat }[] = [
  { key: "assets", label: "Total assets", format: money },
  { key: "liabilities", label: "Total liabilities", format: money },
  { key: "equity", label: "Shareholders' equity", format: money },
  { key: "currentAssets", label: "Current assets", format: money },
  { key: "currentLiabilities", label: "Current liabilities", format: money },
  { key: "cash", label: "Cash & equivalents", format: money },
  { key: "debt", label: "Long-term debt", format: money },
];

const CASHFLOW_ROWS: { key: MetricKey | "freeCashFlow"; label: string; format: MoneyFormat }[] = [
  { key: "operatingCashFlow", label: "Operating cash flow", format: money },
  { key: "capex", label: "Capital expenditure", format: money },
  { key: "freeCashFlow", label: "Free cash flow", format: money },
  { key: "dividendsPaid", label: "Dividends paid", format: money },
  { key: "depreciation", label: "D&A", format: money },
];

const RATIO_ROWS: { key: keyof RatioRow; label: string; format: (n: number | null) => string }[] = [
  { key: "grossMargin", label: "Gross margin", format: percent },
  { key: "operatingMargin", label: "Operating margin", format: percent },
  { key: "netMargin", label: "Net margin", format: percent },
  { key: "returnOnEquity", label: "Return on equity", format: percent },
  { key: "returnOnAssets", label: "Return on assets", format: percent },
  { key: "debtToEquity", label: "Debt / equity", format: ratio },
  { key: "currentRatio", label: "Current ratio", format: ratio },
  { key: "freeCashFlowMargin", label: "FCF margin", format: percent },
  { key: "revenueGrowth", label: "Revenue growth YoY", format: signedPercent },
  { key: "epsGrowth", label: "EPS growth YoY", format: signedPercent },
  { key: "freeCashFlowGrowth", label: "FCF growth YoY", format: signedPercent },
];

type StatementTab = "income" | "balance" | "cashflow";

const STATEMENT_TABS: { id: StatementTab; label: string }[] = [
  { id: "income", label: "Income statement" },
  { id: "balance", label: "Balance sheet" },
  { id: "cashflow", label: "Cash flow" },
];

const PRESETS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

// Peer lists are a per-ticker convenience, kept on this device only.
const PEER_STORAGE_KEY = "stockfolio-research-peers-v1";
const MAX_PEERS = 4;

function readPeers(ticker: string): string[] {
  try {
    const raw = window.localStorage.getItem(PEER_STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const list = all[ticker];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string").slice(0, MAX_PEERS) : [];
  } catch {
    return [];
  }
}

function writePeers(ticker: string, peers: string[]) {
  try {
    const raw = window.localStorage.getItem(PEER_STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    all[ticker] = peers;
    window.localStorage.setItem(PEER_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable — the comparison still works for this session.
  }
}

function downloadFile(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function ResearchPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>}>
      <ResearchView />
    </Suspense>
  );
}

function ResearchView() {
  const searchParams = useSearchParams();
  const initialTicker = (searchParams.get("ticker") ?? "").trim().toUpperCase();

  const [ticker, setTicker] = useState(initialTicker);
  const [request, setRequest] = useState<{ symbol: string; nonce: number; refresh: boolean } | null>(
    initialTicker ? { symbol: initialTicker, nonce: 0, refresh: false } : null
  );
  const [loading, setLoading] = useState(!!initialTicker);
  const [error, setError] = useState("");
  const [data, setData] = useState<CompanyResearch | null>(null);
  const [tab, setTab] = useState<StatementTab>("income");

  // Autocomplete + peer comparison
  const [suggestions, setSuggestions] = useState<CompanyMatch[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [peers, setPeers] = useState<string[]>([]);
  const [peerResearch, setPeerResearch] = useState<Record<string, CompanyResearch>>({});
  const [peerInput, setPeerInput] = useState("");

  // Manual submit: all state changes happen in the event handler.
  const submit = (symbol?: string, refresh = false) => {
    const s = (symbol ?? ticker).trim().toUpperCase();
    if (!s) return;
    setTicker(s);
    setLoading(true);
    setError("");
    setSearchOpen(false);
    setSuggestions([]);
    // Functional update keeps a re-submit of the same ticker distinct
    // without reading the clock during render.
    setRequest((prev) => ({ symbol: s, nonce: (prev?.nonce ?? 0) + 1, refresh }));
  };

  // Debounced SEC ticker/name search for the input dropdown.
  useEffect(() => {
    if (!searchOpen) return;
    const q = ticker.trim();
    if (q.length < 2) {
      const clear = setTimeout(() => setSuggestions([]), 0);
      return () => clearTimeout(clear);
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch(`/api/research/search?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((body: { matches?: CompanyMatch[] }) => {
          if (!cancelled) setSuggestions(body.matches ?? []);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ticker, searchOpen]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const url = `/api/research?ticker=${encodeURIComponent(request.symbol)}${request.refresh ? "&refresh=1" : ""}`;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as CompanyResearch & { error?: string };
        return { ok: res.ok, body };
      })
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          setError(body.error || `Research failed for ${request.symbol}.`);
          setData(null);
        } else {
          setData(body);
          setError("");
          // Load this ticker's saved peer list with the ticker itself.
          setPeers(readPeers(body.profile.ticker));
          setPeerResearch({});
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Research request failed.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Fetch every peer in parallel; a failed peer is simply absent from the
  // table and the row shows "loading" only until the batch settles.
  useEffect(() => {
    if (!data || peers.length === 0) return;
    let cancelled = false;
    Promise.all(
      peers.map((p) =>
        fetch(`/api/research?ticker=${encodeURIComponent(p)}`, { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<CompanyResearch>) : null))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, CompanyResearch> = {};
      results.forEach((r, i) => {
        if (r && !("error" in r)) next[peers[i]] = r;
      });
      setPeerResearch(next);
    });
    return () => {
      cancelled = true;
    };
  }, [peers, data]);

  const addPeer = (symbol: string) => {
    const s = symbol.trim().toUpperCase();
    if (!s || !data) return;
    const current = data.profile.ticker;
    if (s === current || peers.includes(s) || peers.length >= MAX_PEERS) return;
    const next = [...peers, s];
    setPeers(next);
    writePeers(current, next);
    setPeerInput("");
  };

  const removePeer = (symbol: string) => {
    if (!data) return;
    const next = peers.filter((p) => p !== symbol);
    setPeers(next);
    writePeers(data.profile.ticker, next);
  };

  const exportJson = () => {
    if (!data) return;
    downloadFile(
      `${data.profile.ticker}-research.json`,
      JSON.stringify(data, null, 2),
      "application/json"
    );
  };

  const exportCsv = () => {
    if (!data) return;
    downloadFile(`${data.profile.ticker}-research.csv`, researchToCsv(data), "text/csv;charset=utf-8");
  };

  const chartData = useMemo(
    () =>
      data
        ? [...data.annual]
            .reverse()
            .map((r) => ({
              fy: `FY${r.fy}`,
              revenue: r.revenue === null ? null : r.revenue / 1e9,
              netIncome: r.netIncome === null ? null : r.netIncome / 1e9,
            }))
        : [],
    [data]
  );

  const years = data ? data.annual : [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">Company Research</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            Fundamentals from SEC EDGAR filings, valued against the live quote. Every figure is a filed
            XBRL fact; anything the filer did not report is shown as &ldquo;—&rdquo;.
          </p>
        </div>
      </div>

      {/* Search */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="glass rounded-xl p-4 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1" htmlFor="research-ticker">
            Ticker or CIK
          </label>
          <input
            id="research-ticker"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="AAPL"
            autoComplete="off"
            className="w-52 px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={loading || !ticker.trim()}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
        >
          {loading ? "Loading…" : "Analyse"}
        </button>
        <div className="flex flex-wrap items-center gap-1 text-xs text-[var(--muted)]">
          <span className="mr-1">Try:</span>
          {PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => submit(s)}
              className="px-2 py-1 rounded border border-[var(--card-border)] hover:border-indigo-500/50 hover:text-[var(--foreground)]"
            >
              {s}
            </button>
          ))}
        </div>
        <p className="w-full text-[11px] text-[var(--muted)]">
          SEC filers only (US listings and foreign private issuers filing 20-F). Use the ticker as it
          appears on the filing, e.g. <span className="font-mono">BRK-B</span>.
        </p>
      </form>

      {error && (
        <div className="glass rounded-xl p-4 border border-red-500/30">
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
          <p className="text-xs text-[var(--muted)] mt-1">
            If the company is not an SEC filer, this research view has no filings to read — it will not
            invent a profile or figures.
          </p>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      )}

      {data && (
        <>
          {/* Profile */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold">{data.profile.name}</h2>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-500 dark:text-indigo-400">
                    {data.profile.ticker}
                  </span>
                  {data.profile.exchanges.map((ex) => (
                    <span key={ex} className="text-[10px] px-2 py-0.5 rounded border border-[var(--card-border)] text-[var(--muted)]">
                      {ex}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs text-[var(--muted)]">
                  <span>CIK {data.profile.cik}</span>
                  {data.profile.industry && <span>{data.profile.industry}</span>}
                  {data.profile.sic && <span>SIC {data.profile.sic}</span>}
                  {data.profile.stateOfIncorporation && <span>Incorporated {data.profile.stateOfIncorporation}</span>}
                  {data.profile.fiscalYearEnd && <span>Fiscal year ends {data.profile.fiscalYearEnd}</span>}
                </div>
                {data.profile.address && (
                  <p className="text-xs text-[var(--muted)] mt-1">{data.profile.address}</p>
                )}
                {data.profile.formerNames.length > 0 && (
                  <p className="text-[11px] text-[var(--muted)] mt-1">
                    Formerly {data.profile.formerNames.map((f) => f.name).filter(Boolean).join(", ")}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold tabular-nums">
                  {data.quote?.price != null ? moneyExact(data.quote.price) : "—"}
                </p>
                <p
                  className={`text-sm tabular-nums ${
                    (data.quote?.changePercent ?? 0) >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"
                  }`}
                >
                  {data.quote?.changePercent != null
                    ? `${data.quote.changePercent >= 0 ? "+" : ""}${data.quote.changePercent.toFixed(2)}%`
                    : data.quoteError
                      ? "price unavailable"
                      : "—"}
                </p>
                <p className="text-[11px] text-[var(--muted)] mt-1">
                  {data.quote?.source ? `${data.quote.source} · ` : ""}
                  {data.quote ? quoteTime(data.quote.tradeTime) : "no live quote"}
                </p>
              </div>
            </div>
            {data.profile.tickers.length > 1 && (
              <p className="text-[11px] text-[var(--muted)] mt-2">
                Filings list {data.profile.tickers.join(", ")}.
              </p>
            )}
          </div>

          {/* Valuation */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
              <h3 className="font-semibold">Valuation</h3>
              <p className="text-[11px] text-[var(--muted)]">
                Price now vs FY{data.valuation.fiscalYear ?? "—"} filed figures · as of {fetchedAt(data.fetchedAt)}
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
              {data.valuation.metrics.map((m) => (
                <div key={m.label} className="rounded-lg border border-[var(--card-border)] p-3">
                  <p className="text-[11px] text-[var(--muted)]">{m.label}</p>
                  <p className="text-lg font-bold tabular-nums">{metricValue(m)}</p>
                  <p className="text-[10px] text-[var(--muted)] leading-tight mt-0.5">{m.basis}</p>
                </div>
              ))}
            </div>
            {data.quote === null && (
              <p className="text-xs text-amber-500 dark:text-amber-400 mt-3">
                Multiples need a live price, which this quote feed did not return. Fundamentals below are
                unaffected.
              </p>
            )}
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <div className="glass rounded-xl p-5">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <h3 className="font-semibold">Revenue &amp; net income</h3>
                <p className="text-[11px] text-[var(--muted)]">
                  {data.currency} billions, filed fiscal years
                </p>
              </div>
              <div className="h-64 mt-3">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" />
                    <XAxis dataKey="fy" tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--card-border)" />
                    <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--card-border)" />
                    <Tooltip
                      contentStyle={{
                        background: "var(--card-bg, #111827)",
                        border: "1px solid var(--card-border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value) =>
                        value == null ? "—" : `${data.currency} ${Number(value).toFixed(2)}B`
                      }
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="revenue" name="Revenue" fill="#6366f1" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="netIncome" name="Net income" fill="#22c55e" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Statements */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="font-semibold">Financial statements</h3>
              <div className="flex gap-1">
                {STATEMENT_TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      tab === t.id
                        ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-500 dark:text-indigo-400"
                        : "border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {years.length === 0 ? (
              <p className="text-sm text-[var(--muted)] py-8 text-center">
                This filer has no annual XBRL statements in the SEC dataset.
              </p>
            ) : (
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)] border-b border-[var(--card-border)]">
                      <th className="py-2 pr-4 font-medium">{data.currency}</th>
                      {years.map((y) => (
                        <th key={y.end} className="py-2 px-3 font-medium text-right whitespace-nowrap">
                          FY{y.fy}
                          <span className="block text-[10px] font-normal normal-case">{y.end}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(tab === "income" ? INCOME_ROWS : tab === "balance" ? BALANCE_ROWS : CASHFLOW_ROWS).map(
                      (row) => (
                        <tr key={row.label} className="border-b border-[var(--card-border)]/60">
                          <td className="py-2 pr-4 text-[var(--muted)] whitespace-nowrap">{row.label}</td>
                          {years.map((y) => {
                            const value =
                              row.key === "freeCashFlow"
                                ? (y as AnnualRow).freeCashFlow
                                : y[row.key as MetricKey];
                            return (
                              <td key={y.end} className="py-2 px-3 text-right tabular-nums">
                                {row.format(value, data.currency)}
                              </td>
                            );
                          })}
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Ratios */}
          {data.ratios.length > 0 && (
            <div className="glass rounded-xl p-5">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <h3 className="font-semibold">Ratios &amp; growth</h3>
                <p className="text-[11px] text-[var(--muted)]">
                  Computed from the filed statements · ROE/ROA use closing equity/assets
                </p>
              </div>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)] border-b border-[var(--card-border)]">
                      <th className="py-2 pr-4 font-medium">Metric</th>
                      {data.ratios.map((r) => (
                        <th key={r.fy} className="py-2 px-3 font-medium text-right whitespace-nowrap">
                          FY{r.fy}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {RATIO_ROWS.map((row) => (
                      <tr key={row.label} className="border-b border-[var(--card-border)]/60">
                        <td className="py-2 pr-4 text-[var(--muted)] whitespace-nowrap">{row.label}</td>
                        {data.ratios.map((r) => (
                          <td key={r.fy} className="py-2 px-3 text-right tabular-nums">
                            {row.format(r[row.key] as number | null)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Filings */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2">
              <h3 className="font-semibold">Recent SEC filings</h3>
              <a
                href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${data.profile.cik}&type=&dateb=&owner=include&count=40`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-500 dark:text-indigo-400 hover:underline"
              >
                All filings on EDGAR ↗
              </a>
            </div>
            {data.filings.length === 0 ? (
              <p className="text-sm text-[var(--muted)] py-6 text-center">No recent filings listed.</p>
            ) : (
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)] border-b border-[var(--card-border)]">
                      <th className="py-2 pr-4 font-medium">Form</th>
                      <th className="py-2 px-3 font-medium">Filed</th>
                      <th className="py-2 px-3 font-medium">Period</th>
                      <th className="py-2 px-3 font-medium">Description</th>
                      <th className="py-2 px-3 font-medium text-right">Document</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.filings.map((f, i) => (
                      <FilingRow key={`${f.form}-${f.filed}-${i}`} filing={f} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Provenance / honesty */}
          <div className="glass rounded-xl p-5">
            <h3 className="font-semibold mb-2">Sources &amp; coverage</h3>
            <ul className="text-xs text-[var(--muted)] space-y-1 list-disc pl-4">
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
              <a href={data.source.submissions} target="_blank" rel="noreferrer" className="hover:underline">
                SEC submissions ↗
              </a>
              <a href={data.source.facts} target="_blank" rel="noreferrer" className="hover:underline">
                SEC XBRL company facts ↗
              </a>
              <span>Fetched {fetchedAt(data.fetchedAt)}</span>
              <span className="font-mono">UA: {data.source.secUserAgent}</span>
            </div>
            <p className="text-[11px] text-[var(--muted)] mt-2">
              Not investment advice. Figures are as filed and can be restated by the company; the latest
              filing for a period wins. Analyst estimates, ratings and TTM multiples are not included
              because they are not in the SEC dataset.
            </p>
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div className="glass rounded-xl p-10 text-center">
          <p className="font-medium">Search a company to see its filings-based research</p>
          <p className="text-sm text-[var(--muted)] mt-1 max-w-xl mx-auto">
            Profile, five years of statements, ratios, valuation against the live quote and recent
            filings — assembled from SEC EDGAR, with the source concept behind every number.
          </p>
        </div>
      )}
    </div>
  );
}

function FilingRow({ filing }: { filing: ResearchFiling }) {
  return (
    <tr className="border-b border-[var(--card-border)]/60">
      <td className="py-2 pr-4 font-mono text-xs">{filing.form}</td>
      <td className="py-2 px-3 tabular-nums whitespace-nowrap">{filing.filed || "—"}</td>
      <td className="py-2 px-3 tabular-nums whitespace-nowrap">{filing.period ?? "—"}</td>
      <td className="py-2 px-3 text-[var(--muted)] max-w-xs truncate">{filing.description ?? "—"}</td>
      <td className="py-2 px-3 text-right">
        <a
          href={filing.url}
          target="_blank"
          rel="noreferrer"
          className="text-indigo-500 dark:text-indigo-400 hover:underline"
        >
          Open ↗
        </a>
      </td>
    </tr>
  );
}
