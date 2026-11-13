// ─── Company research from SEC EDGAR (real filings, no estimates) ───────────
//
// Bloomberg-style research needs a fundamentals source that is free, keyless
// and authoritative. SEC EDGAR is exactly that for SEC registrants: every
// figure below is read from a filed XBRL fact, tagged with the concept and
// accession that supplied it. Where a company does not report a line item we
// return null (the UI prints "—") and add a note saying which concept was
// missing — never a modelled substitute.
//
// Sources:
//   https://www.sec.gov/files/company_tickers.json   ticker → CIK
//   https://data.sec.gov/submissions/CIK##########.json   profile + filings
//   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json   XBRL facts
//
// SEC asks for a descriptive User-Agent; set SEC_USER_AGENT to include your
// own contact address. Everything is cached in-process (CIK map 1h, company
// data 15m) so a page refresh does not re-download megabytes.

import { verifyResearch, type ResearchVerification } from "./research-verify";

const SEC_UA =
  process.env.SEC_USER_AGENT ||
  "Stockfolio research (local app; contact: stockfolio@example.com)";

const SEC_TIMEOUT_MS = 25_000;
const TICKER_TTL_MS = 60 * 60 * 1000;
const COMPANY_TTL_MS = 15 * 60 * 1000;
const MAX_YEARS = 5;

// ─── SEC payload shapes (only the fields we read) ───────────────────────────

interface FactEntry {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}

interface FactConcept {
  label?: string;
  units?: Record<string, FactEntry[]>;
}

export interface CompanyFacts {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, FactConcept>>;
}

export interface SubmissionFiling {
  form?: string;
  filingDate?: string;
  reportDate?: string;
  accessionNumber?: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
}

export interface CompanySubmissions {
  cik?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  category?: string;
  entityType?: string;
  formerNames?: { name?: string; from?: string; to?: string }[];
  addresses?: {
    business?: { street1?: string; city?: string; stateOrCountry?: string; zipCode?: string };
  };
  filings?: { recent?: Record<string, string[] | undefined> };
}

// ─── Concept chains ─────────────────────────────────────────────────────────
// Companies switch XBRL tags over time (and IFRS filers use a different
// taxonomy), so each metric is a priority list. Earlier tags win for a period;
// later tags only fill gaps. The winning tag is reported back to the UI.

const US_GAAP: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
  ],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  // Basic is the last resort: some filers (Berkshire, for one) tag only
  // `EarningsPerShareBasic` and state in the text that diluted equals basic.
  // The statement builder adds a note when the basic tag supplied the figure.
  epsDiluted: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: [
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  debt: ["LongTermDebt", "LongTermDebtNoncurrent", "DebtInstrumentCarryingAmount"],
  sharesOutstanding: ["CommonStockSharesOutstanding", "CommonStockSharesIssued"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  // Added for the financial-analysis scores: distress (Altman), earnings
  // manipulation (Beneish), DuPont's tax/interest burden and coverage.
  retainedEarnings: ["RetainedEarningsAccumulatedDeficit"],
  pretaxIncome: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ],
  receivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
  sga: ["SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"],
  propertyPlantEquipment: ["PropertyPlantAndEquipmentNet"],
  interestExpense: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
  dividendsPaid: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
  depreciation: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "Depreciation",
  ],
};

