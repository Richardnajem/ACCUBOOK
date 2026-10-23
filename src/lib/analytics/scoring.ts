// ─── Fundamental scores from filed statements ───────────────────────────────
//
// Every input is a filed annual figure (sec `AnnualRow`, most recent first) and
// a live market cap. Where a score needs something the filer did not report,
// the score is null and `missing` names the input — never a zero, never an
// industry average. Thresholds are classification conventions, not
// probabilities, and are shown with the score.
//
// Sources are cited in AGENTS.md: Piotroski (2000), Altman (1968/1983/1995),
// Beneish (1999), Sloan (1996), Graham (The Intelligent Investor), Greenblatt
// (The Little Book That Beats the Market), Buffett (1986 letter).

import type { AnnualRow } from "../research";

export interface Check {
  label: string;
  pass: boolean | null;
  detail: string;
}

export interface ScoreResult {
  label: string;
  value: number | null;
  /** Short classification, e.g. "safe" / "grey" / "distress". */
  zone: string | null;
  basis: string;
  missing: string[];
  notes: string[];
}

const nz = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  nz(a) && nz(b) && b !== 0 ? a / b : null;

const pct = (v: number | null): number | null => (v === null ? null : v * 100);

// ─── Piotroski F-score ─────────────────────────────────────────────────────

export interface PiotroskiResult extends ScoreResult {
  checks: Check[];
  available: number;
}

export function piotroskiFScore(annual: AnnualRow[]): PiotroskiResult {
  const cur = annual[0];
  const prev = annual[1];
  const prev2 = annual[2];
  const missing: string[] = [];
  const checks: Check[] = [];

  const add = (label: string, pass: boolean | null, detail: string) => {
    checks.push({ label, pass, detail });
    if (pass === null) missing.push(label);
  };

  const roa = cur && prev ? ratio(cur.netIncome, prev.assets) : null;
  add(
    "Positive return on assets",
    roa === null ? null : roa > 0,
    roa === null ? "needs net income and prior-year total assets" : `ROA ${(roa * 100).toFixed(2)}% on beginning assets`,
  );

  const cfo = cur?.operatingCashFlow ?? null;
  add("Positive operating cash flow", nz(cfo) ? cfo > 0 : null, nz(cfo) ? `CFO ${fmtMoney(cfo)}` : "CFO not reported");

  const roaPrev = prev && prev2 ? ratio(prev.netIncome, prev2.assets) : null;
  add(
    "Rising return on assets",
    roa !== null && roaPrev !== null ? roa > roaPrev : null,
    roa !== null && roaPrev !== null ? `${(roa * 100).toFixed(2)}% vs ${(roaPrev * 100).toFixed(2)}%` : "needs three years of assets and net income",
  );

  add(
    "Earnings backed by cash (CFO > net income)",
    nz(cur?.operatingCashFlow) && nz(cur?.netIncome) ? cur.operatingCashFlow > cur.netIncome : null,
    nz(cur?.operatingCashFlow) && nz(cur?.netIncome) ? `CFO ${fmtMoney(cur.operatingCashFlow)} vs NI ${fmtMoney(cur.netIncome)}` : "needs CFO and net income",
  );

  const lev = (row: AnnualRow | undefined) =>
    row ? ratio((row.currentLiabilities ?? 0) + (row.debt ?? 0), row.assets) : null;
  const levCur = lev(cur);
  const levPrev = lev(prev);
  add(
    "Falling leverage",
    levCur !== null && levPrev !== null ? levCur < levPrev : null,
    levCur !== null && levPrev !== null ? `${(levCur * 100).toFixed(2)}% vs ${(levPrev * 100).toFixed(2)}% of assets` : "needs current liabilities, debt and assets for both years",
  );

  const crCur = ratio(cur?.currentAssets, cur?.currentLiabilities);
  const crPrev = ratio(prev?.currentAssets, prev?.currentLiabilities);
  add(
    "Rising current ratio",
    crCur !== null && crPrev !== null ? crCur > crPrev : null,
    crCur !== null && crPrev !== null ? `${crCur.toFixed(2)} vs ${crPrev.toFixed(2)}` : "needs current assets and liabilities for both years",
  );

  const sharesCur = cur?.sharesOutstanding ?? null;
  const sharesPrev = prev?.sharesOutstanding ?? null;
  add(
    "No share issuance",
    nz(sharesCur) && nz(sharesPrev) ? sharesCur <= sharesPrev * 1.005 : null,
    nz(sharesCur) && nz(sharesPrev)
      ? `${fmtShares(sharesCur)} vs ${fmtShares(sharesPrev)} (a split distorts this test)`
      : "needs shares outstanding for both years",
  );

  const gmCur = ratio(cur?.grossProfit, cur?.revenue);
  const gmPrev = ratio(prev?.grossProfit, prev?.revenue);
  add(
    "Rising gross margin",
    gmCur !== null && gmPrev !== null ? gmCur > gmPrev : null,
    gmCur !== null && gmPrev !== null ? `${(gmCur * 100).toFixed(2)}% vs ${(gmPrev * 100).toFixed(2)}%` : "gross profit not reported for both years",
  );

  const turnCur = cur && prev ? ratio(cur.revenue, prev.assets) : null;
  const turnPrev = prev && prev2 ? ratio(prev.revenue, prev2.assets) : null;
  add(
    "Rising asset turnover",
    turnCur !== null && turnPrev !== null ? turnCur > turnPrev : null,
    turnCur !== null && turnPrev !== null ? `${turnCur.toFixed(3)}× vs ${turnPrev.toFixed(3)}×` : "needs three years of revenue and assets",
  );

  const passed = checks.filter((c) => c.pass === true).length;
  const available = checks.filter((c) => c.pass !== null).length;
  return {
    label: "Piotroski F-score",
    value: available === 9 ? passed : null,
    zone: available === 9 ? (passed >= 7 ? "strong" : passed <= 3 ? "weak" : "neutral") : null,
    basis: `${passed} of ${available} available tests passed${available < 9 ? " (incomplete — not a comparable F-score)" : ""}`,
    missing,
    notes: ["9 binary signals; 7–9 is commonly read as strong, 0–3 as weak."],
    checks,
    available,
  };
}

