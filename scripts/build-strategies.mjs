#!/usr/bin/env node
/*
 * Build the strategy catalogue from the research workbook.
 *
 *   node scripts/build-strategies.mjs [path/to/workbook.xlsx] [--check]
 *
 * Reads `Master_Investment_Strategies.xlsx` (236 rows × 57 columns), repairs the
 * double-encoded text, drops the workbook's six emoji section headings and the
 * row it flags as a duplicate, merges near-identical names, and re-files the
 * 156-row "General Arbitrage" catch-all into the category each row belongs to.
 * Writes `src/lib/strategies-db.ts`.
 *
 * Every figure that survives comes from the sheet. Where a figure is absent the
 * field stays null and the UI prints "—" — nothing is estimated. `--check`
 * exits non-zero when the checked-in file no longer matches the workbook.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src", "lib", "strategies-db.ts");

const args = process.argv.slice(2);
const check = args.includes("--check");
const explicit = args.find((a) => !a.startsWith("--"));

const CANDIDATES = [
  explicit,
  path.join(ROOT, "Master_Investment_Strategies.xlsx"),
  path.join(ROOT, "..", "Master_Investment_Strategies.xlsx"),
].filter(Boolean);
const source = CANDIDATES.find((p) => fs.existsSync(p));
if (!source) {
  console.error("Workbook not found. Pass the path: node scripts/build-strategies.mjs <file.xlsx>");
  process.exit(1);
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * The workbook was written by reading UTF-8 bytes as cp1252, so "↔" arrives as
 * "â†”" and the emoji headings as "ðŸŸ…". Re-encode only when that round-trip is
 * clean; text that is already correct is left alone.
 */
const CP1252_HIGH = {
  "\u20ac": 0x80, "\u201a": 0x82, "\u0192": 0x83, "\u201e": 0x84, "\u2026": 0x85, "\u2020": 0x86,
  "\u2021": 0x87, "\u02c6": 0x88, "\u2030": 0x89, "\u0160": 0x8a, "\u2039": 0x8b, "\u0152": 0x8c,
  "\u017d": 0x8e, "\u2018": 0x91, "\u2019": 0x92, "\u201c": 0x93, "\u201d": 0x94, "\u2022": 0x95,
  "\u2013": 0x96, "\u2014": 0x97, "\u02dc": 0x98, "\u2122": 0x99, "\u0161": 0x9a, "\u203a": 0x9b,
  "\u0153": 0x9c, "\u017e": 0x9e, "\u0178": 0x9f,
};

function repair(value) {
  const s = String(value ?? "");
  // Fast path: pure ASCII never needs repairing.
  if (!/[^\u0000-\u007f]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x100) bytes.push(code);
    else if (CP1252_HIGH[ch] != null) bytes.push(CP1252_HIGH[ch]);
    else return s; // a real glyph (—, ↔, ’, emoji): the string was never mangled
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  return decoded.includes("\ufffd") ? s : decoded;
}

const clean = (v) => repair(v).replace(/\s+/g, " ").trim();
const isBlank = (v) => !clean(v) || /^N\/A \(strategy not found in research data\)$/i.test(clean(v));

/* ------------------------------------------------------------------ sheet -- */

const wb = XLSX.readFile(source);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
const header = rows[0].map(clean);
const records = rows.slice(1).map((r) => {
  const o = {};
  header.forEach((key, i) => { o[key] = clean(r[i] ?? ""); });
  return o;
});

/* ------------------------------------------------------------- categories -- */

/*
 * The workbook's own category column, plus the split of "General Arbitrage".
 * That one bucket holds 156 of 236 rows and covers on-chain, betting, equities,
 * retail and quant strategies, so a "top 5 per category" board on it would only
 * ever show arbitrage. The workbook tries to sub-divide it with five emoji
 * section headings, but they sit after the rows they are meant to introduce
 * (rows 140/146/167/176/186), so the split is done by name instead.
 */
