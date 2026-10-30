// The backtest workbook: one row per bar and one column per indicator, written
// so the numbers can be checked by hand in Excel.
//
// The rule these tests protect: a cell is either the number the run used or
// BLANK (warm-up). A blank must never become 0 — 0 is a real Mega Score and a
// real indicator reading — because a spreadsheet full of 0s looks like data.
//
// Hermetic: synthetic bars, hand-built series, no network and no database.

import { describe, it, expect } from "vitest";
import type { Bar } from "../src/lib/market-data";
import type { BacktestOutput } from "../src/lib/backtest-engine";
import type { MegaScoreSeries } from "../src/lib/mega-score";
import {
  DAILY_HEADERS,
  backtestFileName,
  backtestSheets,
  dailyBarRows,
  indicatorCatalogueRows,
  indicatorRawRows,
  indicatorScoreRows,
  monthlyRows,
  summaryRows,
  tradeRows,
  type BacktestExportInput,
} from "../src/lib/backtest-export";

const bars: Bar[] = [
  { date: "2026-01-02", open: 100, high: 104, low: 99, close: 102, volume: 1000 },
  { date: "2026-01-05", open: 102, high: 103, low: 98, close: 99, volume: 1200 },
  { date: "2026-01-06", open: 99, high: 101, low: 97, close: 100.5, volume: 900 },
];

const specs = [
  {
    id: "ta-rsi-14",
    name: "RSI (14)",
    category: "momentum",
    unit: "points",
    direction: "higher" as const,
    thresholds: [30, 70] as [number, number],
    description: "Relative strength",
    formula: "100 - 100 / (1 + avgGain / avgLoss)",
  },
  {
    id: "ta-atr-pct",
    name: "ATR %",
    category: "volatility",
    unit: "%",
    direction: "lower" as const,
    thresholds: [2, 6] as [number, number],
    description: "Average true range as a share of price",
    formula: "atr(14) / close * 100",
    optional: true,
  },
];

const series: MegaScoreSeries = {
  // Bar 0 has no reading yet — the warm-up blank.
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

const input = {
  run: {
    symbol: "AAPL",
    strategyId: "mega_score",
    strategyName: "Mega Score Regime",
    meta: { name: "Apple Inc.", currency: "USD", exchange: "NASDAQ" },
    dateFrom: "2026-01-02",
    dateTo: "2026-01-06",
    bars: 3,
    dataSource: "cache",
    config: {
      symbol: "AAPL",
      strategyId: "mega_score",
      initialCapital: 100000,
      years: 1,
      commissionBps: 2,
      slippageBps: 2,
      positionPct: 100,
      params: { entry: 70, exit: 25, smooth: 5 },
      benchmarkSymbol: "SPY",
    },
    summary: {
      finalEquity: 101000,
      totalReturnPct: 1,
      benchmarkReturnPct: 0.5,
      cagr: 1,
      sharpe: 0.8,
      sortino: 1.1,
      calmar: 0.9,
      maxDrawdownPct: 2,
      benchmarkMaxDrawdownPct: 3,
      winRate: 50,
      profitFactor: 1.2,
      totalTrades: 1,
      avgTradeReturnPct: 0.4,
      bestTradePct: 0.4,
      worstTradePct: 0.4,
      avgBarsHeld: 1,
      timeInMarketPct: 66.7,
      tradesPerYear: 1,
      barMinutes: 1440,
      barUnit: "day",
      periodsPerYear: 252,
      risk: {
        annualVolPct: 12,
        benchmarkVolPct: 10,
        beta: 1.1,
        downsideDevPct: 8,
        ulcerIndex: 1.2,
        riskFactor: 31.5,
        riskLevel: "Moderate",
      },
      expectancyPct: 0.4,
      payoffRatio: 1.2,
      maxConsecutiveLosses: 0,
      maxConsecutiveWins: 1,
      recoveryFactor: 0.5,
    },
    equityCurve: [
      { date: "2026-01-05", equity: 101000, benchmark: 99.5, drawdownPct: 0, price: 99, invested: true },
      { date: "2026-01-06", equity: 100500, benchmark: 100.2, drawdownPct: 0.5, price: 100.5, invested: false },
    ],
    trades: [
      {
        id: 1,
        entryDate: "2026-01-05",
        exitDate: "2026-01-06",
        side: "long",
        shares: 10,
        entryPrice: 102,
        exitPrice: 100.5,
        pnl: -15,
        returnPct: -1.47,
        bars: 1,
        reason: "signal",
        entryScore: 72,
        entrySignalDate: "2026-01-02",
        entryFillScore: 62,
        exitScore: 20,
        exitSignalDate: "2026-01-05",
        exitFillScore: 58,
      },
    ],
    monthlyReturns: [{ month: "2026-01", ret: 0.5 }],
    priceSeries: [],
    megaScoreDescription: "",
    minTrades: 5,
    meetsMinTrades: false,
    warnings: ["Fewer than 5 closed trades — results are not statistically meaningful."],
  },
  bars,
  series,
  // What the bands actually checked: smoothed, so 72 / 20 either side of 70 / 25.
  signalScores: [NaN, 72, 20],
  weights: { "ta-rsi-14": 2, "ta-atr-pct": 0 },
  bands: { entry: 70, exit: 25, smooth: 5 },
  overrideCount: 1,
  generatedAt: "2026-10-29T08:00:00.000Z",
} as unknown as BacktestExportInput;

const summaryMap = (): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  for (const row of summaryRows(input).slice(1)) map.set(String(row[0]), row[1]);
  return map;
};

