// Price-history / technical-analysis workbook importer.
//
// Converts spreadsheets full of daily OHLCV bars (the kind Excel "technical
// analysis" exports produce: Date, Close/Last, Volume, Open, High, Low, plus
// any number of extra indicator columns) into clean price rows for the app's
// price cache. It is deliberately flexible about layout:
//
//   • Any sheet in the workbook can hold data (all sheets are scanned).
//   • The header row is auto-detected; if a sheet has no recognizable headers,
//     columns are guessed from the data itself (date-like first column +
//     numeric columns ranked by their means: high is the biggest, low the
//     smallest, open/close in between, volume dwarfs everything).
//   • Header names are fuzzy-matched (Close/Last, Adj Close, Price, Vol, …,
//     unicode dashes, stray spaces).
//   • Dates arrive in every format imaginable, INCLUDING MIXED FORMATS IN THE
//     SAME COLUMN (e.g. "9/16/26" meaning Sep 16 next to "11/9/26" meaning
//     11 Sep). Each cell is resolved with a nearest-anchor heuristic against
//     unambiguous neighbours (see resolveDateSeries).
//   • Missing open/high/low fall back to close; missing volume to 0.
//   • The ticker is inferred from the sheet name, falling back to the file
//     name ("tehnival analysis 19926" → TEHNIVAL); a Symbol/Ticker column
//     wins over both when present.
//   • Duplicate (symbol, date) rows across sheets are merged, keeping the
//     most complete row.

import * as XLSX from "xlsx";

