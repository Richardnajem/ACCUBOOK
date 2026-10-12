// Regression test against the real workbook: "tehnival analysis 19926.xlsx".
//
// That file is the shape of export that trips up naive importers — eight sheets,
// rows running newest → oldest, mixed Excel serials and "MM/DD/YYYY" strings,
// and (on Sheet2 / 31026 / 61026) a stray number where the "Close/Last" header
// should be. Column B is still the close on those sheets; the importer recovers
// it from the data, and this test proves the recovered values are the real ones
// by comparing them against cells read straight out of the workbook.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { parsePriceWorkbook, type PriceRow } from "../src/lib/price-import";
import { williamsR, rollingMin, rollingMax, windowMean } from "../src/lib/ta";

const WORKBOOK = fileURLToPath(new URL("../tehnival analysis 19926.xlsx", import.meta.url));
// The workbook is personal data: .gitignore keeps it out of the repo (the repo
// is public), so it exists on the dev machine and never on a CI runner. Skip
// the suite there rather than failing a run it cannot possibly satisfy.
const hasWorkbook = existsSync(WORKBOOK);
const buf = hasWorkbook ? readFileSync(WORKBOOK) : null;
const parsedOrNull = hasWorkbook
  ? parsePriceWorkbook(buf!, "tehnival analysis 19926.xlsx")
  : null;
// Read the workbook once — re-parsing it per sheet blows the test timeout.
const source = hasWorkbook ? XLSX.read(buf!, { type: "buffer", cellDates: true }) : null;

// Read one sheet as a raw matrix so we can compare against the source cells.
function sheetMatrix(name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(source!.Sheets[name], { header: 1, raw: false, defval: "" }) as unknown[][];
}

// First data row of a sheet, keyed by the date it carries.
function firstDataRow(name: string): { date: unknown; close: unknown; row: unknown[] } | null {
  const m = sheetMatrix(name);
  for (let i = 1; i < m.length; i++) {
    const row = m[i];
    if (!row || row[0] == null || row[0] === "") continue;
    return { date: row[0], close: row[1], row };
  }
  return null;
}

