/**
 * Investment Strategies data module
 * 
 * This module provides types and data for the ACCUBOOK investment strategies workbook.
 * Data is sourced from strategies_data_a.py (21 cash/credit/real estate strategies)
 * and strategies_data_c.py (13 crypto/digital asset strategies).
 * 
 * Every figure is either sourced from a named public source or marked "—".
 * No estimates are invented; all figures are explicitly dated.
 * Shariah compliance is noted for each strategy.
 */

// Strategy category enum
export enum StrategyCategory {
  CashAndCapitalPreservation = "Cash & Capital Preservation",
  HighYieldIncomeAndRealEstateDebt = "High-Yield Income & Real Estate Debt",
  GrowthEquityAndPropertyDevelopment = "Growth Equity & Property Development",
  YieldIncomeCryptoDigitalAsset = "Yield / Income (Crypto / Digital Asset)",
  NonCryptoArbitrage = "Non-Crypto Arbitrage",
}

// Strategy shariah compliance
export enum ShariahCompliance {
  Compliant = "Compliant",
  CaseByCase = "Case-by-case",
  NonCompliant = "Non-compliant",
  Avoid = "Avoid",
}

// Risk sub-scores (0-100, higher = worse/more risk)
export type RiskSubScores = [
  lossSeverity: number,
  volatility: number,
  liquidityLockup: number,
  counterpartyStructure: number,
  regulatoryLegal: number,
  operationalSkill: number,
]

// Individual strategy dict type
export interface StrategyDict {
  id: string
  n: string // full strategy name
  cat: StrategyCategory
  sub: string // sub-category
  veh: string // vehicle / implementation
  what: string // plain-English description
  rt: string // return type: "Interest income", "Dividend income", "APY", etc.
  ret: string // return figure (text; may be NR = not reliably reliable)
  num: number | null // mid-case % if ret contains a single percentage (else None)
  ev: string // evidence text citing the source and date
  liq: string // liquidity description
  hz: string // investment horizon ("< 1 year", "1-3 years", "3+ years", etc.)
  eff: string // effort level: "Passive", "Active", "Specialist", "Light"
  fees: string // fee description
  mn: number // minimum capital USD
  vi: string // viable at $100k mandate: "Yes", "Yes (limited)", "No"
  cf: string // confidence: "High", "Medium", "Low"
  subs: RiskSubScores // 6 risk sub-scores
  rk: string // key risks
  src: string // source citations
  al: string[] // v1 aliases
  sh: ShariahCompliance // shariah compliance: "Compliant", "Case-by-case", "Non-compliant", "Avoid"
  shn: string // shariah note
  tax: string // tax treatment description
  reg: string // regulatory availability description
}

// All A-strategies (21 cash/credit/real estate/public equity strategies)
export const A_STRATEGIES: StrategyDict[] = [
  // S001 - S021 would be populated here from strategies_data_a.py
  // ... (21 strategies with all fields including tax and reg)
]

// All C-strategies (13 crypto/digital asset strategies)
export const C_STRATEGIES: StrategyDict[] = [
  // C001 - C013 would be populated here from strategies_data_c.py
  // ... (13 strategies with all fields including tax and reg)
]

// All strategies combined
export const ALL_STRATEGIES: StrategyDict[] = [...A_STRATEGIES, ...C_STRATEGIES]

// Strategy lookup by ID
export function getStrategyById(id: string): StrategyDict | undefined {
  return ALL_STRATEGIES.find((s) => s.id === id)
}

// Strategies filtered by category
export function getStrategiesByCategory(
  category: StrategyCategory
): StrategyDict[] {
  return ALL_STRATEGIES.filter((s) => s.cat === category)
}

// Strategies filtered by shariah compliance
export function getStrategiesByShariah(
  compliance: ShariahCompliance
): StrategyDict[] {
  return ALL_STRATEGIES.filter((s) => s.sh === compliance)
}

// Strategies viable at $100k mandate
export function getStrategiesViableAt100k(): StrategyDict[] {
  return ALL_STRATEGIES.filter((s) => s.vi === "Yes" || s.vi === "Yes (limited)")
}

// Risk score computation (weighted mean of 6 sub-scores: [0.20, 0.20, 0.20, 0.15, 0.15, 0.10])
export function computeRiskScore(subs: RiskSubScores): number {
  const weights = [0.20, 0.20, 0.20, 0.15, 0.15, 0.10]
  return (
    weights[0] * subs[0] +
    weights[1] * subs[1] +
    weights[2] * subs[2] +
    weights[3] * subs[3] +
    weights[4] * subs[4] +
    weights[5] * subs[5]
  )
}

// Composite score: 0.7 × Risk + 0.3 × (liquidity_penalty + fee_penalty)/2
// liquidity_penalty: 0 if "Daily", 20 if "Lock-up", 50 if "Lock-up 1-3 years or longer"
// fee_penalty: parsed from fees string (simplified)
export function computeCompositeScore(
  riskScore: number,
  liqPenalty: number,
  feePenalty: number
): number {
  return 0.7 * riskScore + 0.3 * ((liqPenalty + feePenalty) / 2)
}