// ─── Public types ───────────────────────────────────────────────
export interface PriceRow {
  symbol: string;
  date: string; // ISO yyyy-mm-dd
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SheetSummary {
  sheet: string;
  symbol: string;
  rows: number;
  dateFrom: string | null;
  dateTo: string | null;
}

export interface PriceWorkbook {
  fileName: string;
  totalRows: number;
  sheets: SheetSummary[];
  warnings: string[];
  rows: PriceRow[];
}

// ─── Header normalization + mapping ─────────────────────────────
function normalizeHeader(h: unknown): string {
  return String(h ?? "")
    .replace(/[\u00a0\u2000-\u200b\uFEFF]/g, " ")          // nbsp, unicode spaces, zero-width
    .replace(/[\u2010-\u2015\u2212_\-./\\(),]+/g, " ")      // dashes, underscores, slashes, dots
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PRICE_FIELDS = ["date", "close", "open", "high", "low", "volume", "symbol"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

const HEADER_SYNONYMS: Record<PriceField, string[]> = {
  date: ["date", "dates", "trade date", "session", "time"],
  close: ["close last", "close", "last", "adj close", "adjclose", "adjusted close", "closing price", "close price", "price", "settle", "settlement"],
  open: ["open", "open price", "opening price"],
  high: ["high", "day high", "high price"],
  low: ["low", "day low", "low price"],
  volume: ["volume", "vol", "volume shares", "shares traded", "turnover", "qty traded", "quantity traded"],
  symbol: ["symbol", "ticker", "sym", "security"],
};

function mapHeaderColumns(headers: unknown[]): Partial<Record<PriceField, number>> {
  const map: Partial<Record<PriceField, number>> = {};
  const used = new Set<number>();
  const norm = headers.map(normalizeHeader);
  for (const field of PRICE_FIELDS) {
    const synonyms = HEADER_SYNONYMS[field];
    // Pass 0: exact — Pass 1: contains. Exact matches across ALL headers win
    // before any fuzzy match (e.g. "Close/Last" beats "Entry Price" for close).
    for (const pass of [0, 1]) {
      for (let i = 0; i < norm.length; i++) {
        if (used.has(i) || !norm[i]) continue;
        const hit = pass === 0 ? synonyms.includes(norm[i]) : synonyms.some((s) => norm[i].includes(s));
        if (hit) {
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

function findPriceHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(15, matrix.length); i++) {
    const joined = (matrix[i] ?? []).map(normalizeHeader).join(" ");
    if (/\bdate\b/.test(joined) && /\b(open|high|low|close|last|volume|adj|price)\b/.test(joined)) return i;
  }
  return -1;
}

// ─── Numeric parsing (comma thousands, EU decimals, parentheses) ─
export function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).trim();
  if (!s || s === "-" || s === "--") return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()\s\u00a0]/g, "");
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");       // 1.234,56
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");                  // 1,234.56
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");                                    // 46,26
  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

// ─── Date parsing: per-cell candidates ──────────────────────────
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface ParsedDate {
  iso?: string;    // unambiguous (Date object, serial, ISO, month-name formats)
  mdy?: string;    // valid as month/day/year
  dmy?: string;    // valid as day/month/year
}

function normYear(y: string): number {
  const n = parseInt(y, 10);
  if (y.length === 2) return n > 69 ? 1900 + n : 2000 + n;
  return n;
}

function p2(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoOrUndefined(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined;
  return `${y}-${p2(m)}-${p2(d)}`;
}

function excelSerialToIso(n: number): string {
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

export function parseDateCell2(v: unknown): ParsedDate {
  if (v == null || v === "") return {};
  if (v instanceof Date) return isNaN(v.getTime()) ? {} : { iso: v.toISOString().slice(0, 10) };
  if (typeof v === "number") return v > 20000 && v < 80000 ? { iso: excelSerialToIso(v) } : {};

  const s = String(v).replace(/[\u00a0\u2000-\u200b\uFEFF]/g, " ").trim();
  if (!s) return {};

  // ISO-ish: 2026-09-16 / 2026/09/16 / 2026.9.16
  let m = s.match(/^(\d{4})[\-/.](\d{1,2})[\-/.](\d{1,2})/);
  if (m) {
    const iso = isoOrUndefined(+m[1], +m[2], +m[3]);
    if (iso) return { iso };
  }

  // Numeric with separators: 9/16/26, 11-9-2026, 16.9.2026 — ambiguous M/D vs D/M
  m = s.match(/^(\d{1,2})[\s\-/.]+(\d{1,2})[\s\-/.]+(\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = normYear(m[3]);
    if (y >= 1900 && y <= 2100) {
      return { mdy: isoOrUndefined(y, a, b), dmy: isoOrUndefined(y, b, a) };
    }
    return {};
  }

  // "5 Jan 26" / "5-Jan-2026"
  m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,})\.?[\s\-,]+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) {
      const iso = isoOrUndefined(normYear(m[3]), mo, +m[1]);
      if (iso) return { iso };
    }
  }

  // "Jan 5, 2026" / "September 16, 2026"
  m = s.match(/^([A-Za-z]{3,})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) {
      const iso = isoOrUndefined(normYear(m[3]), mo, +m[2]);
      if (iso) return { iso };
    }
  }

  return {};
}

// ─── Mixed-format date resolution ───────────────────────────────
// Files routinely MIX "9/16/26" (M/D) and "11/9/26" (D/M) in one column.
// Unambiguous cells (one reading invalid, month names, serials, ISO) anchor
// the series; each ambiguous cell picks the reading closest to its nearest
// anchor — which reconstructs the intended chronological order whether the
// file runs ascending or descending. With no anchor at all, defaults to M/D.
export function resolveDateSeries(parsed: ParsedDate[]): (string | null)[] {
  const n = parsed.length;
  const fixed: (string | null)[] = parsed.map((p) =>
    p.iso ?? (p.mdy && p.dmy ? null : p.mdy ?? p.dmy ?? null),
  );

  // Nearest decisive index for every cell (left and right passes).
  const left: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) left[i] = fixed[i] ? i : i > 0 ? left[i - 1] : -1;
  const right: number[] = new Array(n).fill(-1);
  for (let i = n - 1; i >= 0; i--) right[i] = fixed[i] ? i : i < n - 1 ? right[i + 1] : -1;

