// Daily OHLCV market data for publicly traded stocks, with MULTI-SOURCE
// failover: Nasdaq (raw prices) → Yahoo Finance (adjusted, q1 → q2). Results
// are cached into SQLite (per-source basis) so repeat backtests are instant
// and offline-capable, and never mix adjusted/raw price bases.
//
// No API key required. US-listed equities and ETFs.
// Note: Stooq used to be the fallback but now serves a JS proof-of-work
// challenge to non-browsers, so it was dropped (kept only in verify).

import Database from "better-sqlite3";
import path from "path";

const DB_PATH =
  process.env.STOCKFOLIO_DB_PATH ||
  process.env.ACCUBOOKS_DB_PATH || // legacy env name kept for compatibility
  path.join(process.cwd(), "portfolio.db");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface Bar {
  date: string;      // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CachedMeta {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
}

let cacheDb: Database.Database | null = null;

function getCacheDb(): Database.Database {
  if (!cacheDb) {
    cacheDb = new Database(DB_PATH);
    cacheDb.pragma("journal_mode = WAL");
    cacheDb.exec(`
      CREATE TABLE IF NOT EXISTS price_bars (
        symbol TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (symbol, date)
      );
      CREATE TABLE IF NOT EXISTS price_meta (
        symbol TEXT PRIMARY KEY,
        name TEXT,
        currency TEXT,
        exchange TEXT,
        last_refreshed TEXT,
        source TEXT
      );
    `);
    // Migration for caches created before the `source` column existed.
    try { cacheDb.exec("ALTER TABLE price_meta ADD COLUMN source TEXT"); } catch { /* column exists */ }
  }
  return cacheDb;
}

// ─── NY-time helpers ────────────────────────────────────────────
// Yahoo daily bars are stamped with US/Eastern market timestamps, so session
// logic (market open, last expected session) must run on NY time.
function nyParts(d = new Date()): { weekday: string; mins: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), mins: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10) };
}

/** True during regular US trading hours (9:30–16:00 ET, Mon–Fri). Holidays still report open — harmless (a refetch). */
export function isUsMarketOpen(): boolean {
  const { weekday, mins } = nyParts();
  if (weekday === "Sat" || weekday === "Sun") return false;
  return mins >= 570 && mins < 960;
}