// ─── Altman Z ──────────────────────────────────────────────────────────────

export interface AltmanResult extends ScoreResult {
  components: Record<string, number | null>;
  model: "original" | "private" | "non-manufacturer" | null;
}

export function altmanZ(
  annual: AnnualRow[],
  marketCap: number | null,
  variant: "original" | "non-manufacturer" = "original",
): AltmanResult {
  const cur = annual[0];
  const missing: string[] = [];
  const components: Record<string, number | null> = {};

  const ta = cur?.assets ?? null;
  components.x1 = ta ? ratio((cur!.currentAssets ?? 0) - (cur!.currentLiabilities ?? 0), ta) : null;
  components.x2 = ratio(cur?.retainedEarnings ?? null, ta);
  components.x3 = ratio(cur?.operatingIncome ?? null, ta);
  components.x4 =
    variant === "original"
      ? ratio(marketCap, cur?.liabilities ?? null)
      : ratio(cur?.equity ?? null, cur?.liabilities ?? null);
  // X5 only belongs to the original and Z′ models; Z″ omits it, so reporting a
  // value there would imply it feeds the score.
  components.x5 = variant === "original" ? ratio(cur?.revenue ?? null, ta) : null;

  for (const [k, v] of Object.entries(components)) if (v === null) missing.push(k.toUpperCase());

  let value: number | null = null;
  let zone: string | null = null;
  let model: AltmanResult["model"] = null;
  if (variant === "original") {
    if (nz(components.x1) && nz(components.x2) && nz(components.x3) && nz(components.x4) && nz(components.x5)) {
      value = 1.2 * components.x1 + 1.4 * components.x2 + 3.3 * components.x3 + 0.6 * components.x4 + 1.0 * components.x5;
      zone = value > 2.99 ? "safe" : value < 1.81 ? "distress" : "grey";
      model = "original";
    }
  } else if (nz(components.x1) && nz(components.x2) && nz(components.x3) && nz(components.x4)) {
    value = 6.56 * components.x1 + 3.26 * components.x2 + 6.72 * components.x3 + 1.05 * components.x4;
    zone = value > 2.6 ? "safe" : value < 1.1 ? "distress" : "grey";
    model = "non-manufacturer";
  }

  if (components.x2 === null) missing.push("retained earnings (XBRL RetainedEarningsAccumulatedDeficit)");
  return {
    label: variant === "original" ? "Altman Z-score" : "Altman Z″-score",
    value,
    zone,
    basis:
      variant === "original"
        ? "public manufacturer model: 1.2·X1 + 1.4·X2 + 3.3·X3 + 0.6·X4 + 1.0·X5"
        : "non-manufacturer model: 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4 (book equity in X4)",
    missing: [...new Set(missing)],
    notes: [
      "X1 working capital/TA · X2 retained earnings/TA · X3 EBIT/TA · X4 market cap (or book equity)/total liabilities · X5 sales/TA",
      "Not meaningful for banks and insurers; bands are conventions, not default probabilities.",
    ],
  components,
  model,
  };
}