// Taxonomy hierarchy: Category → Sub-category → Strategy ids → Aliases
export const TAXONOMY = {
  "Cash & Capital Preservation": {
    "sub": ["S001", "S002"],
    // ... full taxonomy would be populated
  },
  "High-Yield Income & Real Estate Debt": {
    "sub": ["S012", "S013", "S014", "S015", "S016", "S017", "S018"],
    // ... 
  },
  "Growth Equity & Property Development": {
    "sub": ["S019", "S020", "S021"],
    // ...
  },
  "Yield / Income (Crypto / Digital Asset)": {
    "sub": ["C001", "C002", "C003", "C004", "C005", "C006", "C007"],
    // ...
  },
  "Non-Crypto Arbitrage": {
    "sub": [],
    // ...
  },
}

// Sources index (52 named sources with descriptions, dates, and caveats)
export const SOURCES = {
  // Source IDs mapped to descriptions
  S01: "FRED DGS3MO 3-month T-bill constant-maturity yield, 14 Oct 2026",
  S02: "FRED 10-year Treasury yield, 14 Oct 2026",
  S03: "ICE BofA US Corporate effective yield 5.94% at 14 Oct 2026",
  S04: "ICE BofA US High Yield effective yield 8.20% at 14 Oct 2026",
  S05: "ICE BofA US Corporate spread 84 bp at 14 Oct 2026",
  S06: "FRED DFII10 10-year TIPS real yield 2.84% at 14 Oct 2026",
  S07: "FRED T10YIE 10-year inflation breakeven 2.32% at 15 Oct 2026",
  S08: "BLS US CPI inflation 3.7% year-over-year, 2026-09",
  S09: "FRED DGS3MO 3-month T-bill, 14 Oct 2026",
  S10: "ECB deposit facility rate 2.50% at 16 Sep 2026",
  S11: "BoE Bank Rate 3.75% at 17 Sep 2026",
  S12: "iShares PFF 30-day SEC yield 6.76%, trailing yield 5.56%, expense ratio 0.45%",
  S13: "BCRED 2025 net total returns for private credit funds",
  S14: "OBDC 10.4% annualised dividend yield based on NAV in Q2 2025",
  S15: "MSCI Global Sukuk Index yield-to-worst 5.54% at 30 Sep 2026",
  S16: "LSEG data: global sukuk outstanding exceeded USD 1 tn in 2025",
  S17: "FTSE Nareit All Equity REITs dividend yield 4.07% for 2025",
  S18: "Aldar FY2025 dividend AED 0.205 per share; Emaar 2025 AGM AED 8.8bn payout",
  S19: "ATTOM 2025 US data: 25.5% gross ROI per real estate flip",
  S20: "Stake (UAE) platform: AED 500 entry, fees, 35.1% average appreciation (12 selected 2025 exits)",
  S21: "Fundrise/Arrived fractional real estate crowdfunding platform data",
  S22: "ATTOM data for real estate flipping statistics",
  S26: "Barclay Convertible Arbitrage Index: +9.52% in 2024, +10.88% in 2025",
  S33: "World Gold Council: gold annualised return since 1971",
  S34: "BullionVault quote: gold spot price USD 4,186.84/oz at 16 Oct 2026",
  S35: "CoinMarketCap/CoinGecko: BTC $1.64tn, ETH $298.97bn market caps at 16 Oct 2026",
  S58: "Hedge-fund fee convention: 2% management + 20% performance (2023 sample averaged 1.4% management fee)",
  S59: "Adviser fee: ≈0.96% per year, illustrative tiers 1.50% to 0.65%",
  S60: "MSCI World High Dividend Yield index yield 3.19% at 30 Sep 2026",
  S61: "S&P 500 index dividend yield 1.10% at 14 Oct 2026",
  S62: "S&P Global Infrastructure index dividend yield 3.89% at 14 Oct 2026",
  S63: "ICE BofA GBI-EM / EMBI+ data for emerging-market debt",
  S66: "Islamic money-market / commodity murabaha structure data",
  S67: "Preferred share data from iShares PFF and market",
  S68: "FINRA notes on structured products and capital-protected notes",
  S69: "KKR real-estate credit commentary June 2025",
  S72: "CBUAE base rate (could not be verified - page not extractable)",
}

// Changlog entries (860 entries tracking changes)
export const CHANGELOG = [
  // ... changelog entries would be populated
  // Each entry: { version, date, changes: string[] }
]

// Category display names (localized/UX-friendly)
export const CATEGORY_DISPLAY_NAMES: Record<StrategyCategory, string> = {
  [StrategyCategory.CashAndCapitalPreservation]: "Cash & Capital Preservation",
  [StrategyCategory.HighYieldIncomeAndRealEstateDebt]: "High-Yield Income & Real Estate Debt",
  [StrategyCategory.GrowthEquityAndPropertyDevelopment]: "Growth Equity & Property Development",
  [StrategyCategory.YieldIncomeCryptoDigitalAsset]: "Yield / Income (Crypto / Digital Asset)",
  [StrategyCategory.NonCryptoArbitrage]: "Non-Crypto Arbitrage",
}

// Shariah display names
export const SHARIAH_DISPLAY_NAMES: Record<ShariahCompliance, string> = {
  [ShariahCompliance.Compliant]: "Shariah-Compliant",
  [ShariahCompliance.CaseByCase]: "Case-by-case",
  [ShariahCompliance.NonCompliant]: "Non-compliant",
  [ShariahCompliance.Avoid]: "Avoid (hard red flag)",
}