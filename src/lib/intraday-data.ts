// ─── Intraday history for day-trading research ───────────────────────────
//
// The rest of the app runs on daily bars (market-data.ts). A day-trading
// question ("does this signal still work when the position is opened and
// closed inside one session?") cannot be answered from daily data at all, so
// this module adds a second, timestamped bar series with the same `Bar` shape
// the backtest engine already consumes.
//
// Source: Alpaca Market Data API (https://alpaca.markets/data).
//   • free plan: 7+ years of minute/hour aggregate bars, 200 requests/min,
//     no per-record charge — enough for a real multi-year test.
//   • the free plan serves the IEX feed only. That is real trade data, but
//     roughly 2-3 % of consolidated volume and no opening/closing auction
//     prints, so a run on it answers "what does this do on a thin tape" — not
//     "what would SIP have done". feed=sip needs Algo Trader Plus ($99/mo).
//   • bars are split-adjusted (`adjustment=split`), which is the basis the
//     daily cache uses too, so the two series do not disagree at a split.
//
// Alternatives if the feed depth matters more than the price: Databento
// (usage-based, consolidated US equities, free credits on signup) or Alpaca
// Algo Trader Plus (flat monthly, SIP). Both plug into the same `Bar[]`.
//
// Credentials — either naming works, the app never writes them anywhere:
//   ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY
//   APCA_API_KEY_ID   / APCA_API_SECRET_KEY   (Alpaca's own names)
//
// Nothing here runs unless credentials are present: `hasIntradayData()` is the
// guard the harness checks before it tries to fetch.

import Database from "better-sqlite3";
import path from "path";
import { INTRADAY_TABLES_SQL } from "./db";
import type { Bar } from "./market-data";

const DB_PATH =
  process.env.STOCKFOLIO_DB_PATH ||
  process.env.ACCUBOOKS_DB_PATH ||
  path.join(process.cwd(), "portfolio.db");

export const INTRADAY_TIMEFRAMES = ["1Min", "5Min", "15Min", "1Hour"] as const;
export type IntradayTimeframe = (typeof INTRADAY_TIMEFRAMES)[number];

/** Minutes represented by one bar, per Alpaca timeframe token. */
export const TIMEFRAME_MINUTES: Record<IntradayTimeframe, number> = {
  "1Min": 1,
  "5Min": 5,
  "15Min": 15,
  "1Hour": 60,
};

export const INTRADAY_SOURCE = "alpaca-iex";

export interface AlpacaCredentials {
  keyId: string;
  secret: string;
  /** Which env naming was used — reported by the harness, never logged with values. */
  from: "ALPACA" | "APCA";
}

/** Read the API credentials from the environment, or null when unset. */
export function alpacaCredentials(): AlpacaCredentials | null {
  const pair =
    process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY
      ? ([process.env.ALPACA_API_KEY_ID, process.env.ALPACA_API_SECRET_KEY, "ALPACA"] as const)
      : process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY
        ? ([process.env.APCA_API_KEY_ID, process.env.APCA_API_SECRET_KEY, "APCA"] as const)
        : null;
  if (!pair) return null;
  const [keyId, secret, from] = pair;
  if (!keyId.trim() || !secret.trim()) return null;
  return { keyId: keyId.trim(), secret: secret.trim(), from };
}

/** True when a key is configured — the gate every intraday run checks first. */
export function hasIntradayData(): boolean {
  return alpacaCredentials() !== null;
}

/** One raw Alpaca bar as the REST API returns it. */
export interface AlpacaBar {
  t: string; // ISO timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AlpacaBarsPage {
  bars?: AlpacaBar[] | null;
  next_page_token?: string | null;
  symbol?: string;
}

/**
 * Map one Alpaca page to the app's bar shape. Bars with a non-finite price are
 * dropped rather than carried into a backtest (a NaN close silently poisons
 * every indicator downstream).
 */