// ─── Beneish M-score ───────────────────────────────────────────────────────

export interface BeneishResult extends ScoreResult {
  variables: Record<string, number | null>;
  flagged: boolean | null;
}

export function beneishMScore(annual: AnnualRow[]): BeneishResult {
  const cur = annual[0];
  const prev = annual[1];
  const variables: Record<string, number | null> = {};
  const missing: string[] = [];

  const cogs = (r: AnnualRow | undefined) =>
    r && nz(r.revenue) && nz(r.grossProfit) ? r.revenue - r.grossProfit : null;

  variables.DSRI = cur && prev
    ? ratio(ratio(cur.receivables, cur.revenue), ratio(prev.receivables, prev.revenue))
    : null;
  const gm = (r: AnnualRow | undefined) => (r && nz(cogs(r)) && nz(r.revenue) && r.revenue !== 0 ? (r.revenue - cogs(r)!) / r.revenue : null);
  const gmCur = gm(cur);
  const gmPrev = gm(prev);
  variables.GMI = gmCur && gmPrev && gmCur !== 0 ? gmPrev / gmCur : null;
  const aqi = (r: AnnualRow | undefined) =>
    r && nz(r.assets) && r.assets !== 0
      ? 1 - (((r.currentAssets ?? 0) + (r.propertyPlantEquipment ?? 0)) / r.assets)
      : null;
  const aqiCur = aqi(cur);
  const aqiPrev = aqi(prev);
  variables.AQI = aqiCur !== null && aqiPrev !== null && aqiPrev !== 0 ? aqiCur / aqiPrev : null;
  variables.SGI = cur?.revenue && prev?.revenue ? cur.revenue / prev.revenue : null;
  const depi = (r: AnnualRow | undefined) =>
    r && nz(r.depreciation) && nz(r.propertyPlantEquipment) && r.depreciation + r.propertyPlantEquipment !== 0
      ? r.depreciation / (r.depreciation + r.propertyPlantEquipment)
      : null;
  const depiCur = depi(cur);
  const depiPrev = depi(prev);
  variables.DEPI = depiCur && depiPrev && depiCur !== 0 ? depiPrev / depiCur : null;
  variables.SGAI = cur && prev
    ? ratio(ratio(cur.sga, cur.revenue), ratio(prev.sga, prev.revenue))
    : null;
  variables.LVGI = cur && prev
    ? ratio(
        ratio((cur.currentLiabilities ?? 0) + (cur.debt ?? 0), cur.assets),
        ratio((prev.currentLiabilities ?? 0) + (prev.debt ?? 0), prev.assets),
      )
    : null;
  variables.TATA = cur
    ? ratio((cur.netIncome ?? 0) - (cur.operatingCashFlow ?? 0), cur.assets)
    : null;

  for (const [k, v] of Object.entries(variables)) if (v === null) missing.push(k);
  const required: Array<keyof typeof variables> = ["DSRI", "GMI", "AQI", "SGI", "DEPI", "SGAI", "TATA", "LVGI"];
  const complete = required.every((k) => variables[k] !== null);
  const value = complete
    ? -4.84 +
      0.92 * variables.DSRI! +
      0.528 * variables.GMI! +
      0.404 * variables.AQI! +
      0.892 * variables.SGI! +
      0.115 * variables.DEPI! -
      0.172 * variables.SGAI! +
      4.679 * variables.TATA! -
      0.327 * variables.LVGI!
    : null;

  return {
    label: "Beneish M-score",
    value,
    zone: value === null ? null : value > -2.22 ? "possible manipulation" : "not flagged",
    flagged: value === null ? null : value > -2.22,
    basis: "8-variable model; > −2.22 is the conventional flag. Higher = more likely to be manipulating.",
    missing,
    notes: [
      "AQI uses current assets + PP&E only (long-term investments are not in the dataset).",
      "TATA uses (net income − CFO)/assets; SGAI needs SG&A, which many filers tag inconsistently.",
    ],
    variables,
  };
}