describe("the bars sheet — a row per day, with the numbers the run used", () => {
  const rows = dailyBarRows(input);

  it("has one header plus one row per bar", () => {
    expect(rows.length).toBe(bars.length + 1);
    expect(rows[0]).toEqual(DAILY_HEADERS);
  });

  it("writes open, high, low, close and volume as numbers, not strings", () => {
    const row = rows[1];
    expect(row.slice(1, 6)).toEqual([100, 104, 99, 102, 2]);
    expect(typeof row[1]).toBe("number");
    expect(row[10]).toBe(1000);
  });

  it("keeps the bar's own move apart from the close-to-close move", () => {
    // Row 1: open-to-close 100 -> 102 is +2; there is no previous close yet.
    expect(rows[1][5]).toBe(2);
    expect(rows[1][6]).toBe(2);
    expect(rows[1][7]).toBeNull();
    expect(rows[1][8]).toBeNull();
    expect(rows[1][9]).toBeNull();
    // Row 2: open-to-close 102 -> 99 is -3 and -2.9412 %; close-to-close is the same.
    expect(rows[2][5]).toBeCloseTo(-3, 6);
    expect(rows[2][6]).toBeCloseTo(-2.9412, 4);
    expect(rows[2][7]).toBe(102);
    expect(rows[2][8]).toBeCloseTo(-3, 6);
    expect(rows[2][9]).toBeCloseTo(-2.9412, 4);
  });

  it("leaves a warm-up reading blank instead of calling it zero", () => {
    expect(rows[1][11]).toBeNull();
    expect(rows[1][12]).toBeNull();
    expect(rows[1][11]).not.toBe(0);
    // ...and the real readings are still numbers.
    expect(rows[2][11]).toBe(62);
    expect(rows[2][12]).toBe(72);
  });

  it("labels the zone from the smoothed score and the run's own bands", () => {
    expect(rows[1][13]).toBeNull(); // no reading yet
    expect(rows[2][13]).toBe("Buy zone"); // 72 >= 70
    expect(rows[3][13]).toBe("Exit zone"); // 20 < 25
  });

  it("marks in-market, equity, benchmark and drawdown from the equity curve", () => {
    expect(rows[1][14]).toBeNull(); // the curve starts on the second bar
    expect(rows[1][16]).toBeNull();
    expect(rows[2][14]).toBe(1);
    expect(rows[2][16]).toBe(101000);
    expect(rows[2][17]).toBe(99.5);
    expect(rows[3][14]).toBe(0);
    expect(rows[3][18]).toBe(0.5);
  });

  it("names the trade that happened on the bar", () => {
    expect(rows[1][15]).toBeNull();
    expect(rows[2][15]).toBe("Entry #1");
    expect(rows[3][15]).toBe("Exit #1");
  });

  it("writes no zone at all when the strategy does not trade the composite", () => {
    const plain = dailyBarRows({ ...input, bands: null } as BacktestExportInput);
    expect(plain.slice(1).every((row) => row[13] === null)).toBe(true);
    // the score itself is still exported
    expect(plain[2][11]).toBe(62);
  });
});

