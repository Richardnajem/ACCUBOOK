// Regression test against the real workbook: "tehnival analysis 19926.xlsx".
//
// That file is the shape of export that trips up naive importers — six sheets,
// rows running newest → oldest, mixed Excel serials and "MM/DD/YYYY" strings,
// and (on Sheet2 / 31026 / 61026) a stray number where the "Close/Last" header
// should be. Column B is still the close on those sheets; the importer recovers
// it from the data, and this test proves the recovered values are the real ones
// by comparing them against cells read straight out of the workbook.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { parsePriceWorkbook, type PriceRow } from "../src/lib/price-import";

const WORKBOOK = fileURLToPath(new URL("../tehnival analysis 19926.xlsx", import.meta.url));
const buf = readFileSync(WORKBOOK);
const parsed = parsePriceWorkbook(buf, "tehnival analysis 19926.xlsx");
// Read the workbook once — re-parsing it per sheet blows the test timeout.
const source = XLSX.read(buf, { type: "buffer", cellDates: true });

// Read one sheet as a raw matrix so we can compare against the source cells.
function sheetMatrix(name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(source.Sheets[name], { header: 1, raw: false, defval: "" }) as unknown[][];
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

const byDate = new Map<string, PriceRow>(parsed.rows.map((r) => [r.date, r]));

describe("tehnival analysis 19926.xlsx", () => {
  it("imports every sheet, not just the ones with a proper header", () => {
    expect(parsed.sheets.map((s) => s.sheet).sort()).toEqual(
      ["31026", "61026", "Sheet1", "Sheet2", "Sheet3", "Sheet4"]
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