export function mapAlpacaBars(page: AlpacaBarsPage): Bar[] {
  const out: Bar[] = [];
  for (const b of page.bars ?? []) {
    if (!b || typeof b.t !== "string") continue;
    const values = [b.o, b.h, b.l, b.c].map(Number);
    if (values.some((v) => !Number.isFinite(v))) continue;
    out.push({
      date: b.t,
      open: Number(b.o),
      high: Number(b.h),
      low: Number(b.l),
      close: Number(b.c),
      volume: Number.isFinite(Number(b.v)) ? Number(b.v) : 0,
    });
  }
  return out;
}

/**
 * Roll smaller bars up into `minutes`-minute bars (splitting the series into
 * sessions first, so a bar never spans an overnight gap). Pure, so the
 * arithmetic is testable without a network call.
 */
export function aggregateBars(bars: Bar[], minutes: number): Bar[] {
  if (minutes <= 1 || bars.length === 0) return bars;
  const out: Bar[] = [];
  const bucketKey = (ts: string) => {
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return ts;
    return String(Math.floor(ms / (minutes * 60_000)));
  };
  let cur: Bar | null = null;
  let curKey = "";
  for (const b of bars) {
    const day = b.date.slice(0, 10);
    const key = `${day}|${bucketKey(b.date)}`;
    if (cur && key === curKey) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      cur = { ...b };
      curKey = key;
      out.push(cur);
    }
  }
  return out;
}

/** Session date (UTC day) of an intraday timestamp. */
export const sessionOf = (ts: string): string => ts.slice(0, 10);

