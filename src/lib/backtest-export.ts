// ─── Backtest export: one workbook, every number the run used ───
//
// The backtest screens summarise a run; this writes the whole thing out so the
// figures can be checked by hand in Excel:
//
//   Summary            – what was run, on what data, with which weights, and the metrics
//   Bars (daily …)     – one row per bar: open/high/low/close, both "change"
//                        readings, volume, Mega Score (raw + signal), zone,
//                        in-market flag, equity, benchmark, drawdown
//   Indicator scores   – one column per indicator, its 0-100 health score per bar
//   Indicator raw      – the same grid in each indicator's own units
//   Indicator catalogue– id, name, unit, direction, weight, formula (so a column
//                        can be read without guessing)
//   Trades / Equity / Monthly returns – the run's logs
//
// Accuracy rules, on purpose:
//   · a warm-up reading is a BLANK cell, never 0 — 0 is a real score;
//   · every price and value is written as a NUMBER (not a pre-rounded string), so
//     Excel can sum, chart and re-derive it;
//   · the bars are the run's own bars (same ticker, window, frequency and
//     resampling), and the series is computed from the same weights/edits the
//     engine traded with — see runBacktestWithSeries in backtest-engine.ts.

import * as XLSX from "xlsx";
import type { Bar } from "./market-data";
import type { BacktestOutput } from "./backtest-engine";
import type { MegaScoreSeries } from "./mega-score";
import { effectiveWeight, MEGA_BASELINE, type IndicatorSpec, type WeightMap } from "./mega-indicator";

export type Cell = string | number | null;
export type Row = Cell[];

export interface ExportBands {
  entry: number;
  exit: number;
  /** Bars of trailing smoothing the score went through before the bands checked it. */
  smooth: number;
}

export interface BacktestExportInput {
  run: BacktestOutput;
  bars: Bar[];
  series: MegaScoreSeries;
  /** The score after the strategy's smoothing — the series the bands/velocity checked. */
  signalScores: number[];
  weights?: WeightMap;
  /** Buy/exit bands when the strategy trades the score; null for the others. */
  bands: ExportBands | null;
  /** Overrides applied by the user, for the provenance rows. */
  overrideCount?: number;
  generatedAt?: string;
}

const fmtNum = (v: number | null | undefined, digits = 2): Cell =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

/** Cells are numbers when they are numbers: blanks stay blank, never 0. */
const num = (v: number | null | undefined): Cell =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

const sheetNameFor = (run: BacktestOutput): string => {
  const unit = run.summary.barUnit;
  const label =
    unit === "day" ? "daily" : unit === "week" ? "weekly" : unit === "month" ? "monthly" : `${run.summary.barMinutes}-minute`;
  return `Bars (${label})`.slice(0, 31);
};

const unitLabel = (run: BacktestOutput): string => {
  const unit = run.summary.barUnit;
  if (unit === "day") return "daily bars";
  if (unit === "week") return "weekly bars";
  if (unit === "month") return "monthly bars";
  return `${run.summary.barMinutes}-minute bars`;
};

/** Header for an indicator column: readable, and unique per spec id. */
const specHeader = (spec: IndicatorSpec): string => `${spec.name} (${spec.id})`;

export const DAILY_HEADERS: string[] = [
  "Date",
  "Open",
  "High",
  "Low",
  "Close",
  "Change (close - open)",
  "Change % (close vs open)",
  "Previous close",
  "Change vs previous close",
  "Change % vs previous close",
  "Volume",
  "Mega Score",
  "Mega Score (signal)",
  "Mega zone",
  "In market",
  "Trade action",
  "Equity",
  "Benchmark (indexed 100)",
  "Drawdown %",
];

