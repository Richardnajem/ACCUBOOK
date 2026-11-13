// Cross-source verification: the comparison rules, the two vendor parsers and
// the SEC concept/frame readers, all on fixtures. No network.
import { describe, it, expect } from "vitest";
import {
  compareFigures,
  matchStatus,
  parseNasdaqFinancials,
  parseVendorMoney,
  parseYahooSummary,
  pickConceptValue,
  pickFrameValue,
  summarise,
  type VerifyAnnualRow,
  type VerifySource,
} from "../src/lib/research-verify";

describe("matchStatus", () => {
  it("calls a value inside the tolerance a match and a missing side unavailable", () => {
    expect(matchStatus(1000, 1004, 0.005)).toBe("match"); // 0.4 %
    expect(matchStatus(1000, 1010, 0.005)).toBe("near"); // 1 % — visible, not a conflict
    expect(matchStatus(1000, 1200, 0.005)).toBe("differs");
    expect(matchStatus(1000, null, 0.005)).toBe("unavailable");
    expect(matchStatus(null, 1000, 0.005)).toBe("unavailable");
  });

  it("uses an absolute tolerance for per-share values", () => {
    // $0.01 on EPS is rounding, not a disagreement; 0.01 relative would not be.
    expect(matchStatus(6.08, 6.09, 0.01, true)).toBe("match");
    expect(matchStatus(6.08, 6.35, 0.01, true)).toBe("differs");
  });

  it("bands 3× the tolerance as near, and anything beyond as a conflict", () => {
    expect(matchStatus(1000, 1014, 0.005)).toBe("near"); // 1.4 %
    expect(matchStatus(1000, 1016, 0.005)).toBe("differs"); // 1.6 %
  });
});

describe("parseVendorMoney", () => {
  it("reads the vendor's currency strings, scaling when asked", () => {
    expect(parseVendorMoney("$478,834,000", 1_000)).toBe(478_834_000_000);
    expect(parseVendorMoney("-$321,000", 1_000)).toBe(-321_000_000);
  });

  it("keeps a blank or absent cell null rather than zero", () => {
    expect(parseVendorMoney("")).toBeNull();
    expect(parseVendorMoney("--")).toBeNull();
    expect(parseVendorMoney(undefined)).toBeNull();
    expect(parseVendorMoney("N/A")).toBeNull();
  });
});

describe("parseNasdaqFinancials", () => {
  const payload = {
    data: {
      incomeStatementTable: {
        headers: { value1: "Period Ending:", value2: "9/26/2026", value3: "9/27/2025" },
        rows: [
          { value1: "Total Revenue", value2: "$478,834,000", value3: "$416,161,000" },
          { value1: "Gross Profit", value2: "$233,602,000", value3: "$195,201,000" },
          { value1: "Net Income", value2: "$132,175,000", value3: "$112,010,000" },
          { value1: "Operating Expenses", value2: "", value3: "" },
        ],
      },
      balanceSheetTable: {
        headers: { value2: "9/26/2026", value3: "9/27/2025" },
        rows: [
          { value1: "Total Assets", value2: "$404,548,000", value3: "$359,241,000" },
          { value1: "Cash and Cash Equivalents", value2: "--", value3: "$35,934,000" },
        ],
      },
      cashFlowTable: {
        headers: { value2: "9/26/2026", value3: "9/27/2025" },
        rows: [
          { value1: "Net Cash Flow-Operating", value2: "$145,097,000", value3: "$111,482,000" },
          { value1: "Capital Expenditures", value2: "-$9,041,000", value3: "-$12,715,000" },
        ],
      },
    },
  };

  it("converts the table's thousands into units and keeps the fiscal year end", () => {
    const rows = parseNasdaqFinancials(payload);
    expect(rows.map((r) => r.end)).toEqual(["2026-09-26", "2025-09-27"]);
    expect(rows[0].values.revenue).toBe(478_834_000_000);
    expect(rows[0].values.assets).toBe(404_548_000_000);
    expect(rows[0].values.capex).toBe(-9_041_000_000);
  });

  it("leaves a blank cell null instead of zero", () => {
    const rows = parseNasdaqFinancials(payload);
    expect(rows[0].values.cash).toBeNull();
    expect(rows[1].values.cash).toBe(35_934_000_000);
  });
});