// ─── Accruals, DuPont, Graham, Magic Formula ───────────────────────────────

export function sloanAccruals(annual: AnnualRow[]): ScoreResult {
  const cur = annual[0];
  const prev = annual[1];
  const avgAssets = cur && prev && nz(cur.assets) && nz(prev.assets) ? (cur.assets + prev.assets) / 2 : null;
  const value =
    cur && nz(cur.netIncome) && nz(cur.operatingCashFlow) && avgAssets
      ? ((cur.netIncome - cur.operatingCashFlow) / avgAssets) * 100
      : null;
  return {
    label: "Sloan accruals ratio",
    value,
    zone: value === null ? null : value > 10 ? "high accruals" : value < 0 ? "cash-backed earnings" : "normal",
    basis: "(net income − operating cash flow) / average total assets, in %",
    missing: value === null ? ["net income, CFO and two years of assets"] : [],
    notes: ["Positive means reported earnings exceed cash generation; there is no universal cutoff — compare the trend and peers."],
  };
}

export interface DuPontResult {
  three: {
    netMarginPct: number | null;
    assetTurnover: number | null;
    equityMultiplier: number | null;
    roePct: number | null;
  };
  five: {
    taxBurdenPct: number | null;
    interestBurdenPct: number | null;
    ebitMarginPct: number | null;
    assetTurnover: number | null;
    equityMultiplier: number | null;
    roePct: number | null;
  } | null;
  basis: string;
}

export function dupont(annual: AnnualRow[]): DuPontResult {
  const cur = annual[0];
  const prev = annual[1];
  const avgAssets = cur && prev && nz(cur.assets) && nz(prev.assets) ? (cur.assets + prev.assets) / 2 : cur?.assets ?? null;
  const avgEquity = cur && prev && nz(cur.equity) && nz(prev.equity) ? (cur.equity + prev.equity) / 2 : cur?.equity ?? null;

  const netMargin = ratio(cur?.netIncome, cur?.revenue);
  const turnover = ratio(cur?.revenue, avgAssets);
  const multiplier = ratio(avgAssets, avgEquity);
  const roe = ratio(cur?.netIncome, avgEquity);

  const ebit = cur?.operatingIncome ?? null;
  const ebt = cur?.pretaxIncome ?? null;
  const five =
    nz(cur?.netIncome) && nz(ebt) && nz(ebit) && ebt !== 0 && ebit !== 0 && netMargin !== null
      ? {
          taxBurdenPct: pct(ratio(cur.netIncome, ebt)),
          interestBurdenPct: pct(ratio(ebt, ebit)),
          ebitMarginPct: pct(ratio(ebit, cur.revenue)),
          assetTurnover: turnover,
          equityMultiplier: multiplier,
          roePct: pct(roe),
        }
      : null;

  return {
    three: {
      netMarginPct: pct(netMargin),
      assetTurnover: turnover,
      equityMultiplier: multiplier,
      roePct: pct(roe),
    },
    five,
    basis: "ROE = net margin × asset turnover × equity multiplier (average assets/equity); 5-step splits tax and interest burden out of net margin.",
  };
}

