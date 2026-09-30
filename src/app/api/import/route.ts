import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
// pdf-parse v2 exposes a PDFParse class (CJS build).
import { PDFParse } from "pdf-parse";

export const runtime = "nodejs";

// ─── Types ──────────────────────────────────────────────────────
export interface ImportRow {
  date: string; // ISO yyyy-mm-dd
  description: string;
  symbol: string | null;
  shares: number | null;
  price: number | null;   // for buys/sells: per-share price; for cash events: amount
  type: string;           // buy | sell | dividend | deposit | withdrawal | fee
  fees: number;
  raw?: string;
}

// ─── Field synonyms for auto-mapping ────────────────────────────
const FIELD_SYNONYMS: Record<string, string[]> = {
  date: ["date", "trade date", "transaction date", "posted date", "value date", "fecha", "datum"],
  description: ["description", "details", "narrative", "memo", "name", "desc", "security", "instrument"],
  symbol: ["symbol", "ticker", "sym", "security symbol"],
  shares: ["shares", "quantity", "qty", "units", "amount of shares"],
  price: ["price", "unit price", "share price", "cost per share", "rate"],
  amount: ["amount", "value", "sum", "total", "net amount", "importe"],
  debit: ["debit", "withdrawal", "paid out", "money out", "charge", "outflow"],
  credit: ["credit", "deposit", "paid in", "money in", "inflow"],
  fees: ["fees", "commission", "fee", "brokerage", "commission amount"],
  type: ["type", "side", "action", "activity", "transaction type"],
};

const TYPE_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(buy|bought|purchase|acquisition)\b/i, "buy"],
  [/\b(sell|sold|sale|liquidat)\b/i, "sell"],
  [/\b(dividend|distribution)\b/i, "dividend"],
  [/\b(deposit|contribution|transfer in|funding)\b/i, "deposit"],
  [/\b(withdrawal|withdraw|transfer out)\b/i, "withdrawal"],
  [/\b(fee|commission|interest charged)\b/i, "fee"],
];

function classifyType(desc: string, fallback?: string): string {
  for (const [re, type] of TYPE_KEYWORDS) if (re.test(desc)) return type;
  return fallback || "deposit";
}

// ─── Helpers ────────────────────────────────────────────────────
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

function autoMapColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const used = new Set<number>();
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    // Pass 0: exact match; Pass 1: contains
    for (const pass of [0, 1]) {
      for (let i = 0; i < headers.length; i++) {
        if (used.has(i)) continue;
        const h = normalizeHeader(headers[i] ?? "");
        const matched = pass === 0 ? h === synonyms[0] : synonyms.some((s) => h.includes(s));
        if (h && matched) {
          map[field] = i;
          used.add(i);
          break;
        }
      }
      if (map[field] !== undefined) break;
    }
  }
  return map;
}

function parseAmountCell(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  // Accounting negatives: (1,234.56) → -1234.56
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "");
  // European format: 1.234,56 → 1234.56
  const eu = /^-?[\d.]*,\d{1,2}$/.test(s);
  if (eu) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseDateCell(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().split("T")[0];
  if (typeof v === "number" && v > 20000 && v < 60000) {
    // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().split("T")[0];
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/Y or M-D-Y (US), auto-swaps when month/day look reversed
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const [, a, b, y] = m;
    let mo = parseInt(a);
    let day = parseInt(b);
    if (mo > 12 && day <= 12) [mo, day] = [day, mo];
    const yr = y.length === 2 ? `20${y}` : y;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  // "12 Mar 2026" / "Mar 12, 2026"
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

function splitSidedAmounts(debit: unknown, credit: unknown): number | null {
  const d = parseAmountCell(debit);
  const c = parseAmountCell(credit);
  if (d == null && c == null) return null;
  return (c ?? 0) - (d ?? 0); // credit positive, debit negative
}

// ─── PDF parsing (two strategies) ───────────────────────────────

// Strategy 1: line-based "date ... description ... amount"
function parsePdfRows(text: string): ImportRow[] {
  const rows: ImportRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const dm = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/);
    if (!dm) continue;
    const dateRaw = dm[1];
    const date = parseDateCell(dateRaw);
    if (!date) continue;
    const after = line.slice((dm.index ?? 0) + dateRaw.length);
    // Last amount-looking number on the line wins
    const nums = [...after.matchAll(/-?\(?[\d,]+\.\d{2}\)?/g)];
    if (nums.length === 0) continue;
    const amountRaw = nums[nums.length - 1][0];
    const amount = parseAmountCell(amountRaw);
    if (amount == null || amount === 0) continue;
    const description =
      (dm.index! > 0 ? line.slice(0, dm.index!) : "") +
      after.slice(0, after.length - amountRaw.length);
    rows.push({
      date,
      description: description.replace(/\s{2,}/g, " ").trim() || "(no description)",
      symbol: extractSymbol(description),
      shares: null,
      price: Math.abs(amount),
      type: classifyType(description),
      fees: 0,
      raw: line,
    });
  }
  return rows;
}