/** One row per bar — the sheet most questions about a backtest are answered on. */
export function dailyBarRows(input: BacktestExportInput): Row[] {
  const { run, bars, series, signalScores, bands } = input;
  const equity = new Map(run.equityCurve.map((p) => [p.date, p]));
  const tradeByDate = new Map<string, string>();
  for (const t of run.trades) {
    tradeByDate.set(t.entryDate, `Entry #${t.id}`);
    if (t.exitDate) {
      const previous = tradeByDate.get(t.exitDate);
      tradeByDate.set(t.exitDate, previous ? `${previous} / Exit #${t.id}` : `Exit #${t.id}`);
    }
  }

  const rows: Row[] = [DAILY_HEADERS];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prev = i > 0 ? bars[i - 1].close : null;
    const point = equity.get(b.date);
    const score = series.score[i];
    const signal = signalScores[i];
    let zone: string | null = null;
    if (bands) {
      const reading = Number.isFinite(signal) ? signal : score;
      if (Number.isFinite(reading)) {
        zone = reading >= bands.entry ? "Buy zone" : reading < bands.exit ? "Exit zone" : "Hold zone";
      }
    }
    rows.push([
      b.date,
      num(b.open),
      num(b.high),
      num(b.low),
      num(b.close),
      fmtNum(b.close - b.open, 4),
      b.open !== 0 ? fmtNum(((b.close - b.open) / b.open) * 100, 4) : null,
      num(prev),
      prev === null ? null : fmtNum(b.close - prev, 4),
      prev === null || prev === 0 ? null : fmtNum(((b.close - prev) / prev) * 100, 4),
      num(b.volume),
      num(score),
      num(signal),
      zone,
      point ? (point.invested ? 1 : 0) : null,
      tradeByDate.get(b.date) ?? null,
      point ? fmtNum(point.equity, 2) : null,
      point ? fmtNum(point.benchmark, 2) : null,
      point ? fmtNum(point.drawdownPct, 4) : null,
    ]);
  }
  return rows;
}

/** One column per indicator, its 0-100 score. Warm-up = blank. */
export function indicatorScoreRows(input: BacktestExportInput): Row[] {
  const { bars, series } = input;
  const specs = series.specs ?? [];
  const header: Row = ["Date", "Close", ...specs.map(specHeader)];
  const rows: Row[] = [header];
  for (let i = 0; i < bars.length; i++) {
    rows.push([bars[i].date, num(bars[i].close), ...specs.map((s) => num(series.indicators[s.id]?.[i]))]);
  }
  return rows;
}

/** The same grid in each indicator's own units (RSI points, % distance, ratio …). */
export function indicatorRawRows(input: BacktestExportInput): Row[] {
  const { bars, series } = input;
  const specs = series.specs ?? [];
  const header: Row = ["Date", "Close", ...specs.map(specHeader)];
  const rows: Row[] = [header];
  for (let i = 0; i < bars.length; i++) {
    rows.push([bars[i].date, num(bars[i].close), ...specs.map((s) => num(series.raw[s.id]?.[i]))]);
  }
  return rows;
}

/** What each of those columns is, and how much it counted towards the composite. */
export function indicatorCatalogueRows(input: BacktestExportInput): Row[] {
  const { series, weights } = input;
  const specs = series.specs ?? [];
  const rows: Row[] = [
    ["ID", "Name", "Category", "Unit", "Direction", "Thresholds", "Weight", "In composite", "Used in this run", "Formula", "Description"],
  ];
  for (const spec of specs) {
    const weight = effectiveWeight(spec, weights);
    rows.push([
      spec.id,
      spec.name,
      spec.category,
      spec.unit,
      spec.direction,
      spec.thresholds.join(" / "),
      weight,
      weight > 0 ? "Yes" : "No",
      "Yes",
      spec.formula,
      spec.description,
    ]);
  }
  return rows;
}

export function tradeRows(run: BacktestOutput): Row[] {
  const rows: Row[] = [
    [
      "#",
      "Entry date",
      "Exit date",
      "Bars held",
      "Shares",
      "Entry price",
      "Exit price",
      "Return %",
      "P&L",
      "Exit reason",
      "Score at entry signal",
      "Entry signal date",
      "Score on entry fill day",
      "Score at exit signal",
      "Exit signal date",
      "Score on exit fill day",
    ],
  ];
  for (const t of run.trades) {
    rows.push([
      t.id,
      t.entryDate,
      t.exitDate ?? "open at end of test",
      t.bars,
      t.shares,
      fmtNum(t.entryPrice, 4),
      t.exitPrice === null ? null : fmtNum(t.exitPrice, 4),
      fmtNum(t.returnPct, 4),
      fmtNum(t.pnl, 2),
      t.reason,
      num(t.entryScore),
      t.entrySignalDate ?? null,
      num(t.entryFillScore),
      num(t.exitScore),
      t.exitSignalDate ?? null,
      num(t.exitFillScore),
    ]);
  }
  return rows;
}