export function grahamNumber(annual: AnnualRow[], price: number | null): {
  value: number | null;
  upsidePct: number | null;
  eps: number | null;
  bookValuePerShare: number | null;
} {
  const cur = annual[0];
  const eps = cur?.epsDiluted ?? null;
  const bvps = cur && nz(cur.equity) && nz(cur.sharesOutstanding) && cur.sharesOutstanding > 0
    ? cur.equity / cur.sharesOutstanding
    : null;
  const value = nz(eps) && nz(bvps) && eps > 0 && bvps > 0 ? Math.sqrt(22.5 * eps * bvps) : null;
  return {
    value,
    upsidePct: value !== null && price !== null && price > 0 ? (value / price - 1) * 100 : null,
    eps,
    bookValuePerShare: bvps,
  };
}

export interface GrahamCriteriaResult {
  checks: Check[];
  passed: number;
  available: number;
}

/** The defensive-investor tests that the dataset can actually answer. */
export function grahamCriteria(annual: AnnualRow[], price: number | null, marketCap: number | null): GrahamCriteriaResult {
  const cur = annual[0];
  const checks: Check[] = [];
  const add = (label: string, pass: boolean | null, detail: string) => checks.push({ label, pass, detail });

  add(
    "Current assets ≥ 2× current liabilities",
    nz(cur?.currentAssets) && nz(cur?.currentLiabilities) ? cur.currentAssets >= 2 * cur.currentLiabilities : null,
    nz(cur?.currentAssets) && nz(cur?.currentLiabilities)
      ? `${cur.currentAssets.toFixed(0)} vs ${(2 * cur.currentLiabilities).toFixed(0)}`
      : "balance-sheet items not reported",
  );
  const wc = nz(cur?.currentAssets) && nz(cur?.currentLiabilities) ? cur.currentAssets - cur.currentLiabilities : null;
  add(
    "Long-term debt ≤ working capital",
    wc !== null && nz(cur?.debt) ? cur.debt <= wc : null,
    wc !== null && nz(cur?.debt) ? `debt ${fmtMoney(cur.debt)} vs WC ${fmtMoney(wc)}` : "debt or working capital unavailable",
  );
  const positiveYears = annual.slice(0, Math.min(10, annual.length)).filter((r) => nz(r.netIncome) && r.netIncome > 0).length;
  add(
    "Positive earnings in each of the past 10 years",
    annual.filter((r) => nz(r.netIncome)).length >= 10 ? positiveYears === 10 : null,
    annual.length >= 10 ? `${positiveYears} of ${annual.length} years positive` : `only ${annual.length} annual periods available`,
  );
  const epsCur = cur?.epsDiluted ?? null;
  const epsThreeAvg = average(annual.slice(0, 3).map((r) => r.epsDiluted));
  const pe = nz(epsThreeAvg) && epsThreeAvg > 0 && price !== null ? price / epsThreeAvg : null;
  add("P/E ≤ 15 on 3-year average EPS", pe === null ? null : pe <= 15, pe === null ? "needs 3 years of EPS and a price" : `P/E ${pe.toFixed(1)}×`);
  const bvps = cur && nz(cur.equity) && nz(cur.sharesOutstanding) && cur.sharesOutstanding > 0 ? cur.equity / cur.sharesOutstanding : null;
  const pb = bvps && price !== null && bvps > 0 ? price / bvps : null;
  add(
    "P/B ≤ 1.5 (or P/E × P/B ≤ 22.5)",
    pb === null ? null : pb <= 1.5 || (pe !== null && pe * pb <= 22.5),
    pb === null ? "needs book value per share and a price" : `P/B ${pb.toFixed(2)}×${pe !== null ? `, P/E×P/B ${(pe * pb).toFixed(1)}` : ""}`,
  );
  add(
    "Adequate size (sales ≥ $100m, historical Graham figure)",
    nz(cur?.revenue) ? cur.revenue >= 100_000_000 : null,
    nz(cur?.revenue) ? `sales ${fmtMoney(cur.revenue)}` : "revenue not reported",
  );
  add(
    "Dividend record ≥ 20 years",
    null,
    "requires a dividend history the SEC annual series does not carry",
  );
  add(
    "Earnings growth ≥ 1/3 over 10 years",
    null,
    annual.length >= 10
      ? "requires the 3-year average EPS ten years earlier and the dividend history"
      : `needs 10 annual periods (have ${annual.length})`,
  );

  const available = checks.filter((c) => c.pass !== null);
  return { checks, passed: available.filter((c) => c.pass).length, available: available.length };
}

