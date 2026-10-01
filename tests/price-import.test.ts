import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  parsePriceWorkbook,
  parseDateCell2,
  resolveDateSeries,
  parseNum,
  inferSymbol,
} from "../src/lib/price-import";

function buildWorkbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, matrix] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const HEADERS = ["Date", "Close/Last", "Volume", "Open", "High", "Low", "Change", "RSI", "Trading Sig."];

// ─── parseNum ───────────────────────────────────────────────────
describe("parseNum", () => {
  it("parses plain, thousands-separated, and comma-decimal numbers", () => {
    expect(parseNum(46.26)).toBeCloseTo(46.26);
    expect(parseNum("3,646,554.00")).toBe(3646554);
    expect(parseNum("1.234,56")).toBeCloseTo(1234.56);
    expect(parseNum("46,26")).toBeCloseTo(46.26);
    expect(parseNum("(1,234.56)")).toBeCloseTo(-1234.56);
    expect(parseNum(" 46.26 ")).toBeCloseTo(46.26);
  });

  it("returns null for junk", () => {
    expect(parseNum("")).toBeNull();
    expect(parseNum("-")).toBeNull();
    expect(parseNum("n/a")).toBeNull();
    expect(parseNum(null)).toBeNull();
  });
});

// ─── dates ──────────────────────────────────────────────────────
describe("parseDateCell2", () => {
  it("handles ISO, month names, and Excel serials unambiguously", () => {
    expect(parseDateCell2("2026-09-16").iso).toBe("2026-09-16");
    expect(parseDateCell2("16 Sep 2026").iso).toBe("2026-09-16");
    expect(parseDateCell2("Sep 16, 2026").iso).toBe("2026-09-16");
    expect(parseDateCell2(new Date(Date.UTC(2026, 8, 16))).iso).toBe("2026-09-16");
    expect(parseDateCell2(46281).iso).toBe("2026-09-16"); // Excel serial
  });

  it("returns both readings for ambiguous d/m vs m/d", () => {
    const p = parseDateCell2("9/16/26");
    expect(p.mdy).toBe("2026-09-16");
    expect(p.dmy).toBeUndefined(); // day 16 invalid as month
    const p2 = parseDateCell2("11/9/26");
    expect(p2.mdy).toBe("2026-11-09");
    expect(p2.dmy).toBe("2026-09-11");
  });
});

describe("resolveDateSeries (mixed M/D and D/M)", () => {
  it("anchors ambiguous cells to the nearest unambiguous neighbour", () => {
    // "9/16/26" forces M/D; later "11/9/26" must then read as 11 Sep.
    const parsed = ["9/16/26", "9/15/2026", "9/14/2026", "11/9/26", "10/9/26", "9/9/26"].map(parseDateCell2);
    const out = resolveDateSeries(parsed);
    expect(out).toEqual([
      "2026-09-16",
      "2026-09-15",
      "2026-09-14",
      "2026-09-11",
      "2026-09-10",
      "2026-09-09",
    ]);
  });

  it("works when the series runs the other way", () => {
    const parsed = ["9/9/26", "10/9/26", "11/9/26", "14/9/26", "9/16/26"].map(parseDateCell2);
    const out = resolveDateSeries(parsed);
    expect(out).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-14",
      "2026-09-16",
    ]);
  });

  it("defaults to M/D when there is no anchor at all", () => {
    const out = resolveDateSeries(["3/4/26", "4/4/26", "5/4/26"].map(parseDateCell2));
    expect(out).toEqual(["2026-03-04", "2026-04-04", "2026-05-04"]);
  });
});

// ─── symbol inference ───────────────────────────────────────────
describe("inferSymbol", () => {
  it("prefers a real ticker sheet name", () => {
    expect(inferSymbol("NVDA", "whatever.xlsx")).toBe("NVDA");
  });

  it("falls back to the first meaningful file-name token", () => {
    expect(inferSymbol("Sheet1", "tehnival analysis 19926.xlsx")).toBe("TEHNIVAL");
    expect(inferSymbol("Sheet2", "AAPL-daily.xlsx")).toBe("AAPL");
  });

  it("never returns generic words", () => {
    expect(inferSymbol("Data", "daily export.xlsx")).toBe("IMPORT");
  });
});