// Strategy 2: column-aligned tables (cells separated by 2+ spaces)
function parsePdfTable(text: string): ImportRow[] {
  const rows: ImportRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  let headers: string[] | null = null;
  let colMap: Record<string, number> = {};

  for (const line of lines) {
    const cells = line.split(/\s{2,}/).map((c) => c.trim());
    if (!headers) {
      if (cells.length >= 3) {
        const joined = cells.map(normalizeHeader).join(" ");
        if (/date/.test(joined) && /(amount|value|shares|quantity|price|debit|credit)/.test(joined)) {
          headers = cells;
          colMap = autoMapColumns(cells);
        }
      }
      continue;
    }
    if (cells.length < 2) continue;
    const date = parseDateCell(colMap.date !== undefined ? cells[colMap.date] : cells[0]);
    if (!date) continue;
    const amount =
      (colMap.debit !== undefined || colMap.credit !== undefined
        ? splitSidedAmounts(cells[colMap.debit], cells[colMap.credit])
        : null) ?? parseAmountCell(cells[colMap.amount]);
    if (amount == null || amount === 0) continue;
    const description = (colMap.description !== undefined ? cells[colMap.description] : "") || "(no description)";
    const shares = colMap.shares !== undefined ? parseAmountCell(cells[colMap.shares]) : null;
    const price = colMap.price !== undefined ? parseAmountCell(cells[colMap.price]) : null;
    rows.push({
      date,
      description,
      symbol: (colMap.symbol !== undefined ? cells[colMap.symbol]?.trim() : null) || extractSymbol(description),
      shares,
      price: price ?? Math.abs(amount),
      type: classifyType(description),
      fees: colMap.fees !== undefined ? Math.abs(parseAmountCell(cells[colMap.fees]) ?? 0) : 0,
      raw: line,
    });
  }
  return rows;
}

// Best-effort ticker extraction from a description line.
function extractSymbol(desc: string): string | null {
  const m = desc.match(/\b([A-Z]{2,5})\b/);
  return m ? m[1] : null;
}

// ─── POST: parse file → preview ─────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const name = file.name.toLowerCase();
    const buf = Buffer.from(await file.arrayBuffer());
    let rows: ImportRow[] = [];

    if (name.endsWith(".pdf")) {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const result = await parser.getText();
        const text: string = result.text || "";
        rows = parsePdfTable(text);
        if (rows.length === 0) rows = parsePdfRows(text);
      } finally {
        await parser.destroy();
      }
    } else {
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const matrix: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });

      // Find the header row within the first 10 rows (brokers love preamble rows)
      let headerIdx = -1;
      for (let i = 0; i < Math.min(10, matrix.length); i++) {
        const joined = (matrix[i] ?? []).map((c) => normalizeHeader(String(c ?? ""))).join(" ");
        if (
          /date/.test(joined) &&
          /(amount|value|shares|quantity|price|debit|credit|symbol|ticker|description|details|memo)/.test(joined)
        ) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx === -1) headerIdx = 0;

      const headers = (matrix[headerIdx] ?? []).map((c) => String(c ?? ""));
      const map = autoMapColumns(headers);
      const hasSided = map.debit !== undefined || map.credit !== undefined;
      const hasSharePrice = map.shares !== undefined && map.price !== undefined;
      if (map.date === undefined || (!hasSided && map.amount === undefined && !hasSharePrice)) {
        return NextResponse.json(
          { error: `Could not find date and amount/shares columns. Headers seen: ${headers.join(", ") || "(none)"}` },
          { status: 422 },
        );
      }

      for (let r = headerIdx + 1; r < matrix.length; r++) {
        const row = matrix[r] as unknown[];
        if (!row || row.every((c) => c == null || c === "")) continue;
        const date = parseDateCell(row[map.date]);
        if (!date) continue;

        const description = map.description !== undefined ? String(row[map.description] ?? "").trim() : "";
        const shares = map.shares !== undefined ? parseAmountCell(row[map.shares]) : null;
        const price = map.price !== undefined ? parseAmountCell(row[map.price]) : null;
        const amount = hasSided
          ? splitSidedAmounts(row[map.debit], row[map.credit])
          : map.amount !== undefined
            ? parseAmountCell(row[map.amount])
            : null;

        // A trade row needs shares+price OR an amount (cash/dividend rows)
        const isTrade = shares != null && shares > 0 && price != null && price > 0;
        if (!isTrade && (amount == null || amount === 0)) continue;

        const declaredType = map.type !== undefined ? String(row[map.type] ?? "") : "";
        const type = classifyType(declaredType || description, isTrade ? (amount != null && amount < 0 ? "sell" : "buy") : "deposit");

        rows.push({
          date,
          description: description || "(no description)",
          symbol: (map.symbol !== undefined ? String(row[map.symbol] ?? "").trim() : "") || extractSymbol(description),
          shares: isTrade ? Math.abs(shares!) : null,
          price: isTrade ? Math.abs(price!) : Math.abs(amount ?? 0),
          type,
          fees: map.fees !== undefined ? Math.abs(parseAmountCell(row[map.fees]) ?? 0) : 0,
        });
      }
    }

    if (rows.length === 0) {
      return NextResponse.json({ error: "No importable rows found in file" }, { status: 422 });
    }

    // Dedupe within the file by fingerprint
    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      const k = `${r.date}|${r.type}|${r.symbol}|${r.shares}|${r.price}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return NextResponse.json({
      fileName: file.name,
      totalRows: unique.length,
      rows: unique.slice(0, 200),
    });
  } catch (err) {
    console.error("Import parse failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to parse file" }, { status: 500 });
  }
}

// ─── PUT: commit rows ───────────────────────────────────────────
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const rows: ImportRow[] = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return NextResponse.json({ error: "No rows to import" }, { status: 400 });

    const { upsertTradeByFingerprint } = await import("@/lib/db");
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const res = upsertTradeByFingerprint({
        date: r.date,
        type: r.type,
        symbol: r.symbol ? r.symbol.toUpperCase() : null,
        shares: r.shares ?? 0,
        price: r.price ?? 0,
      });
      if (res.inserted) inserted++;
      else skipped++;
    }
    return NextResponse.json({ inserted, skipped, total: rows.length });
  } catch (err) {
    console.error("Import commit failed:", err);
    return NextResponse.json({ error: "Failed to import rows" }, { status: 500 });
  }
}