const CATEGORIES = {
  income: { label: "High-Yield Income & Real Estate Debt", blurb: "Cash-flow first: private credit, REITs, mezzanine and preferred equity." },
  cash: { label: "Fixed Income & Capital Preservation", blurb: "Capital-preservation anchors: sukuk, corporates, structured notes." },
  growth: { label: "Growth Equity & Property Development", blurb: "Development, buyouts and concentrated equity risk." },
  venture: { label: "Venture & Early-Stage Equity", blurb: "Seed and venture bets with power-law outcomes." },
  rwa: { label: "RWA (Real World Assets)", blurb: "Tokenised treasuries, credit and property, and the basis against TradFi." },
  equities: { label: "TradFi / Equities", blurb: "Listed-market arbitrage: mergers, ETFs, convertibles, index events." },
  crypto: { label: "DeFi / Web3", blurb: "On-chain basis, staking, MEV and cross-venue arbitrage." },
  sports: { label: "Sports Betting", blurb: "Book-to-book surebets, promotions and exchange arbitrage." },
  retail: { label: "Retail / Logistics", blurb: "Physical and digital goods, tickets, travel and marketplace gaps." },
  events: { label: "Prediction Markets", blurb: "Event, political and awards markets against their fair odds." },
  commodities: { label: "Commodities & Energy", blurb: "Spreads along a production, storage or power curve." },
  quant: { label: "Quant & Model-Driven", blurb: "Latency, sentiment, statistical and structural rule-based edges." },
};

const SHEET_TO_CATEGORY = {
  "High-Yield Income & Real Estate Debt": "income",
  "Fixed Income & Capital Preservation": "cash",
  "Growth Equity & Property Development": "growth",
  "Venture & Early-Stage Equity": "venture",
  "RWA (Real World Assets)": "rwa",
  "TradFi / Equities": "equities",
  "DeFi / Web3": "crypto",
  "Sports Betting": "sports",
  "Retail / Logistics": "retail",
  "Prediction Markets": "events",
  "Ultra-Speculative / Quantitative Trading": "quant",
};

// Keyword families for the "General Arbitrage" rows. First match wins, so the
// concrete markets are tested before the generic quant words.
const FAMILIES = [
  ["events", /\b(elections?|political|predictions?|awards?|oscars?|grammys?|reality tv|entertainment|weather|seasons?|market suspension|financial event|macro event)\b/i],
  ["sports", /\b(bets?|betting|bookies?|bookmakers?|back[\s-]?lay|lay|odds|surebets?|bonus(es)?|free bet|parlay|handicaps?|props?|outrights?|totals|clv|steam|closing line|cashout|sportsbooks?|voiding|settlement|deposit match|early payout|half[\s-]time|in-play|lines?|opening line|player prop|stakeback|reload|white-label|spread betting|promos?|leagues?|push rule)\b/i],
  ["crypto", /\b(crypto|de-?pegs?|dex|cex|mev|flash ?loans?|oracles?|cross-chain|on-chain|btc|bitcoin|eth|ethereum|stablecoins?|staking|lst|lrt|rebase|defi|nfts?|tokens?|chain|babylon|governance|intent|jit|sandwich|aggregators?|funding rates?|web3|validators?|sequencers?|liquidations?)\b/i],
  ["retail", /\b(retail|inventory|clearance|tickets?|resale|coupons?|gift cards?|flights?|hotels?|travel|domains?|marketplaces?|app store|fiverr|upwork|social media|cpc|outsourcing|licens(e|ing)|ip|vip|loyalty|miles|bundl(e|ing)|e-?commerce|dropship|amazon|ebay|sneakers?)\b/i],
  ["commodities", /\b(commodity|commodities|crack spread|crush spread|spark spread|electricity|energy|renewable|gold|oil|gas|metals?)\b/i],
  ["equities", /\b(equity|equities|stocks?|options?|futures?|etfs?|bonds?|dividends?|mergers?|m&a|adrs?|box|conversions?|reversals?|gamma|stat|pairs?|volatility|yield curve|treasur(y|ies)|repo|credit|capital structure|closed-end|dual listing|spin-?offs?|tender|rights offering|buybacks?|stub|sector|earnings|index|nav|leveraged|convertibles?|preferred|swaps?|basis|carry|reconstitution|calendar spread|roll yield|term structure|creation|redemption|distressed|bankruptcy|delta-neutral)\b/i],
  ["quant", /\b(ai|ais|algorithmic|algorithms?|latency|sentiment|patterns?|bias|behaviou?r|multi-hop|models?|predictive|flow|micro-?structure|structural|rules-based|masking|quant|reprice|skew|delay|lag|overreaction|inefficien\w*|anomal(?:y|ies)|seasonal|time-?zone|narrative|account farming|jurisdiction\w*|tax|incentive|pooling|correlation|geographic)\b/i],
];