describe("parseYahooSummary", () => {
  const payload = {
    quoteSummary: {
      result: [
        {
          incomeStatementHistory: {
            incomeStatementHistory: [
              {
                endDate: { fmt: "2026-09-30", raw: 1790726400 },
                totalRevenue: { raw: 478_834_000_000 },
                grossProfit: { raw: 233_602_000_000 },
                netIncome: { raw: 132_175_000_000 },
                dilutedEPS: { raw: 8.98 },
              },
            ],
          },
          balanceSheetHistory: {
            balanceSheetStatements: [
              { endDate: { fmt: "2026-09-30" }, totalAssets: { raw: 404_548_000_000 }, cash: { raw: 36_305_000_000 } },
            ],
          },
          cashflowStatementHistory: {
            cashflowStatements: [
              { endDate: { fmt: "2026-09-30" }, totalCashFromOperatingActivities: { raw: 145_097_000_000 }, capitalExpenditures: { raw: -9_041_000_000 } },
            ],
          },
        },
      ],
    },
  };

  it("merges the three statements into one row per period end", () => {
    const rows = parseYahooSummary(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0].end).toBe("2026-09-30");
    expect(rows[0].values.revenue).toBe(478_834_000_000);
    expect(rows[0].values.assets).toBe(404_548_000_000);
    expect(rows[0].values.operatingCashFlow).toBe(145_097_000_000);
    expect(rows[0].values.epsDiluted).toBe(8.98);
  });

  it("returns nothing when Yahoo answers with an error object", () => {
    expect(parseYahooSummary({ quoteSummary: { error: { code: "Unauthorized", description: "Invalid Crumb" } } })).toEqual([]);
  });
});

describe("pickConceptValue", () => {
  const concept = {
    units: {
      USD: [
        // original 10-K
        { start: "2025-01-01", end: "2025-12-31", val: 1000, form: "10-K", fp: "FY", filed: "2026-02-01" },
        // restated in the next 10-K's comparative column
        { start: "2025-01-01", end: "2025-12-31", val: 1010, form: "10-K", fp: "FY", filed: "2027-02-01" },
        // quarterly — not an annual value
        { start: "2025-10-01", end: "2025-12-31", val: 260, form: "10-Q", fp: "Q4", filed: "2026-02-01" },
      ],
    },
  };

  it("takes the newest filed value for the period (restatement wins)", () => {
    expect(pickConceptValue(concept, { end: "2025-12-31", unit: "USD", instant: false })).toBe(1010);
  });

  it("will not answer for a period the concept does not carry", () => {
    expect(pickConceptValue(concept, { end: "2024-12-31", unit: "USD", instant: false })).toBeNull();
  });

  it("rejects a duration fact when asked for an instant (and vice versa)", () => {
    const instant = {
      units: { USD: [{ end: "2025-12-31", val: 5000, form: "10-K", fp: "FY", filed: "2026-02-01" }] },
    };
    expect(pickConceptValue(instant, { end: "2025-12-31", unit: "USD", instant: true })).toBe(5000);
    expect(pickConceptValue(instant, { end: "2025-12-31", unit: "USD", instant: false })).toBeNull();
    expect(pickConceptValue(concept, { end: "2025-12-31", unit: "USD", instant: true })).toBeNull();
  });
});

