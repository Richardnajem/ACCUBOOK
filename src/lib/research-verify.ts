// ─── Cross-source verification for the research tab ────────────────────────
//
// The research view reads its statements from one place (SEC XBRL company
// facts). One source cannot catch its own mistakes — a wrong tag, a period
// picked from a comparative column, a filer whose "revenue" tag covers only
// part of the business all look fine in isolation.
//
// This module reads the same figures from four other places and reports the
// agreement per figure, so a number is either confirmed by independent reads
// or visibly in dispute:
//
//   1. SEC XBRL company facts      — the numbers the page shows (primary)
//   2. SEC XBRL company concept    — the raw series for the tag we chose,
//                                    re-read from its own endpoint: catches a
//                                    wrong period, tag or restatement pick
//   3. SEC XBRL frames             — the company-independent CY frame (every
//                                    filer's value for that period/tag)
//   4. Nasdaq                      — an independent vendor's annual statements
//   5. Yahoo Finance               — a second independent vendor
//
// Nothing is averaged and nothing is "corrected": a disagreement is reported
// with both values and the delta. Sources fail independently, and a failure is
// reported as unavailable rather than as agreement.
//
// All parsing below is pure and exported, so `tests/research-verify.test.ts`
// pins the arithmetic on fixtures and never touches the network.

const SEC_UA =
  process.env.SEC_USER_AGENT ||
  "Stockfolio research (local app; contact: stockfolio@example.com)";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TIMEOUT_MS = 12_000;

// ─── What gets verified ────────────────────────────────────────────────────

export type VerifyMetric =
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "epsDiluted"
  | "assets"
  | "liabilities"
  | "equity"
  | "cash"
  | "operatingCashFlow"
  | "capex";

export const VERIFY_METRICS: { metric: VerifyMetric; label: string; tolerance: number }[] = [
  { metric: "revenue", label: "Revenue", tolerance: 0.005 },
  { metric: "grossProfit", label: "Gross profit", tolerance: 0.005 },
  { metric: "operatingIncome", label: "Operating income", tolerance: 0.005 },
  { metric: "netIncome", label: "Net income", tolerance: 0.005 },
  { metric: "epsDiluted", label: "EPS (diluted)", tolerance: 0.01 },
  { metric: "assets", label: "Total assets", tolerance: 0.005 },
  { metric: "liabilities", label: "Total liabilities", tolerance: 0.005 },
  { metric: "equity", label: "Shareholders' equity", tolerance: 0.005 },
  { metric: "cash", label: "Cash & equivalents", tolerance: 0.01 },
  { metric: "operatingCashFlow", label: "Operating cash flow", tolerance: 0.005 },
  { metric: "capex", label: "Capital expenditure", tolerance: 0.005 },
];

/** One fiscal year the page shows, as the primary source computed it. */
export interface VerifyAnnualRow {
  fy: number;
  end: string;
  values: Partial<Record<VerifyMetric, number | null>>;
  /**
   * The XBRL concept that supplied each value FOR THIS PERIOD. It has to be
   * per period: a filer can move from CashAndCashEquivalentsAtCarryingValue to
   * the restricted-cash tag between years, and re-reading the newest tag for
   * an older year would invent a disagreement with the raw series.
   */
  tags?: Partial<Record<VerifyMetric, string>>;
}

/** One row a verification source returned, keyed by its own period end. */
export interface SourceRow {
  end: string;
  values: Partial<Record<VerifyMetric, number | null>>;
}

export type SourceKind = "sec-primary" | "sec-api" | "vendor";

export interface VerifySource {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  ok: boolean;
  error?: string;
  ms: number;
  rows: SourceRow[];
}

export type MatchStatus = "match" | "near" | "differs" | "unavailable";

export interface SourceMatch {
  source: string;
  value: number | null;
  /** signed difference vs the primary, as a fraction of the primary value */
  diffPct: number | null;
  status: MatchStatus;
  /** why a value was not comparable (different currency, blank in the feed) */
  note?: string;
}