function categoryFor(record) {
  const sheetCategory = record["Category"];
  const direct = SHEET_TO_CATEGORY[sheetCategory];
  if (direct) return { id: direct, via: "sheet" };
  if (sheetCategory !== "General Arbitrage") return { id: "quant", via: "fallback" };
  const haystack = `${record["Investment Option / Instrument Name"]} ${record["Status / Viability Tier"]}`;
  for (const [id, re] of FAMILIES) if (re.test(haystack)) return { id, via: "split" };
  return { id: "quant", via: "fallback" };
}

/* -------------------------------------------------------------- risk/ret -- */

function riskNumber(text) {
  const t = clean(text).toLowerCase();
  if (t === "") return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n > 1 ? n / 100 : n;
  const bands = {
    "very low": 0.2,
    low: 0.3,
    "low to moderate": 0.45,
    moderate: 0.55,
    "moderate to high": 0.7,
    elevated: 0.75,
    high: 0.85,
    "high to extreme": 0.95,
    "extreme (total loss risk)": 1,
    extreme: 1,
  };
  return bands[t] ?? null;
}

function riskBand(risk) {
  if (risk == null) return "Unknown";
  if (risk < 0.35) return "Very low";
  if (risk < 0.5) return "Low";
  if (risk < 0.65) return "Moderate";
  if (risk < 0.8) return "Elevated";
  if (risk < 0.95) return "High";
  return "Extreme";
}

/**
 * Parse "5% - 12% APY", "10% - 30% Monthly", "15.0% - 25.0%+", "Asymmetric …".
 * `mid` is the midpoint of the stated range and `annual` is the figure used for
 * comparison — null when the sheet gives no annualisable yield.
 */
function parseReturn(text) {
  const t = clean(text);
  if (/asymmetric/i.test(t)) return { mid: null, annual: null, basis: "asymmetric" };
  const values = [...t.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1])).filter((n) => n > 0);
  if (!values.length) return { mid: null, annual: null, basis: "not stated" };
  const mid = (Math.min(...values) + Math.max(...values)) / 2;
  if (/per month|monthly|\/mo\b/i.test(t)) return { mid, annual: mid * 12, basis: "monthly" };
  if (/per (flip|deal|project|trade)/i.test(t)) return { mid, annual: null, basis: "per deal" };
  return { mid, annual: mid, basis: "annual" };
}

function outlookWeight(outlook) {
  const t = outlook.toLowerCase();
  if (t.includes("very bullish")) return 4;
  if (t.includes("strong")) return 3;
  if (t.includes("bullish")) return 3;
  if (t.includes("steady")) return 2;
  if (t.includes("bearish")) return 0;
  return 1;
}

/* ------------------------------------------------------------ dedupe keys -- */

/*
 * The long tail lists the same strategy under several spellings — "Sentiment
 * Arb" / "Sentiment Arbitrage" / "Sentiment-Arb" — and more differ only by
 * punctuation ("CEX-DEX Basis" vs "CEX–DEX Basis"). Parentheticals are kept
 * because they distinguish real pairs: "Stat Arb (Pairs)" ≠ "(Equities)".
 */
function nameKey(name) {
  return clean(name)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9()]+/g, "")
    .replace(/(arbitrage|arb)$/, "");
}

