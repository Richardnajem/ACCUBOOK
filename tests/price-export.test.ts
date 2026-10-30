// The full-history price workbook: one row per trading day, one column per
// indicator, in both 0-100 scores and each indicator's own units.
//
// The rules these tests protect:
//   · a warm-up reading is BLANK, never 0 — 0 is a real score and a real value;
//   · numbers are written as numbers, so Excel can sum and chart them;
//   · every bar the source returned is exported (not a backtest window), and
//     the coverage sheet says why a column may start late;
//   · the day-level detail (changes, dollar volume, 52-week distances) is
//     derived from the bars themselves.
//
// Hermetic: synthetic bars, hand-built series, no network and no database.

import { describe, it, expect } from "vitest";
import type { Bar } from "../src/lib/market-data";
import type { MegaScoreSeries } from "../src/lib/mega-score";
import {
  PRICE_HEADERS,
  buildPriceWorkbook,
  dailyPriceRows,
  indicatorCatalogueRows,
  indicatorCoverageRows,
  indicatorRawRows,
  indicatorScoreRows,
  priceFileName,
  priceSheets,
  priceSummaryRows,
  type PriceExportInput,
} from "../src/lib/price-export";

const bars: Bar[] = [
  { date: "2026-01-02", open: 100, high: 104, low: 99, close: 102, volume: 1000 },
  { date: "2026-01-05", open: 102, high: 103, low: 98, close: 99, volume: 1200 },
  { date: "2026-01-06", open: 99, high: 101, low: 97, close: 100.5, volume: 900 },
];

const specs: MegaScoreSeries["specs"] = [
  {
    id: "ta-rsi-14",
    name: "RSI (14)",
    category: "Technical",
    unit: "",
    direction: "band",
    thresholds: [30, 70],
    description: "Relative strength index",
    formula: "100 - 100 / (1 + avgGain / avgLoss)",
  },
  {
    id: "ta-atr-pct",
    name: "ATR %",
    category: "Technical",
    unit: "%",
    direction: "band",
    thresholds: [1, 5],
    description: "Average true range as a share of price",
    formula: "atr(14) / close * 100",
    optional: true,
  },
];

const series: MegaScoreSeries = {
  // Bar 0 is warm-up — the blank that must never turn into 0.
  score: [NaN, 62, 58],
  indicators: {
    "ta-rsi-14": [NaN, 71, 66],
    "ta-atr-pct": [NaN, 20, 0],
  },
  raw: {
    "ta-rsi-14": [NaN, 63.5, 58.2],
    "ta-atr-pct": [NaN, 2.4, 0],
  },
  customSpecs: [],
  specs,
  customErrors: [],
};

const input: PriceExportInput = {
  symbol: "AAPL",
  meta: { name: "Apple Inc.", exchange: "NASDAQ", currency: "USD", source: "yahoo" },
  bars,
  series,
  weights: { "ta-rsi-14": 2 },
  yearsRequested: 30,
  overrideCount: 1,
  customCount: 0,
  generatedAt: "2026-10-30T00:00:00.000Z",
};

describe("Daily prices — every trading day, with the day's own detail", () => {
  it("writes one row per bar, oldest first, with no forward-filled gaps", () => {
    const rows = dailyPriceRows(input);
    expect(rows).toHaveLength(bars.length + 1);
    expect(rows[0]).toEqual(PRICE_HEADERS);
    expect(rows.slice(1).map((r) => r[0])).toEqual(bars.map((b) => b.date));
  });

  it("keeps prices and volume as numbers and leaves missing values blank", () => {
    const [, first, second] = dailyPriceRows(input);
    expect(first[1]).toBe(100);
    expect(first[4]).toBe(102);
    expect(first[10]).toBe(1000);
    // The first bar has no previous close, so both close-to-close cells are blank.
    expect(first[7]).toBeNull();
    expect(first[8]).toBeNull();
    expect(first[9]).toBeNull();
    expect(second[7]).toBe(102);
    expect(second[8]).toBe(-3);
    expect(second[9]).toBe(Number(((-3 / 102) * 100).toFixed(4)));
  });

  it("derives dollar volume, intraday range and both change readings", () => {
    const [, first] = dailyPriceRows(input);
    expect(first[5]).toBe(2); // close − open
    expect(first[6]).toBe(2); // 2 / 100 * 100
    expect(first[11]).toBe(102000); // 102 × 1000
    expect(first[12]).toBe(Number(((5 / 102) * 100).toFixed(4)));
  });

  it("leaves the 52-week columns blank until a full year of bars exists", () => {
    const rows = dailyPriceRows(input).slice(1);
    for (const row of rows) {
      expect(row[13]).toBeNull();
      expect(row[14]).toBeNull();
      expect(row[15]).toBeNull();
      expect(row[16]).toBeNull();
    }
  });

  it("writes the Mega Score as a number", () => {
    const rows = dailyPriceRows(input).slice(1);
    // Bar 0 has no score (NaN) -> blank, never 0.
    expect(rows[0][17]).toBeNull();
    expect(rows[1][17]).toBe(62);
    expect(rows[2][17]).toBe(58);
  });

  it("counts the indicators that had a reading, so a default 50 is explainable", () => {
    const rows = dailyPriceRows(input).slice(1);
    // Bar 0: nothing is ready. Bar 1: both score. Bar 2: 66 and a real 0 -> both count.
    expect(rows[0][18]).toBe(0);
    expect(rows[1][18]).toBe(2);
    expect(rows[2][18]).toBe(2);
  });
});