export interface MagicFormulaResult {
  returnOnCapitalPct: number | null;
  earningsYieldPct: number | null;
  enterpriseValue: number | null;
  ebit: number | null;
  capitalEmployed: number | null;
  missing: string[];
}

export function magicFormula(annual: AnnualRow[], marketCap: number | null): MagicFormulaResult {
  const cur = annual[0];
  const ebit = cur?.operatingIncome ?? null;
  const nwc = nz(cur?.currentAssets) && nz(cur?.currentLiabilities) ? cur.currentAssets - cur.currentLiabilities : null;
  const ppe = cur?.propertyPlantEquipment ?? null;
  const capitalEmployed = nwc !== null && ppe !== null ? nwc + ppe : null;
  const ev = nz(marketCap) ? marketCap + (cur?.debt ?? 0) - (cur?.cash ?? 0) : null;
  const missing: string[] = [];
  if (ebit === null) missing.push("operating income (EBIT)");
  if (capitalEmployed === null) missing.push("net working capital + net PP&E");
  if (ev === null) missing.push("market cap");
  return {
    returnOnCapitalPct: pct(ratio(ebit, capitalEmployed)),
    earningsYieldPct: pct(ratio(ebit, ev)),
    enterpriseValue: ev,
    ebit,
    capitalEmployed,
    missing,
  };
}

// ─── Multiples ─────────────────────────────────────────────────────────────

export function pegRatio(
  annual: AnnualRow[],
  marketCap: number | null,
): { peg: number | null; pe: number | null; growthPct: number | null; basis: string } {
  const cur = annual[0];
  const pe = nz(marketCap) && nz(cur?.netIncome) && cur.netIncome > 0 ? marketCap / cur.netIncome : null;
  const epsSeries = annual.map((r) => r.epsDiluted).filter(nz).reverse();
  let growth: number | null = null;
  let basis = "needs at least two annual EPS values";
  if (epsSeries.length >= 2) {
    const first = epsSeries[0];
    const last = epsSeries[epsSeries.length - 1];
    const years = epsSeries.length - 1;
    if (first > 0 && last > 0) {
      growth = (Math.pow(last / first, 1 / years) - 1) * 100;
      basis = `${years}-year EPS CAGR from filed statements`;
    }
  }
  return {
    peg: pe !== null && growth !== null && growth > 0 ? pe / growth : null,
    pe,
    growthPct: growth,
    basis,
  };
}

export function evToEbitda(annual: AnnualRow[], marketCap: number | null): { multiple: number | null; ev: number | null; ebitda: number | null } {
  const cur = annual[0];
  const ev = nz(marketCap) ? marketCap + (cur?.debt ?? 0) - (cur?.cash ?? 0) : null;
  const ebitda = nz(cur?.operatingIncome) && nz(cur?.depreciation) ? cur.operatingIncome + cur.depreciation : null;
  return { multiple: ratio(ev, ebitda), ev, ebitda };
}

export function fcfYield(annual: AnnualRow[], marketCap: number | null): { yieldPct: number | null; fcf: number | null } {
  const cur = annual[0];
  return {
    yieldPct: pct(ratio(cur?.freeCashFlow ?? null, marketCap)),
    fcf: cur?.freeCashFlow ?? null,
  };
}