const IFRS: Record<string, string[]> = {
  revenue: ["Revenue", "RevenueFromContractsWithCustomers"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["ProfitLossFromOperatingActivities"],
  netIncome: ["ProfitLoss"],
  epsDiluted: ["DilutedEarningsLossPerShare", "BasicEarningsLossPerShare"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["Equity", "EquityAttributableToOwnersOfParent"],
  currentAssets: ["CurrentAssets"],
  currentLiabilities: ["CurrentLiabilities"],
  cash: ["CashAndCashEquivalents"],
  debt: ["LongtermBorrowings", "Borrowings"],
  sharesOutstanding: ["NumberOfSharesOutstanding"],
  operatingCashFlow: ["CashFlowsFromUsedInOperatingActivities"],
  capex: ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
  retainedEarnings: ["RetainedEarnings"],
  pretaxIncome: ["ProfitLossBeforeTax"],
  receivables: ["CurrentTradeReceivables", "TradeAndOtherCurrentReceivables"],
  sga: ["SellingGeneralAndAdministrativeExpense"],
  propertyPlantEquipment: ["PropertyPlantAndEquipment"],
  interestExpense: ["InterestExpense"],
  dividendsPaid: ["DividendsPaidClassifiedAsFinancingActivities"],
  depreciation: ["DepreciationAndAmortisationExpense"],
};

export interface MetricPick {
  /** value for the period ending at `end` */
  value: number;
  /** XBRL concept that supplied it */
  tag: string;
  /** taxonomy: us-gaap | ifrs-full */
  taxonomy: string;
  /** filing date of the fact used (latest filing that reported the period) */
  filed: string;
  /** earliest filing date that reported the period */
  firstFiled: string;
  /** fiscal year label the company first filed this period under */
  fy: number;
}

export interface AnnualRow {
  fy: number;
  end: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  epsDiluted: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  cash: number | null;
  debt: number | null;
  sharesOutstanding: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  dividendsPaid: number | null;
  depreciation: number | null;
  freeCashFlow: number | null;
  // ── Extended fundamentals used by the financial-analysis scores ──
  /** RetainedEarningsAccumulatedDeficit / RetainedEarnings (instant) */
  retainedEarnings: number | null;
  /** pre-tax income (IncomeLossFromContinuingOperationsBeforeIncomeTaxes…) */
  pretaxIncome: number | null;
  receivables: number | null;
  /** SG&A — needed by Beneish; many filers tag it inconsistently */
  sga: number | null;
  propertyPlantEquipment: number | null;
  interestExpense: number | null;
}

export type MetricKey = Exclude<keyof AnnualRow, "fy" | "end" | "freeCashFlow">;

export interface RatioRow {
  fy: number;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  debtToEquity: number | null;
  currentRatio: number | null;
  freeCashFlowMargin: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  freeCashFlowGrowth: number | null;
}

export interface ValuationMetric {
  label: string;
  value: number | null;
  kind: "money" | "multiple" | "percent";
  /** how the figure was produced, e.g. "price × shares" */
  basis: string;
}

export interface Valuation {
  /** fiscal year of the statement figures used */
  fiscalYear: number | null;
  /** reporting currency of the statements backing the multiples */
  reportingCurrency: string;
  /** USD per 1 unit of reportingCurrency (1 for USD filers) */
  fxRate: number | null;
  /** market cap in the reporting currency (what the multiples divide by) */
  marketCapReporting: number | null;
  /** market cap in USD — price × shares */
  marketCap: number | null;
  enterpriseValue: number | null;
  priceToEarnings: number | null;
  priceToSales: number | null;
  priceToBook: number | null;
  earningsYieldPct: number | null;
  freeCashFlowYieldPct: number | null;
  dividendYieldPct: number | null;
  evToEbitda: number | null;
  ebitda: number | null;
  metrics: ValuationMetric[];
}

export interface ResearchProfile {
  ticker: string;
  name: string;
  cik: string;
  sic: string | null;
  industry: string | null;
  fiscalYearEnd: string | null;
  stateOfIncorporation: string | null;
  category: string | null;
  entityType: string | null;
  exchanges: string[];
  tickers: string[];
  formerNames: { name: string; from: string | null; to: string | null }[];
  address: string | null;
}

export interface PriceSourceCheck {
  source: string;
  ok: boolean;
  price: number | null;
  error?: string;
}

export interface ResearchFiling {
  form: string;
  filed: string;
  period: string | null;
  description: string | null;
  url: string;
}

export interface StatementOrigin {
  /** CIK the statement tables were read from */
  cik: string;
  /** registrant name behind that CIK */
  name: string;
  /** true when this is not the registrant the ticker maps to */
  predecessor: boolean;
  /** why a different CIK was used, in plain words */
  note: string | null;
}

export interface CompanyResearch {
  profile: ResearchProfile;
  /** where the statements came from (a successor registrant may differ from the profile) */
  statementsSource: StatementOrigin;
  /** independent cross-read of the figures; null when verification was skipped */
  verification: ResearchVerification | null;
  /** the price sources behind the quote (null when the route did not supply them) */
  priceSources: PriceSourceCheck[] | null;
  /** how many price sources agreed and how far apart they were */
  priceAgreement: { agreeing: number; spreadPct: number | null } | null;
  /** most recent fiscal year first */
  annual: AnnualRow[];
  ratios: RatioRow[];
  valuation: Valuation;
  filings: ResearchFiling[];
  quote: {
    price: number | null;
    previousClose: number | null;
    changePercent: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    marketState: string | null;
    tradeTime: number | null;
    source: string | null;
  } | null;
  quoteError: string | null;
  /** reporting currency of the statement figures */
  currency: string;
  /** XBRL taxonomy the statements came from */
  taxonomy: "us-gaap" | "ifrs-full" | "none";
  /** USD-per-unit FX used for a non-USD reporter (null when unavailable) */
  fx: {
    currency: string;
    usdPerUnit: number;
    source: string;
    fetchedAt: string;
  } | null;
  /** which XBRL concept backed each metric (latest period) */
  tags: Partial<Record<MetricKey, string | null>>;
  /** what is missing or assumed, in plain words */
  notes: string[];
  source: { tickerMap: string; submissions: string; facts: string; secUserAgent: string };
  fetchedAt: string;
}

// ─── Fetching + caching ─────────────────────────────────────────────────────

async function secFetch<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

let tickerCache: { at: number; map: Map<string, { cik: string; title: string }> } | null = null;

async function loadTickerMap() {
  if (tickerCache && Date.now() - tickerCache.at < TICKER_TTL_MS) return tickerCache.map;
  const raw = await secFetch<Record<string, { cik_str: number; ticker: string; title: string }>>(
    "https://www.sec.gov/files/company_tickers.json"
  );
  const map = new Map<string, { cik: string; title: string }>();
  for (const row of Object.values(raw)) {
    if (!row?.ticker) continue;
    map.set(row.ticker.toUpperCase(), {
      cik: String(row.cik_str).padStart(10, "0"),
      title: row.title ?? row.ticker,
    });
  }
  tickerCache = { at: Date.now(), map };
  return map;
}

export async function resolveCik(ticker: string): Promise<{ cik: string; title: string } | null> {
  const t = ticker.trim().toUpperCase();
  // A bare CIK is also accepted (with or without the CIK prefix).
  if (/^\d{1,10}$/.test(t)) return { cik: t.padStart(10, "0"), title: `CIK ${t}` };
  const map = await loadTickerMap();
  return map.get(t) ?? map.get(t.replace(/\./g, "-")) ?? null;
}

const companyCache = new Map<string, { at: number; data: CompanyResearch }>();

export function clearResearchCache() {
  tickerCache = null;
  companyCache.clear();
  fxCache.clear();
}

/** Drop one ticker's cached research (used by the page's Refresh button). */
export function clearCompanyResearch(ticker: string) {
  companyCache.delete(ticker.trim().toUpperCase());
}

export interface CompanyMatch {
  ticker: string;
  cik: string;
  name: string;
}

/**
 * Search the SEC registrant list by ticker or company name. The whole map is
 * one cached download (~700KB), so typing in the UI costs no extra requests.
 */
export async function searchCompanies(query: string, limit = 8): Promise<CompanyMatch[]> {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const map = await loadTickerMap();
  const scored: (CompanyMatch & { score: number })[] = [];
  for (const [ticker, value] of map) {
    const name = value.title.toUpperCase();
    let score = -1;
    if (ticker === q) score = 100;
    else if (ticker.startsWith(q)) score = 80;
    else if (name.startsWith(q)) score = 60;
    else if (name.includes(q)) score = 40;
    else if (ticker.includes(q)) score = 20;
    if (score < 0) continue;
    scored.push({ ticker, cik: value.cik, name: value.title, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map(({ ticker, cik, name }) => ({ ticker, cik, name }));
}

/**
 * CSV export of the research view: one table with a unit column so a statement
 * figure and a ratio can live in the same file without ambiguity. Missing
 * values are empty cells (not 0).
 */
export function researchToCsv(data: CompanyResearch): string {
  const years = data.annual.map((r) => r.fy);
  const header = ["metric", "unit", ...years.map((y) => `FY${y}`)];
  const num = (v: number | null) => (v === null ? "" : String(v));
  const lines: string[][] = [header];

  const metricRows: { label: string; unit: string; get: (r: AnnualRow) => number | null }[] = [
    { label: "Revenue", unit: data.currency, get: (r) => r.revenue },
    { label: "Gross profit", unit: data.currency, get: (r) => r.grossProfit },
    { label: "Operating income", unit: data.currency, get: (r) => r.operatingIncome },
    { label: "Net income", unit: data.currency, get: (r) => r.netIncome },
    { label: "EPS diluted", unit: `${data.currency}/share`, get: (r) => r.epsDiluted },
    { label: "Total assets", unit: data.currency, get: (r) => r.assets },
    { label: "Total liabilities", unit: data.currency, get: (r) => r.liabilities },
    { label: "Shareholders equity", unit: data.currency, get: (r) => r.equity },
    { label: "Current assets", unit: data.currency, get: (r) => r.currentAssets },
    { label: "Current liabilities", unit: data.currency, get: (r) => r.currentLiabilities },
    { label: "Cash and equivalents", unit: data.currency, get: (r) => r.cash },
    { label: "Long-term debt", unit: data.currency, get: (r) => r.debt },
    { label: "Operating cash flow", unit: data.currency, get: (r) => r.operatingCashFlow },
    { label: "Capital expenditure", unit: data.currency, get: (r) => r.capex },
    { label: "Free cash flow", unit: data.currency, get: (r) => r.freeCashFlow },
    { label: "Dividends paid", unit: data.currency, get: (r) => r.dividendsPaid },
  ];
  for (const row of metricRows) {
    lines.push([row.label, row.unit, ...data.annual.map((r) => num(row.get(r)))]);
  }

  const ratioRows: { label: string; get: (r: RatioRow) => number | null }[] = [
    { label: "Gross margin", get: (r) => r.grossMargin },
    { label: "Operating margin", get: (r) => r.operatingMargin },
    { label: "Net margin", get: (r) => r.netMargin },
    { label: "Return on equity", get: (r) => r.returnOnEquity },
    { label: "Return on assets", get: (r) => r.returnOnAssets },
    { label: "Debt to equity", get: (r) => r.debtToEquity },
    { label: "Current ratio", get: (r) => r.currentRatio },
    { label: "FCF margin", get: (r) => r.freeCashFlowMargin },
    { label: "Revenue growth", get: (r) => r.revenueGrowth },
    { label: "EPS growth", get: (r) => r.epsGrowth },
    { label: "FCF growth", get: (r) => r.freeCashFlowGrowth },
  ];
  for (const row of ratioRows) {
    lines.push([row.label, "ratio", ...data.ratios.map((r) => num(row.get(r)))]);
  }

  return lines.map((cells) => cells.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ─── FX (for non-USD reporters) ────────────────────────────────────────────
// IFRS filers report in their local currency; comparing a USD share price with
// DKK earnings without converting would produce a meaningless P/E. Yahoo's
// FX chart gives USD per unit of the reporting currency.

const QUOTE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const fxCache = new Map<string, { at: number; rate: number | null }>();

export async function fetchFxRate(currency: string): Promise<number | null> {
  if (currency === "USD") return 1;
  const hit = fxCache.get(currency);
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) return hit.rate;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(currency)}USD=X?range=1d&interval=1d`,
      { headers: { "User-Agent": QUOTE_UA, Accept: "application/json" }, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const rate = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    fxCache.set(currency, { at: Date.now(), rate });
    return rate;
  } catch {
    fxCache.set(currency, { at: Date.now(), rate: null });
    return null;
  }
}

// ─── XBRL extraction ───────────────────────────────────────────────────────

const isAnnualForm = (form?: string) =>
  !!form && (form.startsWith("10-K") || form.startsWith("20-F"));

const daysBetween = (a: string, b: string) =>
  (Date.parse(b) - Date.parse(a)) / 86_400_000;

/**
 * Pull one metric's annual values out of companyfacts.
 *
 * Returns a map period-end → pick. A period is keyed by its END date (not the
 * filing's `fy`) because a 10-K repeats the prior year as a comparative fact
 * with the NEW fiscal year attached; keying by `fy` would double-count it.
 * The displayed fiscal year is the one from the oldest filing of that period.
 */
export function extractAnnualSeries(
  facts: CompanyFacts | null | undefined,
  chains: string[],
  units: string[],
  instant: boolean,
  /** read ONLY this taxonomy — us-gaap tags like "Assets" also exist in IFRS,
   *  and mixing them would stitch half a US statement onto half an IFRS one */
  taxonomy?: "us-gaap" | "ifrs-full"
): Map<string, MetricPick> {
  const out = new Map<string, MetricPick>();
  if (!facts?.facts) return out;
  const taxonomies: { name: string; concepts: Record<string, FactConcept> }[] = [];
  if (!taxonomy || taxonomy === "us-gaap") {
    if (facts.facts["us-gaap"]) taxonomies.push({ name: "us-gaap", concepts: facts.facts["us-gaap"] });
  }
  if (!taxonomy || taxonomy === "ifrs-full") {
    if (facts.facts["ifrs-full"]) taxonomies.push({ name: "ifrs-full", concepts: facts.facts["ifrs-full"] });
  }

  for (const tax of taxonomies) {
    for (const tag of chains) {
      const conceptUnits = tax.concepts[tag]?.units;
      if (!conceptUnits) continue;
      for (const unit of units) {
      const entries = conceptUnits[unit];
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!isAnnualForm(e.form)) continue;
        if (typeof e.val !== "number" || !Number.isFinite(e.val)) continue;
        if (!e.end) continue;
        if (instant) {
          if (e.start) continue;
          // Balance-sheet facts are stamped fy= that year; keep the FY guard
          // loose because some 20-F filings omit it.
          if (e.fp && e.fp !== "FY") continue;
        } else {
          if (!e.start) continue;
          if (daysBetween(e.start, e.end) < 300) continue;
          if (e.fp && e.fp !== "FY") continue;
        }
        const filed = e.filed ?? "";
        const fy = e.fy ?? Number(e.end.slice(0, 4));
        const prev = out.get(e.end);
        if (!prev) {
          out.set(e.end, { value: e.val, tag, taxonomy: tax.name, filed, firstFiled: filed, fy });
        } else if (filed > prev.filed) {
          // Restatement / amendment: the newest filing wins, but only from the
          // SAME concept. A later filing of a lower-priority tag must not
          // replace the higher-priority figure — Apple's FY2022 cash is 23.6bn
          // on the balance sheet, while the restricted-cash series (the next
          // tag in the chain) reports 25.0bn in the FY2023 10-K's comparative.
          // Letting that overwrite relabelled the line and mixed two
          // definitions across the row.
          if (tag === prev.tag) {
            out.set(e.end, { ...prev, value: e.val, tag, taxonomy: tax.name, filed });
          }
        } else if (filed < prev.firstFiled) {
          // companyfacts lists facts in JSON order, not filing order — an
          // older 10-K seen later still owns the period's fiscal-year label.
          out.set(e.end, { ...prev, firstFiled: filed, fy });
        }
      }
      }
      // Earlier chain tags are authoritative; later ones only fill gaps, so we
      // do NOT break out of the chain loop — gaps get filled per period.
    }
  }
  return out;
}

/**
 * Reporting currency of the annual facts. IFRS filers report in their local
 * currency (NOK, DKK, JPY, …), so assuming USD would silently drop every
 * statement line. Scans the revenue/asset concepts, us-gaap first.
 */
export function detectCurrency(facts: CompanyFacts | null | undefined): string {
  const concepts = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    "Revenue",
    "SalesRevenueNet",
    "Assets",
    "NetIncomeLoss",
    "ProfitLoss",
  ];
  for (const tax of ["us-gaap", "ifrs-full"]) {
    const map = facts?.facts?.[tax];
    if (!map) continue;
    for (const concept of concepts) {
      const units = Object.keys(map[concept]?.units ?? {});
      const monetary = units.find((u) => /^[A-Z]{3}$/.test(u));
      if (monetary) return monetary;
    }
  }
  return "USD";
}

type MetricUnit = "money" | "perShare" | "shares";

const METRIC_SPECS: { key: MetricKey; label: string; unit: MetricUnit; instant: boolean }[] = [
  { key: "revenue", label: "Revenue", unit: "money", instant: false },
  { key: "grossProfit", label: "Gross profit", unit: "money", instant: false },
  { key: "operatingIncome", label: "Operating income", unit: "money", instant: false },
  { key: "netIncome", label: "Net income", unit: "money", instant: false },
  { key: "epsDiluted", label: "EPS (diluted)", unit: "perShare", instant: false },
  { key: "assets", label: "Total assets", unit: "money", instant: true },
  { key: "liabilities", label: "Total liabilities", unit: "money", instant: true },
  { key: "equity", label: "Shareholders' equity", unit: "money", instant: true },
  { key: "currentAssets", label: "Current assets", unit: "money", instant: true },
  { key: "currentLiabilities", label: "Current liabilities", unit: "money", instant: true },
  { key: "cash", label: "Cash & equivalents", unit: "money", instant: true },
  { key: "debt", label: "Long-term debt", unit: "money", instant: true },
  { key: "sharesOutstanding", label: "Shares outstanding", unit: "shares", instant: true },
  { key: "operatingCashFlow", label: "Operating cash flow", unit: "money", instant: false },
  { key: "capex", label: "Capital expenditure", unit: "money", instant: false },
  { key: "dividendsPaid", label: "Dividends paid", unit: "money", instant: false },
  { key: "depreciation", label: "Depreciation & amortisation", unit: "money", instant: false },
  { key: "retainedEarnings", label: "Retained earnings", unit: "money", instant: true },
  { key: "pretaxIncome", label: "Pre-tax income", unit: "money", instant: false },
  { key: "receivables", label: "Accounts receivable", unit: "money", instant: true },
  { key: "sga", label: "SG&A expense", unit: "money", instant: false },
  { key: "propertyPlantEquipment", label: "Property, plant & equipment", unit: "money", instant: true },
  { key: "interestExpense", label: "Interest expense", unit: "money", instant: false },
];

const FY_PRIORITY: MetricKey[] = ["revenue", "netIncome", "operatingIncome", "assets", "equity"];

// ─── Revenue completeness ──────────────────────────────────────────────────
// The contract-revenue tags cover "revenue from contracts with customers" —
// which for a conglomerate is only part of the income statement. Berkshire's
// FY2025 10-K reports $247.2bn under that tag and $371.4bn of total revenues;
// reading the first one alone understates revenue by a third. When the filer
// also tags a total-revenue line for the SAME period and it is materially
// larger, the total is what the income statement shows, so it wins — and the
// swap is named in the notes rather than made silently.
const CONTRACT_REVENUE_TAGS = new Set([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "RevenueFromContractsWithCustomers",
]);
const TOTAL_REVENUE_TAGS = ["Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet"];
/** material gap before the total-revenue line replaces the contract figure */
const REVENUE_TOTAL_GAP = 0.02;

export function formatMoneyShort(value: number, currency: string): string {
  const abs = Math.abs(value);
  const divisor = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : 1e3;
  const suffix = divisor === 1e9 ? "bn" : divisor === 1e6 ? "m" : "k";
  return `${currency} ${(value / divisor).toFixed(1)}${suffix}`;
}

/**
 * The fiscal-year label for a period comes from the income-statement facts
 * first (they are unambiguous), then the balance sheet. Max/min across all
 * metrics is wrong: a comparative balance sheet stamped with the later
 * filing's fy would otherwise relabel the prior year.
 */
function fiscalYearFor(picks: Map<MetricKey, Map<string, MetricPick>>, end: string): number {
  for (const key of FY_PRIORITY) {
    const hit = picks.get(key)?.get(end);
    if (hit) return hit.fy;
  }
  for (const map of picks.values()) {
    const hit = map.get(end);
    if (hit) return hit.fy;
  }
  return Number(end.slice(0, 4));
}

export interface StatementBuild {
  annual: AnnualRow[];
  tags: Partial<Record<MetricKey, string | null>>;
  /** the concept behind each metric IN EACH PERIOD (filer tags change over time) */
  periodTags: Partial<Record<MetricKey, Record<string, string>>>;
  notes: string[];
  /** ISO currency of the statement figures */
  currency: string;
  /** which XBRL taxonomy supplied the rows */
  taxonomy: "us-gaap" | "ifrs-full" | "none";
}

function unitsFor(unit: MetricUnit, currency: string): string[] {
  if (unit === "shares") return ["shares"];
  if (unit === "perShare") return [`${currency}/shares`];
  // Only the reporting currency: mixing a USD fact into DKK statements would
  // silently corrupt every ratio.
  return [currency];
}

function buildRows(picks: Map<MetricKey, Map<string, MetricPick>>, ends: string[]): AnnualRow[] {
  return ends.map((end) => {
    const row: Record<string, number | null> = {};
    for (const spec of METRIC_SPECS) {
      row[spec.key] = picks.get(spec.key)?.get(end)?.value ?? null;
    }
    const ocf = row.operatingCashFlow;
    const capex = row.capex;
    return {
      ...(row as unknown as Omit<AnnualRow, "fy" | "end" | "freeCashFlow">),
      fy: fiscalYearFor(picks, end),
      end,
      // Capital expenditure is only subtracted when the filer actually
      // reported it — no silent zero. If it is missing, FCF is "—".
      freeCashFlow: ocf !== null && capex !== null ? ocf - capex : null,
    };
  });
}

function extractSheet(
  facts: CompanyFacts | null | undefined,
  chains: Record<string, string[]>,
  currency: string,
  taxonomy: "us-gaap" | "ifrs-full",
  /** fiscal years of statements to rebuild — the research view wants the latest
   *  few, a long-horizon study wants everything the filer has */
  maxYears: number = MAX_YEARS
): { picks: Map<MetricKey, Map<string, MetricPick>>; annual: AnnualRow[] } {
  const picks = new Map<MetricKey, Map<string, MetricPick>>();
  for (const spec of METRIC_SPECS) {
    picks.set(
      spec.key,
      extractAnnualSeries(
        facts,
        chains[spec.key] ?? [],
        unitsFor(spec.unit, currency),
        spec.instant,
        taxonomy
      )
    );
  }
  const ends = new Set<string>();
  for (const map of picks.values()) for (const end of map.keys()) ends.add(end);
  const sorted = [...ends].sort((a, b) => (a < b ? 1 : -1)).slice(0, maxYears);
  return { picks, annual: buildRows(picks, sorted) };
}

export function buildAnnualStatements(
  facts: CompanyFacts | null | undefined,
  /** default keeps the research view at MAX_YEARS; studies pass more */
  maxYears: number = MAX_YEARS
): StatementBuild {
  const currency = detectCurrency(facts);
  const usGaap = extractSheet(facts, US_GAAP, currency, "us-gaap", maxYears);
  let picks = usGaap.picks;
  let annual = usGaap.annual;
  let taxonomy: StatementBuild["taxonomy"] = annual.length > 0 ? "us-gaap" : "none";

  // Some 20-F / 40-F filers tag everything with IFRS. Fall back when us-gaap
  // produced no core income-statement line (not merely no rows — a stray
  // us-gaap balance fact must not block the IFRS statements).
  const lacksCore = annual.length === 0 || annual.every(
    (r) => r.revenue === null && r.netIncome === null
  );
  if (lacksCore && facts?.facts?.["ifrs-full"]) {
    const ifrs = extractSheet(facts, IFRS, currency, "ifrs-full", maxYears);
    if (ifrs.annual.some((r) => r.revenue !== null || r.netIncome !== null)) {
      picks = ifrs.picks;
      annual = ifrs.annual;
      taxonomy = "ifrs-full";
    }
  }

  // Provenance: the tag behind the most recent period that has the metric.
  const tags: Partial<Record<MetricKey, string | null>> = {};
  const ends = annual.map((r) => r.end);
  for (const spec of METRIC_SPECS) {
    const map = picks.get(spec.key);
    let tag: string | null = null;
    for (const end of ends) {
      const hit = map?.get(end);
      if (hit) {
        tag = hit.tag;
        break;
      }
    }
    tags[spec.key] = tag;
  }

  const notes: string[] = [];

  // Replace a partial contract-revenue figure with the filer's total-revenue
  // line for the same period, and say so. A period the total does not cover
  // keeps the contract figure (never inferred from another year).
  const revenuePicks = picks.get("revenue");
  if (revenuePicks) {
    const totals = extractAnnualSeries(facts, TOTAL_REVENUE_TAGS, [currency], false, taxonomy === "none" ? undefined : taxonomy);
    for (const row of annual) {
      const chosen = revenuePicks.get(row.end);
      const total = totals.get(row.end);
      if (!chosen || !total || !CONTRACT_REVENUE_TAGS.has(chosen.tag)) continue;
      if (total.value <= chosen.value * (1 + REVENUE_TOTAL_GAP)) continue;
      revenuePicks.set(row.end, total);
      row.revenue = total.value;
      notes.push(
        `${formatMoneyShort(total.value, currency)} of total revenue is used for FY${row.fy}: the filer's contract-revenue tag covers only ` +
          `${formatMoneyShort(chosen.value, currency)} of it (${total.tag} is the income-statement total).`
      );
    }
    // The provenance map was built from the pre-override picks; re-read the
    // newest period so the UI names the concept that actually supplied the
    // figure on screen.
    for (const row of annual) {
      const hit = revenuePicks.get(row.end);
      if (hit) {
        tags.revenue = hit.tag;
        break;
      }
    }
  }

  for (const spec of METRIC_SPECS) {
    if (!annual.some((r) => r[spec.key] !== null)) {
      notes.push(`${spec.label}: not reported as an annual XBRL fact by this filer.`);
    }
  }
  if (tags.epsDiluted === "EarningsPerShareBasic" || tags.epsDiluted === "BasicEarningsLossPerShare") {
    notes.push(
      "EPS: this filer tags only BASIC EPS; no diluted per-share fact is filed, so the figure shown is the filed basic EPS."
    );
  }
  if (annual.length > 0) {
    notes.push(
      `Statement periods end ${annual[annual.length - 1].end} → ${annual[0].end}; annual (10-K/20-F/40-F) facts only.`
    );
    if (taxonomy === "ifrs-full") {
      notes.push("Statements use the IFRS taxonomy, as filed by this foreign private issuer.");
    }
    if (currency !== "USD") {
      notes.push(`Statements are reported in ${currency}; multiples convert them to USD.`);
    }
  }

  // Per-period provenance, taken AFTER the revenue swap: it is what the
  // cross-source check re-reads, and a filer can change tag between years.
  const periodTags: Partial<Record<MetricKey, Record<string, string>>> = {};
  for (const [key, map] of picks) {
    const byPeriod: Record<string, string> = {};
    for (const [end, pick] of map) byPeriod[end] = pick.tag;
    periodTags[key] = byPeriod;
  }

  return { annual, tags, periodTags, notes, currency, taxonomy };
}

// ─── Ratios ────────────────────────────────────────────────────────────────

const div = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 ? null : a / b;

function growth(curr: number | null, prev: number | null): number | null {
  if (curr === null || prev === null || prev <= 0) return null;
  return curr / prev - 1;
}

export function computeRatios(annual: AnnualRow[]): RatioRow[] {
  return annual.map((row, i) => {
    const prev = annual[i + 1];
    return {
      fy: row.fy,
      grossMargin: div(row.grossProfit, row.revenue),
      operatingMargin: div(row.operatingIncome, row.revenue),
      netMargin: div(row.netIncome, row.revenue),
      returnOnEquity: div(row.netIncome, row.equity),
      returnOnAssets: div(row.netIncome, row.assets),
      debtToEquity: div(row.debt, row.equity),
      currentRatio: div(row.currentAssets, row.currentLiabilities),
      freeCashFlowMargin: div(row.freeCashFlow, row.revenue),
      revenueGrowth: growth(row.revenue, prev?.revenue ?? null),
      epsGrowth: growth(row.epsDiluted, prev?.epsDiluted ?? null),
      freeCashFlowGrowth: growth(row.freeCashFlow, prev?.freeCashFlow ?? null),
    };
  });
}

// ─── Valuation ─────────────────────────────────────────────────────────────

export function latestShares(facts: CompanyFacts | null | undefined, annual: AnnualRow[]): number | null {
  const dei = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  const cover = dei
    .filter((e) => typeof e.val === "number" && e.end)
    .sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  if (cover) return cover.val;
  const reported = annual.find((r) => r.sharesOutstanding !== null)?.sharesOutstanding;
  return reported ?? null;
}

export interface ValuationOptions {
  /** reporting currency of the statements (default USD) */
  currency?: string;
  /** USD per 1 unit of the reporting currency; null = conversion unavailable */
  usdPerUnit?: number | null;
}

export function buildValuation(
  annual: AnnualRow[],
  price: number | null,
  shares: number | null,
  options: ValuationOptions = {}
): Valuation {
  const currency = options.currency ?? "USD";
  const fx = currency === "USD" ? 1 : options.usdPerUnit ?? null;
  const latest = annual[0] ?? null;

  // Market cap in USD is always price × shares. The multiples divide by market
  // cap converted into the STATEMENT currency, so P/E and FCF yield compare
  // like with like (a currency-free ratio once both legs match).
  const marketCap = price !== null && shares !== null ? price * shares : null;
  const priceReporting = price !== null && fx !== null ? price / fx : null;
  const marketCapReporting =
    priceReporting !== null && shares !== null ? priceReporting * shares : null;

  const ebitda =
    latest && latest.operatingIncome !== null && latest.depreciation !== null
      ? latest.operatingIncome + latest.depreciation
      : null;
  // EV needs both legs of the net-debt bridge; without reported debt or cash
  // the figure would understate the enterprise value, so it stays "—".
  const evReporting =
    marketCapReporting !== null && latest && latest.debt !== null && latest.cash !== null
      ? marketCapReporting + latest.debt - latest.cash
      : null;
  const enterpriseValue = evReporting !== null && fx !== null ? evReporting * fx : null;

  const pe = latest ? div(marketCapReporting, latest.netIncome) : null;
  const ps = latest ? div(marketCapReporting, latest.revenue) : null;
  const pb = latest ? div(marketCapReporting, latest.equity) : null;
  const earningsYieldPct = pe !== null && pe !== 0 ? (1 / pe) * 100 : null;
  const fcfYield = latest ? div(latest.freeCashFlow, marketCapReporting) : null;
  const freeCashFlowYieldPct = fcfYield === null ? null : fcfYield * 100;
  const divYield = latest ? div(latest.dividendsPaid, marketCapReporting) : null;
  const dividendYieldPct = divYield === null ? null : divYield * 100;
  const evToEbitda = div(evReporting, ebitda);
  const fxNote = currency === "USD" ? "" : ` (${currency} statements, converted at ${fx ?? "—"})`;

  const metrics: ValuationMetric[] = [
    { label: "Market cap", value: marketCap, kind: "money", basis: "price × shares outstanding, USD" },
    { label: "Enterprise value", value: enterpriseValue, kind: "money", basis: `market cap + debt − cash${fxNote}` },
    { label: "P/E", value: pe, kind: "multiple", basis: `market cap ÷ latest FY net income${fxNote}` },
    { label: "P/S", value: ps, kind: "multiple", basis: `market cap ÷ latest FY revenue${fxNote}` },
    { label: "P/B", value: pb, kind: "multiple", basis: `market cap ÷ latest FY equity${fxNote}` },
    { label: "Earnings yield", value: earningsYieldPct === null ? null : earningsYieldPct / 100, kind: "percent", basis: "1 ÷ P/E" },
    { label: "FCF yield", value: freeCashFlowYieldPct === null ? null : freeCashFlowYieldPct / 100, kind: "percent", basis: "FY free cash flow ÷ market cap" },
    { label: "Dividend yield", value: dividendYieldPct === null ? null : dividendYieldPct / 100, kind: "percent", basis: "FY dividends paid ÷ market cap" },
    { label: "EV / EBITDA", value: evToEbitda, kind: "multiple", basis: "EV ÷ (operating income + D&A)" },
  ];

  return {
    fiscalYear: latest?.fy ?? null,
    reportingCurrency: currency,
    fxRate: fx,
    marketCapReporting,
    marketCap,
    enterpriseValue,
    priceToEarnings: pe,
    priceToSales: ps,
    priceToBook: pb,
    earningsYieldPct,
    freeCashFlowYieldPct,
    dividendYieldPct,
    evToEbitda,
    ebitda,
    metrics,
  };
}

// ─── Profile + filings ─────────────────────────────────────────────────────

const FILING_FORMS = [
  "10-K",
  "10-Q",
  "8-K",
  "20-F",
  "40-F",
  "6-K",
  "DEF 14A",
  "S-1",
  "10-K/A",
  "10-Q/A",
];

export function buildFilings(sub: CompanySubmissions, cik: string, limit = 12): ResearchFiling[] {
  const recent = sub.filings?.recent;
  if (!recent) return [];
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const periods = recent.reportDate ?? [];
  const accessions = recent.accessionNumber ?? [];
  const docs = recent.primaryDocument ?? [];
  const descriptions = recent.primaryDocDescription ?? [];
  const cikNoPad = String(Number(cik));
  const out: ResearchFiling[] = [];
  for (let i = 0; i < forms.length && out.length < limit; i++) {
    const form = forms[i];
    if (!FILING_FORMS.includes(form)) continue;
    const accession = accessions[i] ?? "";
    const doc = docs[i] ?? "";
    const url =
      accession && doc
        ? `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${accession.replace(/-/g, "")}/${doc}`
        : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}`;
    out.push({
      form,
      filed: dates[i] ?? "",
      period: periods[i] || null,
      description: descriptions[i] || null,
      url,
    });
  }
  return out;
}

export function buildProfile(
  sub: CompanySubmissions,
  cik: string,
  fallbackTicker: string
): ResearchProfile {
  const addr = sub.addresses?.business;
  return {
    ticker: fallbackTicker,
    name: sub.name ?? fallbackTicker,
    cik,
    sic: sub.sic ?? null,
    industry: sub.sicDescription ?? null,
    fiscalYearEnd: sub.fiscalYearEnd ?? null,
    stateOfIncorporation: sub.stateOfIncorporation ?? null,
    category: sub.category ?? null,
    entityType: sub.entityType ?? null,
    exchanges: sub.exchanges ?? [],
    tickers: sub.tickers ?? [fallbackTicker],
    formerNames: (sub.formerNames ?? []).map((f) => ({
      name: f.name ?? "",
      from: f.from ?? null,
      to: f.to ?? null,
    })),
    address: addr
      ? [addr.street1, addr.city, addr.stateOrCountry, addr.zipCode].filter(Boolean).join(", ")
      : null,
  };
}

// ─── Orchestration ─────────────────────────────────────────────────────────

/**
 * Raw XBRL company facts for a ticker.
 *
 * Exists for studies that need the full filing history: `fetchCompanyResearch`
 * caps its statements at `MAX_YEARS` for the research view, and its response does
 * not carry the facts. Returns null when the ticker has no SEC registrant — no
 * throw, so a universe loop can skip a name and keep going.
 */
export async function fetchCompanyFacts(ticker: string): Promise<CompanyFacts | null> {
  const resolved = await resolveCik(ticker.trim().toUpperCase());
  if (!resolved) return null;
  return secFetch<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${resolved.cik}.json`);
}

// ─── Successor registrants (a reorganisation moves the 10-Ks) ─────────────
// A ticker can map to an entity that has filed no annual report yet while the
// operating company's 10-Ks sit under an earlier CIK. In Nov 2026 XOM mapped
// to ExxonMobil Holdings Corp (only 10-Qs so far) while Exxon Mobil Corp's
// annual reports were under CIK 34088 — the page showed an empty statement set
// for a mega-cap. EDGAR's company search lists the registrants filing annual
// reports under a name, so the fallback finds the entity that actually has
// them and the response says which CIK was used. It is a FALLBACK only: it
// runs when the mapped registrant produced no annual rows, and a candidate is
// accepted only when it shares the company's leading name token.

const NAME_STOP_WORDS = new Set([
  "THE", "AND", "HOLDINGS", "HOLDING", "GROUP", "CORP", "CORPORATION", "INC",
  "INCORPORATED", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "NV", "AG", "SE",
]);

interface RegistrantHit {
  cik: string;
  name: string;
}

function leadingNameKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_STOP_WORDS.has(w));
  return (words[0] ?? "").slice(0, 5);
}