  const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  const out: (string | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fixed[i]) { out[i] = fixed[i]; continue; }
    const p = parsed[i];
    if (!p.mdy && !p.dmy) continue;
    const li = left[i], ri = right[i];
    const aIdx = li >= 0 && ri >= 0 ? (i - li <= ri - i ? li : ri) : Math.max(li, ri);
    const anchor = aIdx >= 0 ? fixed[aIdx] : null;
    if (!anchor || !p.mdy || !p.dmy) { out[i] = p.mdy ?? p.dmy ?? null; continue; }
    const dm = Math.abs(t(p.mdy) - t(anchor));
    const dd = Math.abs(t(p.dmy) - t(anchor));
    out[i] = dd < dm ? p.dmy : p.mdy; // tie → M/D
  }
  return out;
}

// ─── Ticker inference ───────────────────────────────────────────
const GENERIC_NAME =
  /^(sheet|m?sheet\d*|worksheet|workbook|page|data|dataset|prices?|price.*history|histor.*|export|analys.*|daily|weekly|monthly|chart.*|signal.*|trading|import|book|report|raw|cache|new)/i;

function cleanSymbolCandidate(s: string): string | null {
  const word = s.replace(/[^A-Za-z0-9.\-]/g, " ").trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z][A-Za-z0-9.\-]{1,11}$/.test(word)) return null;
  if (GENERIC_NAME.test(word)) return null;
  return word.toUpperCase();
}

export function inferSymbol(sheetName: string, fileName: string): string {
  const fromSheet = cleanSymbolCandidate(sheetName);
  if (fromSheet) return fromSheet;

  const stem = fileName.replace(/\.[^.]+$/, "");
  const tokens = stem.split(/[^A-Za-z]+/).filter((t) => t.length >= 2);
  const keep = tokens.filter((t) => !GENERIC_NAME.test(t));
  const fromFile = keep.length > 0 ? cleanSymbolCandidate(keep[0]) : null;
  if (fromFile) return fromFile;

  return "IMPORT";
}

// ─── Positional fallback (no usable header row) ─────────────────
function guessColumnsByData(matrix: unknown[][]): { map: Partial<Record<PriceField, number>>; dateCol: number } | null {
  const width = Math.max(0, ...matrix.slice(0, 200).map((r) => (r ?? []).length));
  if (width === 0) return null;

  const rows = matrix.slice(0, 200);
  const dateableCount = new Array(width).fill(0);
  const numCount = new Array(width).fill(0);
  const sum = new Array(width).fill(0);

  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      const v = row?.[c];
      const pd = parseDateCell2(v);
      if (pd.iso || pd.mdy || pd.dmy) dateableCount[c]++;
      // Cells with a date reading (including ISO strings and 9/16/26) must not
      // count as numbers, or the date column looks numeric-dominant.
      const n = pd.iso || pd.mdy || pd.dmy ? null : parseNum(v);
      if (n != null) { numCount[c]++; sum[c] += Math.abs(n); }
    }
  }
  const sampled = Math.max(1, rows.length);

  // Date column: most date-parseable cells, and it must not be numeric-dominant.
  let dateCol = -1;
  let best = 0;
  for (let c = 0; c < width; c++) {
    if (dateableCount[c] > best && dateableCount[c] >= sampled * 0.5 && numCount[c] < sampled * 0.8) {
      best = dateableCount[c];
      dateCol = c;
    }
  }
  if (dateCol === -1) return null;

  // Numeric columns ranked by mean magnitude.
  const numeric = [];
  for (let c = 0; c < width; c++) {
    if (c === dateCol || numCount[c] < sampled * 0.5) continue;
    numeric.push({ col: c, mean: sum[c] / numCount[c] });
  }
  numeric.sort((a, b) => a.mean - b.mean);

  const map: Partial<Record<PriceField, number>> = { date: dateCol };
  const assign4 = (cols: { col: number; mean: number }[]) => {
    // Means sorted ascending: low, min(open,close), max(open,close), high.
    // In open/high/low/close layouts open sits before close, so earlier
    // column of the middle two is open.
    if (cols.length < 4) return;
    const sorted = [...cols].sort((a, b) => a.mean - b.mean);
    map.low = sorted[0].col;
    map.high = sorted[3].col;
    const mid = [sorted[1], sorted[2]].sort((a, b) => a.col - b.col);
    map.open = mid[0].col;
    map.close = mid[1].col;
  };

  if (numeric.length === 1) {
    map.close = numeric[0].col;
  } else if (numeric.length === 2 || numeric.length === 3) {
    // close + volume (volume's mean dwarfs price); any third column ignored.
    map.close = numeric[0].col;
    map.volume = numeric[numeric.length - 1].col;
  } else if (numeric.length === 4) {
    assign4(numeric);
  } else {
    // 5+: biggest mean is volume, run the 4-column rule on the rest.
    const volumeCol = numeric[numeric.length - 1].col;
    assign4(numeric.slice(0, -1));
    map.volume = volumeCol;
  }
  if (map.close === undefined && map.open === undefined) return null;
  return { map, dateCol };
}