export function ownerEarnings(annual: AnnualRow[]): { value: number | null; basis: string } {
  const cur = annual[0];
  if (!cur) return { value: null, basis: "no statements" };
  const ni = cur.netIncome;
  const da = cur.depreciation;
  const capex = cur.capex;
  if (!nz(ni) || !nz(da) || !nz(capex)) {
    return { value: null, basis: "needs net income, D&A and capex" };
  }
  return {
    value: ni + da - capex,
    basis: "net income + D&A − total capex (all capex treated as maintenance; Buffett's own figure needs maintenance capex, which is not reported)",
  };
}

// ─── Composite ─────────────────────────────────────────────────────────────

export interface CompanyScores {
  fiscalYear: number | null;
  piotroski: PiotroskiResult;
  altman: AltmanResult;
  altmanNonManufacturer: AltmanResult;
  beneish: BeneishResult;
  accruals: ScoreResult;
  dupont: DuPontResult;
  graham: ReturnType<typeof grahamNumber>;
  grahamCriteria: GrahamCriteriaResult;
  magic: MagicFormulaResult;
  peg: ReturnType<typeof pegRatio>;
  evEbitda: ReturnType<typeof evToEbitda>;
  fcf: ReturnType<typeof fcfYield>;
  ownerEarnings: ReturnType<typeof ownerEarnings>;
  /** 0–100 blend of the scores that are available; null if too few inputs. */
  composite: number | null;
  compositeBasis: string;
}

const scoreBand = (v: number | null, lo: number, hi: number): number | null => {
  if (v === null) return null;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
};

export function scoreCompany(
  annual: AnnualRow[],
  marketCap: number | null,
  price: number | null,
): CompanyScores {
  const piotroski = piotroskiFScore(annual);
  const altman = altmanZ(annual, marketCap, "original");
  const altmanNonManufacturer = altmanZ(annual, marketCap, "non-manufacturer");
  const beneish = beneishMScore(annual);
  const accruals = sloanAccruals(annual);
  const dupontRes = dupont(annual);
  const graham = grahamNumber(annual, price);
  const grahamCrit = grahamCriteria(annual, price, marketCap);
  const magic = magicFormula(annual, marketCap);
  const pegRes = pegRatio(annual, marketCap);
  const evEbitdaRes = evToEbitda(annual, marketCap);
  const fcfRes = fcfYield(annual, marketCap);
  const oe = ownerEarnings(annual);

  const parts: number[] = [];
  const labels: string[] = [];
  if (piotroski.value !== null) {
    parts.push((piotroski.value / 9) * 100);
    labels.push("Piotroski");
  }
  const zPart = scoreBand(altman.value, 1.0, 3.5);
  if (zPart !== null) {
    parts.push(zPart);
    labels.push("Altman Z");
  }
  if (accruals.value !== null) {
    parts.push(scoreBand(-accruals.value, -25, 25) ?? 0);
    labels.push("accruals");
  }
  if (dupontRes.three.roePct !== null) {
    parts.push(scoreBand(dupontRes.three.roePct, 0, 30) ?? 0);
    labels.push("ROE");
  }
  if (magic.returnOnCapitalPct !== null) {
    parts.push(scoreBand(magic.returnOnCapitalPct, 0, 30) ?? 0);
    labels.push("return on capital");
  }

  return {
    fiscalYear: annual[0]?.fy ?? null,
    piotroski,
    altman,
    altmanNonManufacturer,
    beneish,
    accruals,
    dupont: dupontRes,
    graham,
    grahamCriteria: grahamCrit,
    magic,
    peg: pegRes,
    evEbitda: evEbitdaRes,
    fcf: fcfRes,
    ownerEarnings: oe,
    composite: parts.length >= 3 ? Math.round(parts.reduce((s, p) => s + p, 0) / parts.length) : null,
    compositeBasis: `equal-weight blend of ${labels.join(", ")}${parts.length < 3 ? " — too few scores for a composite" : ""}`,
  };
}

// ─── Formatting helpers (used in the `detail` strings) ─────────────────────

function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtShares(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return v.toFixed(0);
}

function average(xs: Array<number | null>): number | null {
  const vals = xs.filter(nz);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
