import type { CategoryId, RiskBand, Strategy, StrategyFact } from "./strategies-db";

/**
 * Researched strategy additions — curated October 2026, outside the workbook.
 *
 * The workbook (`strategies-db.ts`) is generated from a spreadsheet and is
 * arbitrage-heavy:186 of its rows trade price gaps. This module adds50 strategies
 * that ordinary investors actually use — index cores, factor tilts, cash and bond
 * ladders, options income, real-estate methods, allocation frameworks and a few
 * speculative crypto methods — each with:
 *
 *   - a risk level (0–1, banded exactly like the workbook's rows),
 *   - a viability verdict with a note saying what has to be true for it to work,
 *   - a return figure where one is honestly available (typical industry range,
 *     historical average or current published yield) and `null` where it is not,
 *   - a horizon (short < ~1 year, medium ~1–5 years, long5+ years) so the
 *     explorer can sort and filter for short-term vs long-term money,
 *   - at least one source **that was actually opened during the research pass**.
 *
 * Rules kept from the rest of the catalogue:
 *   - every figure-bearing fact starts with "Typical:", "Historical:" or
 *     "As of" — these are ranges and measurements, never forecasts;
 *   - a method nobody has priced keeps a blank figure (`retAnnual: null`) and
 *     says why in the drawer rather than inventing a number;
 *   - no recommendation or guarantee language anywhere.
 *
 * Reddit and forum threads were part of the research pass (r/options, r/Bogleheads,
 * r/personalfinance, r/financialindependence, r/realestateinvesting all surfaced
 * these methods), but reddit.com refused direct fetches, so only pages that were
 * genuinely opened are cited as sources. Where a community-beloved method has no
 * credible measured figure (the wheel, house hacking), the row says so instead of
 * quoting a backtest blog.
 */

export type Horizon = "short" | "medium" | "long";

export type Viability = "Viable" | "Viable with conditions" | "Speculative" | "Mostly institutional";

export interface ResearchedSource {
  title: string;
  url: string;
  note: string;
}

export interface ResearchedStrategy extends Strategy {
  /** Marker for the type guard — workbook rows do not carry it. */
  researched: true;
  horizon: Horizon;
  horizonText: string;
  viability: Viability;
  viabilityNote: string;
  /** Pages actually opened during research; every entry has at least one. */
  sources: ResearchedSource[];
}

export const HORIZON_META: Record<Horizon, { label: string; hint: string; order: number }> = {
  short: { label: "Short-term", hint: "under about a year", order: 0 },
  medium: { label: "Medium-term", hint: "about1–5 years", order: 1 },
  long: { label: "Long-term", hint: "5 years and beyond", order: 2 },
};

export const VIABILITIES: Viability[] = ["Viable", "Viable with conditions", "Speculative", "Mostly institutional"];

/* --------------------------------------------------------------- builder -- */

const RESEARCHED_MARKER = "Researched addition (not in the workbook)";

function riskBandOf(risk: number): RiskBand {
  if (risk < 0.35) return "Very low";
  if (risk < 0.5) return "Low";
  if (risk < 0.65) return "Moderate";
  if (risk < 0.8) return "Elevated";
  if (risk < 0.95) return "High";
  return "Extreme";
}

interface RetSpec {
  low: number;
  high: number;
  /** Display text for the card; defaults to "low%–high%". */
  text?: string;
  basis?: "annual" | "monthly";
}