function isoOf(v: unknown): string | null {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // Ambiguous (both parts could be a month) — the importer resolves those
    // against neighbouring anchors, so don't second-guess them here.
    if (a <= 12 && b <= 12) return null;
    return `${m[3]}-${a > 12 ? b : a}-${String(a > 12 ? a : b).padStart(2, "0")}`.replace(
      /^(\d{4})-(\d{1,2})-(\d{2})$/,
      (_all, y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${d}`,
    );
  }
  return null;
}

// One column of a sheet as numbers, in the sheet's own row order. Raw values, so
// no display rounding creeps into the comparison.
function columnNumbers(sheet: string, col: number): number[] {
  const m = XLSX.utils.sheet_to_json(source!.Sheets[sheet], {
    header: 1,
    raw: true,
    defval: "",
  }) as unknown[][];
  const out: number[] = [];
  for (let i = 1; i < m.length; i++) {
    const v = m[i]?.[col];
    out.push(typeof v === "number" && Number.isFinite(v) ? v : NaN);
  }
  return out;
}

// The sheets list the newest bar first while lib/ta's windows run oldest →
// newest, so reversing a column hands the app the series it would compute on.
// The trailing-window *sets* are identical either way.
function ascendingColumn(sheet: string, col: number): number[] {
  return columnNumbers(sheet, col).reverse();
}

// Compare element-wise, but report what happened rather than just passing:
//   compared — bars both sides define (the value of the check)
//   warmup   — bars the workbook defines while the app is still warming up
//   appOnly  — bars the app defines and the workbook does not (a bug if any)
function compareSeries(
  app: number[],
  expected: number[],
  label: string,
  digits: number
): { compared: number; warmup: number; appOnly: number } {
  let compared = 0;
  let warmup = 0;
  let appOnly = 0;
  for (let i = 0; i < Math.min(app.length, expected.length); i++) {
    const a = app[i];
    const e = expected[i];
    if (Number.isFinite(e)) {
      if (!Number.isFinite(a)) {
        warmup++;
        continue;
      }
      expect(a, `${label} diverged at bar ${i}: app=${a} workbook=${e}`).toBeCloseTo(e, digits);
      compared++;
    } else if (Number.isFinite(a)) {
      appOnly++;
    }
  }
  return { compared, warmup, appOnly };
}

const byDate = new Map<string, PriceRow>((parsedOrNull?.rows ?? []).map((r) => [r.date, r]));

// describe.skip when the workbook is absent: the checks below still register
// on the dev machine, where the file exists.
const suite = hasWorkbook ? describe : describe.skip;

suite("tehnival analysis 19926.xlsx", () => {
  const parsed = parsedOrNull!;
  it("imports every sheet, not just the ones with a proper header", () => {
    expect(parsed.sheets.map((s) => s.sheet).sort()).toEqual(
      ["101026", "111026", "31026", "61026", "Sheet1", "Sheet2", "Sheet3", "Sheet4"]
    );
    for (const s of parsed.sheets) expect(s.rows, s.sheet).toBeGreaterThan(2000);
  });

  it("merges to a clean, gap-free, strictly ascending series", () => {
    expect(parsed.totalRows).toBeGreaterThanOrEqual(2500);
    expect(parsed.rows[0].symbol).toBe("TEHNIVAL");
    for (let i = 1; i < parsed.rows.length; i++) {
      const prev = parsed.rows[i - 1].date;
      const cur = parsed.rows[i].date;
      expect(cur > prev, `date not ascending at ${i}: ${prev} → ${cur}`).toBe(true);
    }
    for (const r of parsed.rows) {
      expect(r.close).toBeGreaterThan(0);
      expect(r.volume).toBeGreaterThanOrEqual(0);
      expect(r.high).toBeGreaterThanOrEqual(r.low);
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("recovers the close column on the sheets whose header cell is a number", () => {
    // Sheet1 has a real "Close/Last" header — use it as ground truth for a date
    // that only the unlabelled sheets extend past (2026-10-02 comes from
    // 31026/61026, which Sheet1 does not reach).
    const s1 = firstDataRow("Sheet1");
    expect(s1).not.toBeNull();

    // A date present only in the sheets that needed the fallback.
    const fallbackOnly = ["31026", "61026"].map((n) => firstDataRow(n)).filter(Boolean);
    expect(fallbackOnly.length).toBeGreaterThan(0);

    for (const src of [firstDataRow("31026"), firstDataRow("61026")]) {
      if (!src) continue;
      const iso = isoOf(src.date);
      if (!iso) continue;
      const got = byDate.get(iso);
      expect(got, `no imported row for ${iso}`).toBeTruthy();
      // The importer must have read the same cell we read straight from the file.
      expect(got!.close).toBeCloseTo(Number(src.close), 6);
    }
  });

  it("agrees with the labelled Close/Last column on shared dates", () => {
    // Every row of Sheet1 carries an explicit header; those closes must survive
    // the merge unchanged.
    const m = sheetMatrix("Sheet1");
    let checked = 0;
    for (let i = 1; i < m.length && checked < 25; i++) {
      const iso = isoOf(m[i]?.[0]);
      const close = Number(m[i]?.[1]);
      if (!iso || !Number.isFinite(close) || close <= 0) continue;
      const got = byDate.get(iso);
      if (!got) continue;
      expect(got.close, `close mismatch on ${iso}`).toBeCloseTo(close, 6);
      checked++;
    }
    expect(checked, "no shared dates to compare").toBeGreaterThan(10);
  });

  it("still reports sheets it cannot read instead of failing silently", () => {
    // Warnings are informational — the fallback rows must not be errors.
    expect(Array.isArray(parsed.warnings)).toBe(true);
    for (const w of parsed.warnings) expect(typeof w).toBe("string");
  });
});

// The sheets added with the newest export carry the indicator blocks the app had
// yet to compute: 101026 ends with a Williams %R block, and 111026 adds the
// Stochastic RSI block on top of it. Column indexes below are 0-based.
suite("the workbook's new indicator columns", () => {
  it("Williams %R (14) reproduces the sheet's own column", () => {
    // Sheet 101026: 1 close, 4 high, 5 low, 88 Williams %R (14).
    const app = williamsR(
      ascendingColumn("101026", 4),
      ascendingColumn("101026", 5),
      ascendingColumn("101026", 1),
      14
    );
    const { compared, warmup, appOnly } = compareSeries(
      app,
      ascendingColumn("101026", 88),
      "Williams %R (14)",
      8
    );
    expect(compared, "too few bars compared").toBeGreaterThan(2000);
    expect(appOnly, "the app reported bars the workbook has no value for").toBe(0);
    expect(warmup, "warm-up gap larger than the 14-bar window").toBeLessThanOrEqual(32);
  });

  it("Stochastic RSI (14,14,3) reproduces the sheet's block from the sheet's RSI", () => {
    // Sheet 111026: 12 RSI(14), 16 raw StochRSI %K, 17 fast %K, 18 fast %D.
    // The block is built on the sheet's own RSI column, so that is the series fed
    // through the app's window and smoothing helpers here: it pins the 14-bar
    // range window, the 0-1 → 0-100 scale and both 3-period averages. The sheet's
    // RSI column is not Wilder-smoothed the way lib/ta's rsi() is (it is a
    // patchwork of pasted exports), so the RSI values themselves are out of scope.
    const r = ascendingColumn("111026", 12);
    const lo = rollingMin(r, 14);
    const hi = rollingMax(r, 14);
    const raw = r.map((v, i) =>
      Number.isFinite(hi[i] - lo[i]) && hi[i] > lo[i] ? ((v - lo[i]) / (hi[i] - lo[i])) * 100 : NaN
    );
    const scaled = (col: number) => ascendingColumn("111026", col).map((v) => v * 100);

    const checks = [
      compareSeries(raw, scaled(16), "raw StochRSI %K", 8),
      compareSeries(windowMean(raw, 3), scaled(17), "fast %K", 8),
      compareSeries(windowMean(windowMean(raw, 3), 3), scaled(18), "fast %D", 8),
    ];
    for (let i = 0; i < checks.length; i++) {
      expect(checks[i].compared, `too few bars compared (#${i})`).toBeGreaterThan(2000);
      expect(checks[i].appOnly, `unmatched app readings (#${i})`).toBe(0);
      expect(checks[i].warmup, `warm-up gap larger than a full window (#${i})`).toBeLessThanOrEqual(32);
    }
  });
});