// ─── Per-sheet parsing ──────────────────────────────────────────
// Some workbooks label the close column with a stray value instead of a
// header — your technical-analysis export has "Close/Last" on Sheet1 but a bare
// number (the latest price) in the same cell on Sheet2/31026/61026. When close
// can't be matched by name but high/low are known, fall back to the unmapped
// column whose values actually sit inside the day's high/low range — that is
// always the close. Ties keep the leftmost column, i.e. the standard
// Date | Close | Volume | Open | High | Low layout.
function detectCloseColumn(
  matrix: unknown[][],
  headerIdx: number,
  map: Partial<Record<PriceField, number>>,
): number {
  if (map.low === undefined || map.high === undefined) return -1;
  const loCol = map.low;
  const hiCol = map.high;
  const taken = new Set<number>(
    PRICE_FIELDS.map((f) => map[f]).filter((v): v is number => v !== undefined),
  );
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const end = Math.min(matrix.length, start + 120);
  if (end - start < 20) return -1;
  const width = Math.max(0, ...matrix.slice(start, end).map((r) => (r ?? []).length));

  // Reference price scale: the average of the high/low columns. A close always
  // sits on the same scale as them; volume, RSI, CCI and percent columns do not.
  let refSum = 0;
  let refN = 0;
  for (let r = start; r < end; r++) {
    const row = matrix[r] as unknown[] | undefined;
    for (const c of [loCol, hiCol]) {
      const v = parseNum(row?.[c]);
      if (v != null && v > 0) { refSum += v; refN++; }
    }
  }
  const ref = refN > 0 ? refSum / refN : 0;
  if (!(ref > 0)) return -1;

  // First (leftmost) numeric column on that price scale wins — the standard
  // layouts put Close immediately after Date, and ties must stay deterministic.
  for (let c = 0; c < width; c++) {
    if (taken.has(c)) continue;
    let nums = 0;
    let sum = 0;
    let tested = 0;
    for (let r = start; r < end; r++) {
      const v = parseNum(matrix[r]?.[c]);
      tested++;
      if (v != null) { nums++; sum += v; }
    }
    if (tested < 20 || nums / tested < 0.7) continue;
    const mean = sum / nums;
    if (mean <= 0 || Math.abs(mean - ref) / ref > 0.25) continue;
    return c;
  }
  return -1;
}

interface SheetParse {
  rows: PriceRow[];
  summary: SheetSummary | null;
}