describe("pickFrameValue", () => {
  const frame = {
    data: [
      { cik: 320193, end: "2026-09-26", val: 478_834_000_000 },
      { cik: 789019, end: "2026-06-30", val: 331_839_000_000 },
    ],
  };

  it("reads this filer's value from the frame, matched by CIK and period end", () => {
    expect(pickFrameValue(frame, { cik: "0000320193", end: "2026-09-26" })).toBe(478_834_000_000);
  });

  it("returns null rather than borrowing another company's figure", () => {
    expect(pickFrameValue(frame, { cik: "0000320193", end: "2026-06-30" })).toBeNull();
    expect(pickFrameValue(frame, { cik: "9999999999", end: "2026-09-26" })).toBeNull();
  });
});

describe("compareFigures", () => {
  const annual: VerifyAnnualRow[] = [
    { fy: 2026, end: "2026-09-26", values: { revenue: 478_834_000_000, netIncome: 132_175_000_000, cash: null } },
  ];
  const sources: VerifySource[] = [
    {
      id: "sec-facts",
      name: "SEC company facts",
      kind: "sec-primary",
      url: "",
      ok: true,
      rows: [{ end: "2026-09-26", values: annual[0].values }],
      ms: 0,
    },
    {
      id: "yahoo",
      name: "Yahoo Finance",
      kind: "vendor",
      url: "",
      ok: true,
      // month-end alignment, plus a net income that is materially different
      rows: [{ end: "2026-09-30", values: { revenue: 478_834_000_000, netIncome: 150_000_000_000 } }],
      ms: 12,
    },
    {
      id: "nasdaq",
      name: "Nasdaq",
      kind: "vendor",
      url: "",
      ok: false,
      error: "HTTP 403",
      rows: [],
      ms: 8,
    },
  ];

  it("matches a 52/53-week period to the vendor's month end", () => {
    const rows = compareFigures(annual, sources);
    const revenue = rows.find((r) => r.metric === "revenue")!;
    expect(revenue.verdict).toBe("verified");
    expect(revenue.confirmedBy).toBe(1);
    expect(revenue.matches.find((m) => m.source === "Yahoo Finance")?.status).toBe("match");
  });

  it("reports a material difference as a conflict and keeps both values", () => {
    const rows = compareFigures(annual, sources);
    const net = rows.find((r) => r.metric === "netIncome")!;
    expect(net.verdict).toBe("conflict");
    expect(net.primary).toBe(132_175_000_000);
    expect(net.matches.find((m) => m.source === "Yahoo Finance")?.value).toBe(150_000_000_000);
    expect(net.matches.find((m) => m.source === "Yahoo Finance")?.diffPct).toBeCloseTo(0.1349, 3);
  });

  it("treats a sub-1.5% vendor difference as corroboration, with the delta kept", () => {
    const close: VerifySource = {
      id: "yahoo",
      name: "Yahoo Finance",
      kind: "vendor",
      url: "",
      ok: true,
      rows: [{ end: "2026-09-30", values: { netIncome: 133_000_000_000 } }],
      ms: 1,
    };
    const rows = compareFigures(annual, [sources[0], close]);
    const net = rows.find((r) => r.metric === "netIncome")!;
    expect(net.verdict).toBe("verified");
    expect(net.matches[0].status).toBe("near");
    expect(net.matches[0].diffPct).toBeCloseTo(0.00624, 4);
  });

  it("does not let a failed source count as agreement", () => {
    const rows = compareFigures(annual, sources);
    const cash = rows.find((r) => r.metric === "cash")!;
    expect(cash.primary).toBeNull();
    expect(cash.verdict).toBe("not-reported");
    const failed = cash.matches.find((m) => m.source === "Nasdaq")!;
    expect(failed.status).toBe("unavailable");
    expect(failed.value).toBeNull();
  });

  it("marks a figure nobody else publishes as single-source, never verified", () => {
    const onlyPrimary: VerifySource[] = [sources[0]];
    const rows = compareFigures(annual, onlyPrimary, "sec-facts");
    expect(rows.find((r) => r.metric === "revenue")!.verdict).toBe("single-source");
  });

  it("will not compare a vendor row from a different period", () => {
    const wrongPeriod: VerifySource = {
      id: "yahoo",
      name: "Yahoo Finance",
      kind: "vendor",
      url: "",
      ok: true,
      rows: [{ end: "2023-09-30", values: { revenue: 478_834_000_000 } }],
      ms: 1,
    };
    const rows = compareFigures(annual, [sources[0], wrongPeriod]);
    const revenue = rows.find((r) => r.metric === "revenue")!;
    expect(revenue.matches[0].status).toBe("unavailable");
    expect(revenue.verdict).toBe("single-source");
  });

  it("compares capex by amount, not by the vendor's sign convention", () => {
    const capexAnnual: VerifyAnnualRow[] = [
      { fy: 2026, end: "2026-09-26", values: { capex: 9_041_000_000 } },
    ];
    const nasdaq: VerifySource = {
      id: "nasdaq",
      name: "Nasdaq",
      kind: "vendor",
      url: "",
      ok: true,
      rows: [{ end: "2026-09-26", values: { capex: -9_041_000_000 } }],
      ms: 1,
    };
    const rows = compareFigures(capexAnnual, [sources[0], nasdaq]);
    const capex = rows.find((r) => r.metric === "capex")!;
    expect(capex.verdict).toBe("verified");
    expect(capex.matches[0].value).toBe(9_041_000_000);
  });

  it("treats a vendor's 0 against a real figure as a blank, not a conflict", () => {
    const gpAnnual: VerifyAnnualRow[] = [
      { fy: 2026, end: "2026-09-26", values: { grossProfit: 233_602_000_000 } },
    ];
    const yahooZero: VerifySource = {
      id: "yahoo",
      name: "Yahoo Finance",
      kind: "vendor",
      url: "",
      ok: true,
      rows: [{ end: "2026-09-30", values: { grossProfit: 0 } }],
      ms: 1,
    };
    const rows = compareFigures(gpAnnual, [sources[0], yahooZero]);
    const gp = rows.find((r) => r.metric === "grossProfit")!;
    expect(gp.verdict).toBe("single-source");
    expect(gp.matches[0].status).toBe("unavailable");
    expect(gp.matches[0].note).toContain("no figure in its feed");
  });

  it("does not call a constant currency multiple a disagreement", () => {
    // ASML: the statements are EUR, Nasdaq's tables are USD at ×1.174.
    const eur: VerifyAnnualRow[] = [
      {
        fy: 2025,
        end: "2025-12-31",
        values: { revenue: 32_667_000_000, netIncome: 9_610_000_000, assets: 50_570_000_000, equity: 19_610_000_000 },
      },
    ];
    const usd: VerifySource = {
      id: "nasdaq",
      name: "Nasdaq",
      kind: "vendor",
      url: "",
      ok: true,
      rows: [
        {
          end: "2025-12-31",
          values: { revenue: 38_370_000_000, netIncome: 11_290_000_000, assets: 59_390_000_000, equity: 23_030_000_000 },
        },
      ],
      ms: 1,
    };
    const rows = compareFigures(eur, [sources[0], usd]);
    const revenue = rows.find((r) => r.metric === "revenue")!;
    expect(revenue.verdict).toBe("single-source");
    expect(revenue.matches[0].status).toBe("unavailable");
    expect(revenue.matches[0].note).toContain("different currency or scale");
  });

  it("summarises every verdict once", () => {
    const figures = compareFigures(annual, sources);
    const summary = summarise(figures, sources);
    expect(summary.figures).toBe(figures.length);
    expect(summary.verified).toBe(figures.filter((f) => f.verdict === "verified").length);
    expect(summary.conflicts).toBe(1);
    expect(summary.sources).toBe(3);
    expect(summary.sourcesOk).toBe(2);
  });
});