describe("The per-indicator sheets — every indicator, every day", () => {
  it("gives each indicator its own named column in the score sheet", () => {
    const rows = indicatorScoreRows(input);
    expect(rows[0]).toEqual(["Date", "Close", "RSI (14) (ta-rsi-14)", "ATR % (ta-atr-pct)"]);
    expect(rows[1].slice(2)).toEqual([null, null]);
    expect(rows[2].slice(2)).toEqual([71, 20]);
    // A score of 0 is real and must survive as 0, not blank.
    expect(rows[3].slice(2)).toEqual([66, 0]);
  });

  it("writes the same grid in each indicator's own units", () => {
    const rows = indicatorRawRows(input);
    expect(rows[0]).toEqual(["Date", "Close", "RSI (14) (ta-rsi-14)", "ATR % (ta-atr-pct)"]);
    expect(rows[1].slice(2)).toEqual([null, null]);
    expect(rows[2].slice(2)).toEqual([63.5, 2.4]);
    expect(rows[3].slice(2)).toEqual([58.2, 0]);
  });

  it("documents each indicator and how much it counted towards the composite", () => {
    const rows = indicatorCatalogueRows(input);
    const rsi = rows.find((row) => row[0] === "ta-rsi-14")!;
    const atr = rows.find((row) => row[0] === "ta-atr-pct")!;
    expect(rsi[2]).toBe("Technical");
    expect(rsi[6]).toBe(2); // explicit weight wins
    expect(rsi[7]).toBe("Yes");
    expect(atr[6]).toBe(0); // catalogue entry: weight 0 until added
    expect(atr[7]).toBe("No");
    expect(String(rsi[8])).toContain("avgGain");
  });

  it("reports each indicator's coverage, so a blank column is explainable", () => {
    const rows = indicatorCoverageRows(input);
    const rsi = rows.find((row) => row[0] === "ta-rsi-14")!;
    expect(rsi[3]).toBe(2); // readings
    expect(rsi[4]).toBe(1); // leading warm-up bars
    expect(rsi[5]).toBe("2026-01-05"); // first reading
    expect(rsi[6]).toBe("2026-01-06"); // last reading
  });
});

describe("Summary, sheets and filename", () => {
  it("states what was exported and how a blank should be read", () => {
    const rows = priceSummaryRows(input);
    const map = new Map(rows.filter((r) => r.length === 2).map((r) => [r[0], r[1]]));
    expect(map.get("Ticker")).toBe("AAPL");
    expect(map.get("Company")).toBe("Apple Inc.");
    expect(map.get("Price source")).toBe("yahoo");
    expect(map.get("First bar")).toBe("2026-01-02");
    expect(map.get("Last bar")).toBe("2026-01-06");
    expect(map.get("Bars (trading days)")).toBe(3);
    expect(map.get("Indicators scored")).toBe(2);
    expect(map.get("Indicators in the composite (weight > 0)")).toBe(1);
    expect(map.get("Per-indicator edits applied")).toBe(1);
    // The warm-up rule is stated, not assumed.
    const reading = rows.filter((r) => r[0] === "How to read").map((r) => String(r[1])).join(" ");
    expect(reading).toContain("NOT zero");
    // A short history is explained rather than padded.
    expect(reading).toContain("not padded");
  });

  it("orders the sheets and keeps every name Excel-legal", () => {
    const sheets = priceSheets(input);
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary",
      "Daily prices",
      "Indicator scores",
      "Indicator raw",
      "Indicator catalogue",
      "Indicator coverage",
    ]);
    for (const sheet of sheets) {
      expect(sheet.name.length).toBeLessThanOrEqual(31);
      expect(sheet.rows.length).toBeGreaterThan(1);
    }
  });

  it("builds a workbook holding those sheets", () => {
    const wb = buildPriceWorkbook(input);
    expect(wb.SheetNames).toEqual(priceSheets(input).map((s) => s.name));
  });

  it("names the file after the ticker and the export date", () => {
    expect(priceFileName("AAPL", new Date("2026-10-30T12:00:00Z"))).toBe(
      "price-history-AAPL-2026-10-30.xlsx",
    );
    expect(priceFileName("BRK-B", new Date("2026-10-30T12:00:00Z"))).toBe(
      "price-history-BRK-B-2026-10-30.xlsx",
    );
  });
});