describe("the per-indicator sheets — every indicator, every bar", () => {
  it("gives each indicator its own named column", () => {
    const rows = indicatorScoreRows(input);
    expect(rows[0]).toEqual(["Date", "Close", "RSI (14) (ta-rsi-14)", "ATR % (ta-atr-pct)"]);
    expect(rows.length).toBe(bars.length + 1);
  });

  it("writes the 0-100 score in the scores sheet", () => {
    const rows = indicatorScoreRows(input);
    expect(rows[1].slice(2)).toEqual([null, null]);
    expect(rows[2].slice(2)).toEqual([71, 20]);
  });

  it("writes the indicator's own units in the raw sheet", () => {
    const rows = indicatorRawRows(input);
    expect(rows[2].slice(2)).toEqual([63.5, 2.4]);
    expect(rows[3].slice(2)).toEqual([58.2, 0]); // a real 0 is kept as 0
  });

  it("catalogues each column with its weight and whether it counted", () => {
    const rows = indicatorCatalogueRows(input);
    expect(rows[0].slice(0, 4)).toEqual(["ID", "Name", "Category", "Unit"]);
    const rsi = rows.find((row) => row[0] === "ta-rsi-14")!;
    const atr = rows.find((row) => row[0] === "ta-atr-pct")!;
    expect(rsi[6]).toBe(2);
    expect(rsi[7]).toBe("Yes");
    expect(atr[6]).toBe(0);
    expect(atr[7]).toBe("No");
    expect(String(rsi[9])).toContain("avgGain");
  });
});

describe("the run's own logs", () => {
  it("exports the trade with the score on each side of it", () => {
    const [header, row] = tradeRows(input.run);
    expect(header).toContain("Score on entry fill day");
    expect(header).toContain("Score at exit signal");
    expect(row[10]).toBe(72); // entry signal reading
    expect(row[11]).toBe("2026-01-02");
    expect(row[12]).toBe(62); // entry fill-day reading
    expect(row[13]).toBe(20); // exit signal reading
    expect(row[14]).toBe("2026-01-05");
    expect(row[15]).toBe(58); // exit fill-day reading
  });

  it("exports monthly returns with their sign", () => {
    expect(monthlyRows(input.run)[1]).toEqual(["2026-01", 0.5]);
  });
});

describe("the summary says what was run before it prints any figure", () => {
  it("records the provenance the file needs to be reproducible", () => {
    const map = summaryMap();
    expect(map.get("Ticker")).toBe("AAPL");
    expect(map.get("Strategy")).toBe("Mega Score Regime");
    expect(map.get("Frequency")).toBe("daily bars");
    expect(map.get("Bars in this run")).toBe(3);
    expect(map.get("Benchmark")).toBe("SPY");
    expect(map.get("Per-indicator edits applied")).toBe(1);
    expect(map.get("Indicators scored")).toBe(2);
    expect(map.get("Indicators in the composite (weight > 0)")).toBe(1);
  });

  it("states the bands the run actually checked", () => {
    expect(String(summaryMap().get("Composite bands"))).toContain("buy at score >= 70");
    expect(String(summaryMap().get("Composite bands"))).toContain("smoothed over 5 bars");
  });

  it("says a blank is a warm-up, not a zero", () => {
    const flat = summaryRows(input).map((row) => row.join(" ")).join(" | ");
    expect(flat).toContain("blank cell is a warm-up reading");
    expect(flat).toContain("NOT zero");
  });

  it("carries the run's warnings rather than dropping them", () => {
    const flat = summaryRows(input).map((row) => row.join(" ")).join(" | ");
    expect(flat).toContain("Fewer than 5 closed trades");
  });
});

describe("the workbook itself", () => {
  it("orders the sheets and keeps every name Excel-legal", () => {
    const sheets = backtestSheets(input);
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary",
      "Bars (daily)",
      "Indicator scores",
      "Indicator raw",
      "Indicator catalogue",
      "Trades",
      "Equity",
      "Monthly returns",
    ]);
    for (const sheet of sheets) expect(sheet.name.length).toBeLessThanOrEqual(31);
  });

  it("does not ship a stub sheet", () => {
    const empty = { ...input, run: { ...input.run, trades: [], monthlyReturns: [] } } as BacktestExportInput;
    const names = backtestSheets(empty).map((s) => s.name);
    expect(names).not.toContain("Trades");
    expect(names).not.toContain("Monthly returns");
    expect(names).toContain("Summary"); // the provenance sheet always stays
  });

  it("names the file by ticker, strategy and date", () => {
    expect(backtestFileName(input.run, new Date("2026-10-29T10:00:00Z"))).toBe(
      "backtest-AAPL-mega_score-2026-10-29.xlsx"
    );
    const odd = { ...input.run, symbol: "BRK/B", strategyId: "rsi fast" } as BacktestOutput;
    expect(backtestFileName(odd, new Date("2026-10-29T10:00:00Z"))).toBe(
      "backtest-BRK-B-rsi-fast-2026-10-29.xlsx"
    );
  });
});