export function equityRows(run: BacktestOutput): Row[] {
  const rows: Row[] = [["Date", "Equity", "Benchmark (indexed 100)", "Drawdown %", "Close", "In market"]];
  for (const p of run.equityCurve) {
    rows.push([p.date, fmtNum(p.equity, 2), fmtNum(p.benchmark, 2), fmtNum(p.drawdownPct, 4), fmtNum(p.price, 4), p.invested ? 1 : 0]);
  }
  return rows;
}

export function monthlyRows(run: BacktestOutput): Row[] {
  const rows: Row[] = [["Month", "Return %"]];
  for (const m of run.monthlyReturns) rows.push([m.month, fmtNum(m.ret, 4)]);
  return rows;
}

/** What was run, on which data, with which weights — before any figure. */
export function summaryRows(input: BacktestExportInput): Row[] {
  const { run, series, weights, bands, overrideCount, generatedAt } = input;
  const s = run.summary;
  const scored = (series.specs ?? []).length;
  const contributing = (series.specs ?? []).filter((spec) => effectiveWeight(spec, weights) > 0).length;
  const runType = run.dataSource === "cache" ? "cached price history" : "Yahoo Finance (fetched for this run)";
  const rows: Row[] = [["Field", "Value"]];

  const put = (field: string, value: Cell) => rows.push([field, value]);

  put("Exported", generatedAt ?? new Date().toISOString());
  put("Ticker", run.symbol);
  put("Company", run.meta.name);
  put("Exchange", run.meta.exchange);
  put("Currency", run.meta.currency);
  put("Strategy", run.strategyName);
  put("Strategy id", run.strategyId);
  put("Frequency", unitLabel(run));
  put("Bar length (minutes)", s.barMinutes);
  put("Bars per year (annualisation)", s.periodsPerYear);
  put("Bars in this run", run.bars);
  put("First bar", run.dateFrom);
  put("Last bar", run.dateTo);
  put("Price data", runType);
  put("History requested (years)", run.config.years);
  put("Initial capital", run.config.initialCapital);
  put("Commission (bps)", run.config.commissionBps);
  put("Slippage (bps)", run.config.slippageBps);
  put("Position size (% of equity)", run.config.positionPct);
  put("Benchmark", run.config.benchmarkSymbol?.toUpperCase() || `${run.symbol} buy & hold`);
  put("Indicators scored", scored);
  put("Indicators in the composite (weight > 0)", contributing);
  put("Weights", weights && Object.keys(weights).length > 0 ? "your saved Mega Indicator weights" : "app defaults");
  put("Per-indicator edits applied", overrideCount ?? 0);
  put(
    "Composite bands",
    bands
      ? `buy at score >= ${bands.entry}, sell below ${bands.exit}, score smoothed over ${bands.smooth} bar${bands.smooth === 1 ? "" : "s"} (baseline ${MEGA_BASELINE.entry}/${MEGA_BASELINE.exit})`
      : "not used by this strategy (the composite is still exported per bar)",
  );
  if (run.config.stopLossPct) put("Stop loss", `${run.config.stopLossPct}%`);
  if (run.config.takeProfitPct) put("Take profit", `${run.config.takeProfitPct}%`);
  if (run.config.maxTrades) put("Max entries", run.config.maxTrades);

  const metrics: [string, Cell][] = [
    ["Final equity", fmtNum(s.finalEquity, 2)],
    ["Total return %", fmtNum(s.totalReturnPct, 4)],
    ["Benchmark return % (buy & hold)", fmtNum(s.benchmarkReturnPct, 4)],
    ["CAGR %", fmtNum(s.cagr, 4)],
    ["Sharpe", fmtNum(s.sharpe, 4)],
    ["Sortino", fmtNum(s.sortino, 4)],
    ["Calmar", fmtNum(s.calmar, 4)],
    ["Max drawdown %", fmtNum(s.maxDrawdownPct, 4)],
    ["Benchmark max drawdown %", fmtNum(s.benchmarkMaxDrawdownPct, 4)],
    ["Annual volatility %", fmtNum(s.risk.annualVolPct, 4)],
    ["Benchmark volatility %", fmtNum(s.risk.benchmarkVolPct, 4)],
    ["Beta", fmtNum(s.risk.beta, 4)],
    ["Downside deviation %", fmtNum(s.risk.downsideDevPct, 4)],
    ["Ulcer index", fmtNum(s.risk.ulcerIndex, 4)],
    ["Risk factor (0-100)", fmtNum(s.risk.riskFactor, 1)],
    ["Risk level", s.risk.riskLevel],
    ["Closed trades", s.totalTrades],
    ["Trades per year", fmtNum(s.tradesPerYear, 3)],
    ["Win rate %", fmtNum(s.winRate, 2)],
    ["Profit factor", fmtNum(s.profitFactor, 3)],
    ["Average trade %", fmtNum(s.avgTradeReturnPct, 3)],
    ["Best trade %", fmtNum(s.bestTradePct, 3)],
    ["Worst trade %", fmtNum(s.worstTradePct, 3)],
    ["Average bars held", fmtNum(s.avgBarsHeld, 2)],
    ["Time in market %", fmtNum(s.timeInMarketPct, 2)],
  ];
  rows.push(["", ""], ["Metrics", "Value"]);
  for (const [label, value] of metrics) put(label, value);

  if (run.minTrades !== null) {
    rows.push(["", ""], ["Quality floor", run.meetsMinTrades ? `met (${run.minTrades})` : `NOT met (${run.minTrades})`]);
  }
  if (series.customErrors.length > 0) {
    rows.push(["", ""], ["Indicator warnings", ""]);
    for (const warning of series.customErrors) put("warning", warning);
  }
  if (run.warnings.length > 0) {
    rows.push(["", ""], ["Run warnings", ""]);
    for (const warning of run.warnings) put("warning", warning);
  }
  rows.push(
    ["", ""],
    ["How to read", "A blank cell is a warm-up reading (the indicator needs more bars) - it is NOT zero."],
    ["How to read", "Mega Score = the composite 0-100. Mega Score (signal) is that score after the strategy's smoothing, i.e. what its bands actually checked."],
    ["How to read", "Change (close - open) is the bar's own move; change vs previous close is the close-to-close move (the first bar has none)."],
  );
  return rows;
}