export type FigureVerdict = "verified" | "conflict" | "single-source" | "not-reported";

export interface FigureCheck {
  metric: VerifyMetric;
  label: string;
  fy: number;
  end: string;
  primary: number | null;
  /** every non-primary source, in display order */
  matches: SourceMatch[];
  /** independent sources that returned this figure at all */
  readBy: number;
  /** independent sources that agreed with the primary */
  confirmedBy: number;
  verdict: FigureVerdict;
}

export interface VerificationSummary {
  figures: number;
  verified: number;
  conflicts: number;
  singleSource: number;
  notReported: number;
  sources: number;
  sourcesOk: number;
}

export interface ResearchVerification {
  checkedAt: string;
  sources: { id: string; name: string; kind: SourceKind; ok: boolean; error?: string; ms: number; figures: number; url: string }[];
  figures: FigureCheck[];
  summary: VerificationSummary;
  note: string;
}

// ─── Comparison (pure) ─────────────────────────────────────────────────────

/**
 * Compare one source value with the primary. `tolerance` is relative for money
 * lines and absolute for per-share values; anything inside it is a match,
 * anything up to 3× it is "near" (rounding, a calendar-year alignment or a
 * slightly different line definition — shown with its delta, and still treated
 * as corroboration), and anything beyond that is a conflict. A missing side is
 * never a match.
 */
export function matchStatus(
  primary: number | null,
  candidate: number | null,
  tolerance: number,
  absolute = false
): MatchStatus {
  if (primary === null || candidate === null) return "unavailable";
  const diff = Math.abs(candidate - primary);
  const allowed = absolute ? tolerance : Math.abs(primary) * tolerance;
  if (diff <= allowed) return "match";
  if (diff <= allowed * 3) return "near";
  return "differs";
}

/**
 * Turn the primary rows + every source's rows into per-figure checks.
 *
 * Periods are matched by fiscal-year label first and by `end` date second,
 * because vendors align a 52/53-week filer to a month end (AAPL 2026-09-26 is
 * Yahoo's 2026-09-30). A source row can only answer for the period it covers.
 */
/**
 * A source whose money figures are a constant multiple of the primary is
 * reporting in another currency (or another scale), not disagreeing: Nasdaq
 * files ASML in USD while ASML's statements are EUR. Comparing those would
 * manufacture ten "conflicts" out of one conversion, so that source's money
 * lines are marked unavailable with the factor instead.
 *
 * True when every sample sits within 2 % of the median — a single factor.
 */