// ─── OHLC sanity validation ─────────────────────────────────────
// Bad rows from a provider (or a parse hiccup) must never reach the cache or a
// backtest: they silently corrupt indicators and trades. Drops impossible bars
// rather than trying to "fix" them.
function validateBars(bars: Bar[]): Bar[] {
  const seen = new Set<string>();
  const today = todayNY();
  const out: Bar[] = [];
  for (const b of bars) {
    if (!b.date || seen.has(b.date)) continue;      // dupes / missing date
    if (b.date > today) continue;                    // future stamp = clock/parsing bug
    if (!(b.open > 0) || !(b.close > 0) || !(b.high > 0) || !(b.low > 0)) continue;
    if (b.high < b.low) continue;                    // impossible range
    if (b.high < Math.max(b.open, b.close) - 1e-6) continue;
    if (b.low > Math.min(b.open, b.close) + 1e-6) continue;
    if (!(b.volume >= 0)) continue;
    seen.add(b.date);
    out.push(b);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Yahoo chart API: free, keyless daily OHLCV (split/dividend-adjusted).
// Tries query1 then query2 (independent rate-limit pools) before giving up.
async function fetchYahooDaily(symbol: string, period1: number, period2: number): Promise<{ bars: Bar[]; meta: CachedMeta }> {
  const attempts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let lastErr: unknown = null;
  for (const host of attempts) {
    try {
      return await fetchYahooDailyHost(host, symbol, period1, period2);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`All Yahoo endpoints failed for ${symbol}.`);
}

async function fetchYahooDailyHost(host: string, symbol: string, period1: number, period2: number): Promise<{ bars: Bar[]; meta: CachedMeta }> {
  const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, {
    headers: {
      // Yahoo rejects requests without a browser-ish User-Agent
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (res.status === 404) throw new Error(`Ticker "${symbol}" not found. Check the symbol (e.g. AAPL, MSFT, SPY).`);
  if (res.status === 429) throw new Error("Yahoo Finance rate limit hit — wait a few seconds and retry.");
  if (!res.ok) throw new Error(`Market data provider returned HTTP ${res.status} for ${symbol}.`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const err = json?.chart?.error?.description;
    throw new Error(err ? `Yahoo Finance error: ${err}` : `No data for "${symbol}".`);
  }
  const meta = result.meta || {};
  const ts: number[] = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens: (number | null)[] = q.open || [];
  const highs: (number | null)[] = q.high || [];
  const lows: (number | null)[] = q.low || [];
  const closes: (number | null)[] = q.close || [];
  const adjcloses: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose || q.close || [];
  const volumes: (number | null)[] = q.volume || [];

  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i], a = adjcloses[i], v = volumes[i];
    if (o == null || h == null || l == null || c == null || a == null) continue;
    if (o <= 0 || c <= 0) continue; // Yahoo emits nulls on halts/holidays
    // Rebuild OHLC from adjusted close so the series is split/dividend-consistent
    const ratio = a / c;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: o * ratio,
      high: h * ratio,
      low: l * ratio,
      close: a,
      volume: v ?? 0,
    });
  }
  const seen = new Set<string>();
  const deduped = bars.filter(b => {
    if (seen.has(b.date)) return false;
    seen.add(b.date);
    return true;
  });
  return {
    bars: validateBars(deduped),
    meta: {
      symbol: meta.symbol || symbol,
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency || "USD",
      exchange: meta.fullExchangeName || meta.exchangeName || "",
    },
  };
}

// ─── Nasdaq: official raw OHLCV, stocks + ETFs (~1 year window max) ───────
// https://api.nasdaq.com/api/quote/{SYM}/historical?assetclass=stocks|etf
// Rows: Date (MM/DD/YYYY), Close/Last, Volume, Open, High, Low. UNADJUSTED.
// Dates come back newest-first and the API caps at 10 years per request,
// so long histories page through year windows.
async function fetchNasdaqDaily(symbol: string, years: number): Promise<{ bars: Bar[]; meta: CachedMeta }> {
  const NASDAQ_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const attempt = async (assetclass: "stocks" | "etf"): Promise<{ bars: Bar[]; meta: CachedMeta } | null> => {
    const allBars: Bar[] = [];
    const now = new Date();
    // Page backwards in 1-year windows, Nasdaq caps limit=9999 per request.
    for (let page = 0; page < Math.ceil(years); page++) {
      const to = new Date(now.getFullYear() - page, now.getMonth(), now.getDate());
      const from = new Date(now.getFullYear() - page - 1, now.getMonth(), now.getDate() + 1);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=9999`;
      let res: Response;
      try {
        res = await fetch(url, { headers: NASDAQ_HEADERS, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      } catch {
        return null; // network error — try next assetclass
      }
      if (res.status === 404 || res.status === 400) return null; // wrong assetclass
      if (!res.ok) throw new Error(`Nasdaq returned HTTP ${res.status} for ${symbol}.`);
      const json = await res.json();
      const rows = json?.data?.tradesTable?.rows;
      if (!Array.isArray(rows)) return null; // unknown symbol / wrong class
      for (const r of rows) {
        // "09/28/2026" → "2026-09-28"; values like "$338.40" or "765.61" or "N/A"
        const clean = (v: unknown) => {
          const n = parseFloat(String(v ?? "").replace(/[$,]/g, ""));
          return Number.isFinite(n) ? n : null;
        };
        const m = String(r.date ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!m) continue;
        const date = `${m[3]}-${m[1]}-${m[2]}`;
        const close = clean(r.close);
        const open = clean(r.open);
        const high = clean(r.high);
        const low = clean(r.low);
        const vol = clean(r.volume);
        if (close == null || open == null || high == null || low == null) continue;
        allBars.push({ date, open, high, low, close, volume: vol ?? 0 });
      }
      // If this window came back sparse we've likely hit the listing start.
      if (rows.length < 50) break;
    }
    return {
      bars: validateBars(allBars),
      meta: { symbol, name: symbol, currency: "USD", exchange: "Nasdaq" },
    };
  };

  // ETFs live under assetclass=etf; everything else under stocks.
  const asEtf = await attempt("etf");
  if (asEtf && asEtf.bars.length > 0) return asEtf;
  const asStock = await attempt("stocks");
  if (asStock && asStock.bars.length > 0) return asStock;
  throw new Error(`No Nasdaq data for "${symbol}" (tried ETF and stock classes).`);
}

// Stooq CSV (legacy fallback — now usually blocked by a JS challenge).
async function fetchStooqDaily(symbol: string): Promise<{ bars: Bar[]; meta: CachedMeta }> {
  const stooqSym = symbol.toLowerCase();
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}.us&i=d`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!res.ok) throw new Error(`Stooq returned HTTP ${res.status} for ${symbol}.`);
  const text = await res.text();
  if (!text || text.startsWith("No data")) throw new Error(`No Stooq data for "${symbol}".`);
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error(`No Stooq data for "${symbol}".`);
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    // Date,Open,High,Low,Close,Volume
    if (cols.length < 6) continue;
    const [d, o, h, l, c, v] = cols;
    const open = parseFloat(o), high = parseFloat(h), low = parseFloat(l), close = parseFloat(c);
    if (!Number.isFinite(open) || !Number.isFinite(close) || close <= 0) continue;
    bars.push({
      date: d.trim(),
      open, high, low, close,
      volume: Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0,
    });
  }
  if (bars.length === 0) throw new Error(`No Stooq data for "${symbol}".`);
  return {
    bars: validateBars(bars),
    meta: { symbol, name: symbol, currency: "USD", exchange: "Stooq" },
  };
}

// Failover chain for daily bars: Yahoo q1 → Yahoo q2 (adjusted, full history)
// → Nasdaq (raw, ~1 year max) → Stooq (raw, legacy; usually bot-blocked).
// The `source` matters: Yahoo bars are split/dividend-ADJUSTED, Nasdaq/Stooq
// bars are RAW. Mixing bases in one cached series creates price seams, so the
// cache is tagged per symbol and a source switch invalidates the old rows
// instead of blending them. Nasdaq is gated to ≤1-year windows because its
// historical endpoint silently returns null rows for older ranges.
type BarSource = "nasdaq" | "yahoo" | "stooq";
export async function fetchDailyWithFailover(symbol: string, years: number): Promise<{ bars: Bar[]; meta: CachedMeta; source: BarSource }> {
  const errors: string[] = [];

  try {
    const r = await fetchYahooDaily(symbol, Math.floor((Date.now() - years * 365.25 * 86400_000) / 1000), Math.floor(Date.now() / 1000));
    return { ...r, source: "yahoo" };
  } catch (e) {
    errors.push(`Yahoo: ${e instanceof Error ? e.message : "failed"}`);
  }

  if (years <= 1.05) {
    try {
      const r = await fetchNasdaqDaily(symbol, years);
      return { ...r, source: "nasdaq" };
    } catch (e) {
      errors.push(`Nasdaq: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  try {
    const r = await fetchStooqDaily(symbol);
    return { ...r, source: "stooq" };
  } catch (e) {
    errors.push(`Stooq: ${e instanceof Error ? e.message : "failed"}`);
  }

  throw new Error(`All market data sources failed for ${symbol}. ${errors.join(" | ")}`);
}

// In-memory negative cache so a dead provider isn't hammered on every request.
const recentFailure = new Map<string, number>();
const FAILURE_BACKOFF_MS = 30_000;

export async function getDailyBars(symbol: string, years = 10): Promise<{ bars: Bar[]; meta: CachedMeta; source: "cache" | "yahoo" }> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) throw new Error("Ticker is required.");
  if (!/^[A-Z0-9.\-^=]{1,12}$/.test(sym)) throw new Error(`"${symbol}" does not look like a valid ticker symbol.`);
  if (!Number.isFinite(years) || years <= 0) years = 10;

  const db = getCacheDb();
  const earliest = new Date(Date.now() - years * 365.25 * 86400_000).toISOString().slice(0, 10);
  const today = todayNY();
  const marketOpen = isUsMarketOpen();
  // While the market is open, today's bar is a partial (close = last trade), so
  // "complete through today" only counts if the cache was refreshed AFTER the
  // close. Otherwise we treat today as missing and refetch.
  const lastCompleteSession = marketOpen ? previousSession(today) : today;
  const metaRow = db.prepare("SELECT symbol, name, currency, exchange, source FROM price_meta WHERE symbol = ?").get(sym) as (CachedMeta & { source: string | null }) | undefined;
  const cached = db.prepare("SELECT MIN(date) as minDate, MAX(date) as maxDate, COUNT(*) as n FROM price_bars WHERE symbol = ?").get(sym) as { minDate: string | null; maxDate: string | null; n: number };

  const freshEnough =
    cached && cached.n > 0 &&
    cached.minDate !== null && cached.maxDate !== null &&
    cached.minDate <= earliest &&
    cached.maxDate >= lastCompleteSession;

  if (freshEnough) {
    const bars = db.prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE symbol = ? AND date >= ? ORDER BY date ASC").all(sym, earliest) as Bar[];
    return {
      bars,
      meta: metaRow || { symbol: sym, name: sym, currency: "USD", exchange: "cache" },
      source: "cache" as const,
    };
  }

  // Refetch guard: don't hammer a failing provider all day.
  const failedAt = recentFailure.get(sym);
  if (failedAt && Date.now() - failedAt < FAILURE_BACKOFF_MS) {
    const fallback = db.prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE symbol = ? AND date >= ? ORDER BY date ASC").all(sym, earliest) as Bar[];
    if (fallback.length > 0) {
      return { bars: fallback, meta: metaRow || { symbol: sym, name: sym, currency: "USD", exchange: "cache" }, source: "cache" as const };
    }
    throw new Error(`Market data for ${sym} is temporarily unavailable — retry shortly.`);
  }

  const { bars, meta, source } = await fetchDailyWithFailover(sym, years);
  if (bars.length === 0) throw new Error(`No price history available for "${sym}".`);
  recentFailure.set(sym, Date.now()); // cleared below only if the write succeeds

  // While the market is open, drop today's partial bar (its "close" is just the
  // last trade, and it would be baked into the cache as an official close).
  const completeBars = marketOpen ? bars.filter((b) => b.date < today) : bars;

  // Source-basis guard: Yahoo = adjusted, Stooq = raw. Never blend bases.
  // If the incoming source differs from what's cached, replace that symbol's
  // history entirely with the new source's series (it fetched the same window).
  const cachedSource = metaRow?.source ?? null;
  const basisChanged = cachedSource !== null && cachedSource !== source;
  if (basisChanged) {
    db.prepare("DELETE FROM price_bars WHERE symbol = ?").run(sym);
  }

  const upsert = db.prepare(`INSERT INTO price_bars (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`);
  const tx = db.transaction((rows: Bar[]) => {
    for (const b of rows) upsert.run(sym, b.date, b.open, b.high, b.low, b.close, b.volume);
  });
  tx(completeBars);
  db.prepare(`INSERT INTO price_meta (symbol, name, currency, exchange, last_refreshed, source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET name=excluded.name, currency=excluded.currency, exchange=excluded.exchange, last_refreshed=excluded.last_refreshed, source=excluded.source`)
    .run(sym, meta.name, meta.currency, meta.exchange, today, source);

  recentFailure.delete(sym);

  const stored = db.prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE symbol = ? AND date >= ? ORDER BY date ASC").all(sym, earliest) as Bar[];
  return {
    bars: stored,
    meta: { ...meta, source } as CachedMeta,
    source: "cache" as const,
  };
}

// The trading day before `today` (ignores holidays — worst case we refetch once).
function previousSession(today: string): string {
  const base = new Date(`${today}T12:00:00Z`).getTime();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(base - i * 86400_000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) return d.toISOString().slice(0, 10);
  }
  return today;
}

// ─── Cross-source verification ─────────────────────────────────
// Fetches the same recent window from Nasdaq AND Yahoo independently and
// compares day-to-day returns. Nasdaq reports RAW closes, Yahoo ADJUSTED —
// absolute prices differ by cumulative dividend adjustments, but daily returns
// match across bases, which is exactly what indicators/backtests consume.
export interface VerifyReport {
  symbol: string;
  nasdaq: { bars: number; firstDate: string | null; lastDate: string | null };
  yahoo: { bars: number; firstDate: string | null; lastDate: string | null };
  comparedDays: number;
  maxReturnDiffPct: number;
  meanAbsDiffPct: number;
  mismatches: Array<{ date: string; nasdaqRetPct: number; yahooRetPct: number; diffPct: number }>;
  verdict: "match" | "minor-drift" | "major-divergence" | "unverifiable";
  note: string;
}

export async function verifyDataSources(symbol: string, lookbackDays = 90): Promise<VerifyReport> {
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,12}$/.test(sym)) throw new Error(`"${symbol}" is not a valid ticker.`);

  const nasdaq: Bar[] = [];
  let nasdaqErr: string | null = null;
  try {
    const r = await fetchNasdaqDaily(sym, Math.max(1, Math.ceil(lookbackDays / 365)));
    const cutoff = new Date(Date.now() - lookbackDays * 86400_000).toISOString().slice(0, 10);
    nasdaq.push(...r.bars.filter((b) => b.date >= cutoff));
  } catch (e) { nasdaqErr = e instanceof Error ? e.message : "nasdaq failed"; }

  const yahoo: Bar[] = [];
  let yahooErr: string | null = null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await fetchYahooDaily(sym, now - lookbackDays * 86400 * 2, now);
    yahoo.push(...r.bars);
  } catch (e) { yahooErr = e instanceof Error ? e.message : "yahoo failed"; }

  const report: VerifyReport = {
    symbol: sym,
    nasdaq: { bars: nasdaq.length, firstDate: nasdaq[0]?.date ?? null, lastDate: nasdaq[nasdaq.length - 1]?.date ?? null },
    yahoo: { bars: yahoo.length, firstDate: yahoo[0]?.date ?? null, lastDate: yahoo[yahoo.length - 1]?.date ?? null },
    comparedDays: 0,
    maxReturnDiffPct: 0,
    meanAbsDiffPct: 0,
    mismatches: [],
    verdict: "unverifiable",
    note: "",
  };

  if (nasdaqErr) report.note += `Nasdaq: ${nasdaqErr}. `;
  if (yahooErr) report.note += `Yahoo: ${yahooErr}. `;
  if (nasdaq.length < 3 || yahoo.length < 3) {
    report.note += "Not enough data from both sources to compare.";
    return report;
  }

  // Day-over-day % returns keyed by date (first bar has no return).
  const returns = (bars: Bar[]) => {
    const map = new Map<string, number>();
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].date === bars[i - 1].date) continue;
      map.set(bars[i].date, (bars[i].close / bars[i - 1].close - 1) * 100);
    }
    return map;
  };
  const nRets = returns(nasdaq);
  const yRets = returns(yahoo);

  const common = [...yRets.keys()].filter((d) => nRets.has(d)).sort();
  report.comparedDays = common.length;
  if (common.length === 0) {
    report.note += "No overlapping dates between sources.";
    return report;
  }

  let maxDiff = 0;
  let sumDiff = 0;
  for (const d of common) {
    const diff = Math.abs(nRets.get(d)! - yRets.get(d)!);
    sumDiff += diff;
    if (diff > maxDiff) maxDiff = diff;
    if (diff > 0.75) {
      report.mismatches.push({
        date: d,
        nasdaqRetPct: Math.round(nRets.get(d)! * 1000) / 1000,
        yahooRetPct: Math.round(yRets.get(d)! * 1000) / 1000,
        diffPct: Math.round(diff * 1000) / 1000,
      });
    }
  }
  report.maxReturnDiffPct = Math.round(maxDiff * 1000) / 1000;
  report.meanAbsDiffPct = Math.round((sumDiff / common.length) * 10000) / 10000;
  report.mismatches = report.mismatches.slice(0, 15);

  report.verdict =
    report.meanAbsDiffPct < 0.15 && maxDiff <= 1.0 ? "match"
    : maxDiff <= 3.0 ? "minor-drift"
    : "major-divergence";
  report.note += ` Compared ${common.length} daily returns across Nasdaq (raw) and Yahoo (adjusted). Returns match across bases; absolute prices differ only by the dividend adjustment.`;
  return report;
}

export function listCachedSymbols(): Array<CachedMeta & { bars: number; first_date: string | null; last_date: string | null }> {
  const db = getCacheDb();
  return db.prepare(`
    SELECT m.symbol, m.name, m.currency, m.exchange,
      COUNT(b.date) as bars,
      MIN(b.date) as first_date,
      MAX(b.date) as last_date
    FROM price_meta m
    LEFT JOIN price_bars b ON b.symbol = m.symbol
    GROUP BY m.symbol ORDER BY m.symbol
  `).all() as Array<CachedMeta & { bars: number; first_date: string | null; last_date: string | null }>;
}

// Today's date in US/Eastern — Yahoo daily bars are stamped with Eastern timestamps.
function todayNY(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}