interface Def {
  id: string;
  name: string;
  category: CategoryId;
  horizon: Horizon;
  horizonText: string;
  risk: number;
  ret?: RetSpec;
  viability: Viability;
  viabilityNote: string;
  description: string;
  rationale: string;
  keyRisk: string;
  facts?: StrategyFact[];
  sources: ResearchedSource[];
  limitations?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function build(def: Def): ResearchedStrategy {
  const risk = def.risk;
  const band = riskBandOf(risk);
  const basis = def.ret?.basis ?? "annual";
  const retMid = def.ret ? round2((def.ret.low + def.ret.high) / 2) : null;
  const retAnnual = def.ret ? (basis === "monthly" ? round2((retMid as number) * 12) : retMid) : null;
  const score = retAnnual != null && risk > 0 ? Math.round((retAnnual / risk) * 10) / 10 : null;
  const retText = def.ret ? def.ret.text ?? `${def.ret.low}%–${def.ret.high}%` : "";
  const horizonMeta = HORIZON_META[def.horizon];

  const facts: StrategyFact[] = [
    { label: "Horizon", value: `${horizonMeta.label} (${def.horizonText})` },
    { label: "Viability", value: `${def.viability} — ${def.viabilityNote}` },
    ...(def.facts ?? []),
  ];

  return {
    researched: true,
    id: def.id,
    name: def.name,
    category: def.category,
    sheetCategory: RESEARCHED_MARKER,
    outlook: "",
    risk,
    riskText: band,
    band,
    retText,
    retMid,
    retAnnual,
    retBasis: def.ret ? basis : "not stated",
    coreRank: null,
    score,
    tier: "Researched — outside the workbook",
    description: def.description,
    rationale: def.rationale,
    keyRisk: def.keyRisk,
    source: def.sources.map((s) => s.title).join("; "),
    freshness: "Researched October 2026",
    confidence: "Sourced from pages opened October2026; figures are typical ranges, historical averages or published current yields — not forecasts",
    limitations:
      def.limitations ??
      "Industry ranges and historical measurements vary with window, vehicle and costs; verify the current figure before relying on it.",
    aliases: [],
    facts,
    horizon: def.horizon,
    horizonText: def.horizonText,
    viability: def.viability,
    viabilityNote: def.viabilityNote,
    sources: def.sources,
  };
}

/* --------------------------------------------------------------- sources -- */

const DAMODARAN = {
  title: "Historical Returns on Stocks, Bonds and Bills:1928–2024 (NYU Stern)",
  url: "https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html",
  note: "Damodaran's annual US dataset: equities, small caps, T-bills, T-bonds, Baa corporates, real estate and gold.",
};
const CBOE_BXM = {
  title: "Cboe S&P500 BuyWrite Index (BXM) factsheet",
  url: "https://cdn.cboe.com/resources/indices/factsheet/CboeGlobalIndices_BXM-Index.pdf",
  note: "Covered-call benchmark since1986 with full risk metrics versus the S&P500.",
};
const CBOE_PUT = {
  title: "Cboe S&P500 PutWrite Index (PUT) factsheet",
  url: "https://cdn.cboe.com/resources/indices/factsheet/CboeGlobalIndices_PUT-Index.pdf",
  note: "Collateralised short-put benchmark since2007 with full risk metrics versus the S&P500.",
};
const AQR_FACTORS = {
  title: "AQR — Understanding Factor Investing",
  url: "https://funds.aqr.com/Insights/Strategies/Understanding-Factor-Investing",
  note: "Factor families (value, momentum, quality, low-volatility, defensive, multi-factor) and what they target.",
};

/* ------------------------------------------------------------------ data -- */

const DEFS: Def[] = [
  /* ---------------------------------------------------------- cash ------ */
  {
    id: "treasury-bill-ladder",
    name: "Treasury Bill Ladder",
    category: "cash",
    horizon: "short",
    horizonText: "4 to52 weeks per rung; the ladder keeps rolling",
    risk: 0.05,
    ret: { low: 3, high: 4, text: "≈3%–4% (floats with the T-bill curve)" },
    viability: "Viable",
    viabilityNote: "Buy at auction through TreasuryDirect or a broker; the only credit exposure is the US Treasury.",
    description:
      "Stagger purchases across4-,8-,13-,26- and52-week bills so a rung matures at regular intervals. Each maturity is cash you can spend, reinvest at the new curve, or roll forward.",
    rationale:
      "The safest liquid yield available to a retail investor, with a deep secondary market and interest exempt from state and local tax. The ladder exists to manage reinvestment risk rather than to beat anything.",
    keyRisk:
      "When the curve drops, every rung that matures rolls into a lower rate; long cash stretches also mean large equity-bear-market opportunity cost.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: the3-month T-bill averaged roughly3.3%/yr over1928–2024 in the NYU Stern dataset; the current rate is whatever the latest auction sets.",
      },
      { label: "Liquidity", value: "Daily secondary market; bills are among the most liquid securities in existence." },
    ],
    sources: [DAMODARAN],
  },
  {
    id: "series-i-savings-bonds",
    name: "Series I Savings Bonds",
    category: "cash",
    horizon: "medium",
    horizonText: "1-year lock; sensibly held5+ years;30-year instrument",
    risk: 0.1,
    ret: { low: 4.26, high: 4.26, text: "4.26% composite (May–Oct2026 issue window)" },
    viability: "Viable",
    viabilityNote: "Capped at USD10,000 per year per person electronically — it is a cash-buffer tool, not a portfolio.",
    description:
      "A US Treasury savings bond whose rate = a fixed rate (known at purchase, for life) plus an inflation rate that resets every six months from CPI-U. Interest compounds and is deferred until redemption.",
    rationale:
      "Inflation-linked government yield with a0% floor and no price risk if held to maturity terms. The fixed component is the part you actually keep for thirty years.",
    keyRisk:
      "One-year lock and a three-month interest penalty for redemptions inside five years; the inflation component can reset to near zero in deflation.",
    facts: [
      {
        label: "As of",
        value: "As of the May1–Oct31,2026 issue window: composite4.26%, of which the fixed rate is0.90% for the life of the bond (TreasuryDirect).",
      },
      { label: "Purchase cap", value: "USD10,000 electronic per calendar year per person (paper via tax refund on top)." },
    ],
    sources: [
      {
        title: "TreasuryDirect — I bonds interest rates",
        url: "https://treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/",
        note: "Official composite rate, fixed-rate mechanics and the semiannual CPI reset.",
      },
      DAMODARAN,
    ],
  },
  {
    id: "money-market-fund-parking",
    name: "Money Market Fund Parking",
    category: "cash",
    horizon: "short",
    horizonText: "Same-day liquidity; designed as a cash substitute",
    risk: 0.05,
    ret: { low: 3, high: 4, text: "≈ the T-bill rate less fees (3%–4% when bills yield there)" },
    viability: "Viable",
    viabilityNote: "Government/retail class funds only; yields track short rates and move with policy.",
    description:
      "Park cash in a regulated mutual fund holding T-bills, commercial paper, bankers' acceptances and CDs. Retail government funds are managed to keep a stable $1 NAV with a weighted average maturity under60 days.",
    rationale:
      "A cash substitute that pays the prevailing short rate; useful as the collateral base for options strategies and as the spending buffer for any portfolio.",
    keyRisk:
      "Not bank-insured (SIPC protection only, no FDIC); prime funds carry credit risk and can break the buck in stress; yields fall the moment rates are cut.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: money market yields track the T-bill rate, which averaged roughly3.3%/yr over1928–2024 (NYU Stern); the fund charges come off the top.",
      },
    ],
    sources: [
      {
        title: "FINRA — Taking a Look at Money Market Funds",
        url: "https://www.finra.org/investors/insights/money-market-funds",
        note: "Fund types, the60-day weighted-average-maturity rule, $1 NAV and the FDIC/SIPC distinction.",
      },
      DAMODARAN,
    ],
  },
  {
    id: "cd-ladder",
    name: "Certificate of Deposit Ladder",
    category: "cash",
    horizon: "medium",
    horizonText: "3 months to5 years per rung",
    risk: 0.08,
    ret: { low: 3.5, high: 5, text: "≈3.5%–5% APY (best offers ≈5.00%, Oct2026)" },
    viability: "Viable",
    viabilityNote: "FDIC/NCUA insurance per bank per owner category; spread across institutions above the limit.",
    description:
      "Split cash across CDs of increasing maturities so one rung matures regularly, each rung reinvested at the newest rate. Brokered CDs add a secondary market; direct bank CDs add early-withdrawal penalties.",
    rationale:
      "Locks a known rate with deposit insurance; the ladder removes the need to guess where rates will be when the current CD matures.",
    keyRisk:
      "Early-withdrawal penalties; reinvestment risk on short rungs; the opportunity cost of insured cash during long equity bull phases.",
    facts: [
      {
        label: "As of",
        value: "As of Oct2026, the best published CD offers reached ≈5.00% APY on short terms, with the broad market clustered in the3.5%–4.5% area (Bankrate rate tables).",
      },
    ],
    sources: [
      {
        title: "Bankrate — Best CD Rates (Oct2026)",
        url: "https://www.bankrate.com/banking/cds/cd-rates/",
        note: "Live comparison of broker and bank CD offers across terms.",
      },
      DAMODARAN,
    ],
  },
  {
    id: "municipal-bond-ladder",
    name: "Municipal Bond Ladder",
    category: "cash",
    horizon: "long",
    horizonText: "5–30 years across rungs",
    risk: 0.2,
    viability: "Viable with conditions",
    viabilityNote: "Only beats taxable alternatives for taxpayers in meaningful brackets — compare tax-equivalent yields first.",
    description:
      "A staggered ladder of state and local government bonds whose interest is generally exempt from federal income tax (and often state tax in the issuing state).",
    rationale:
      "Tax-exempt income at near-investment-grade risk for high-bracket investors; the ladder fixes reinvestment the same way it does for corporates.",
    keyRisk:
      "Municipal credit is thinner than corporate credit (small issuers, revenue-backed obligations); call features shorten duration exactly when rates fall.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: tax-exempt municipal paper prices at a lower yield than taxable equivalents; the tax-equivalent yield must be computed against the investor's own bracket before this beats a corporate ladder.",
      },
    ],
    sources: [
      {
        title: "FINRA — Money Market Funds (tax-exempt fund mechanics)",
        url: "https://www.finra.org/investors/insights/money-market-funds",
        note: "Mechanism context on state/local obligations and federal tax exemption; no muni-specific yield is published on this page.",
      },
    ],
  },
  {
    id: "myga-annuity-ladder",
    name: "MYGA (Multi-Year Fixed-Rate Annuity) Ladder",
    category: "cash",
    horizon: "long",
    horizonText: "2–9 years per contract; ladder the maturities",
    risk: 0.25,
    ret: { low: 5.3, high: 6.6, text: "≈5.3%–6.6% (A-rated carriers, Oct2026)" },
    viability: "Viable with conditions",
    viabilityNote: "The rate is contractual, but the promise is only as good as the insurer; treat it as a CD alternative, not a market product.",
    description:
      "A fixed-rate deferred annuity: one rate for the whole term, tax-deferred compounding, laddered across maturities the same way as CDs. Surrender charges apply if you exit early.",
    rationale:
      "In a high-rate window these have priced above Treasuries and CDs because the carrier carries the credit and the duration.",
    keyRisk:
      "Insurer default risk (state guaranty funds have caps and are not insurance); surrender charges; early withdrawals before59½ can carry a tax penalty.",
    facts: [
      {
        label: "As of",
        value:
          "As of late Sep/Oct2026, A-rated multi-year fixed annuity rates ran roughly5.30%–6.00% by term, with the best published offers up to ≈6.6% on long terms (annuity.org rate tables).",
      },
    ],
    sources: [
      {
        title: "Annuity.org — Best Fixed Annuity Rates",
        url: "https://www.annuity.org/annuities/rates/",
        note: "Daily-updated rate table by carrier rating and term.",
      },
    ],
  },
  {
    id: "bank-bonus-churning",
    name: "Bank Account Bonus Churning",
    category: "cash",
    horizon: "short",
    horizonText: "About2–6 months per bonus cycle",
    risk: 0.15,
    viability: "Viable",
    viabilityNote: "Requires organisation: direct-deposit or balance requirements, fee waivers and account-closing dates.",
    description:
      "Open checking/savings accounts for their cash sign-up bonuses, meet the stated direct-deposit or balance requirement for the stated period, collect the bonus, then close or move on to the next offer.",
    rationale:
      "Banks price acquisition aggressively; the payout on the required balance for the required months can beat any savings rate available, with no market risk.",
    keyRisk:
      "Hard-pull or ChexSystems effects on repeated applications; bonuses are taxable interest; the cash is locked out of other investments during the qualifying window.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: offers in2026 cluster in the low hundreds of dollars per cycle — for example a $250 bonus for two $500 direct deposits within75 days (Finder, Oct2026) — with larger balances unlocking four-figure offers.",
      },
    ],
    sources: [
      {
        title: "Finder — Best Checking Account Bonuses (Oct2026)",
        url: "https://www.finder.com/banking/best-checking-account-bonuses",
        note: "Live list of qualifying requirements per offer.",
      },
    ],
  },
  {
    id: "sukuk-ijarah",
    name: "Sukuk Ijarah (Lease-Based Islamic Bonds)",
    category: "cash",
    horizon: "long",
    horizonText: "3–10 years typical maturities",
    risk: 0.3,
    ret: { low: 5, high: 5.6, text: "≈5%–5.6% (global sukuk yield to worst, Sep2026)" },
    viability: "Viable",
    viabilityNote: "Shariah-screened fixed income; the investable universe is smaller than conventional bonds.",
    description:
      "Certificates whose return is rent on a real asset or usufruct, not interest on a loan — the compliant fixed-income instrument for portfolios that screen for it. Ijarah (lease-based) structures are the most asset-backed form.",
    rationale:
      "Same role as a bond ladder — duration and income — with AAOIFI-style screening applied to the underlying asset and contract.",
    keyRisk:
      "Credit and duration risk behave like conventional bonds; non-USD issues add currency risk; some structures are asset-based rather than asset-backed.",
    facts: [
      {
        label: "As of",
        value:
          "As of Sep30,2026 the MSCI Global Sukuk Index showed yield to worst5.54%, modified duration5.30 and average rating A− across293 securities ($527B market cap).",
      },
    ],
    sources: [
      {
        title: "MSCI Global Sukuk Index",
        url: "https://www.msci.com/indexes/index/765221/msci-global-sukuk-index",
        note: "Live index characteristics: yield, duration, rating, constituents.",
      },
    ],
  },
  {
    id: "long-term-bond-ladder",
    name: "Long-Term Treasury Ladder",
    category: "cash",
    horizon: "long",
    horizonText: "1–30 years across rungs, held to maturity",
    risk: 0.3,
    ret: { low: 4.5, high: 5.5, text: "≈4.5%–5.5% long-run average (floats with the curve)" },
    viability: "Viable with conditions",
    viabilityNote: "Only makes sense with maturities matched to known future spending; selling early reintroduces rate risk.",
    description:
      "Individual US Treasuries held to maturity across many years, so each future year of spending is already funded by a known par value.",
    rationale:
      "The only duration instrument with no default question; a ladder turns bond-price volatility into a non-issue if you simply never sell before maturity.",
    keyRisk:
      "Long bonds swing hard mark-to-market (30-year Treasuries can fall double digits in a rising-rate year); reinvestment at maturity may be at much lower rates.",
    facts: [
      {
        label: "Historical anchor",
        value: "Historical: the10-year US Treasury averaged roughly5%/yr over1928–2024 (NYU Stern dataset).",
      },
    ],
    sources: [DAMODARAN],
  },
  {
    id: "investment-grade-corporate-ladder",
    name: "Investment-Grade Corporate Bond Ladder",
    category: "cash",
    horizon: "long",
    horizonText: "1–10 years per rung",
    risk: 0.35,
    ret: { low: 5.5, high: 6.5, text: "≈5.5%–6.5% long-run average (Baa corporates)" },
    viability: "Viable with conditions",
    viabilityNote: "Individual bonds or broad IG funds; the spread is the payment for taking issuer credit.",
    description:
      "Ladder investment-grade corporate bonds to earn the credit spread over Treasuries with defined maturities, or use a broad IG fund for simplicity at the cost of perpetual duration.",
    rationale:
      "Corporate spreads are the market's price for default risk; a ladder lets you harvest it with known exit dates.",
    keyRisk:
      "Downgrades and defaults hit the lowest IG tier (Baa) hardest; spread widening marks paper down even when credit is fine.",
    facts: [
      {
        label: "Historical anchor",
        value: "Historical: Baa corporates averaged roughly6%/yr over1928–2024 versus ≈5% for Treasuries (NYU Stern dataset).",
      },
    ],
    sources: [DAMODARAN],
  },
  {
    id: "tax-exempt-money-market-funds",
    name: "Tax-Exempt Money Market Funds",
    category: "cash",
    horizon: "short",
    horizonText: "Same-day liquidity cash substitute",
    risk: 0.1,
    viability: "Viable with conditions",
    viabilityNote: "Only meaningful for high-bracket taxpayers; the headline yield is always lower than taxable funds.",
    description:
      "Money market funds holding short state and local obligations, paying interest generally exempt from federal income tax (and often state tax for residents of the issuing state).",
    rationale:
      "For a top-bracket investor the after-tax yield can beat taxable government funds even though the quoted yield is lower.",
    keyRisk:
      "Lower pre-tax yield means low-bracket investors lose by switching; state-specific concentration in single-state versions.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: compare the tax-exempt yield against a taxable fund's yield × (1 − marginal federal rate); the switch only pays above that crossover.",
      },
    ],
    sources: [
      {
        title: "FINRA — Taking a Look at Money Market Funds",
        url: "https://www.finra.org/investors/insights/money-market-funds",
        note: "Describes tax-exempt municipal money market funds and their federal tax treatment.",
      },
    ],
  },

  /* --------------------------------------------------------- income ----- */
  {
    id: "covered-call-etf-funds",
    name: "Covered-Call ETF Funds (JEPI / QYLD class)",
    category: "income",
    horizon: "medium",
    horizonText: "Ongoing holding; monthly distributions",
    risk: 0.45,
    ret: { low: 7, high: 12, text: "≈7%–12% trailing distributions (JEPI≈7.4%, XYLD≈9.5%, QYLD≈11.8%, Jan2026)" },
    viability: "Viable with conditions",
    viabilityNote: "Income vehicles, not return engines: yield is not total return and the caps are structural.",
    description:
      "ETFs that hold an equity portfolio and systematically sell options against it, distributing the premium as monthly income. QYLD/XYLD write at-the-money calls on the whole index; JEPI uses equity-linked notes on out-of-the-money strikes.",
    rationale:
      "Buys the same exposure as the Cboe buy-write benchmark in an ETF wrapper: less volatility and shallower drawdowns than the index, in exchange for capped upside.",
    keyRisk:
      "Upside is capped in rallies and the full market hit minus premium arrives in falls; high distribution yields can mask NAV erosion, and tax treatment differs fund by fund.",
    facts: [
      {
        label: "Historical benchmark",
        value:
          "Historical: the Cboe BXM buy-write index compounded ≈8.6%/yr since1986 versus ≈11.2% for the S&P500, with10.6% versus15.2% volatility and a -35.8% versus -50.9% worst drawdown (Cboe factsheet, Sep2026).",
      },
      {
        label: "Structural point",
        value: "Typical: QYLD-style at-the-money writing surrenders nearly all upside; JEPI-style out-of-the-money writing keeps more of it for a lower headline yield (TradeAlgo fund comparison).",
      },
    ],
    sources: [
      {
        title: "TradeAlgo — QYLD vs JEPI vs XYLD",
        url: "https://www.tradealgo.com/trading-guides/options/qyld-vs-jepi-vs-xyld",
        note: "Trailing yields, strike methodology, expense ratios and NAV behaviour of the three largest funds.",
      },
      CBOE_BXM,
    ],
  },
  {
    id: "manual-buy-write-covered-calls",
    name: "Manual Covered Calls (Buy-Write)",
    category: "income",
    horizon: "medium",
    horizonText: "30–60 day typical cycle; ongoing",
    risk: 0.45,    ret: { low: 8.6, high: 8.6, text: "≈8.6%/yr (Cboe BXM buy-write benchmark,1986–2026)" },
    viability: "Viable with conditions",
    viabilityNote: "Needs options approval, position sizing per100 shares, and discipline about what you are willing to sell at.",
    description:
      "Own100 shares per contract and sell call options against them repeatedly, collecting premium until expiration or assignment. The DIY version lets you choose strikes and names instead of taking the index's systematic rule.",
    rationale:
      "Converts idle upside into cash flow; the benchmark evidence says the trade is a volatility-and-drawdown reduction with a return cost, not free income.",
    keyRisk:
      "Shares are called away in rallies at the strike; in falls the premium is only a thin cushion against the full equity loss.",
    facts: [
      {
        label: "Historical benchmark",
        value:
          "Historical: Cboe BXM (systematic ATM monthly writing on the S&P500) since1986: ≈8.6%/yr, Sharpe0.56 versus the index's0.56, beta0.62 (Cboe factsheet, Sep2026).",
      },
    ],
    sources: [CBOE_BXM],
  },
  {
    id: "cash-secured-put-selling",
    name: "Cash-Secured Put Selling",
    category: "income",
    horizon: "medium",
    horizonText: "30–45 day typical cycle; ongoing",
    risk: 0.55,
    ret: { low: 7.2, high: 7.2, text: "≈7.2%/yr (Cboe PUT benchmark,2007–2026)" },
    viability: "Viable with conditions",
    viabilityNote: "Requires full cash collateral in bills or cash — naked margin selling puts is a different, much riskier trade.",
    description:
      "Sell put options on stocks (or indexes) you are genuinely willing to own, with cash held against the obligation. Keep the premium if the option expires worthless; buy the stock at the strike if assigned.",
    rationale:
      "Paid to wait at a lower entry price; the collateral earns its own yield while the put is open. The PUT index is the systematic, measured version of exactly this.",
    keyRisk:
      "Assignment in falling markets delivers the full loss below the strike minus premium; single-stock puts add idiosyncratic blow-up risk.",
    facts: [
      {
        label: "Historical benchmark",
        value:
          "Historical: Cboe PUT (ATM monthly SPX puts over T-bill collateral) sinceJan2007: ≈7.2%/yr versus ≈11.0% for the S&P500, with10.7% versus15.4% volatility and a -32.7% versus -50.9% worst drawdown (Cboe factsheet, Sep2026).",
      },
    ],
    sources: [CBOE_PUT],
  },
  {
    id: "options-wheel-strategy",
    name: "The Wheel (Cash-Secured Put → Covered Call)",
    category: "income",
    horizon: "medium",
    horizonText: "3–9 months per full cycle",
    risk: 0.55,
    viability: "Viable with conditions",
    viabilityNote: "A retail favourite (it dominates r/options); treat the Cboe indices as the honest evidence base, not broker-blog backtests.",
    description:
      "Sell cash-secured puts; if assigned, hold the shares and sell covered calls until called away; repeat. One continuous loop of collecting premium on a stock you are content to own at your own prices.",
    rationale:
      "Formalises buy-low/sell-high with cash flow in between. Because the wheel is simply a put-write leg stacked on a buy-write leg, the Cboe PUT and BXM indices bracket what a systematic version has historically delivered.",
    keyRisk:
      "The stock can fall far below the strike and then sit there while your calls are struck below your cost basis; the cycle can lock capital for months at a loss.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: no credible long-run annual figure exists for the wheel itself — once assignment is included its exposure converges on the same short-put-plus-buy-write profile the Cboe PUT and BXM indices measure (≈7%–9%/yr long-run at index level, lower volatility than the S&P500).",
      },
    ],
    sources: [
      {
        title: "Alpaca — The Options Wheel Strategy",
        url: "https://alpaca.markets/learn/options-wheel-strategy",
        note: "Mechanics, assignment flow and risk management of the CSP-to-covered-call loop.",
      },
      CBOE_PUT,
      CBOE_BXM,
    ],
  },
  {
    id: "dividend-growth-investing",
    name: "Dividend Growth Investing",
    category: "income",
    horizon: "long",
    horizonText: "5+ years; built for decades of compounding",
    risk: 0.45,
    viability: "Viable with conditions",
    viabilityNote: "Works as a core only if dividends are reinvested and the payer's dividend is sustainable, not just high.",
    description:
      "Own companies with long records of raising dividends (the aristocrats criterion is25 consecutive years) and reinvest the payments. The point is the growth rate of the income, not the starting yield.",
    rationale:
      "Dividends are a documented third of long-run equity total return when reinvested; a growing-dividend screen is a conservative quality filter that has historically produced steadier compounding with shallower drawdowns than the broad market.",
    keyRisk:
      "Sector concentration (financials, staples, healthcare, utilities); long stretches of growth-stock underperformance; a dividend cut is usually accompanied by a price collapse.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: the NYU Stern S&P500 series includes reinvested dividends and still averages only ≈10%/yr since1928 — the dividend-growth approach trades some of the market's upside for lower drawdowns rather than beating it (AQR factor framing: quality/low-vol tilts target risk reduction).",
      },
    ],
    sources: [AQR_FACTORS, DAMODARAN],
  },
  {
    id: "peer-to-peer-lending",
    name: "Peer-to-Peer Consumer Lending",
    category: "income",
    horizon: "medium",
    horizonText: "36–60 month loans; monthly principal and interest",
    risk: 0.6,
    ret: { low: 5.3, high: 5.3, text: "≈5.3% platform average (Prosper, Oct2026)" },
    viability: "Viable with conditions",
    viabilityNote: "Diversify across hundreds of notes; grade selection moves results more than most investors expect.",
    description:
      "Invest in small fractions of personal loans on a marketplace; borrowers repay monthly with interest. Auto-invest tools build and maintain the diversification.",
    rationale:
      "Consumer credit yield without a bank intermediary; the platform publishes its own aggregate result so the figure is checkable.",
    keyRisk:
      "Defaults are concentrated in low grades and in economic downturns; secondary market liquidity is thin; platform risk sits between you and the borrower.",
    facts: [
      {
        label: "As of",
        value:
          "As of Oct2026 Prosper's published average historical return across its platform was ≈5.3% — individual portfolios range widely with grade mix and era; independent analyses argue net-of-default results can be materially lower than headline yields.",
      },
    ],
    sources: [
      {
        title: "Prosper — Invest (platform performance)",
        url: "https://www.prosper.com/invest",
        note: "Platform-published average historical return and auto-invest grade mixes.",
      },
    ],
  },
  {
    id: "farmland-investment-platforms",
    name: "Farmland Investment Platforms",
    category: "income",
    horizon: "long",
    horizonText: "3–7 year typical platform holds",
    risk: 0.55,
    ret: { low: 12.1, high: 12.1, text: "≈12.1%/yr20-year US farmland average (USDA/NCREIF via AcreTrader)" },
    viability: "Viable with conditions",
    viabilityNote: "Illiquid, appraisal-priced and platform-dependent; the long average is not a promise about the next decade.",
    description:
      "Buy shares in farmland parcels through platforms that handle title, farming operators and leases; income arrives as lease payments plus land appreciation, often with quarterly distributions.",
    rationale:
      "A real asset with low equity correlation: returns come from crop leases and from land values that track agricultural economics rather than corporate earnings.",
    keyRisk:
      "Illiquidity and platform concentration; weather, commodity-price and rate cycles; recent years have run well below the long-run average (2024 even printed slightly negative in index terms).",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: US farmland averaged ≈12.1%/yr over the past20 years in AcreTrader's compilation of USDA and NCREIF data; total returns were positive every year since1990 in that dataset, but the last two years were roughly flat to negative.",
      },
    ],
    sources: [
      {
        title: "AcreTrader — Farmland Returns in the United States",
        url: "https://acretrader.com/resources/farmland-values/farmland-returns",
        note: "USDA/NCREIF-based long-run farmland return compilation.",
      },
    ],
  },
  {
    id: "mortgage-note-investing",
    name: "Mortgage Note Investing",
    category: "income",
    horizon: "medium",
    horizonText: "2–7 years remaining term typical",
    risk: 0.6,
    ret: { low: 8, high: 12, text: "≈8%–12% (performing notes, industry guides)" },
    viability: "Viable with conditions",
    viabilityNote: "Direct ownership of servicing or a good servicer is required; this is private credit with a house behind it.",
    description:
      "Buy the promissory note secured by real estate — performing for monthly income, or non-performing at a discount to restructure or foreclose. The note, not the property, is what you own.",
    rationale:
      "Real-estate-secured yield without landlord duties; performing notes price off the borrower's payment record and the collateral, not off market sentiment.",
    keyRisk:
      "Borrower default; servicing quality; notes are illiquid and title/lien diligence is on the buyer; foreclosure is slow and expensive where it comes to that.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: performing notes are marketed around the8%–12% range against CDs and bonds (The Entrust Group guide); non-performing paper is priced off recovery scenarios instead of yield and can lose the whole investment.",
      },
    ],
    sources: [
      {
        title: "The Entrust Group — The Ultimate Guide to Mortgage Note Investing",
        url: "https://www.theentrustgroup.com/blog/mortgage-note-investing",
        note: "Note mechanics, types, risks and due-diligence checklist.",
      },
    ],
  },
  {
    id: "business-development-companies",
    name: "Business Development Companies (BDCs)",
    category: "income",
    horizon: "medium",
    horizonText: "Daily liquidity; multi-year income holding",
    risk: 0.65,
    viability: "Viable with conditions",
    viabilityNote: "Income vehicles with real credit risk: pick the portfolio, not just the yield.",
    description:
      "Listed US investment companies (regulated since1980) that lend to and take equity in small and mid-sized businesses, distributing at least90% of taxable income as dividends.",
    rationale:
      "Daily-liquid access to the private-credit spread that used to require a private fund; the dividend is real interest income from operating loans.",
    keyRisk:
      "Loan losses pass straight to shareholders; BDCs use leverage on top of credit risk; payouts track portfolio performance and can be cut.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: BDC dividend yields have run well above investment-grade corporate credit in recent years, which is the entire appeal and the entire warning (VanEck BDC investor guide).",
      },
    ],
    sources: [
      {
        title: "VanEck — BDC Investing: A Comprehensive Guide for Investors",
        url: "https://www.vaneck.com/us/en/blogs/income-investing/investors-guide-to-bdcs/",
        note: "BDC structure, the90% distribution requirement and the risk framing.",
      },
    ],
  },
  {
    id: "clo-equity-tranches",
    name: "CLO Equity Tranches",
    category: "income",
    horizon: "long",
    horizonText: "5–12 years (CLO deal life)",
    risk: 0.8,
    ret: { low: 8.9, high: 10.6, text: "≈9%–10.6% average/median IRR (797 completed deals)" },
    viability: "Mostly institutional",
    viabilityNote: "First-loss sleeve of a leveraged-loan securitisation; retail access is usually via specialist funds.",
    description:
      "The residual slice of a collateralised loan obligation: it takes the first credit losses and receives all the excess spread after the debt tranches are paid. Cash flows are waterfall-dictated and often distributed quarterly.",
    rationale:
      "Levered credit carry with a defined legal structure; the equity tranche is where the loan portfolio's default risk is actually priced.",
    keyRisk:
      "Loan defaults hit equity first and can end the deal; manager quality matters enormously; pricing is opaque and secondary liquidity is limited.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: across797 CLOs that made final equity distributions between the late1990s and2020, the average equity tranche returned ≈8.98%/yr and the median ≈10.63%/yr (Amherst Pierpont study, via SanCap Portfolio Strategy).",
      },
    ],
    sources: [
      {
        title: "SanCap Portfolio Strategy — Evaluating CLO Equity",
        url: "https://portfolio-strategy.apsec.com/a-quick-guide-to-clo-debt-and-equity/chapter-v/",
        note: "The797-deal final-distribution study and how CLO equity governance works.",
      },
    ],
  },
  {
    id: "trade-finance-funds",
    name: "Trade & Supply-Chain Finance Funds",
    category: "income",
    horizon: "short",
    horizonText: "30–120 days per transaction; funds are evergreen",
    risk: 0.5,
    viability: "Viable with conditions",
    viabilityNote: "Institutional fund access mainly; direct platform lending adds counterparty selection risk.",
    description:
      "Finance the gap between a supplier shipping goods and a buyer paying for them — invoices, letters of credit, receivables — for a discount. Each transaction self-liquidates when the buyer pays.",
    rationale:
      "Short-duration, goods-secured credit that has historically yielded above money-market rates with low volatility and low correlation to public markets.",
    keyRisk:
      "Double-financing and document fraud; concentration in corridors or buyers; the asset class's low default history is regime-dependent.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: trade finance returns sit above money-market yields with low volatility and a30–120 day horizon; global demand for the funding is estimated at USD2.5–4 trillion (AllianzGI).",
      },
    ],
    sources: [
      {
        title: "AllianzGI — Trade finance: a portfolio staple",
        url: "https://www.allianzgi.com/en/insights/trade-finance-portfolio-staple",
        note: "Market size, structure, correlation and the yield argument versus cash.",
      },
    ],
  },
  {
    id: "net-lease-reit-income",
    name: "Net-Lease REIT Income",
    category: "income",
    horizon: "long",
    horizonText: "Multi-year holding; daily liquidity via the REIT",
    risk: 0.5,
    ret: { low: 4, high: 4.5, text: "≈4%–4.5% (triple-net lease REITs, YE2025)" },
    viability: "Viable with conditions",
    viabilityNote: "Sustainable only where the tenant roster and rent escalators are solid — yield alone does not prove that.",
    description:
      "Listed REITs owning single-tenant properties on triple-net leases: the tenant pays taxes, insurance and maintenance, so the REIT's cash flow is close to a bond coupon on real estate.",
    rationale:
      "The most bond-like listed real-estate exposure, with contractual rent escalators and daily liquidity that private property cannot offer.",
    keyRisk:
      "Tenant credit (a large tenant's bankruptcy hits directly); lease renewals below inflation; REIT dividends are ordinary income, not qualified dividends.",
    facts: [
      {
        label: "As of",
        value:
          "As of year-end2025, triple-net lease REIT yields sat around the4%–4.5% area, while the whole REIT spectrum ranged from ≈2%–3% (data centers) to ≈10%–14% (mortgage REITs) — the yield gap is a story about risk, not free income (ICFS sector table).",
      },
    ],
    sources: [
      {
        title: "ICFS Specialist's Desk — REIT Dividend Yields by Property Sector",
        url: "https://icfs.com/specialists-desk/reit-dividend-yields",
        note: "Sector-by-sector REIT yield table with sustainability and tax commentary.",
      },
    ],
  },
  {
    id: "data-center-infra-reit-growth",
    name: "Data-Center & Infrastructure REIT Growth",
    category: "income",
    horizon: "long",
    horizonText: "Multi-year holding; daily liquidity via the REIT",
    risk: 0.55,
    ret: { low: 2, high: 3, text: "≈2%–3% yield (data-center REITs, YE2025) — return is growth-led" },
    viability: "Viable with conditions",
    viabilityNote: "Not an income strategy: the yield is the lowest in the REIT spectrum because the money is made in rent growth and multiple expansion.",
    description:
      "Listed REITs owning data centers, towers, fiber and other digital infrastructure, leased to hyperscalers and carriers on long contracts with escalators.",
    rationale:
      "The structural demand story of cloud and AI compute, owned through a liquid REIT wrapper with contractual rent growth instead of commodity-price exposure.",
    keyRisk:
      "Tenant concentration (a few hyperscalers dominate leases); heavy capex cycles; a low starting yield means most of the return depends on the market continuing to pay up for growth.",
    facts: [
      {
        label: "As of",
        value:
          "As of year-end2025, data-center REITs yielded only ≈2%–3% — the lowest of any property sector — which tells you the return history has come from price appreciation, not income (ICFS sector table).",
      },
    ],
    sources: [
      {
        title: "ICFS Specialist's Desk — REIT Dividend Yields by Property Sector",
        url: "https://icfs.com/specialists-desk/reit-dividend-yields",
        note: "Sector yield table placing data centers at the low-yield, growth-led end of the spectrum.",
      },
    ],
  },
  {
    id: "mortgage-reit-income",
    name: "Mortgage REIT Income",
    category: "income",
    horizon: "medium",
    horizonText: "Multi-year holding with monthly distributions",
    risk: 0.8,
    ret: { low: 10, high: 14, text: "≈10%–14% (mortgage REIT sector, YE2025)" },
    viability: "Viable with conditions",
    viabilityNote: "A yield trap for anyone who reads only the headline number — these are leveraged book-value bets.",
    description:
      "Listed trusts that own mortgage debt (agency and non-agency) and earn the spread between their funding cost and the loan yield, distributing most of it.",
    rationale:
      "The highest listed income in the REIT spectrum; the spread business is a leveraged carry trade on the rate curve.",
    keyRisk:
      "Substantial balance-sheet leverage means rate moves swing book value hard; hedging quality differs wildly between managers; dividend cuts follow spread compression.",
    facts: [
      {
        label: "As of",
        value: "As of year-end2025, mortgage REIT sector yields ran ≈10%–14% — the top of the REIT range and the most leverage behind it (ICFS sector table).",
      },
    ],
    sources: [
      {
        title: "ICFS Specialist's Desk — REIT Dividend Yields by Property Sector",
        url: "https://icfs.com/specialists-desk/reit-dividend-yields",
        note: "mREIT yield range and the leverage/sustainability warnings that come with it.",
      },
    ],
  },
  {
    id: "yieldco-infrastructure-funds",
    name: "Yieldco / Infrastructure Income Funds",
    category: "income",
    horizon: "long",
    horizonText: "Multi-year holding; quarterly distributions",
    risk: 0.55,
    ret: { low: 5.5, high: 7.5, text: "≈5.5%–7.5% initial yields (yieldco listing examples)" },
    viability: "Viable with conditions",
    viabilityNote: "Only where the offtake contracts are long and the sponsor stops strip-mining the vehicle for growth projects.",
    description:
      "Listed vehicles holding operating solar, wind and grid assets under long-term power-purchase agreements, distributing most of the contracted cash flow.",
    rationale:
      "Contracted, quasi-utility cash flow with inflation linkage in the better contracts — a different return driver from REITs or corporate credit.",
    keyRisk:
      "The2015–18 yieldco bust showed distributions can be cut when growth stalls; parent-sponsor conflicts and refinancing of short-dated structures.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: studied yieldco listings launched at projected dividend yields around5.5%–7.5% (NRG Yield5.45%, Pattern Energy6.25%, TransAlta Renewables7.5% at IPO) — and yields fell as prices rose, or rose as prices fell, from there (Norton Rose Fulbright).",
      },
    ],
    sources: [
      {
        title: "Norton Rose Fulbright — Yield Cos Compared",
        url: "https://www.projectfinance.law/publications/2013/december/yield-cos-compared",
        note: "Yieldco structure, contracted-cash-flow logic and the initial yields of the2013 cohort.",
      },
    ],
  },

  /* --------------------------------------------------------- growth ----- */
  {
    id: "buy-and-hold-rental-property",
    name: "Buy-and-Hold Rental Property",
    category: "growth",
    horizon: "long",
    horizonText: "5–30+ years with monthly cash flow",
    risk: 0.5,
    viability: "Viable with conditions",
    viabilityNote: "Works where the numbers work: purchase price, rent, costs and financing have to clear a positive spread on day one.",
    description:
      "Buy a residential (or small commercial) property, rent it, and hold through cycles. Return = cash-on-cash yield + principal paydown + appreciation + tax effects, all of which must be measured separately.",
    rationale:
      "The most familiar leveraged real-asset income: leverage magnifies both the cash yield and the price moves, and time converts paper gains into rent.",
    keyRisk:
      "Vacancy, repairs, tenants and rate cycles; leverage cuts both ways; a single property is an undiversified, illiquid position.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: direct real estate has on average compounded below equities in long datasets (the NYU Stern real-estate series runs well under the ≈10%/yr equity average), but with different risk; local leverage changes individual outcomes enormously (SparkRental ROI review).",
      },
    ],
    sources: [
      {
        title: "SparkRental — ROI on Real Estate: Historical Returns & How They're Calculated",
        url: "https://sparkrental.com/roi-on-real-estate/",
        note: "The different return measures for property and how they combine.",
      },
      DAMODARAN,
    ],
  },
  {
    id: "brrrr-method",
    name: "BRRRR (Buy, Rehab, Rent, Refinance, Repeat)",
    category: "growth",
    horizon: "medium",
    horizonText: "6–24 months per full cycle",
    risk: 0.65,
    viability: "Viable with conditions",
    viabilityNote: "Depends entirely on buying below after-repair value and on the appraisal supporting the refinance.",
    description:
      "Buy a distressed property at a discount, renovate it to lift its appraised value, rent it out, then refinance most of the capital back out and redeploy it into the next deal.",
    rationale:
      "Recycling one pile of capital across many properties; the strategy's edge is the acquisition discount, not the renovation.",
    keyRisk:
      "Rehab overruns eat the margin; if the appraisal comes in low the refinance leaves capital trapped; leverage stacks across properties in one market.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: the mechanism is designed to recover most of the initial capital at refinance, which makes the return on remaining equity hard to compare with plain rental returns — the residual exposure is what has to be measured (SparkRental/BRRRR framing).",
      },
    ],
    sources: [
      {
        title: "SparkRental — ROI on Real Estate (BRRRR section)",
        url: "https://sparkrental.com/roi-on-real-estate/",
        note: "How BRRRR changes the capital-recycling and return-on-equity arithmetic.",
      },
    ],
  },
  {
    id: "real-estate-syndications",
    name: "Real Estate Syndications",
    category: "growth",
    horizon: "long",
    horizonText: "5–10 year project or fund life",
    risk: 0.7,
    ret: { low: 15, high: 30, text: "≈15%–30% sponsor targets (commonly marketed; deal-by-deal)" },
    viability: "Viable with conditions",
    viabilityNote: "Accredited-investor gates, blind-pool risk and multi-year lock-ups; the sponsor is the strategy.",
    description:
      "Pool capital with a sponsor who finds, finances and operates a single deal (or fund); you are the passive LP with defined rights, a promote structure and usually no exit until the sponsor sells.",
    rationale:
      "Institutional-grade real estate with leverage and operating upside that REITs cannot offer, in exchange for illiquidity and information asymmetry.",
    keyRisk:
      "Sponsor execution and honesty; the promote means mediocre outcomes pay you little; capital calls and exit timing are the sponsor's to decide.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: sponsor-target IRRs in the mid-teens to high-twenties are commonly marketed for value-add deals (SparkRental review); actual net results are deal-by-deal and unaudited.",
      },
    ],
    sources: [
      {
        title: "SparkRental — ROI on Real Estate",
        url: "https://sparkrental.com/roi-on-real-estate/",
        note: "Syndication return ranges as commonly presented and the measurement caveats.",
      },
    ],
  },

  /* --------------------------------------------------------- venture ---- */
  {
    id: "secondary-venture-purchases",
    name: "Secondary Venture Purchases",
    category: "venture",
    horizon: "long",
    horizonText: "3–7 years until the underlying company exits",
    risk: 0.65,
    viability: "Viable with conditions",
    viabilityNote: "Access requires fund-level or marketplace participation, and usually GP consent on transfers.",
    description:
      "Buy existing private-fund interests or direct shares from early employees, angels or funds — typically at a discount to the last reported valuation.",
    rationale:
      "Traction is already proven and the entry price often embeds a discount; the J-curve is partly skipped because the fund's early years already happened.",
    keyRisk:
      "Still private and illiquid; valuations are stale quarterly marks; information asymmetry favours the seller in a forced sale, the buyer in a patient one.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: secondary transactions commonly complete at ≈15%–20% discounts to reported NAV, with most of the value expected from post-purchase appreciation rather than from the discount itself (Hamilton Lane).",
      },
    ],
    sources: [
      {
        title: "Hamilton Lane — Secondaries: Myths vs. Opportunities",
        url: "https://www.hamiltonlane.com/en-us/insight/the-truth-about-secondaries",
        note: "How LP secondaries price, what the discount is and is not, and where returns come from.",
      },
    ],
  },
  {
    id: "spac-trust-redemption-arbitrage",
    name: "SPAC Trust / Redemption Arbitrage",
    category: "venture",
    horizon: "short",
    horizonText: "Weeks to months around a merger vote",
    risk: 0.35,
    ret: { low: 11.6, high: 11.6, text: "≈11.6% annualized (redeeming investors, studied window)" },
    viability: "Viable with conditions",
    viabilityNote: "The measured window (2019–2020) was a deal boom; today's SPAC supply, trust yields and redemption behaviour all differ.",
    description:
      "Buy SPAC shares at or below trust value before a deal vote; redeem at the vote to get your cash plus trust interest back, optionally keeping warrants/rights. The cash floor is the trade.",
    rationale:
      "A venture-adjacent payoff with collateral: you are long the option value of a deal and short nothing, because redemption returns the cash.",
    keyRisk:
      "Not redeeming means holding a dilution machine — the median SPAC held only ≈$6.67 of cash per$10 share at merger; deal supply and market windows come and go.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: across the SPACs studied (47 merging Jan2019–Jun2020), redeeming investors averaged ≈11.6% annualized with essentially no downside, while holders through mergers saw prices fall by a third or more on average (Klausner, Ohlrogge & Ruan).",
      },
    ],
    sources: [
      {
        title: "Harvard Law School Forum on Corporate Governance — A Sober Look at SPACs",
        url: "https://corpgov.law.harvard.edu/2020/11/19/a-sober-look-at-spacs/",
        note: "The dilution maths, the redemption option and the measured redeemer returns.",
      },
    ],
  },

  /* --------------------------------------------------------- rwa -------- */
  {
    id: "tokenised-tbill-carry",
    name: "Tokenised T-Bill Carry",
    category: "rwa",
    horizon: "short",
    horizonText: "Daily redemption; no maturity needed",
    risk: 0.3,
    ret: { low: 3.67, high: 3.67, text: "≈3.67% base APY (Ondo OUSG, Oct2026) + variable carry" },
    viability: "Viable with conditions",
    viabilityNote: "Qualified-purchaser gates on the main products; issuer, smart-contract and redemption risk sit on top of the T-bill risk.",
    description:
      "Hold a token whose backing is short-term US Treasuries or a treasury fund, accruing daily yield on-chain; optionally lend the token into DeFi markets when borrow rates exceed the coupon.",
    rationale:
      "Dollar cash yield that settles24/7 and can be used as DeFi collateral — the bridge between money-market yield and on-chain finance.",
    keyRisk:
      "Issuer and redemption risk (gated redemptions in stress); smart-contract risk; eligibility requirements (e.g. OUSG is a Reg D offering for accredited/QP buyers, $5k minimum).",
    facts: [
      {
        label: "As of",
        value:
          "As of Oct2026, Ondo OUSG published ≈3.67% APY on short-term Treasuries held via BlackRock's BUIDL fund, with fees capped at0.15% and24/7 mint/redeem (Ondo).",
      },
    ],
    sources: [
      {
        title: "Ondo Finance — OUSG (tokenised short-term US Treasuries)",
        url: "https://ondo.finance/ousg",
        note: "Current APY, underlying holdings, fees, eligibility and redemption mechanics.",
      },
    ],
  },
  {
    id: "on-chain-private-credit-pools",
    name: "On-Chain Private Credit Pools",
    category: "rwa",
    horizon: "medium",
    horizonText: "30–180 day loans; pool exit varies",
    risk: 0.7,
    ret: { low: 9, high: 14, text: "≈9%–14% APY (Maple institutional book,2026)" },
    viability: "Viable with conditions",
    viabilityNote: "The pool delegate is the credit officer: their underwriting, not the protocol's code, determines whether the yield is real.",
    description:
      "Supply stablecoins to pools where professional delegates underwrite loans to crypto-native institutions (trading firms, market makers); interest accrues on-chain and repays at maturity.",
    rationale:
      "Real loan interest rather than token emissions, at a spread over overcollateralised DeFi rates — the undercollateralised credit market, on-chain.",
    keyRisk:
      "Credit and delegate risk (Maple restructured after the2022 Orthogonal default); loans can be undercollateralised by design; large providers can withdraw pool liquidity quickly.",
    facts: [
      {
        label: "As of",
        value:
          "As of2026, Maple's institutional book quoted ≈9%–14% APY on30–180 day loans; most loans are now overcollateralised105%–130% in BTC/ETH/SOL after the2022 restructuring, with ≈$2.1B TVL (Eco/Maple overview).",
      },
    ],
    sources: [
      {
        title: "Eco — Maple Finance: DeFi lending for institutions",
        url: "https://eco.com/support/en/articles/15002227-maple-finance-defi-lending-for-institutions",
        note: "Pool-delegate model, current rates, collateral policy and the2022 default history.",
      },
    ],
  },

  /* --------------------------------------------------------- equities --- */
  {
    id: "sp500-index-core",
    name: "S&P 500 Index Core (Buy & Hold)",
    category: "equities",
    horizon: "long",
    horizonText: "10+ years; decades is the honest horizon",
    risk: 0.5,
    ret: { low: 10, high: 10, text: "≈10%/yr nominal,1928–2024 (≈6.5%–7% real)" },
    viability: "Viable",
    viabilityNote: "The default core against which every other row on this page must justify itself.",
    description:
      "Own the whole US large-cap market through a low-cost index fund, dividends reinvested, and do almost nothing forever.",
    rationale:
      "The most measured return stream in finance: ≈10%/yr nominal over nearly a century, which beats most active strategies over the same window precisely because it never stops compounding.",
    keyRisk:
      "Equity drawdowns are real and long (the index has lost more than half its value more than once); returns measured over short windows can be zero or negative.",
    facts: [
      {
        label: "Historical anchor",
        value: "Historical: S&P500 total return averaged ≈10%/yr nominal over1928–2024 (NYU Stern/Damodaran dataset).",
      },
    ],
    sources: [DAMODARAN],
  },
  {
    id: "small-cap-value-tilt",
    name: "Small-Cap Value Tilt",
    category: "equities",
    horizon: "long",
    horizonText: "10+ years; factor premia are slow and drought-prone",
    risk: 0.6,
    viability: "Viable with conditions",
    viabilityNote: "A tilt, not a replacement core — and only with the patience for decade-long tracking error.",
    description:
      " overweight small, cheap stocks relative to the broad index, usually through a factor fund, on the evidence of the size and value premia in the academic asset-pricing literature.",
    rationale:
      "The best-documented equity premium after the market itself; the small slice of it that survives modern screening tends to come from small value, not small growth.",
    keyRisk:
      "The premium has run in multi-decade regimes; naive size alone is not robust (AQR's work on the 'no size effect' result); concentration and liquidity in small names.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: value, momentum and quality are the most recognised equity factor premia; size is far less reliable on its own (AQR factor literature summary).",
      },
    ],
    sources: [AQR_FACTORS, DAMODARAN],
  },
  {
    id: "momentum-factor-tilt",
    name: "Momentum Factor Tilt",
    category: "equities",
    horizon: "long",
    horizonText: "Ongoing with monthly–quarterly rebalancing",
    risk: 0.6,
    viability: "Viable with conditions",
    viabilityNote: "Only systematic implementations survive the turnover; discretionary trend-chasing is a different activity.",
    description:
      "Hold stocks with strong recent relative returns, rebalanced monthly, on the evidence that winners keep winning over the short-to-medium term.",
    rationale:
      "Momentum is one of the most replicated premia in finance — and one of the few that also shows up in time-series form across assets (the trend-following family).",
    keyRisk:
      "Momentum crashes are violent and clustered; high turnover means high taxes and spread costs; crowding can amplify reversals.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: momentum premia are documented across decades and geographies but arrive with sharp reversals — the AQR factor framework positions it alongside value and quality, not instead of them.",
      },
    ],
    sources: [AQR_FACTORS],
  },
  {
    id: "quality-moat-investing",
    name: "Quality / Moat Investing",
    category: "equities",
    horizon: "long",
    horizonText: "Multi-year compounding holding",
    risk: 0.45,
    viability: "Viable",
    viabilityNote: "Works as a core or tilt; the discipline is paying a fair price for quality, not any price.",
    description:
      "Own companies with high and stable profitability, low leverage, clean balance sheets and durable competitive advantages.",
    rationale:
      "Quality stocks have historically produced steadier compounding and shallower drawdowns than the market average — the evidence-based version of the Buffett-style hold-forever core.",
    keyRisk:
      "Quality gets expensive in late cycles and can lag speculative rallies; 'quality' screens can cluster into the same few sectors.",
    facts: [
      {
        label: "Typical",
        value: "Typical: quality strategies aim at improved risk-adjusted returns and reduced drawdowns across cycles rather than maximal raw returns (AQR).",
      },
    ],
    sources: [AQR_FACTORS],
  },
  {
    id: "low-volatility-factor",
    name: "Low-Volatility Factor",
    category: "equities",
    horizon: "long",
    horizonText: "Multi-year holding; low turnover",
    risk: 0.35,
    viability: "Viable",
    viabilityNote: "A defensive equity sleeve; expect it to lag in strong bull phases by design.",
    description:
      "Hold the market's least volatile stocks — or a low-volatility index fund — accepting lower individual stock risk than the broad market.",
    rationale:
      "The low-vol anomaly (calmer stocks risk-adjusted) is one of the most persistent anomalies in the factor literature and a practical defensive equity sleeve.",
    keyRisk:
      "Sector drift toward utilities, staples and healthcare; still full equity beta in crashes, just less of it; the anomaly's edge has compressed as the products became popular.",
    facts: [
      {
        label: "Typical",
        value: "Typical: low-volatility strategies have delivered attractive risk-adjusted returns with greater risk mitigation per the factor literature (AQR).",
      },
    ],
    sources: [AQR_FACTORS],
  },
  {
    id: "managed-futures-trend-following",
    name: "Managed Futures / Trend Following",
    category: "equities",
    horizon: "medium",
    horizonText: "Evergreen; positions held weeks to months",
    risk: 0.5,
    viability: "Viable with conditions",
    viabilityNote: "Accessible today through managed-futures funds and ETFs; fees and roll costs are a first-order term.",
    description:
      "Time-series momentum across futures markets: long assets in positive trends, short (or flat) those in negative trends, with volatility targeting. The CTA/managed-futures industry runs these rules at scale.",
    rationale:
      "The one alternative risk premium with a century of measured evidence, and a genuinely different return stream from equities and bonds.",
    keyRisk:
      "Whipsaw in range-bound markets; crowded positioning; long flat stretches that test patience right before the trend years pay.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: AQR's simulated time-series momentum strategy was consistently profitable over110 years (from1880) across equity-index, bond, commodity and currency futures, with an average Sharpe of ≈0.4 per market (Hurst, Ooi & Pedersen).",
      },
    ],
    sources: [
      {
        title: "AQR — A Century of Evidence on Trend-Following Investing",
        url: "https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing",
        note: "The1880–present simulation and what it says about robustness versus statistical fluke.",
      },
    ],
  },
  {
    id: "diy-moving-average-trend-filter",
    name: "DIY Moving-Average Trend Filter",
    category: "equities",
    horizon: "medium",
    horizonText: "Weeks to months per signal",
    risk: 0.5,
    viability: "Viable with conditions",
    viabilityNote: "A simplified single-asset version of managed futures; the net-of-cost evidence on one index alone is contested.",
    description:
      "Hold an index when it is above its long moving average (e.g.200-day) and move to cash or reduce when below — a mechanical exit rule applied to your own holdings.",
    rationale:
      "The retail-sized version of time-series momentum: cut losses short, let profits run, with no discretion at the signal.",
    keyRisk:
      "Whipsaw costs in choppy years; tax events at every exit; few decades of index data make single-asset backtests easy to overfit.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: the underlying rule is time-series momentum — long markets with recent positive returns, flat or short those with negative (AQR definition) — the measured evidence spans portfolios of futures, not one index.",
      },
    ],
    sources: [
      {
        title: "AQR — A Century of Evidence on Trend-Following Investing",
        url: "https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing",
        note: "Definition of the basic trend rule and the breadth of the evidence behind it.",
      },
    ],
  },
  {
    id: "multi-factor-blend",
    name: "Multi-Factor Blend",
    category: "equities",
    horizon: "long",
    horizonText: "Multi-year with periodic rebalancing",
    risk: 0.55,
    viability: "Viable",
    viabilityNote: "The factor premia compensate for patience and tracking error, not for activity.",
    description:
      "Combine value, momentum and quality (and sometimes low-volatility) signals in one systematic portfolio so that when one factor droughts another can carry.",
    rationale:
      "Factors behave badly alone and better together: combining styles smooths the premia's long droughts while keeping the research-backed edge over a plain market weight.",
    keyRisk:
      "Smart-beta fees; signal overlap can hide concentration; premia can all struggle together in the worst regimes.",
    facts: [
      {
        label: "Typical",
        value:
          "Typical: multi-factor strategies seek robustness across cycles by combining styles rather than betting on one premium (AQR multi-factor framework).",
      },
    ],
    sources: [AQR_FACTORS],
  },

  /* --------------------------------------------------------- crypto ----- */
  {
    id: "crypto-dollar-cost-averaging",
    name: "Bitcoin / Crypto Dollar-Cost Averaging",
    category: "crypto",
    horizon: "long",
    horizonText: "Years of recurring buys",
    risk: 0.85,
    ret: {
      low: 16.3,
      high: 16.3,
      text: "≈16%/yr annualised from the +105% Jan2022–Oct2026 backtest window",
    },
    viability: "Viable with conditions",
    viabilityNote: "Only with money whose loss is survivable, and only with an exchange/custody setup you can actually secure.",
    description:
      "Buy a fixed dollar amount of BTC (or a BTC/ETH pair) on a fixed schedule regardless of price — converting volatility into an average cost instead of a timing problem.",
    rationale:
      "The measured virtue of DCA is that it beats lump-sum buying in falling windows and never requires calling a top; on an asset with70%+ drawdowns that behavioural edge is real.",
    keyRisk:
      "Drawdowns beyond-70% have happened repeatedly; the long-run return is entirely window-dependent; custody loss (hack, key loss) is permanent and uninsured.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: $100/week into BTC from Jan2022 turned$24,900 into$50,953 by Oct2026 (+104.6%), beating the same money invested up front by ≈$5,800 — in that window; changing the start date changes the winner (CryptoVantage backtest).",
      },
    ],
    sources: [
      {
        title: "CryptoVantage — Dollar-Cost Averaging Bitcoin: What $100 a Week Would Have Done",
        url: "https://www.cryptovantage.com/news/dollar-cost-averaging-bitcoin-100-a-week/",
        note: "Week-by-week DCA versus lump-sum backtest over Jan2022–Oct2026 with the window caveat spelled out.",
      },
    ],
  },
  {
    id: "restaking-and-points-farming",
    name: "Restaking & Points Farming",
    category: "crypto",
    horizon: "short",
    horizonText: "Weeks to months per campaign",
    risk: 0.9,
    viability: "Speculative",
    viabilityNote: "The 'return' is a hoped-for future token distribution whose value and timing nobody can promise.",
    description:
      "Restake liquid staking tokens into restaking markets (EigenLayer-style) and accumulate points across protocols in expectation of token distributions.",
    rationale:
      "Real yield exists (staking rewards plus fees), but the points layer is an option on an airdrop that may underwhelm — the2024 EIGEN distribution is the case study.",
    keyRisk:
      "Slashing in the restaked services; smart-contract risk stacked across layers; token unlock schedules that dump on farmers; distribution backlash risk.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: EigenLayer's points programme culminated in the May2024 EIGEN airdrop, which arrived amid significant backlash over allocation levels and expectations (The Defiant).",
      },
    ],
    sources: [
      {
        title: "The Defiant — EigenLayer Airdrop Outcry Shows Points are Raising Traders' Expectations",
        url: "https://thedefiant.io/news/research-and-opinion/eigenlayer-airdrop-outcry-shows-how-points-are-raising-trader-expectations",
        note: "The points-to-airdrop economy and what happened when expectations met the actual distribution.",
      },
    ],
  },
  {
    id: "stablecoin-depeg-recovery",
    name: "Stablecoin Depeg Recovery",
    category: "crypto",
    horizon: "short",
    horizonText: "Days to weeks when the event happens",
    risk: 0.95,
    viability: "Speculative",
    viabilityNote: "In the defining case of the genre, holders of the 'stable' asset lost nearly everything — the payoff is capped, the loss is not.",
    description:
      "Buy a fiat-referenced token that has lost its peg, betting the issuer's reserves or arbitrage mechanics restore it; sized so a total loss is survivable.",
    rationale:
      "Price dislocations on claim structures do sometimes snap back — but only where the claim is genuinely backed; this trade is a bet on reserve quality first and market mechanics second.",
    keyRisk:
      "Death-spiral designs can go to zero in days while on-chain holders race each other to the exit; sophisticated holders exit first and the rest absorb the loss.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: Terra/UST's May2022 run destroyed ≈$50B of value in three days; the run accelerated precisely because everyone could see everyone else's positions on-chain (MIT Sloan CFI, Liu/Makarov/Schoar).",
      },
    ],
    sources: [
      {
        title: "MIT Sloan CFI — Anatomy of a Run: The Terra Luna Crash",
        url: "https://mitsloan.mit.edu/cfi/anatomy-a-run-terra-luna-crash",
        note: "The mechanics and speed of the UST run and who lost what.",
      },
    ],
  },

  /* --------------------------------------------------------- quant ----- */
  {
    id: "all-weather-all-seasons-allocation",
    name: "All Weather / All Seasons Allocation",
    category: "quant",
    horizon: "long",
    horizonText: "Decades; quarterly or annual rebalance",
    risk: 0.35,
    ret: { low: 5.3, high: 5.3, text: "≈5.3% real/yr since1970 (US backtest)" },
    viability: "Viable",
    viabilityNote: "A portfolio you hold rather than a trade; the rebalancing between the slices is part of the return.",
    description:
      "Risk-balance one portfolio across growth and inflation regimes: the implementable version is ≈30% stocks,40% long Treasuries,15% intermediate Treasuries,8% gold,7% commodities (Portfolio Charts rounding).",
    rationale:
      "No single asset has to be right; each quadrant of the economy gets an asset built for it, and rebalancing forces buying whatever fell.",
    keyRisk:
      "Long bonds get crushed in inflation regimes (2022 was a live demonstration); real returns sit well below equity-only compounds; the institutional fund is not the ETF version.",
    facts: [
      {
        label: "Historical anchor",
        value: "Historical: the US All Seasons backtest shows an average ≈5.3% real return per year since1970 (Portfolio Charts).",
      },
    ],
    sources: [
      {
        title: "Portfolio Charts — All Seasons Portfolio",
        url: "https://portfoliocharts.com/portfolios/all-seasons-portfolio/",
        note: "The implementable allocation and its long-run US backtest numbers.",
      },
    ],
  },
  {
    id: "permanent-portfolio",
    name: "Permanent Portfolio",
    category: "quant",
    horizon: "long",
    horizonText: "Decades; annual rebalance",
    risk: 0.3,
    viability: "Viable",
    viabilityNote: "Designed to never need a macro view; the cost is accepting modest long-run growth.",
    description:
      "Equal quarters in stocks, long-term bonds, cash and gold — one asset for each economic state (prosperity, deflation, recession, inflation), rebalanced annually.",
    rationale:
      "Browne's claim was survivability: no plausible economic regime wipes out all four sleeves at once, and rebalancing buys whichever one is cheap.",
    keyRisk:
      "Cash and gold drag during long equity bull markets; the portfolio can go years without beating inflation by much.",
    facts: [
      {
        label: "Historical anchor",
        value: "Historical: the four-slice mix has avoided catastrophic drawdowns across ≈50 years of history, at the price of modest long-run returns (Optimized Portfolio review).",
      },
    ],
    sources: [
      {
        title: "Optimized Portfolio — Harry Browne Permanent Portfolio Review",
        url: "https://www.optimizedportfolio.com/permanent-portfolio/",
        note: "Allocation, drawdown history and the ETF implementation details.",
      },
    ],
  },
  {
    id: "risk-parity-allocation",
    name: "Risk Parity Allocation",
    category: "quant",
    horizon: "long",
    horizonText: "Decades; ongoing risk rebalancing",
    risk: 0.45,
    viability: "Viable with conditions",
    viabilityNote: "Honest implementations use leverage on the bond sleeve; without leverage it is really a bond-heavy portfolio.",
    description:
      "Weight assets by their contribution to portfolio risk rather than by dollars — equities, bonds and diversifiers each carrying equal risk — so no single asset dominates the outcome.",
    rationale:
      "A60/40 portfolio carries roughly90% of its risk in equities; risk parity removes that concentration and, per AQR's long backtest, has historically outperformed60/40 at comparable volatility.",
    keyRisk:
      "Leverage risk when rates rise sharply; correlation spikes in crises turn diversification off exactly when it is needed; borrowing costs eat the carry.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: AQR's simple risk parity strategy outperformed a60/40 portfolio over ≈40 years at similar annualized volatility; traditional60/40 devotes ≈90% of its risk budget to equities (AQR white paper).",
      },
    ],
    sources: [
      {
        title: "AQR — Understanding Risk Parity",
        url: "https://www.aqr.com/-/media/AQR/Documents/Insights/White-Papers/Understanding-Risk-Parity.pdf",
        note: "The risk-concentration argument and the simple strategy's long backtest.",
      },
    ],
  },
  {
    id: "balanced-60-40-portfolio",
    name: "60/40 Balanced Portfolio",
    category: "quant",
    horizon: "long",
    horizonText: "Decades; rebalance quarterly to annually",
    risk: 0.4,
    ret: { low: 6, high: 8, text: "≈6%–8%/yr long-run blended (historical)" },
    viability: "Viable",
    viabilityNote: "The benchmark allocation of the industry — cheap, liquid and fully explained by the asset-class averages.",
    description:
      "Sixty percent global equities, forty percent bonds, rebalanced on a schedule. The simplest portfolio that mixes the two return engines in documented proportion.",
    rationale:
      "Equities have averaged ≈10%/yr and bonds roughly5%/yr over nearly a century, so a blend has historically landed between them with a shallower ride than pure equity.",
    keyRisk:
      "Stocks and bonds can fall together (2022 proved it); the equity share still dominates the risk, and long-run real returns are only moderate.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: US T-bills averaged ≈3.3%/yr, ≈10-year Treasuries ≈5%/yr and the S&P500 ≈10%/yr over1928–2024 (NYU Stern dataset) — the60/40 blend's history is built from those three lines.",
      },
    ],
    sources: [DAMODARAN],
  },

  /* --------------------------------------------------------- events ---- */
  {
    id: "election-model-vs-market-trading",
    name: "Election Model-vs-Market Trading",
    category: "events",
    horizon: "short",
    horizonText: "Weeks to months around an election",
    risk: 0.6,
    viability: "Speculative",
    viabilityNote: "Forecast accuracy is not a return: the trade only pays when your model beats the market price, after fees and spread.",
    description:
      "Build or follow a polling/fundamentals model of an election, compare its probabilities to prediction-market prices, and trade the difference on the venue where the mispricing is largest.",
    rationale:
      "The academic record says markets aggregate information at least as well as polls — which cuts both ways: the price you are trading against is usually pretty good.",
    keyRisk:
      "Model error; thin event-market liquidity and wide spreads; resolution-rule surprises that make a correct directional call lose money anyway.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: across345 elections analysed, an expectations-based model called the winner ≈81% of the time versus ≈69% for the standard polling question (Wolfers & Rothschild, Brookings).",
      },
    ],
    sources: [
      {
        title: "Brookings — Forecasting Elections: Voter Intentions versus Expectations",
        url: "https://www.brookings.edu/articles/forecasting-elections-voter-intentions-versus-expectations/",
        note: "Model-versus-poll hit rates across345 elections and what expectations capture.",
      },
    ],
  },

  /* --------------------------------------------------------- commodities  */
  {
    id: "gold-and-silver-allocation",
    name: "Gold & Silver Strategic Allocation",
    category: "commodities",
    horizon: "long",
    horizonText: "Decades; typically a small strategic sleeve of the portfolio",
    risk: 0.5,
    viability: "Viable",
    viabilityNote: "A hedge sleeve with no yield: its job is to be there in monetary stress, not to outperform equities.",
    description:
      "Hold physical metal or a low-cost trust/ETF allocation as an inflation, currency and crisis hedge, rebalanced against the rest of the portfolio — a5%–10% sleeve is the common sizing.",
    rationale:
      "Over50 years gold's return has run above inflation and broadly alongside global nominal GDP — a real-asset store of value whose crises behaviour is unlike any financial asset.",
    keyRisk:
      "Long flat decades with no income; storage, premium and tracker costs; silver adds industrial demand volatility on top.",
    facts: [
      {
        label: "Historical anchor",
        value:
          "Historical: gold's50-year annual return has run well above US CPI and in line with global nominal GDP growth (World Gold Council GLTER,1971–2023) — the WGC framework argues long-run returns materially exceed the0%–1% real that older theories assume.",
      },
    ],
    sources: [
      {
        title: "World Gold Council — Gold's long-term expected return (GLTER)",
        url: "https://www.gold.org/goldhub/research/golds-long-term-expected-return-glter",
        note: "The WGC's long-run return framework and its50-year evidence.",
      },
      DAMODARAN,
    ],
  },
];

export const RESEARCHED_STRATEGIES: ResearchedStrategy[] = DEFS.map(build);

/** True for rows added by this module (the drawer renders them differently). */
export function isResearched(s: Strategy): s is ResearchedStrategy {
  return (s as Partial<ResearchedStrategy>).researched === true;
}

export function researchedCount(): number {
  return RESEARCHED_STRATEGIES.length;
}

/** The horizon of a researched row; workbook rows go through the catalog's parser. */
export function horizonOfResearched(s: Strategy): Horizon | null {
  return isResearched(s) ? s.horizon : null;
}