function parseSheet(
  sheetName: string,
  matrix: unknown[][],
  fileName: string,
  warnings: string[],
): SheetParse {
  if (matrix.length === 0) return { rows: [], summary: null };

  const headerIdx = findPriceHeaderRow(matrix);
  let map: Partial<Record<PriceField, number>>;
  let fallback = false;

  if (headerIdx >= 0) {
    map = mapHeaderColumns(matrix[headerIdx]);
  } else {
    const guessed = guessColumnsByData(matrix);
    if (!guessed) return { rows: [], summary: null };
    map = guessed.map;
    fallback = true;
  }

  const hasOhlc = map.open !== undefined || map.high !== undefined || map.low !== undefined;
  // Close missing by name? Recover it from the data before giving up on the sheet.
  if (map.close === undefined && !fallback) {
    const guess = detectCloseColumn(matrix, headerIdx, map);
    if (guess >= 0) {
      map.close = guess;
      warnings.push(
        `Sheet "${sheetName}": no "Close" header found — column ${guess + 1} was used (its values sit inside the high/low range).`,
      );
    }
  }
  if (map.date === undefined || (map.close === undefined && !hasOhlc)) {
    return { rows: [], summary: null }; // not a price sheet
  }
  if (fallback) {
    warnings.push(`Sheet "${sheetName}": no header row found — columns were guessed from the data.`);
  }

  const sheetSymbol = inferSymbol(sheetName, fileName);

  // Pass 1: collect date candidates for the whole column.
  const rawDates: unknown[] = [];
  const dataRows: unknown[][] = [];
  for (let r = headerIdx >= 0 ? headerIdx + 1 : 0; r < matrix.length; r++) {
    const row = matrix[r] as unknown[] | undefined;
    if (!row || row.every((c) => c == null || c === "")) continue;
    rawDates.push(row[map.date!]);
    dataRows.push(row);
  }
  const dates = resolveDateSeries(rawDates.map(parseDateCell2));

  // Pass 2: build rows.
  const rows: PriceRow[] = [];
  let skipped = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const date = dates[i];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }

    const closeV = map.close !== undefined ? parseNum(row[map.close]) : null;
    let openV = map.open !== undefined ? parseNum(row[map.open]) : null;
    let highV = map.high !== undefined ? parseNum(row[map.high]) : null;
    let lowV = map.low !== undefined ? parseNum(row[map.low]) : null;
    const volumeV = map.volume !== undefined ? parseNum(row[map.volume]) : null;

    if (closeV == null || closeV <= 0) { skipped++; continue; }
    if (openV == null || openV <= 0) openV = closeV;
    if (highV == null || highV <= 0) highV = closeV;
    if (lowV == null || lowV <= 0) lowV = closeV;
    if (highV < lowV) [highV, lowV] = [lowV, highV];

    let symbol = sheetSymbol;
    if (map.symbol !== undefined) {
      const cell = String(row[map.symbol] ?? "").trim().toUpperCase();
      if (/^[A-Z0-9.\-^=]{1,12}$/.test(cell)) symbol = cell;
    }

    rows.push({
      symbol,
      date,
      open: openV,
      high: highV,
      low: lowV,
      close: closeV,
      volume: volumeV != null && volumeV > 0 ? volumeV : 0,
    });
  }
  if (skipped > 0) {
    warnings.push(`Sheet "${sheetName}": ${skipped} row${skipped === 1 ? "" : "s"} skipped (unreadable date or close).`);
  }
  if (rows.length === 0) return { rows: [], summary: null };

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    rows,
    summary: {
      sheet: sheetName,
      symbol: rows[0].symbol,
      rows: rows.length,
      dateFrom: rows[0].date,
      dateTo: rows[rows.length - 1].date,
    },
  };
}

// ─── Workbook entry point ───────────────────────────────────────
function rowScore(r: PriceRow): number {
  return (r.volume > 0 ? 1 : 0) + (r.open !== r.close ? 1 : 0) + (r.high !== r.close ? 1 : 0) + (r.low !== r.close ? 1 : 0);
}

export function parsePriceWorkbook(buf: Buffer, fileName: string): PriceWorkbook {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const warnings: string[] = [];

  const byKey = new Map<string, PriceRow>();
  const sheets: SheetSummary[] = [];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][];
    const { rows, summary } = parseSheet(name, matrix, fileName, warnings);
    if (summary) sheets.push(summary);

    for (const row of rows) {
      const key = `${row.symbol}|${row.date}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, row);
      } else if (rowScore(row) > rowScore(existing)) {
        byKey.set(key, row); // richer row (real volume / full OHLC) wins
      }
    }
  }

  if (sheets.length === 0) {
    warnings.push("No sheet in this workbook looked like a price history (needs a date column plus close/open/high/low/volume).");
  }

  const rows = [...byKey.values()].sort(
    (a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) || (a.date < b.date ? -1 : 1),
  );

  return {
    fileName,
    totalRows: rows.length,
    sheets,
    warnings,
    rows,
  };
}