// Pairs the normaliser cannot see: same strategy, different wording.
const ALIAS_GROUPS = [
  ["Intent Solving", "Intent-Based Solving"],
  ["MEV / JIT Liquidity", "JIT Liquidity", "JIT Liquidity Arb"],
  ["BTC-Fi (Babylon)", "Babylon BTC Arb", "BTC-Fi Yield Arb"],
  ["Closing Line Value (CLV) Arb", "Closing Line Value (CLV) Arbitrage"],
  ["Spot ↔ Futures Basis", "Cash & Carry"],
  ["Cross-Exchange Arb", "Cross-Exchange Arbitrage"],
  ["Synthetic Market Arbitrage", "Synthetic Replication Arb"],
  ["Bias Detection Arbitrage", "Behavioral Masking"],
  ["Capital Pooling", "Capital Pooling Arbitrage"],
  ["Flash Loan Arb", "Flash Loan Arbitrage"],
  ["Cross-Exchange Futures Arb", "Futures Arbitrage"],
  ["Volatility Arb", "Volatility Arbitrage"],
  ["Sentiment Arb", "Sentiment Arbitrage", "Sentiment-Arb"],
  ["AI Masked Arb", "AI-Masked Arb"],
  ["Stat Arb", "Stat-Arb"],
  ["Stat Arb (Pairs)", "Stat-Arb (Pairs)"],
  ["Merger Arbitrage", "M&A (Merger) Arb"],
  ["Reality TV Show Arbitrage", "Reality TV / Awards Market Arb"],
  ["Political Market Arbitrage", "Political / Election Arb"],
  ["Inventory Arbitrage", "Inventory Arb"],
  ["Retail Arbitrage", "Retail / Event Bundling"],
  ["Player Props Arbitrage", "Player Prop Arb"],
  ["Financial Event Arbitrage", "Financial / Macro Event Arb"],
  ["Time-Zone Market Arbitrage", "Time-Zone / Seasonal Arb"],
  ["Lower-League Arbitrage", "Regional League Arbitrage"],
  ["Cross-Exchange Arb", "Cross-Exchange Arbitrage", "Cross-Exchange Futures Arb"],
];

const aliasByKey = new Map();
for (const group of ALIAS_GROUPS) {
  const canonical = nameKey(group[0]);
  for (const name of group) aliasByKey.set(nameKey(name), canonical);
}
const canonicalKey = (name) => aliasByKey.get(nameKey(name)) ?? nameKey(name);

/* --------------------------------------------------------------- assemble -- */

const REPORT = { raw: records.length, headings: 0, duplicates: [], merged: [], families: {}, templatePairs: 0 };
const groups = new Map();

