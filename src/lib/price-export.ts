// ─── Price-history export: every day, every indicator, one workbook ───
//
// The backtest export (lib/backtest-export.ts) describes ONE run: its window,
// its strategy, its equity curve. This is the other question — "give me the
// whole price history for this ticker, with all the indicator readings" — so it
// carries every bar the data source returned, not a backtest window:
//
//   Summary            – what was exported, from which source, over which span
//   Daily prices       – one row per trading day: OHLCV, both change readings,
//                        dollar volume, intraday range, 52-week high/low and
//                        the distance to each, plus the Mega Score
//   Indicator scores   – one column per indicator, its 0-100 score per day
//   Indicator raw      – the same grid in each indicator's own units
//   Indicator catalogue– id, name, unit, direction, weight, formula, description
//   Indicator coverage – readings per indicator, its leading warm-up and the
//                        first/last day it could answer (so a blank column is
//                        explainable rather than mysterious)
//
// The same accuracy rules as the backtest workbook apply:
//   · a warm-up reading is a BLANK cell, never 0 — 0 is a real score;
//   · every price and value is written as a NUMBER, so Excel can sum and chart it;
//   · the series is computed from the SAME bars and the same weights/edits the
//     Mega Indicator page is showing.

import * as XLSX from "xlsx";
import type { Bar } from "./market-data";
import type { MegaScoreSeries } from "./mega-score";
import { effectiveWeight, type IndicatorSpec, type WeightMap } from "./mega-indicator";
import { rollingMax, rollingMin } from "./ta";

export type Cell = string | number | null;
export type Row = Cell[];

export interface PriceExportMeta {
  name?: string | null;
  exchange?: string | null;
  currency?: string | null;
  source?: string | null;
}

export interface PriceExportInput {
  symbol: string;
  meta?: PriceExportMeta | null;
  /** Every bar the source returned, oldest → newest. */
  bars: Bar[];
  /** The causal series computed over those exact bars. */
  series: MegaScoreSeries;
  weights?: WeightMap;
  /** Window the caller asked for; used to explain a shorter series honestly. */
  yearsRequested?: number;
  /** Per-indicator edits the series was computed with. */
  overrideCount?: number;
  customCount?: number;
  generatedAt?: string;
}

const fmtNum = (v: number | null | undefined, digits = 4): Cell =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

/** Cells are numbers when they are numbers: blanks stay blank, never 0. */
const num = (v: number | null | undefined): Cell =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/** Header for an indicator column: readable, and unique per spec id. */
const specHeader = (spec: IndicatorSpec): string => `${spec.name} (${spec.id})`;

export const PRICE_HEADERS: string[] = [
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
  "Dollar volume (close x volume)",
  "Intraday range %",
  "52-week high (close)",
  "52-week low (close)",
  "Distance from 52-week high %",
  "Distance above 52-week low %",
  "Mega Score",
  "Indicators with a reading",
];

/**
 * One row per trading day — the sheet the "all days" request is answered on.
 * Weekends and holidays have no bar because there was no session; nothing is
 * forward-filled. The 52-week columns stay blank until 252 bars exist, because
 * a partial year is not a 52-week reading.
 */
export function dailyPriceRows(input: PriceExportInput): Row[] {
  const { bars, series } = input;
  const closes = bars.map((b) => b.close);
  const hi52 = rollingMax(closes, 252);
  const lo52 = rollingMin(closes, 252);
  const specs = series.specs ?? [];
  const rows: Row[] = [PRICE_HEADERS];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prev = i > 0 ? bars[i - 1].close : null;
    // How many indicators could answer on this bar. The composite reads its
    // documented neutral 50 when none can, so this column is what tells a real
    // 50 apart from "nothing was ready yet".
    const ready = specs.filter((spec) => Number.isFinite(series.indicators[spec.id]?.[i])).length;
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
      fmtNum(b.close * b.volume, 2),
      b.close !== 0 ? fmtNum(((b.high - b.low) / b.close) * 100, 4) : null,
      num(hi52[i]),
      num(lo52[i]),
      Number.isFinite(hi52[i]) && hi52[i] > 0
        ? fmtNum(((b.close - hi52[i]) / hi52[i]) * 100, 4)
        : null,
      Number.isFinite(lo52[i]) && lo52[i] > 0
        ? fmtNum(((b.close - lo52[i]) / lo52[i]) * 100, 4)
        : null,
      num(series.score[i]),
      ready,
    ]);
  }
  return rows;
}

/** One column per indicator, its 0-100 score per day. Warm-up = blank. */
export function indicatorScoreRows(input: PriceExportInput): Row[] {
  const { bars, series } = input;
  const specs = series.specs ?? [];
  const rows: Row[] = [["Date", "Close", ...specs.map(specHeader)]];
  for (let i = 0; i < bars.length; i++) {
    rows.push([
      bars[i].date,
      num(bars[i].close),
      ...specs.map((s) => num(series.indicators[s.id]?.[i])),
    ]);
  }
  return rows;
}

/** The same grid in each indicator's own units (RSI points, %, ratios …). */
export function indicatorRawRows(input: PriceExportInput): Row[] {
  const { bars, series } = input;
  const specs = series.specs ?? [];
  const rows: Row[] = [["Date", "Close", ...specs.map(specHeader)]];
  for (let i = 0; i < bars.length; i++) {
    rows.push([
      bars[i].date,
      num(bars[i].close),
      ...specs.map((s) => num(series.raw[s.id]?.[i])),
    ]);
  }
  return rows;
}