/** Registrants that filed `form` under a company name (EDGAR Atom search). */
async function searchAnnualRegistrants(name: string, form: "10-K" | "20-F"): Promise<RegistrantHit[]> {
  const key = leadingNameKey(name);
  if (key.length < 3) return [];
  const url =
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=" +
    `${encodeURIComponent(key)}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=40&output=atom`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": SEC_UA, Accept: "application/atom+xml" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    // The Atom feed puts each matched company in its own <company-info> block
    // (the <entry> elements are that company's filings and carry no CIK).
    const blocks = xml.includes("<company-info>")
      ? xml.split("<company-info>").slice(1)
      : [xml];
    const hits: RegistrantHit[] = [];
    for (const block of blocks) {
      const cik = block.match(/<cik>(\d+)<\/cik>/)?.[1];
      const conformed = block.match(/<conformed-name>([^<]+)<\/conformed-name>/)?.[1];
      if (!cik || !conformed) continue;
      // The name must carry the same leading token: a name search is fuzzy and
      // picking a different company would be worse than an empty page.
      if (!conformed.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").includes(key)) continue;
      hits.push({ cik: cik.padStart(10, "0"), name: conformed });
    }
    const seen = new Set<string>();
    return hits.filter((h) => (seen.has(h.cik) ? false : (seen.add(h.cik), true))).slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Find the registrant whose annual filings back a company name. Returns null
 * when nothing better exists — the caller then reports the empty statement set
 * instead of inventing one.
 */
async function findStatementRegistrant(
  name: string,
  skipCik: string
): Promise<{ facts: CompanyFacts; cik: string; name: string; build: StatementBuild } | null> {
  const candidates = [
    ...(await searchAnnualRegistrants(name, "10-K")),
    ...(await searchAnnualRegistrants(name, "20-F")),
  ].filter((c) => c.cik !== skipCik);

  const loaded = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const facts = await secFetch<CompanyFacts>(
          `https://data.sec.gov/api/xbrl/companyfacts/CIK${candidate.cik}.json`
        );
        const build = buildAnnualStatements(facts);
        return build.annual.length > 0 ? { ...candidate, facts, build } : null;
      } catch {
        return null;
      }
    })
  );
  const usable = loaded.filter((x): x is NonNullable<typeof x> => x !== null);
  if (usable.length === 0) return null;
  // Newest annual period wins: that is the entity whose statements are current.
  usable.sort((a, b) => (a.build.annual[0].end < b.build.annual[0].end ? 1 : -1));
  return usable[0];
}