for (const record of records) {
  const rawName = record["Investment Option / Instrument Name"];
  if (!rawName) continue;
  const name = clean(rawName);

  // Section headings the workbook embeds as if they were strategies.
  if (/^\p{Extended_Pictographic}/u.test(name)) {
    REPORT.headings += 1;
    continue;
  }

  const tier = record["Status / Viability Tier"];
  const rationale = record["Strategic Rationale & Detailed Evaluation"];
  if (/duplicate entry/i.test(tier) || /exact duplicate/i.test(rationale)) {
    REPORT.duplicates.push(name);
    continue;
  }

  const { id: category, via } = categoryFor(record);
  REPORT.families[via] = (REPORT.families[via] || 0) + 1;

  const risk = riskNumber(record["Risk Level"]);
  const ret = parseReturn(record["Expected Return / Yield"]);
  const tierIsLabel = /^(core rank|duplicate|category overlap|platform link|unviable)/i.test(tier);

  // Prose fields (description/rationale/keyRisk) are rendered on their own, so
  // they are not repeated in the fact list.
  const facts = [
    ["Liquidity", record["Liquidity Profile"]],
    ["Capital requirements", record["Capital Requirements"]],
    ["Lock-up", record["Lock-up Period"]],
    ["Fees", record["Management Fee Structure"]],
    ["Benchmark", record["Performance Benchmark"]],
    ["Tax efficiency", record["Tax Efficiency Rating"]],
    ["Minimum horizon", record["Minimum Investment Horizon"]],
    ["Geography", record["Geographic Exposure"]],
    ["Jurisdiction", record["Regulatory Jurisdiction"]],
    ["Volatility", record["Volatility Range"]],
    ["S&P 500 correlation", record["Correlation to S&P 500"]],
    ["Due diligence", record["Due Diligence Intensity"]],
    ["Smart-money flows", record["Smart Money Flows"]],
    ["Concentration risk", record["Concentration Risk"]],
    ["Counterparty risk", record["Counterparty Risk"]],
    ["Transparency", record["Transparency Level"]],
    ["Exit flexibility", record["Exit Flexibility"]],
    ["Favourable conditions", record["Market Conditions Favorable"]],
    ["Adverse conditions", record["Market Conditions Adverse"]],
    ["AAOIFI Standard 62", record["AAOIFI Standard 62 Compliance"]],
    ["Shariah screening", record["Shariah Screening Criteria"]],
    ["MEV exposure", record["MEV Exposure"]],
    ["Smart-contract risk", record["Smart Contract Risk"]],
    ["Regulatory compliance", record["Regulatory Compliance"]],
    ["Environmental impact", record["Environmental Impact Rating"]],
    ["Social impact", record["Social Impact Rating"]],
    ["Governance", record["Governance Rating"]],
    ["Sample size", record["Sample Size"]],
    ["Stress test", record["Stress Test Results"]],
    ["Peer benchmarking", record["Peer Benchmarking"]],
    ["Historical performance", record["Historical Performance"]],
    ["Analysis period", record["Analysis Period"]],
    ["Backtesting", record["Backtesting Method"]],
    ["Risk model", record["Risk Model"]],
    ["Validation", record["Validation Method"]],
    ["Assumptions", record["Assumptions Made"]],
    ["Limitations", record["Limitations"]],
    ["Exit strategy", record["Exit Strategy"]],
    ["Rebalancing", record["Rebalancing Frequency"]],
  ]
    .filter(([, value]) => !isBlank(value))
    .map(([label, value]) => ({ label, value: clean(value) }));

  const coreRank = Number(record["Overall Rank"]);

  const entry = {
    name,
    category,
    sheetCategory: record["Category"],
    outlook: record["Unnamed: 10"],
    risk,
    riskText: record["Risk Level"],
    band: riskBand(risk),
    retText: record["Expected Return / Yield"],
    retMid: ret.mid,
    retAnnual: ret.annual,
    retBasis: ret.basis,
    coreRank: Number.isFinite(coreRank) && coreRank > 0 ? coreRank : null,
    tier: tierIsLabel ? tier : "",
    description: tierIsLabel ? "" : tier,
    rationale,
    keyRisk: record["Unnamed: 9"],
    source: record["Research Source"],
    freshness: record["Data Freshness"],
    confidence: record["Confidence Level"],
    limitations: record["Limitations"],
    facts,
    aliases: [],
  };

  const key = `${category}:${canonicalKey(name)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(entry);
}

/* ---------------------------------------------------------------- scoring -- */

const evidence = (s) =>
  s.facts.length +
  (s.coreRank != null ? 50 : 0) +
  (/^flexible\.?$|^high safety\.?$/i.test(s.rationale) ? 0 : 3) +
  (outlookWeight(s.outlook) !== 1 ? 1 : 0);

const strategies = [];

for (const rowsInGroup of groups.values()) {
  // Keep the best-evidenced spelling; fold the rest in as aliases.
  rowsInGroup.sort((a, b) => evidence(b) - evidence(a) || b.facts.length - a.facts.length);
  const winner = { ...rowsInGroup[0] };
  winner.aliases = rowsInGroup.slice(1).map((r) => r.name);
  if (winner.aliases.length) {
    REPORT.merged.push(...winner.aliases.map((a) => `${a} → ${winner.name}`));
  }
  if (winner.coreRank == null) winner.coreRank = rowsInGroup.find((r) => r.coreRank != null)?.coreRank ?? null;
  if (!winner.outlook) winner.outlook = rowsInGroup.find((r) => r.outlook)?.outlook ?? "";
  if (!winner.description) winner.description = rowsInGroup.find((r) => r.description)?.description ?? "";
  if (!winner.tier) winner.tier = rowsInGroup.find((r) => r.tier)?.tier ?? "";

  winner.score = winner.risk && winner.retAnnual != null
    ? Math.round((winner.retAnnual / winner.risk) * 10) / 10
    : null;
  winner.evidence = evidence(winner);
  winner.id = slug(winner.name);
  strategies.push(winner);
}

function slug(name) {
  return clean(name)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2194\u2192]/g, "-to-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Stable, meaningful order: by category, then the sheet's own rank, then score.
const CATEGORY_ORDER = ["income", "cash", "growth", "venture", "rwa", "equities", "crypto", "sports", "retail", "events", "commodities", "quant"];
strategies.sort((a, b) =>
  CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
  (a.coreRank ?? 1e9) - (b.coreRank ?? 1e9) ||
  (b.score ?? -1) - (a.score ?? -1) ||
  (b.evidence ?? 0) - (a.evidence ?? 0) ||
  a.name.localeCompare(b.name),
);

// Ids must be unique across the file; suffix repeats.
const idCount = new Map();
for (const s of strategies) {
  const n = (idCount.get(s.id) || 0) + 1;
  idCount.set(s.id, n);
  if (n > 1) s.id = `${s.id}-${n}`;
}

/* ------------------------------------------------------ template detection -- */

/*
 * The workbook's long tail reuses one research template, which is worse than a
 * blank cell: "Sample size: 1000+ protocols" ends up on an Asian handicap
 * betting strategy. A label/value pair repeated on 15 or more rows is template
 * text; it is still shipped so nothing is lost, but flagged so the UI can keep
 * it apart from research that is actually about this strategy.
 */
const pairCount = new Map();
for (const s of strategies) {
  for (const f of s.facts) {
    const key = `${f.label}\u0000${f.value}`;
    pairCount.set(key, (pairCount.get(key) || 0) + 1);
  }
}
const TEMPLATE_MIN = 15;
let totalFacts = 0;
for (const s of strategies) {
  for (const f of s.facts) {
    totalFacts += 1;
    if ((pairCount.get(`${f.label}\u0000${f.value}`) || 0) >= TEMPLATE_MIN) {
      f.template = true;
      REPORT.templatePairs += 1;
    }
  }
}

/* ------------------------------------------------------------------ write -- */

const countByCategory = Object.fromEntries(
  CATEGORY_ORDER.map((id) => [id, strategies.filter((s) => s.category === id).length]),
);
const unknown = strategies.filter((s) => !CATEGORY_ORDER.includes(s.category));
if (unknown.length) {
  console.error(`Unmapped categories: ${[...new Set(unknown.map((s) => s.category))].join(", ")}`);
  process.exit(1);
}

const q = (v) => JSON.stringify(v);
const num = (v) => (v == null ? "null" : String(v));
const emitStrategy = (s) => `  {
    id: ${q(s.id)},
    name: ${q(s.name)},
    category: ${q(s.category)},
    sheetCategory: ${q(s.sheetCategory)},
    outlook: ${q(s.outlook)},
    risk: ${num(s.risk)},
    riskText: ${q(s.riskText)},
    band: ${q(s.band)},
    retText: ${q(s.retText)},
    retMid: ${num(s.retMid)},
    retAnnual: ${num(s.retAnnual)},
    retBasis: ${q(s.retBasis)},
    coreRank: ${num(s.coreRank)},
    score: ${num(s.score)},
    tier: ${q(s.tier)},
    description: ${q(s.description)},
    rationale: ${q(s.rationale)},
    keyRisk: ${q(s.keyRisk)},
    source: ${q(s.source)},
    freshness: ${q(s.freshness)},
    confidence: ${q(s.confidence)},
    limitations: ${q(s.limitations)},
    aliases: ${q(s.aliases)},
    facts: [${s.facts.map((f) => `{ label: ${q(f.label)}, value: ${q(f.value)}${f.template ? ", template: true" : ""} }`).join(", ")}],
  }`;

const body = `/**
 * Strategy catalogue — GENERATED, do not edit by hand.
 *
 *   node scripts/build-strategies.mjs            # rebuild from the workbook
 *   node scripts/build-strategies.mjs --check    # fail if this file is stale
 *
 * Source: \`Master_Investment_Strategies.xlsx\` (${REPORT.raw} rows). The build drops
 * ${REPORT.headings} emoji section headings and ${REPORT.duplicates.length} row the workbook itself flags as a duplicate,
 * merges ${REPORT.merged.length} spelling variants, and re-files the ${strategies.filter((s) => s.sheetCategory === "General Arbitrage").length} surviving rows of the
 * workbook's "General Arbitrage" catch-all, leaving ${strategies.length} strategies.
 *
 * Every figure is copied from the sheet. A field the sheet leaves blank stays
 * null and the UI prints "—" rather than guessing. \`sheetCategory\` is the
 * workbook's own grouping; \`category\` is the one used on screen.
 */

export type CategoryId = ${CATEGORY_ORDER.map((c) => q(c)).join(" | ")};

export type RiskBand = "Very low" | "Low" | "Moderate" | "Elevated" | "High" | "Extreme" | "Unknown";

export interface StrategyFact {
  label: string;
  value: string;
  /**
   * True when the workbook repeated this exact label/value pair across many
   * rows — the research columns of the long tail are one template copied
   * wholesale, so "Sample size: 1000+ protocols" appears on a betting
   * strategy. Template facts are kept but shown apart from real research.
   */
  template?: boolean;
}

export interface Strategy {
  id: string;
  name: string;
  category: CategoryId;
  /** The workbook's own category column (differs where the build re-files a row). */
  sheetCategory: string;
  /** The sheet's outlook column ("Neutral", "Very Bullish for $100k", …), verbatim. */
  outlook: string;
  /** 0–1 from the sheet's Risk Level column; word bands are mapped to numbers. */
  risk: number | null;
  /** The sheet's Risk Level cell, verbatim. */
  riskText: string;
  band: RiskBand;
  /** The sheet's Expected Return cell, verbatim. */
  retText: string;
  /** Midpoint of the stated range, on the stated basis. */
  retMid: number | null;
  /** \`retMid\` normalised to a year where the basis allows it, else null. */
  retAnnual: number | null;
  retBasis: "annual" | "monthly" | "per deal" | "asymmetric" | "not stated";
  /** The sheet's Overall Rank — only ${strategies.filter((s) => s.coreRank != null).length} of ${strategies.length} rows carry one. */
  coreRank: number | null;
  /** RAR: \`retAnnual\` ÷ \`risk\`, rounded to 1dp — null when either figure is missing. */
  score: number | null;
  tier: string;
  description: string;
  rationale: string;
  keyRisk: string;
  source: string;
  freshness: string;
  confidence: string;
  limitations: string;
  /** Other spellings the sheet listed for this same strategy. */
  aliases: string[];
  /** Research fields the sheet actually filled, in reading order. */
  facts: StrategyFact[];
}

export interface StrategyCategory {
  id: CategoryId;
  label: string;
  blurb: string;
}

export const STRATEGY_CATEGORIES: StrategyCategory[] = [
${CATEGORY_ORDER.map((id) => `  { id: ${q(id)}, label: ${q(CATEGORIES[id].label)}, blurb: ${q(CATEGORIES[id].blurb)} },`).join("\n")}
];

/** What the build read and what it did with it. */
export const STRATEGY_BUILD = {
  workbook: "Master_Investment_Strategies.xlsx",
  sheetRows: ${REPORT.raw},
  sectionHeadingsDropped: ${REPORT.headings},
  duplicatesDropped: ${q(REPORT.duplicates)},
  mergedSpellings: ${q(REPORT.merged)},
  generalArbitrageSplit: ${JSON.stringify(REPORT.families)},
  byCategory: ${JSON.stringify(countByCategory)},
} as const;

export const STRATEGIES: Strategy[] = [
${strategies.map(emitStrategy).join(",\n")}
];
`;

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== body) {
    console.error("src/lib/strategies-db.ts is stale — run: node scripts/build-strategies.mjs");
    process.exit(1);
  }
  console.log("strategies-db.ts is up to date.");
  process.exit(0);
}

fs.writeFileSync(OUT, body);

console.log(`source           : ${path.relative(ROOT, source)}`);
console.log(`rows read        : ${REPORT.raw}`);
console.log(`headings dropped : ${REPORT.headings}`);
console.log(`duplicate dropped: ${REPORT.duplicates.join(", ") || "—"}`);
console.log(`merged spellings : ${REPORT.merged.length}`);
for (const line of REPORT.merged) console.log(`                   ${line}`);
console.log(`strategies       : ${strategies.length}`);
console.log("by category      :", countByCategory);
console.log("general arb split:", REPORT.families);
console.log("with core rank   :", strategies.filter((s) => s.coreRank != null).length);
console.log(`wrote            : ${path.relative(ROOT, OUT)}`);