// ─── full workbook parse ────────────────────────────────────────
describe("parsePriceWorkbook", () => {
  it("parses the full technical-analysis layout (Nasdaq-style headers + indicator columns)", () => {
    const buf = buildWorkbook({
      Sheet1: [
        HEADERS,
        ["9/16/26", "46.26", "3,646,554.00", "47.18", "47.48", "46.12", "", "", ""],
        ["09/15/2026", "46.52", "3,833,060.00", "47.25", "47.58", "46.56", "-0.26", "39.62", ""],
        ["11/9/26", "48.26", "3,864,579.00", "49.08", "50.24", "48.18", "-1.31", "40.71", ""],
      ],
      Sheet2: [
        ["Date", "Close/Last", "Volume", "Open", "High", "Low", "ER", "R.Kernel Trend", "SMA‑10", "Trading Signal"],
        ["9/16/26", "46.26", "3,646,554.00", "47.18", "47.48", "46.12", "0.1", "46.26", "49.08", "SELL"],
        ["09/15/2026", "46.52", "3,833,060.00", "47.25", "47.58", "46.56", "0.2", "46.33", "49.55", "BUY"],
      ],
    });
    const wb = parsePriceWorkbook(buf, "tehnival analysis 19926.xlsx");

    // 3 unique dates total: Sheet2's 9/16 and 09/15 rows duplicate Sheet1's and
    // merge into them (richer row wins); 11/9/26 resolves to Sep 11 via anchors.
    expect(wb.totalRows).toBe(3);
    expect(wb.sheets.map((s) => s.symbol)).toEqual(["TEHNIVAL", "TEHNIVAL"]);

    const s1 = wb.rows.filter((r) => r.date <= "2026-09-16").sort((a, b) => (a.date < b.date ? -1 : 1));
    const sep15 = s1.find((r) => r.date === "2026-09-15");
    expect(sep15).toBeDefined();
    expect(sep15!.close).toBeCloseTo(46.52);
    expect(sep15!.open).toBeCloseTo(47.25);
    expect(sep15!.volume).toBe(3833060);

    // "11/9/26" resolved against M/D anchors → 11 Sep, not 9 Nov.
    expect(wb.rows.some((r) => r.date === "2026-09-11" && r.close === 48.26)).toBe(true);
    expect(wb.rows.some((r) => r.date === "2026-11-09")).toBe(false);
  });

  it("merges duplicate symbol+date rows across sheets keeping the richer row", () => {
    const buf = buildWorkbook({
      Prices: [
        ["Date", "Close", "Volume", "Open", "High", "Low"],
        ["2026-09-15", "46.52", "", "46.52", "46.52", "46.52"],
        ["2026-09-16", "47.00", "", "47.00", "47.00", "47.00"],
      ],
      Copy: [
        ["Date", "Close", "Volume", "Open", "High", "Low"],
        ["2026-09-15", "46.52", "12345", "46.50", "46.90", "46.40"],
      ],
    });
    // 3 unique symbol+date keys — the Copy sheet's 09/15 row is richer (real
    // volume, full OHLC) so it replaces the Prices sheet's flat row.
    const wb = parsePriceWorkbook(buf, "TEHNIVAL.xlsx");
    expect(wb.totalRows).toBe(3);
    const merged = wb.rows.find((r) => r.date === "2026-09-15");
    expect(merged!.volume).toBe(12345); // richer row won
  });

  it("guesses columns when there is no header row", () => {
    const buf = buildWorkbook({
      PLTR: [
        [new Date(Date.UTC(2026, 0, 5)), 62.1, 63.0, 61.8, 62.5, 5100000],
        [new Date(Date.UTC(2026, 0, 6)), 62.5, 63.4, 62.0, 63.1, 4800000],
        [new Date(Date.UTC(2026, 0, 7)), 63.1, 64.0, 62.9, 63.8, 5200000],
        [new Date(Date.UTC(2026, 0, 8)), 63.8, 64.2, 63.2, 63.5, 4900000],
        [new Date(Date.UTC(2026, 0, 9)), 63.5, 64.1, 63.0, 64.0, 5000000],
      ],
    });
    const wb = parsePriceWorkbook(buf, "portfolio.xlsx");
    expect(wb.sheets[0]?.symbol).toBe("PLTR");
    expect(wb.totalRows).toBe(5);
    const first = wb.rows[0];
    expect(first.open).toBeCloseTo(62.1);
    expect(first.high).toBeCloseTo(63.0);
    expect(first.low).toBeCloseTo(61.8);
    expect(first.close).toBeCloseTo(62.5);
    expect(first.volume).toBe(5100000);
  });

  it("survives a workbook with no price-looking sheet", () => {
    const buf = buildWorkbook({ Notes: [["hello"], ["world"]] });
    const wb = parsePriceWorkbook(buf, "misc.xlsx");
    expect(wb.totalRows).toBe(0);
    expect(wb.warnings.length).toBeGreaterThan(0);
  });
});