/** Sheet list, in the order Excel opens them. Empty sheets are dropped. */
export interface WorkbookSheet {
  name: string;
  rows: Row[];
}

export function backtestSheets(input: BacktestExportInput): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [
    { name: "Summary", rows: summaryRows(input) },
    { name: sheetNameFor(input.run), rows: dailyBarRows(input) },
    { name: "Indicator scores", rows: indicatorScoreRows(input) },
    { name: "Indicator raw", rows: indicatorRawRows(input) },
    { name: "Indicator catalogue", rows: indicatorCatalogueRows(input) },
    { name: "Trades", rows: tradeRows(input.run) },
    { name: "Equity", rows: equityRows(input.run) },
    { name: "Monthly returns", rows: monthlyRows(input.run) },
  ];
  // A sheet with only its header says nothing; skip it rather than shipping a stub.
  return sheets.filter((sheet) => sheet.rows.length > 1 || sheet.name === "Summary" || sheet.name === "Indicator catalogue");
}

export function buildBacktestWorkbook(input: BacktestExportInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const sheet of backtestSheets(input)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31));
  }
  return wb;
}

/** `backtest-AAPL-mega_score-2026-10-28.xlsx` */
export function backtestFileName(run: BacktestOutput, at = new Date()): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `backtest-${safe(run.symbol)}-${safe(run.strategyId)}-${at.toISOString().slice(0, 10)}.xlsx`;
}