interface IntradayRow {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

let cacheDb: Database.Database | null = null;
function getDb(): Database.Database {
  if (!cacheDb) {
    cacheDb = new Database(DB_PATH);
    cacheDb.pragma("journal_mode = WAL");
    cacheDb.exec(INTRADAY_TABLES_SQL);
    cacheDb.pragma("synchronous = NORMAL");
  }
  return cacheDb;
}

export interface IntradayMeta {
  symbol: string;
  timeframe: IntradayTimeframe;
  firstTs: string;
  lastTs: string;
  source: string;
}

/** What the local cache holds for a symbol/timeframe (null = nothing yet). */
export function intradayMeta(symbol: string, timeframe: IntradayTimeframe): IntradayMeta | null {
  const row = getDb()
    .prepare("SELECT symbol, timeframe, first_ts, last_ts, source FROM intraday_meta WHERE symbol = ? AND timeframe = ?")
    .get(symbol.toUpperCase(), timeframe) as
    | { symbol: string; timeframe: string; first_ts: string | null; last_ts: string | null; source: string | null }
    | undefined;
  if (!row || !row.first_ts || !row.last_ts) return null;
  return {
    symbol: row.symbol,
    timeframe: row.timeframe as IntradayTimeframe,
    firstTs: row.first_ts,
    lastTs: row.last_ts,
    source: row.source ?? INTRADAY_SOURCE,
  };
}

/** Bars already cached for a symbol/timeframe, oldest first. */
export function cachedIntradayBars(symbol: string, timeframe: IntradayTimeframe): Bar[] {
  const rows = getDb()
    .prepare(
      "SELECT ts, open, high, low, close, volume FROM intraday_bars WHERE symbol = ? AND timeframe = ? ORDER BY ts ASC"
    )
    .all(symbol.toUpperCase(), timeframe) as IntradayRow[];
  return rows.map((r) => ({
    date: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

export function storeIntradayBars(symbol: string, timeframe: IntradayTimeframe, bars: Bar[]): number {
  if (bars.length === 0) return 0;
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO intraday_bars (symbol, timeframe, ts, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`
  );
  const write = db.transaction((rows: Bar[]) => {
    for (const b of rows) {
      upsert.run(symbol.toUpperCase(), timeframe, b.date, b.open, b.high, b.low, b.close, b.volume);
    }
  });
  write(bars);
  const first = bars[0].date;
  const last = bars[bars.length - 1].date;
  db.prepare(
    `INSERT INTO intraday_meta (symbol, timeframe, first_ts, last_ts, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe) DO UPDATE SET
       first_ts=MIN(intraday_meta.first_ts, excluded.first_ts),
       last_ts=MAX(intraday_meta.last_ts, excluded.last_ts),
       source=excluded.source, fetched_at=excluded.fetched_at`
  ).run(symbol.toUpperCase(), timeframe, first, last, INTRADAY_SOURCE, new Date().toISOString());
  return bars.length;
}

export interface FetchIntradayOptions {
  timeframe?: IntradayTimeframe;
  /** Inclusive ISO date (YYYY-MM-DD) or timestamp. */
  start: string;
  /** Exclusive ISO date (YYYY-MM-DD) or timestamp. */
  end?: string;
  /** Alpaca feed: "iex" is the free one, "sip" needs a paid subscription. */
  feed?: "iex" | "sip";
  /** Max pages to follow (10 000 bars each) — a runaway guard, not a limit to tune. */
  maxPages?: number;
}

interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

/**
 * Fetch bars page by page from Alpaca. `deps.fetchImpl` exists so the pagination
 * and mapping can be tested without a key or a network call.
 */
export async function fetchAlpacaBars(
  symbol: string,
  opts: FetchIntradayOptions,
  deps: { fetchImpl?: FetchLike; credentials?: AlpacaCredentials | null } = {}
): Promise<Bar[]> {
  const creds = deps.credentials ?? alpacaCredentials();
  if (!creds) {
    throw new Error(
      "No Alpaca market-data credentials. Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY " +
        "(or APCA_API_KEY_ID / APCA_API_SECRET_KEY) — a free Alpaca account includes 7+ years of minute bars."
    );
  }
  const doFetch = (deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const sym = symbol.trim().toUpperCase();
  const timeframe = opts.timeframe ?? "1Min";
  const feed = opts.feed ?? "iex";
  const maxPages = opts.maxPages ?? 60;

  let token: string | null = null;
  const bars: Bar[] = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      timeframe,
      start: opts.start,
      limit: "10000",
      adjustment: "split",
      feed,
    });
    if (opts.end) params.set("end", opts.end);
    if (token) params.set("page_token", token);

    const res = await doFetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?${params}`, {
      headers: {
        "APCA-API-KEY-ID": creds.keyId,
        "APCA-API-SECRET-KEY": creds.secret,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Alpaca bars for ${sym} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as AlpacaBarsPage;
    bars.push(...mapAlpacaBars(json));
    token = json.next_page_token ?? null;
    if (!token) break;
  }
  if (bars.length === 0) {
    throw new Error(
      `Alpaca returned no ${timeframe} bars for ${sym} in ${opts.start}..${opts.end ?? "now"}. ` +
        "Check the ticker, the date range, and that the feed is allowed on your plan."
    );
  }
  return bars;
}

export interface IntradayResult {
  bars: Bar[];
  source: "cache" | "alpaca";
  meta: IntradayMeta | null;
}

/**
 * Cache-first intraday history: whatever the local `intraday_bars` table already
 * covers is used as-is, and only the uncovered front of the window is fetched.
 * Repeat runs of the same harness are then offline, exactly like daily bars.
 */
export async function getIntradayBars(
  symbol: string,
  opts: FetchIntradayOptions,
  deps: { fetchImpl?: FetchLike; credentials?: AlpacaCredentials | null; refresh?: boolean } = {}
): Promise<IntradayResult> {
  const timeframe = opts.timeframe ?? "1Min";
  const cached = deps.refresh ? [] : cachedIntradayBars(symbol, timeframe);
  const wantedStart = opts.start;
  const covers = cached.length > 0 && cached[0].date.slice(0, 10) <= wantedStart.slice(0, 10);
  if (covers) {
    const end = opts.end;
    const bars = end ? cached.filter((b) => b.date < end) : cached;
    if (bars.length > 0) return { bars, source: "cache", meta: intradayMeta(symbol, timeframe) };
  }
  const fetched = await fetchAlpacaBars(symbol, { ...opts, timeframe }, deps);
  storeIntradayBars(symbol, timeframe, fetched);
  const all = cachedIntradayBars(symbol, timeframe);
  const end = opts.end;
  return {
    bars: end ? all.filter((b) => b.date < end) : all,
    source: "alpaca",
    meta: intradayMeta(symbol, timeframe),
  };
}