/** What each of those columns is, and how much it counted towards the composite. */
export function indicatorCatalogueRows(input: PriceExportInput): Row[] {
  const { series, weights } = input;
  const specs = series.specs ?? [];
  const rows: Row[] = [
    ["ID", "Name", "Category", "Unit", "Direction", "Thresholds", "Weight", "In composite", "Formula", "Description"],
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
      spec.formula,
      spec.description,
    ]);
  }
  return rows;
}

/**
 * Per-indicator coverage: how many days it could answer, how many leading bars
 * it needed first, and the first/last day it produced a reading. An export with
 * a mostly-blank column says here exactly why that column is blank.
 */
export function indicatorCoverageRows(input: PriceExportInput): Row[] {
  const { bars, series } = input;
  const specs = series.specs ?? [];
  const rows: Row[] = [
    ["ID", "Name", "Unit", "Readings", "Leading warm-up bars", "First reading", "Last reading"],
  ];
  for (const spec of specs) {
    const values = series.raw[spec.id] ?? [];
    let readings = 0;
    let warmUp = 0;
    let first: string | null = null;
    let last: string | null = null;
    for (let i = 0; i < bars.length; i++) {
      if (Number.isFinite(values[i])) {
        readings++;
        if (first === null) first = bars[i].date;
        last = bars[i].date;
      } else if (first === null) {
        warmUp++;
      }
    }
    rows.push([spec.id, spec.name, spec.unit, readings, warmUp, first, last]);
  }
  return rows;
}

/** What was exported, from where, over which span — before any figure. */
export function priceSummaryRows(input: PriceExportInput): Row[] {
  const { symbol, meta, bars, series, weights, yearsRequested, overrideCount, customCount, generatedAt } = input;
  const rows: Row[] = [["Field", "Value"]];
  const put = (field: string, value: Cell) => rows.push([field, value]);

  const specs = series.specs ?? [];
  const contributing = specs.filter((spec) => effectiveWeight(spec, weights) > 0).length;
  const first = bars[0]?.date ?? null;
  const last = bars[bars.length - 1]?.date ?? null;
  const spanYears =
    first && last
      ? (new Date(`${last}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / (365.25 * 86400_000)
      : null;

  put("Exported", generatedAt ?? new Date().toISOString());
  put("Ticker", symbol);
  put("Company", meta?.name ?? null);
  put("Exchange", meta?.exchange ?? null);
  put("Currency", meta?.currency ?? null);
  put("Price source", meta?.source ?? "cached price history");
  put("Frequency", "daily bars (one row per trading session)");
  put("First bar", first);
  put("Last bar", last);
  put("Bars (trading days)", bars.length);
  put("Years covered", fmtNum(spanYears, 2));
  put("Years requested", yearsRequested ?? null);
  put("Indicators scored", specs.length);
  put("Indicators in the composite (weight > 0)", contributing);
  put("Weights", weights && Object.keys(weights).length > 0 ? "the Mega Indicator weights you have saved" : "app defaults");
  put("Per-indicator edits applied", overrideCount ?? 0);
  put("Custom indicators", customCount ?? 0);

  if (series.customErrors.length > 0) {
    rows.push(["", ""], ["Indicator warnings", ""]);
    for (const warning of series.customErrors) put("warning", warning);
  }

  rows.push(
    ["", ""],
    ["How to read", "One row per trading day. Weekends and market holidays have no bar because there was no session — nothing is forward-filled or invented."],
    ["How to read", "A blank indicator cell is a warm-up reading (that indicator needs more bars) — it is NOT zero. 0 is a real Mega Score and a real indicator value."],
    ["How to read", "Mega Score is the composite 0-100. On a bar where no indicator has a reading yet the engine prints its documented neutral 50 — read the \"Indicators with a reading\" column beside it: 0 there means that 50 is neutral-by-default, not a measured reading."],
    ["How to read", "Indicator raw holds each indicator's own units; Indicator scores holds the same reading normalised to 0-100 by its thresholds. The catalogue sheet spells out both."],
    ["How to read", "Prices are exactly what the source stored. Yahoo/FX history is dividend-adjusted; an imported workbook keeps its own basis — the summary names the source."],
  );
  if (yearsRequested && spanYears !== null && spanYears < yearsRequested - 0.5) {
    rows.push([
      "How to read",
      `You asked for ${yearsRequested} years but the source has ${fmtNum(spanYears, 2)} — this series starts where the ticker's history starts, it was not padded.`,
    ]);
  }
  return rows;
}

/** Sheet list, in the order Excel opens them. Empty sheets are dropped. */
export interface WorkbookSheet {
  name: string;
  rows: Row[];
}

export function priceSheets(input: PriceExportInput): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [
    { name: "Summary", rows: priceSummaryRows(input) },
    { name: "Daily prices", rows: dailyPriceRows(input) },
    { name: "Indicator scores", rows: indicatorScoreRows(input) },
    { name: "Indicator raw", rows: indicatorRawRows(input) },
    { name: "Indicator catalogue", rows: indicatorCatalogueRows(input) },
    { name: "Indicator coverage", rows: indicatorCoverageRows(input) },
  ];
  // A sheet with only its header says nothing; skip it rather than shipping a stub.
  return sheets.filter(
    (sheet) =>
      sheet.rows.length > 1 ||
      sheet.name === "Summary" ||
      sheet.name === "Indicator catalogue",
  );
}

export function buildPriceWorkbook(input: PriceExportInput): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const sheet of priceSheets(input)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31));
  }
  return wb;
}

/** `price-history-AAPL-2026-10-30.xlsx` */
export function priceFileName(symbol: string, at = new Date()): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `price-history-${safe(symbol.toUpperCase())}-${at.toISOString().slice(0, 10)}.xlsx`;
}