export interface ResearchInput {
  ticker: string;
  /** injected in tests so no network is touched */
  quote?: { price: number | null; previousClose: number | null; changePercent: number | null; dayHigh: number | null; dayLow: number | null; marketState: string | null; tradeTime: number | null; source: string | null } | null;
  quoteError?: string | null;
  /** every price source that answered, so the page can show the price check too */
  priceSources?: PriceSourceCheck[] | null;
  priceAgreement?: { agreeing: number; spreadPct: number | null } | null;
  /** false skips the cross-source read (used for peer tables: 4 peers × 5 sources would be a lot) */
  verify?: boolean;
}

export async function fetchCompanyResearch(input: ResearchInput): Promise<CompanyResearch> {
  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) throw new Error("ticker is required");

  // A cached entry built with `verify: false` (peer table, scoring route) has no
  // cross-source read: serve it to another unverified caller, but never to the
  // research page, which would then show a company with no check for 15 min.
  const wantsVerification = input.verify !== false;
  const cached = companyCache.get(ticker);
  if (
    cached &&
    Date.now() - cached.at < COMPANY_TTL_MS &&
    (!wantsVerification || cached.data.verification !== null)
  ) {
    return cached.data;
  }

  const resolved = await resolveCik(ticker);
  if (!resolved) {
    throw new Error(
      `No SEC registrant found for "${ticker}". This research view covers SEC filers only; a non-US or non-listed company will not be here.`
    );
  }
  const cik = resolved.cik;
  const [sub, facts] = await Promise.all([
    secFetch<CompanySubmissions>(`https://data.sec.gov/submissions/CIK${cik}.json`),
    secFetch<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`),
  ]);

  // Statements normally come from the registrant the ticker maps to. If that
  // entity has filed no annual report yet (a successor holdco), fall back to
  // the registrant that does — and say so, with both names.
  let statements = buildAnnualStatements(facts);
  let statementFacts = facts;
  let origin: StatementOrigin = {
    cik,
    name: sub.name ?? resolved.title,
    predecessor: false,
    note: null,
  };
  if (statements.annual.length === 0) {
    const alt = await findStatementRegistrant(sub.name ?? resolved.title, cik);
    if (alt) {
      statements = alt.build;
      statementFacts = alt.facts;
      const covers = alt.build.annual[0].end;
      origin = {
        cik: alt.cik,
        name: alt.name,
        predecessor: true,
        note:
          `Ticker ${ticker} maps to CIK ${cik} (${sub.name ?? resolved.title}), which has filed no annual report yet. ` +
          `The statements below are read from CIK ${alt.cik} (${alt.name}), the registrant whose annual report runs to ${covers}.`,
      };
    }
  }
  const { annual, tags, periodTags, notes, currency, taxonomy } = statements;
  const ratios = computeRatios(annual);
  const shares = latestShares(statementFacts, annual);
  const quote = input.quote ?? null;

  // Non-USD reporters need a conversion before their earnings can be compared
  // with a USD share price. Failure is surfaced, never replaced by a guess.
  let usdPerUnit: number | null = currency === "USD" ? 1 : null;
  if (currency !== "USD") usdPerUnit = await fetchFxRate(currency);
  const valuation = buildValuation(annual, quote?.price ?? null, shares, {
    currency,
    usdPerUnit,
  });
  const fx =
    currency !== "USD" && usdPerUnit !== null
      ? {
          currency,
          usdPerUnit,
          source: `https://query1.finance.yahoo.com/v8/finance/chart/${currency}USD=X`,
          fetchedAt: new Date().toISOString(),
        }
      : null;

  const allNotes = [...notes];
  if (origin.note) allNotes.push(origin.note);
  if (currency !== "USD") {
    allNotes.push(
      fx
        ? `Converted 1 ${currency} = ${fx.usdPerUnit} USD (Yahoo FX, ${new Date(fx.fetchedAt).toLocaleString()}) for market cap, EV and multiples.`
        : `${currency}/USD rate was unavailable — multiples that need a currency conversion stay \"—\"; the statements and ratios are still in ${currency}.`
    );
  }
  if (quote === null) {
    allNotes.push(`Live price unavailable${input.quoteError ? `: ${input.quoteError}` : ""} — valuation multiples are "—".`);
  }
  if (shares === null) {
    allNotes.push("Shares outstanding were not reported — market cap and multiples cannot be computed.");
  }
  if (quote !== null && valuation.enterpriseValue === null) {
    allNotes.push("Enterprise value: long-term debt or cash was not reported for the latest fiscal year, so EV and EV/EBITDA stay \"—\".");
  }
  if (quote !== null && valuation.evToEbitda === null && valuation.enterpriseValue !== null) {
    allNotes.push("EV/EBITDA: operating income or depreciation & amortisation was not reported, so the multiple stays \"—\".");
  }
  allNotes.push(
    "Multiples use the latest FILED fiscal year (not TTM) against the current price, so they are a point-in-time comparison, not a forecast."
  );

  // Cross-source read of the same figures (SEC concept, SEC frames, Nasdaq,
  // Yahoo). It never throws and never changes a number — it reports agreement.
  let verification: ResearchVerification | null = null;
  if (input.verify !== false) {
    try {
      verification = await verifyResearch({
        ticker,
        cik: origin.cik,
        currency,
        taxonomy,
        annual: annual.map((row) => ({
          fy: row.fy,
          end: row.end,
          tags: {
            revenue: periodTags.revenue?.[row.end],
            grossProfit: periodTags.grossProfit?.[row.end],
            operatingIncome: periodTags.operatingIncome?.[row.end],
            netIncome: periodTags.netIncome?.[row.end],
            epsDiluted: periodTags.epsDiluted?.[row.end],
            assets: periodTags.assets?.[row.end],
            liabilities: periodTags.liabilities?.[row.end],
            equity: periodTags.equity?.[row.end],
            cash: periodTags.cash?.[row.end],
            operatingCashFlow: periodTags.operatingCashFlow?.[row.end],
            capex: periodTags.capex?.[row.end],
          },
          values: {
            revenue: row.revenue,
            grossProfit: row.grossProfit,
            operatingIncome: row.operatingIncome,
            netIncome: row.netIncome,
            epsDiluted: row.epsDiluted,
            assets: row.assets,
            liabilities: row.liabilities,
            equity: row.equity,
            cash: row.cash,
            operatingCashFlow: row.operatingCashFlow,
            capex: row.capex,
          },
        })),
      });
    } catch (e) {
      verification = {
        checkedAt: new Date().toISOString(),
        sources: [],
        figures: [],
        summary: { figures: 0, verified: 0, conflicts: 0, singleSource: 0, notReported: 0, sources: 0, sourcesOk: 0 },
        note: `Cross-source check failed: ${e instanceof Error ? e.message : "unknown error"}`,
      };
    }
  }

  const data: CompanyResearch = {
    profile: buildProfile(sub, cik, ticker),
    statementsSource: origin,
    verification,
    priceSources: input.priceSources ?? null,
    priceAgreement: input.priceAgreement ?? null,
    annual,
    ratios,
    valuation,
    filings: buildFilings(sub, cik),
    quote,
    quoteError: input.quoteError ?? null,
    currency,
    taxonomy,
    fx,
    tags,
    notes: allNotes,
    source: {
      tickerMap: "https://www.sec.gov/files/company_tickers.json",
      submissions: `https://data.sec.gov/submissions/CIK${cik}.json`,
      // The CIK the statement tables were actually read from (see
      // statementsSource): for a successor registrant it is not the ticker's.
      facts: `https://data.sec.gov/api/xbrl/companyfacts/CIK${origin.cik}.json`,
      secUserAgent: SEC_UA,
    },
    fetchedAt: new Date().toISOString(),
  };
  companyCache.set(ticker, { at: Date.now(), data });
  return data;
}