function isConstantScale(ratios: number[]): boolean {
  const m = median(ratios);
  return m > 0 && ratios.every((r) => Math.abs(r - m) / m < 0.02) && (m < 0.95 || m > 1.05);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The money-line ratios one source shows for ONE period (per-share excluded). */
function rowRatios(row: VerifyAnnualRow, hit: SourceRow | null): number[] {
  if (!hit) return [];
  const ratios: number[] = [];
  for (const spec of VERIFY_METRICS) {
    if (spec.metric === "epsDiluted") continue;
    const primary = row.values[spec.metric] ?? null;
    const value = hit.values[spec.metric] ?? null;
    if (primary && value) ratios.push(Math.abs(value / primary));
  }
  return ratios;
}

export function compareFigures(
  annual: VerifyAnnualRow[],
  sources: VerifySource[],
  primaryId = "sec-facts"
): FigureCheck[] {
  const independent = sources.filter((s) => s.id !== primaryId);

  const out: FigureCheck[] = [];
  for (const row of annual) {
    // Per period: a constant money-line factor means a different currency/scale
    // for that year (a filer that switched reporting currency would only show
    // it in the years on either side of the change).
    const rowScale = new Map<string, number>();
    for (const src of independent) {
      const ratios = rowRatios(row, findRow(src.rows, row));
      if (ratios.length >= 3 && isConstantScale(ratios)) rowScale.set(src.id, median(ratios));
    }
    for (const spec of VERIFY_METRICS) {
      const primary = row.values[spec.metric] ?? null;
      const absolute = spec.metric === "epsDiluted";
      // Capex is reported as a positive outflow here and as a negative cash
      // movement by some vendors; the amount is what matters.
      const normalise = (v: number | null) => (v === null ? null : spec.metric === "capex" ? Math.abs(v) : v);
      const matches: SourceMatch[] = [];
      for (const src of independent) {
        const hit = findRow(src.rows, row);
        const value = normalise(hit?.values[spec.metric] ?? null);
        const factor = rowScale.get(src.id);
        if (value !== null && factor && spec.metric !== "epsDiluted") {
          matches.push({
            source: src.name,
            value: null,
            diffPct: null,
            status: "unavailable",
            note: `figures are ×${factor.toFixed(2)} of the statement values — a different currency or scale, so not compared`,
          });
          continue;
        }
        if (value === 0 && primary !== null && primary !== 0) {
          // A vendor's 0 where the filer reports a figure is a blank in their
          // feed (Yahoo sends grossProfit: 0 when it has no cost of revenue).
          matches.push({ source: src.name, value: null, diffPct: null, status: "unavailable", note: "reported as 0 by the source (no figure in its feed)" });
          continue;
        }
        matches.push({
          source: src.name,
          value,
          diffPct: primary !== null && value !== null && primary !== 0 ? (value - primary) / Math.abs(primary) : null,
          status: matchStatus(primary, value, spec.tolerance, absolute),
        });
      }
      const readBy = matches.filter((m) => m.value !== null).length;
      // "near" corroborates as well as "match" — the delta is printed beside
      // it, so a 1 % vendor difference is visible rather than hidden.
      const confirmedBy = matches.filter((m) => m.status === "match" || m.status === "near").length;
      const verdict: FigureVerdict =
        primary === null
          ? "not-reported"
          : matches.some((m) => m.status === "differs")
            ? "conflict"
            : confirmedBy > 0
              ? "verified"
              : "single-source";
      out.push({
        metric: spec.metric,
        label: spec.label,
        fy: row.fy,
        end: row.end,
        primary,
        matches,
        readBy,
        confirmedBy,
        verdict,
      });
    }
  }
  return out;
}

/**
 * The source row for this fiscal year. Vendors align a 52/53-week filer to the
 * nearest month end (the SEC's 2026-09-26 is Yahoo's 2026-09-30), so a row
 * within 45 days of the period end is the same year; further away is a
 * different period and must NOT be silently compared.
 */
function findRow(rows: SourceRow[], target: VerifyAnnualRow): SourceRow | null {
  const exact = rows.find((r) => r.end === target.end);
  if (exact) return exact;
  const targetMs = Date.parse(target.end);
  let best: { row: SourceRow; gap: number } | null = null;
  for (const row of rows) {
    const ms = Date.parse(row.end);
    if (!Number.isFinite(ms)) continue;
    const gap = Math.abs(ms - targetMs);
    if (gap <= 45 * 86_400_000 && (!best || gap < best.gap)) best = { row, gap };
  }
  return best?.row ?? null;
}

export function summarise(figures: FigureCheck[], sources: { ok: boolean }[]): VerificationSummary {
  const count = (v: FigureVerdict) => figures.filter((f) => f.verdict === v).length;
  return {
    figures: figures.length,
    verified: count("verified"),
    conflicts: count("conflict"),
    singleSource: count("single-source"),
    notReported: count("not-reported"),
    sources: sources.length,
    sourcesOk: sources.filter((s) => s.ok).length,
  };
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────

async function timedJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Accept: "application/json", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Run at most `limit` promises at once (SEC asks for ≤10 requests/second). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const rawNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Money as published by a vendor: "$1,234,000", "-$12", "--", "" */
export function parseVendorMoney(v: unknown, scale = 1): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v * scale : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[$,%\s]/g, "");
  if (!cleaned || cleaned === "--" || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n * scale : null;
}

// ─── 4. Nasdaq annual statements ───────────────────────────────────────────

interface NasdaqTable {
  headers?: Record<string, string>;
  rows?: ({ value1?: string } & Record<string, string>)[];
}

export interface NasdaqPayload {
  data?: {
    incomeStatementTable?: NasdaqTable;
    balanceSheetTable?: NasdaqTable;
    cashFlowTable?: NasdaqTable;
  };
}

const NASDAQ_MAP: Record<string, VerifyMetric> = {
  "Total Revenue": "revenue",
  "Gross Profit": "grossProfit",
  "Operating Income": "operatingIncome",
  "Net Income": "netIncome",
  "Total Assets": "assets",
  "Total Liabilities": "liabilities",
  "Total Equity": "equity",
  "Cash and Cash Equivalents": "cash",
  "Net Cash Flow-Operating": "operatingCashFlow",
  "Capital Expenditures": "capex",
};

const isoFromUs = (s: string): string => {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
};

/**
 * Nasdaq's annual tables: four periods side by side under value2..value5, each
 * row a label. Values are in THOUSANDS of the reporting currency.
 */
export function parseNasdaqFinancials(json: NasdaqPayload): SourceRow[] {
  const income = json?.data?.incomeStatementTable;
  const headers = income?.headers;
  if (!headers || !income?.rows) return [];
  const tables = [income, json?.data?.balanceSheetTable, json?.data?.cashFlowTable].filter(
    (t): t is NasdaqTable => !!t?.rows
  );
  const rows: SourceRow[] = [];
  for (let i = 2; i <= 5; i++) {
    const end = isoFromUs(headers[`value${i}`] ?? "");
    if (!end) continue;      const values: Partial<Record<VerifyMetric, number | null>> = {};
      for (const table of tables) {
        for (const row of table.rows ?? []) {
          const metric = NASDAQ_MAP[row.value1 ?? ""];
          if (!metric || values[metric] != null) continue;
          // Thousands → units. A blank cell stays null, never 0.
          values[metric] = parseVendorMoney(row[`value${i}`], 1_000);
        }
      }
    if (Object.keys(values).length > 0) rows.push({ end, values });
  }
  return rows;
}

async function fetchNasdaq(sym: string): Promise<SourceRow[]> {
  const json = await timedJson<NasdaqPayload>(
    `https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/financials?frequency=1`,
    { "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*" }
  );
  return parseNasdaqFinancials(json);
}

// ─── 5. Yahoo Finance annual statements ────────────────────────────────────

interface YahooValue {
  raw?: number;
  fmt?: string;
}

type YahooRow = Record<string, unknown> & { endDate?: { fmt?: string; raw?: number } };

export interface YahooPayload {
  quoteSummary?: {
    result?: {
      incomeStatementHistory?: { incomeStatementHistory?: YahooRow[] };
      balanceSheetHistory?: { balanceSheetStatements?: YahooRow[] };
      cashflowStatementHistory?: { cashflowStatements?: YahooRow[] };
    }[];
    error?: { code?: string; description?: string };
  };
}

const YAHOO_MAP: Record<string, VerifyMetric> = {
  totalRevenue: "revenue",
  grossProfit: "grossProfit",
  operatingIncome: "operatingIncome",
  netIncome: "netIncome",
  dilutedEPS: "epsDiluted",
  totalAssets: "assets",
  totalLiab: "liabilities",
  totalStockholderEquity: "equity",
  cash: "cash",
  totalCashFromOperatingActivities: "operatingCashFlow",
  capitalExpenditures: "capex",
};

export function parseYahooSummary(json: YahooPayload): SourceRow[] {
  const result = json?.quoteSummary?.result?.[0];
  if (!result) return [];
  const groups: YahooRow[][] = [
    result.incomeStatementHistory?.incomeStatementHistory ?? [],
    result.balanceSheetHistory?.balanceSheetStatements ?? [],
    result.cashflowStatementHistory?.cashflowStatements ?? [],
  ];
  const byEnd = new Map<string, Partial<Record<VerifyMetric, number | null>>>();
  for (const group of groups) {
    for (const row of group) {
      const end = row.endDate?.fmt ?? "";
      if (!end) continue;
      const values = byEnd.get(end) ?? {};
      for (const [key, metric] of Object.entries(YAHOO_MAP)) {
        const v = row[key] as YahooValue | undefined;
        const n = rawNum(v?.raw);
        if (n !== null && values[metric] == null) values[metric] = n;
      }
      byEnd.set(end, values);
    }
  }
  return [...byEnd.entries()]
    .filter(([, v]) => Object.keys(v).length > 0)
    .map(([end, values]) => ({ end, values }));
}

// Yahoo's quoteSummary needs a cookie + crumb pair since 2024.
let yahooAuth: { cookie: string; crumb: string; at: number } | null = null;

async function yahooCredentials(): Promise<{ cookie: string; crumb: string }> {
  if (yahooAuth && Date.now() - yahooAuth.at < 60 * 60 * 1000) return yahooAuth;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const consent = await fetch("https://fc.yahoo.com/", {
      signal: ctrl.signal,
      headers: { "User-Agent": BROWSER_UA },
    });
    const cookie = (consent.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      signal: ctrl.signal,
      headers: { "User-Agent": BROWSER_UA, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumbRes.ok || !crumb || crumb.length > 24) throw new Error("Yahoo crumb unavailable");
    yahooAuth = { cookie, crumb, at: Date.now() };
    return yahooAuth;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahoo(sym: string): Promise<SourceRow[]> {
  const { cookie, crumb } = await yahooCredentials();
  const modules = [
    "incomeStatementHistory",
    "balanceSheetHistory",
    "cashflowStatementHistory",
  ].join(",");
  const json = await timedJson<YahooPayload>(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      sym.replace(/\./g, "-")
    )}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
    { "User-Agent": BROWSER_UA, Cookie: cookie }
  );
  return parseYahooSummary(json);
}

// ─── 2. SEC company concept (re-read one tag's raw series) ─────────────────

export interface CompanyConceptPayload {
  cik?: number;
  taxonomy?: string;
  tag?: string;
  units?: Record<string, { start?: string; end: string; val: number; fy?: number; fp?: string; form?: string; filed?: string }[]>;
}

/**
 * The newest-filed value a filer reported for `end` under one concept. Same
 * rules as the statement builder: annual forms only, a flow must span ~a year,
 * an instant must not carry a start, and a restatement wins.
 */
export function pickConceptValue(
  json: CompanyConceptPayload,
  opts: { end: string; unit: string; instant: boolean }
): number | null {
  const entries = json?.units?.[opts.unit];
  if (!Array.isArray(entries)) return null;
  let best: { val: number; filed: string } | null = null;
  for (const e of entries) {
    if (e.end !== opts.end) continue;
    if (typeof e.val !== "number" || !Number.isFinite(e.val)) continue;
    const form = e.form ?? "";
    if (!form.startsWith("10-K") && !form.startsWith("20-F")) continue;
    if (e.fp && e.fp !== "FY") continue;
    if (opts.instant && e.start) continue;
    if (!opts.instant && (!e.start || (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000 < 300)) continue;
    const filed = e.filed ?? "";
    if (!best || filed > best.filed) best = { val: e.val, filed };
  }
  return best?.val ?? null;
}

// ─── 3. SEC frames (the company-independent period frame) ──────────────────

export interface FramesPayload {
  data?: { cik: number; entityName?: string; start?: string; end: string; val: number }[];
}

export function pickFrameValue(json: FramesPayload, opts: { cik: string; end: string }): number | null {
  const wanted = Number(opts.cik);
  const hit = (json?.data ?? []).find((d) => Number(d.cik) === wanted && d.end === opts.end);
  return hit && typeof hit.val === "number" && Number.isFinite(hit.val) ? hit.val : null;
}

// ─── Orchestration ─────────────────────────────────────────────────────────

export interface VerifyInput {
  ticker: string;
  cik: string;
  /** ISO currency of the statements */
  currency: string;
  taxonomy: "us-gaap" | "ifrs-full" | "none";
  annual: VerifyAnnualRow[];
}

const INSTANT_METRICS = new Set<VerifyMetric>(["assets", "liabilities", "equity", "cash"]);
const PER_SHARE = new Set<VerifyMetric>(["epsDiluted"]);

const EMPTY_VERIFICATION: ResearchVerification = {
  checkedAt: "",
  sources: [],
  figures: [],
  summary: { figures: 0, verified: 0, conflicts: 0, singleSource: 0, notReported: 0, sources: 0, sourcesOk: 0 },
  note: "",
};

export function emptyVerification(note: string): ResearchVerification {
  return { ...EMPTY_VERIFICATION, checkedAt: new Date().toISOString(), note };
}

/**
 * Read the same annual figures from four other places and report agreement.
 *
 * Never throws: a source that fails is reported as unavailable with its error,
 * and the primary figure stands alone (verdict "single-source"), because an
 * empty cross-check must not look like a pass.
 */
export async function verifyResearch(input: VerifyInput): Promise<ResearchVerification> {
  const latest = input.annual[0];
  if (!latest || input.taxonomy === "none") {
    return emptyVerification("No annual statements to cross-check for this filer.");
  }
  const secHeaders = { "User-Agent": SEC_UA };
  const cik = input.cik.replace(/^0+(?=\d)/, "");
  const cikPadded = input.cik.padStart(10, "0");
  const unit = input.currency;
  // Every concept any period used, so each year is re-read from its own tag.
  const uniqueTags = [
    ...new Set(
      input.annual.flatMap((row) =>
        Object.values(row.tags ?? {}).filter((t): t is string => typeof t === "string" && t.length > 0)
      )
    ),
  ];
  const tagFor = (row: VerifyAnnualRow, metric: VerifyMetric) => row.tags?.[metric] ?? null;

  const postings: Promise<VerifySource>[] = [];

  // ── Nasdaq ──
  postings.push(
    (async () => {
      const started = Date.now();
      const url = `https://api.nasdaq.com/api/company/${input.ticker}/financials?frequency=1`;
      try {
        const rows = await fetchNasdaq(input.ticker);
        return { id: "nasdaq", name: "Nasdaq", kind: "vendor" as const, url, ok: rows.length > 0, rows, ms: Date.now() - started };
      } catch (e) {
        return { id: "nasdaq", name: "Nasdaq", kind: "vendor" as const, url, ok: false, rows: [], error: msg(e), ms: Date.now() - started };
      }
    })()
  );

  // ── Yahoo Finance ──
  postings.push(
    (async () => {
      const started = Date.now();
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${input.ticker}`;
      try {
        const rows = await fetchYahoo(input.ticker);
        return { id: "yahoo", name: "Yahoo Finance", kind: "vendor" as const, url, ok: rows.length > 0, rows, ms: Date.now() - started };
      } catch (e) {
        return { id: "yahoo", name: "Yahoo Finance", kind: "vendor" as const, url, ok: false, rows: [], error: msg(e), ms: Date.now() - started };
      }
    })()
  );

  // ── SEC company concept: one request per tag, all periods ──
  postings.push(
    (async () => {
      const started = Date.now();
      const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/`;
      try {
        const results = await mapLimit(uniqueTags, 4, async (tag) => {
          try {
            return {
              tag,
              json: await timedJson<CompanyConceptPayload>(
                `https://data.sec.gov/api/xbrl/companyconcept/CIK${cikPadded}/${input.taxonomy}/${encodeURIComponent(tag)}.json`,
                secHeaders
              ),
            };
          } catch {
            return { tag, json: null };
          }
        });
        const rows: SourceRow[] = input.annual.map((row) => {
          const values: Partial<Record<VerifyMetric, number | null>> = {};
          for (const spec of VERIFY_METRICS) {
            const tag = tagFor(row, spec.metric);
            if (!tag) continue;
            const json = results.find((r) => r.tag === tag)?.json;
            values[spec.metric] = json
              ? pickConceptValue(json, {
                  end: row.end,
                  unit: PER_SHARE.has(spec.metric) ? `${unit}/shares` : unit,
                  instant: INSTANT_METRICS.has(spec.metric),
                })
              : null;
          }
          return { end: row.end, values };
        });
        const read = rows.some((r) => Object.values(r.values).some((v) => v !== null));
        return {
          id: "sec-concept",
          name: "SEC company concept",
          kind: "sec-api" as const,
          url,
          ok: read,
          rows,
          error: read ? undefined : "no annual facts on the concept endpoints",
          ms: Date.now() - started,
        };
      } catch (e) {
        return { id: "sec-concept", name: "SEC company concept", kind: "sec-api" as const, url, ok: false, rows: [], error: msg(e), ms: Date.now() - started };
      }
    })()
  );

  // ── SEC frames: revenue + net income for the latest fiscal year ──
  postings.push(
    (async () => {
      const started = Date.now();
      const year = latest.end.slice(0, 4);
      const wanted = [
        { metric: "revenue" as VerifyMetric, tag: tagFor(latest, "revenue") },
        { metric: "netIncome" as VerifyMetric, tag: tagFor(latest, "netIncome") },
      ].filter((w): w is { metric: VerifyMetric; tag: string } => !!w.tag);
      const url = `https://data.sec.gov/api/xbrl/frames/${input.taxonomy}/<tag>/${unit}/CY${year}.json`;
      try {
        const results = await mapLimit(wanted, 2, async (w) => {
          try {
            return {
              metric: w.metric,
              json: await timedJson<FramesPayload>(
                `https://data.sec.gov/api/xbrl/frames/${input.taxonomy}/${encodeURIComponent(w.tag)}/${encodeURIComponent(unit)}/CY${year}.json`,
                secHeaders
              ),
            };
          } catch {
            return { metric: w.metric, json: null };
          }
        });
        const values: Partial<Record<VerifyMetric, number | null>> = {};
        for (const r of results) {
          values[r.metric] = r.json ? pickFrameValue(r.json, { cik, end: latest.end }) : null;
        }
        const read = Object.values(values).some((v) => v !== null);
        return {
          id: "sec-frames",
          name: "SEC frames",
          kind: "sec-api" as const,
          url,
          ok: read,
          rows: read ? [{ end: latest.end, values }] : [],
          error: read ? undefined : `no CY${year} frame entry for this filer`,
          ms: Date.now() - started,
        };
      } catch (e) {
        return { id: "sec-frames", name: "SEC frames", kind: "sec-api" as const, url, ok: false, rows: [], error: msg(e), ms: Date.now() - started };
      }
    })()
  );

  const primary: VerifySource = {
    id: "sec-facts",
    name: "SEC company facts",
    kind: "sec-primary",
    url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`,
    ok: true,
    rows: input.annual.map((r) => ({ end: r.end, values: r.values })),
    ms: 0,
  };

  const settled = await Promise.all(postings);
  const all = [primary, ...settled];
  const figures = compareFigures(input.annual, all);
  const summary = summarise(figures, all);

  return {
    checkedAt: new Date().toISOString(),
    sources: all.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      ok: s.ok,
      error: s.error,
      ms: s.ms,
      url: s.url,
      figures: s.rows.reduce(
        (n, r) => n + Object.values(r.values).filter((v) => v !== null && v !== undefined).length,
        0
      ),
    })),
    figures,
    summary,
    note:
      "Five sources are read independently: the SEC company facts behind this page, the SEC company-concept endpoint " +
      "for each chosen tag, the SEC period frame, Nasdaq and Yahoo Finance. Values are compared, never averaged; " +
      "differences usually come from a line definition (net income to common vs total, restricted cash, lease debt) " +
      "or from a vendor's calendar-year alignment, and are shown with both figures.",
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : "failed";
}
