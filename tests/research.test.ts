// SEC research pipeline: period extraction, statement assembly, ratios and
// valuation. Fixtures mirror real companyfacts shapes (including the
// comparative duplicate a 10-K carries for the prior year) so the tests pin
// the behaviours that would silently double-count or mislabel a period.
import { describe, it, expect } from "vitest";
import {
  buildAnnualStatements,
  buildFilings,
  buildValuation,
  computeRatios,
  detectCurrency,
  extractAnnualSeries,
  latestShares,
  type CompanyFacts,
  type CompanySubmissions,
} from "../src/lib/research";

interface Entry {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}

const concept = (entries: Entry[]) => ({ units: { USD: entries } });
const unitConcept = (unit: string) => (entries: Entry[]) => ({ units: { [unit]: entries } });

const facts: CompanyFacts = {
  cik: 123,
  entityName: "Example Corp",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: concept([
        { start: "2022-01-01", end: "2022-12-31", val: 1000, fy: 2022, fp: "FY", form: "10-K", filed: "2023-02-01" },
        { start: "2023-01-01", end: "2023-12-31", val: 1200, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
        // comparative duplicate of 2022, re-filed under fy 2023
        { start: "2022-01-01", end: "2022-12-31", val: 1010, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
        // quarterly — must not become an annual period
        { start: "2024-01-01", end: "2024-03-31", val: 350, fy: 2024, fp: "Q1", form: "10-Q", filed: "2024-05-01" },
      ]),
      GrossProfit: concept([
        { start: "2023-01-01", end: "2023-12-31", val: 600, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      OperatingIncomeLoss: concept([
        { start: "2023-01-01", end: "2023-12-31", val: 150, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      NetIncomeLoss: concept([
        { start: "2022-01-01", end: "2022-12-31", val: 80, fy: 2022, fp: "FY", form: "10-K", filed: "2023-02-01" },
        { start: "2023-01-01", end: "2023-12-31", val: 100, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      Assets: concept([
        { end: "2022-12-31", val: 900, fy: 2022, fp: "FY", form: "10-K", filed: "2023-02-01" },
        { end: "2023-12-31", val: 1000, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      StockholdersEquity: concept([
        { end: "2023-12-31", val: 500, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      CashAndCashEquivalentsAtCarryingValue: concept([
        { end: "2023-12-31", val: 50, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      LongTermDebtNoncurrent: concept([
        { end: "2023-12-31", val: 200, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      NetCashProvidedByUsedInOperatingActivities: concept([
        { start: "2022-01-01", end: "2022-12-31", val: 90, fy: 2022, fp: "FY", form: "10-K", filed: "2023-02-01" },
        { start: "2023-01-01", end: "2023-12-31", val: 110, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      PaymentsToAcquirePropertyPlantAndEquipment: concept([
        // 2022 capex is deliberately absent: FCF must be "—", not OCF.
        { start: "2023-01-01", end: "2023-12-31", val: 40, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
      DepreciationDepletionAndAmortization: concept([
        { start: "2023-01-01", end: "2023-12-31", val: 30, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
      ]),
    },
    dei: {
      EntityCommonStockSharesOutstanding: {
        units: {
          shares: [
            { end: "2023-12-31", val: 90, form: "10-K", filed: "2024-02-01" },
            { end: "2024-06-30", val: 100, form: "10-K", filed: "2024-07-15" },
          ],
        },
      },
    },
  },
};

describe("extractAnnualSeries", () => {
  it("keys periods by end date and keeps the original fiscal-year label", () => {
    const series = extractAnnualSeries(
      facts,
      ["RevenueFromContractWithCustomerExcludingAssessedTax"],
      ["USD"],
      false
    );
    expect([...series.keys()].sort()).toEqual(["2022-12-31", "2023-12-31"]);
    // The comparative re-filed in the 2024 10-K restates 2022 to 1010 but
    // must not create a second 2023 period.
    expect(series.get("2022-12-31")?.value).toBe(1010);
    expect(series.get("2022-12-31")?.fy).toBe(2022);
    expect(series.get("2023-12-31")?.fy).toBe(2023);
  });

  it("ignores quarterly durations when reading annual flows", () => {
    const series = extractAnnualSeries(facts, ["RevenueFromContractWithCustomerExcludingAssessedTax"], ["USD"], false);
    expect(series.has("2024-03-31")).toBe(false);
  });

  it("labels a period from its earliest filing even when facts arrive out of order", () => {
    // companyfacts lists the newest filing's comparative first; the older
    // 10-K appears later in the array. The label must still be FY2022.
    const outOfOrder: CompanyFacts = {
      facts: {
        "us-gaap": {
          Revenues: concept([
            { start: "2023-01-01", end: "2023-12-31", val: 1200, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
            { start: "2022-01-01", end: "2022-12-31", val: 1010, fy: 2023, fp: "FY", form: "10-K", filed: "2024-02-01" },
            { start: "2022-01-01", end: "2022-12-31", val: 1000, fy: 2022, fp: "FY", form: "10-K", filed: "2023-02-01" },
          ]),
        },
      },
    };
    const built = buildAnnualStatements(outOfOrder);
    expect(built.annual.map((r) => ({ end: r.end, fy: r.fy }))).toEqual([
      { end: "2023-12-31", fy: 2023 },
      { end: "2022-12-31", fy: 2022 },
    ]);
    expect(built.annual[1].revenue).toBe(1010); // latest filed value
  });

  it("reports the concept that supplied the value", () => {
    const series = extractAnnualSeries(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["USD"], false);
    expect(series.get("2023-12-31")?.tag).toBe("RevenueFromContractWithCustomerExcludingAssessedTax");
    expect(series.get("2023-12-31")?.taxonomy).toBe("us-gaap");
  });
});

describe("buildAnnualStatements", () => {
  const built = buildAnnualStatements(facts);

  it("returns the most recent fiscal year first", () => {
    expect(built.annual.map((r) => r.fy)).toEqual([2023, 2022]);
  });

  it("computes free cash flow only when capex was filed", () => {
    const fy2023 = built.annual.find((r) => r.fy === 2023)!;
    const fy2022 = built.annual.find((r) => r.fy === 2022)!;
    expect(fy2023.freeCashFlow).toBe(110 - 40);
    expect(fy2022.freeCashFlow).toBeNull();
  });

  it("records a note for a metric the filer never reported", () => {
    // Current assets / liabilities are absent from this fixture entirely.
    expect(built.notes.some((n) => n.startsWith("Current assets"))).toBe(true);
    expect(built.notes.some((n) => n.startsWith("Gross profit"))).toBe(false);
    expect(built.tags.revenue).toBe("RevenueFromContractWithCustomerExcludingAssessedTax");
  });

  it("marks missing metrics null rather than zero", () => {
    const fy2022 = built.annual.find((r) => r.fy === 2022)!;
    expect(fy2022.grossProfit).toBeNull();
    expect(fy2022.equity).toBeNull();
  });
});

describe("computeRatios", () => {
  const annual = buildAnnualStatements(facts).annual;
  const ratios = computeRatios(annual);
  const fy2023 = ratios.find((r) => r.fy === 2023)!;
  const fy2022 = ratios.find((r) => r.fy === 2022)!;

  it("computes margins from the filed lines", () => {
    expect(fy2023.grossMargin).toBeCloseTo(0.5);
    expect(fy2023.operatingMargin).toBeCloseTo(150 / 1200);
    expect(fy2023.netMargin).toBeCloseTo(100 / 1200);
  });

  it("computes returns, leverage, liquidity and FCF margin", () => {
    expect(fy2023.returnOnEquity).toBeCloseTo(0.2);
    expect(fy2023.debtToEquity).toBeCloseTo(0.4);
    expect(fy2023.freeCashFlowMargin).toBeCloseTo(70 / 1200);
  });

  it("computes growth from the prior period and leaves the oldest blank", () => {
    // Growth uses the RESTATED 2022 revenue (1010, latest filing), the same
    // figure shown in the statement table.
    expect(fy2023.revenueGrowth).toBeCloseTo(1200 / 1010 - 1);
    expect(fy2022.revenueGrowth).toBeNull();
    expect(fy2022.epsGrowth).toBeNull();
  });
});

describe("buildValuation", () => {
  const annual = buildAnnualStatements(facts).annual;

  it("values the latest filed year against the quote", () => {
    const v = buildValuation(annual, 10, 100);
    expect(v.fiscalYear).toBe(2023);
    expect(v.marketCap).toBe(1000);
    expect(v.priceToEarnings).toBeCloseTo(10);
    expect(v.priceToSales).toBeCloseTo(1000 / 1200);
    expect(v.priceToBook).toBeCloseTo(2);
    expect(v.freeCashFlowYieldPct).toBeCloseTo((70 / 1000) * 100);
    // EV = 1000 + 200 - 50; EBITDA = 150 + 30
    expect(v.enterpriseValue).toBe(1150);
    expect(v.ebitda).toBe(180);
    expect(v.evToEbitda).toBeCloseTo(1150 / 180);
  });

  it("returns nulls instead of pretending when the price is missing", () => {
    const v = buildValuation(annual, null, 100);
    expect(v.marketCap).toBeNull();
    expect(v.priceToEarnings).toBeNull();
    expect(v.enterpriseValue).toBeNull();
  });

  it("does not assume zero debt in enterprise value", () => {
    const noDebt = annual.map((r) => ({ ...r, debt: null }));
    const v = buildValuation(noDebt, 10, 100);
    expect(v.marketCap).toBe(1000);
    expect(v.enterpriseValue).toBeNull();
  });
});

describe("latestShares", () => {
  it("uses the newest cover-page share count", () => {
    const annual = buildAnnualStatements(facts).annual;
    expect(latestShares(facts, annual)).toBe(100);
  });
});

// A 20-F filer reports in DKK with the IFRS taxonomy. Assuming USD here would
// drop every line; the currency must be detected, stated, and converted only
// for the multiples that mix it with a USD share price.
const dkk = unitConcept("DKK");
const dkkPerShare = unitConcept("DKK/shares");
const ifrsFacts: CompanyFacts = {
  facts: {
    "ifrs-full": {
      Revenue: dkk([
        { start: "2023-01-01", end: "2023-12-31", val: 2000, fy: 2023, fp: "FY", form: "20-F", filed: "2024-02-01" },
        { start: "2024-01-01", end: "2024-12-31", val: 2400, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" },
      ]),
      ProfitLoss: dkk([
        { start: "2023-01-01", end: "2023-12-31", val: 200, fy: 2023, fp: "FY", form: "20-F", filed: "2024-02-01" },
        { start: "2024-01-01", end: "2024-12-31", val: 300, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" },
      ]),
      Assets: dkk([{ end: "2024-12-31", val: 5000, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" }]),
      Equity: dkk([{ end: "2024-12-31", val: 3000, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" }]),
      LongtermBorrowings: dkk([{ end: "2024-12-31", val: 500, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" }]),
      CashAndCashEquivalents: dkk([{ end: "2024-12-31", val: 200, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" }]),
      CashFlowsFromUsedInOperatingActivities: dkk([
        { start: "2024-01-01", end: "2024-12-31", val: 400, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" },
      ]),
      PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities: dkk([
        { start: "2024-01-01", end: "2024-12-31", val: 100, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" },
      ]),
      DilutedEarningsLossPerShare: dkkPerShare([
        { start: "2024-01-01", end: "2024-12-31", val: 10, fy: 2024, fp: "FY", form: "20-F", filed: "2025-02-01" },
      ]),
    },
  },
};

describe("non-USD (IFRS) filers", () => {
  it("detects the reporting currency from the facts", () => {
    expect(detectCurrency(ifrsFacts)).toBe("DKK");
    expect(detectCurrency(facts)).toBe("USD");
  });

  it("falls back to IFRS statements and reads them in DKK", () => {
    const built = buildAnnualStatements(ifrsFacts);
    expect(built.taxonomy).toBe("ifrs-full");
    expect(built.currency).toBe("DKK");
    expect(built.annual[0].revenue).toBe(2400);
    expect(built.annual[0].epsDiluted).toBe(10);
    expect(built.annual[0].freeCashFlow).toBe(300);
    expect(built.tags.revenue).toBe("Revenue");
    expect(built.notes.some((n) => n.includes("reported in DKK"))).toBe(true);
  });

  it("converts price and net debt into the statement currency for multiples", () => {
    const annual = buildAnnualStatements(ifrsFacts).annual;
    const v = buildValuation(annual, 20, 100, { currency: "DKK", usdPerUnit: 0.15 });
    expect(v.reportingCurrency).toBe("DKK");
    expect(v.marketCap).toBe(2000); // USD, price × shares
    // 20 USD / 0.15 = 133.33 DKK per share × 100 shares
    expect(v.marketCapReporting).toBeCloseTo((20 / 0.15) * 100);
    expect(v.priceToEarnings).toBeCloseTo((20 / 0.15) * 100 / 300);
    // EV in DKK = 13333.33 + 500 - 200, converted back to USD × 0.15
    expect(v.enterpriseValue).toBeCloseTo((((20 / 0.15) * 100) + 500 - 200) * 0.15);
  });

  it("keeps the USD market cap but leaves converted multiples blank without FX", () => {
    const annual = buildAnnualStatements(ifrsFacts).annual;
    const v = buildValuation(annual, 20, 100, { currency: "DKK", usdPerUnit: null });
    expect(v.marketCap).toBe(2000);
    expect(v.marketCapReporting).toBeNull();
    expect(v.priceToEarnings).toBeNull();
    expect(v.enterpriseValue).toBeNull();
  });
});

describe("buildFilings", () => {
  const sub: CompanySubmissions = {
    name: "Example Corp",
    tickers: ["EX"],
    exchanges: ["NYSE"],
    filings: {
      recent: {
        form: ["10-K", "424B2", "8-K"],
        filingDate: ["2024-02-01", "2024-03-01", "2024-04-01"],
        reportDate: ["2023-12-31", "", "2024-04-01"],
        accessionNumber: ["0000000123-24-000001", "0000000123-24-000002", "0000000123-24-000003"],
        primaryDocument: ["ex10k.htm", "ex424b2.htm", "ex8k.htm"],
        primaryDocDescription: ["Annual report", "Prospectus", "Current report"],
      },
    },
  };

  it("keeps research forms and links to the EDGAR archive", () => {
    const filings = buildFilings(sub, "0000000123");
    expect(filings.map((f) => f.form)).toEqual(["10-K", "8-K"]);
    expect(filings[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/123/000000012324000001/ex10k.htm"
    );
  });
});
