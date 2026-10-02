// Real-time quotes via Yahoo Finance.
//
// Key points:
// - TRUE live prices, matching what Yahoo's own web cards show (like the
//   SHOP/MRVL/CRWV cards): during the regular session this is the streaming
//   regularMarketPrice; outside regular hours the **last extended-hours
//   trade** (pre/post market) is the live price you see on the web.
// - includePrePost=true so the 1-minute series covers pre-market + regular +
//   after-hours. The last bar's close is the true "last traded price".
// - The quote is cached only for LIVE_TTL_MS (default 3s), so the UI polling
//   every ~3s always sees fresh data, not stale numbers.
// - No API key required.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const LIVE_TTL_MS = 3_000;
const INTRADAY_TTL_MS = 60_000;

// Multi-source failover: Yahoo query1 → query2 (independent rate-limit pools)
// → Stooq (last daily close as a degraded-but-real fallback).
const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

async function fetchChartJson(sym: string): Promise<unknown> {
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      // includePrePost=true — extend the 1m series across pre-market and
      // after-hours so the "last price" reflects the newest trade anywhere in
      // the trading day, exactly like Yahoo's web quote cards.
      const url = `${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 404) throw new Error(`Ticker "${sym}" not found. Check the symbol (e.g. AAPL, MSFT, SPY).`);
      if (!res.ok) throw new Error(`Market data provider returned HTTP ${res.status} for ${sym}.`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`All Yahoo endpoints failed for ${sym}.`);
}

// Stooq fallback: returns the last daily close as the "live" price.
async function stooqFallback(sym: string): Promise<LiveQuote> {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}.us&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!res.ok) throw new Error(`Stooq returned HTTP ${res.status} for ${sym}.`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error(`No Stooq quote for "${sym}".`);
  const cols = lines[1].split(",");
  // Symbol,Date,Time,Open,High,Low,Close,Volume
  const close = parseFloat(cols[6]);
  const open = parseFloat(cols[3]);
  const high = parseFloat(cols[4]);
  const low = parseFloat(cols[5]);
  if (!Number.isFinite(close) || close <= 0) throw new Error(`No Stooq quote for "${sym}".`);
  const quote: LiveQuote = {
    symbol: sym,
    name: null,
    currency: "USD",
    exchange: "Stooq",
    price: close,
    previousClose: Number.isFinite(open) ? open : null,
    change: Number.isFinite(open) ? close - open : null,
    changePercent: Number.isFinite(open) && open !== 0 ? ((close - open) / open) * 100 : null,
    dayHigh: Number.isFinite(high) ? high : null,
    dayLow: Number.isFinite(low) ? low : null,
    yearHigh: null,
    yearLow: null,
    volume: Number.isFinite(parseFloat(cols[7])) ? parseFloat(cols[7]) : null,
    marketState: "CLOSED",
    preMarket: null,
    postMarket: null,
    quoteTime: Date.now(),
    lastTradeTime: Date.now(),
    priceHint: null,
    lastRegularClose: null,
    displayPrice: close,
    displayChange: null,
    displayChangePercent: null,
    displaySession: null,
  };
  return quote;
}

export interface LiveQuote {
  symbol: string;
  name: string | null;
  currency: string;
  exchange: string | null;
  price: number | null;         // regular-session last price (Yahoo regularMarketPrice)
  previousClose: number | null;
  change: number | null;        // regular-session change vs previous close
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  volume: number | null;
  marketState: string | null;   // REGULAR / PRE / POST / CLOSED / PREPRE / POSTPOST
  preMarket: number | null;
  postMarket: number | null;
  quoteTime: number | null;     // epoch ms of the last regular quote
  lastTradeTime: number | null; // epoch ms of the newest trade in ANY session (pre/regular/post)
  priceHint: number | null;     // exchange quoting decimals (sub-$1 = 4)
  lastRegularClose: number | null; // previous regular close, session-corrected
  // ── Extended-hours "what the web shows" fields ──
  // displayPrice = the price a quote card would show right now: the newest
  // trade across pre + regular + post sessions. displayChange/Percent are
  // Yahoo's card convention: vs previous close during regular hours, and vs
  // the regular-session close during extended hours.
  displayPrice: number | null;
  displayChange: number | null;
  displayChangePercent: number | null;
  displaySession: string | null; // "pre" | "regular" | "post" | null
}

export interface IntradayPoint {
  t: number;     // epoch ms
  price: number;
}

interface CacheEntry<T> {
  at: number;
  data: T;
}

const liveCache = new Map<string, CacheEntry<LiveQuote>>();
const intradayCache = new Map<string, CacheEntry<IntradayPoint[]>>();

function validSymbol(raw: string): string | null {
  const sym = raw.trim().toUpperCase();
  return /^[A-Z0-9.\-^=]{1,12}$/.test(sym) ? sym : null;
}

// ─── Market-hours detection (US Eastern time fallback) ─────────
// Yahoo's chart endpoint often omits marketState; derive it from the quote
// timestamp and US market hours (4:00–9:30 pre, 9:30–16:00 regular,
// 16:00–20:00 post ET, Mon–Fri). A session counts as live only if the last
// trade is fresh (extended-hours trades trickle in slowly; a stale timestamp
// means the session ended and the market is effectively closed).
function marketStateFallback(m: Record<string, unknown>): string {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const qt = n(m.regularMarketTime); // epoch seconds
  const now = qt !== null ? new Date(qt * 1000) : new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => et.find((p) => p.type === t)?.value ?? "";
  const mins = parseInt(get("hour"), 10) % 24 * 60 + parseInt(get("minute"), 10);
  const day = get("weekday");

  if (day === "Sat" || day === "Sun") return "CLOSED";

  const age = qt !== null ? Date.now() / 1000 - qt : 0;
  if (mins >= 570 && mins < 960) {
    return age < 300 ? "REGULAR" : "CLOSED"; // 9:30–16:00 ET; stale quote = closed
  }
  if (mins >= 240 && mins < 570) return age < 1800 ? "PRE" : "CLOSED";   // 4:00–9:30 ET
  if (mins >= 960 && mins < 1200) return age < 1800 ? "POST" : "CLOSED"; // 16:00–20:00 ET
  return "CLOSED";
}

// ─── Live quote + intraday bars in one request ──────────────────
export async function getLiveQuote(symbol: string): Promise<LiveQuote> {
  const sym = validSymbol(symbol);
  if (!sym) throw new Error(`"${symbol}" does not look like a valid ticker symbol (e.g. AAPL, MSFT, SPY).`);

  const cached = liveCache.get(sym);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.data;

  // range=1d&interval=1m&includePrePost=true: meta carries the regular-session
  // price; the 1m bar series carries pre/regular/post trades whose last close
  // is the newest traded price of the day (what Yahoo's cards display).
  // Multi-source: Yahoo q1 → q2; if both fail, Stooq last close.
  let json: {
    chart?: {
      result?: Array<{
        meta?: Record<string, unknown>;
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: unknown[] }> };
      }>;
      error?: { description?: string } | null;
    };
  };
  try {
    json = await fetchChartJson(sym) as typeof json;
  } catch (yahooErr) {
    try {
      const q = await stooqFallback(sym);
      liveCache.set(sym, { at: Date.now(), data: q });
      return q;
    } catch {
      throw yahooErr instanceof Error ? yahooErr : new Error(`All market data sources failed for ${sym}.`);
    }
  }
  const result = json?.chart?.result?.[0];
  if (!result) {
    const desc = json?.chart?.error?.description;
    throw new Error(desc ? `Market data error: ${desc}` : `No data for "${sym}".`);
  }

  const m = result.meta ?? {};
  const ts: number[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes: unknown[] = result.indicators?.quote?.[0]?.close ?? [];

  const points: IntradayPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) {
      points.push({ t: ts[i] * 1000, price: c });
    }
  }

  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const price = n(m.regularMarketPrice);
  const prev = n(m.chartPreviousClose) ?? n(m.previousClose);

  // ── Extended-hours display price: the newest trade across all sessions ──
  // Yahoo web cards show the post/pre-market trade as the headline price when
  // the regular session is closed (e.g. MRVL 268.36 +1.57% after 4pm).
  // Compute the last bar's close and label the session from its timestamp and
  // the exchange's tradingPeriods so "what the user sees" matches the web.
  // points only contains non-null closes (filtered above), so the last entry
  // is the newest traded price of the day.
  const lastBarPrice: number | null = points.length > 0 ? points[points.length - 1].price : null;
  const lastBarTime: number | null = points.length > 0 ? points[points.length - 1].t : null;

  let session: "pre" | "regular" | "post" | null = null;
  if (lastBarTime !== null) {
    const periods = m.tradingPeriods as Record<string, unknown> | undefined;
    const pick = (key: string): { start: number; end: number } | null => {
      const seg = (periods?.[key] as Array<Array<{ start?: number; end?: number }>> | undefined)?.[0]?.[0];
      return seg && typeof seg.start === "number" && typeof seg.end === "number"
        ? { start: seg.start * 1000, end: seg.end * 1000 }
        : null;
    };
    const pre = pick("pre"), reg = pick("regular"), post = pick("post");
    const t = lastBarTime;
    // Classification order matters: 16:00 falls in both post and regular end.
    if (post && t >= post.start) session = "post";
    else if (reg && t >= reg.start) session = "regular";
    else if (pre && t >= pre.start) session = "pre";
    // Fallback when the exchange gives no tradingPeriods (crypto, indices):
    if (session === null) {
      const state = typeof m.marketState === "string" ? m.marketState : marketStateFallback(m);
      if (state.startsWith("PRE")) session = "pre";
      else if (state.startsWith("POST")) session = "post";
      else session = "regular";
    }
  }

  // Previous regular close, session-corrected: during pre/post hours Yahoo's
  // chartPreviousClose points at the close BEFORE the last completed regular
  // session (wrong baseline for a new day), while regularMarketPrice IS that
  // session's close. During regular hours chartPreviousClose is correct.
  const lastRegularClose = session === "regular" || session === null ? prev : (price ?? prev);

  // Headline price shown by the UI: newest trade anywhere in the day.
  const displayPrice = lastBarPrice ?? price;
  // Card convention: during regular hours change is vs previous close; in
  // extended hours it's vs the regular-session close (matches Yahoo cards).
  const displayChange =
    displayPrice !== null && prev !== null
      ? session === "regular" || session === null
        ? displayPrice - prev
        : displayPrice - (price ?? prev)
      : null;
  const displayChangeBase = displayChange !== null && displayPrice !== null
    ? (session === "regular" || session === null ? prev : (price ?? prev))
    : null;
  const displayChangePercent =
    displayChange !== null && displayChangeBase !== null && displayChangeBase !== 0
      ? (displayChange / displayChangeBase) * 100
      : null;

  // Market state: prefer Yahoo's own; else derive it, but trust the newest
  // trade timestamp so a fresh post-market bar shows AFTER HOURS, not CLOSED.
  let marketState = typeof m.marketState === "string" && m.marketState ? m.marketState : marketStateFallback(m);
  const nowMs = Date.now();
  const freshTrade = lastBarTime !== null && nowMs - lastBarTime < 15 * 60_000;
  if (session === "post" && !marketState.startsWith("POST")) {
    marketState = freshTrade ? "POST" : "CLOSED";
  } else if (session === "pre" && !marketState.startsWith("PRE")) {
    marketState = freshTrade ? "PRE" : "CLOSED";
  }

  // Timestamp of the newest trade in any session — during extended hours this
  // is minutes old while regularMarketTime still points at yesterday 16:00.
  const lastTradeTime = lastBarTime ?? (n(m.regularMarketTime) !== null ? n(m.regularMarketTime)! * 1000 : null);

  const quote: LiveQuote = {
    symbol: typeof m.symbol === "string" ? m.symbol : sym,
    name: typeof m.longName === "string" ? m.longName : typeof m.shortName === "string" ? m.shortName : null,
    currency: typeof m.currency === "string" ? m.currency : "USD",
    exchange: typeof m.fullExchangeName === "string" ? m.fullExchangeName : null,
    price,
    previousClose: prev,
    change: price !== null && prev !== null ? price - prev : null,
    changePercent: price !== null && prev !== null && prev !== 0 ? ((price - prev) / prev) * 100 : null,
    dayHigh: n(m.regularMarketDayHigh),
    dayLow: n(m.regularMarketDayLow),
    yearHigh: n(m.fiftyTwoWeekHigh),
    yearLow: n(m.fiftyTwoWeekLow),
    volume: n(m.regularMarketVolume),
    marketState,
    preMarket: n(m.preMarketPrice),
    postMarket: n(m.postMarketPrice),
    quoteTime: n(m.regularMarketTime) !== null ? n(m.regularMarketTime)! * 1000 : null,
    lastTradeTime,
    priceHint: n(m.priceHint),
    lastRegularClose,
    displayPrice,
    displayChange,
    displayChangePercent,
    displaySession: session,
  };

  liveCache.set(sym, { at: Date.now(), data: quote });
  if (points.length > 0) intradayCache.set(sym, { at: Date.now(), data: points });
  return quote;
}

// ─── Intraday 1-minute bars for the sparkline ───────────────────
// Reuses getLiveQuote — the same request populates both caches.
export async function getIntradayBars(symbol: string): Promise<IntradayPoint[]> {
  const sym = validSymbol(symbol);
  if (!sym) throw new Error(`"${symbol}" does not look like a valid ticker symbol.`);

  const cached = intradayCache.get(sym);
  if (cached && Date.now() - cached.at < INTRADAY_TTL_MS) return cached.data;

  await getLiveQuote(sym);
  const fresh = intradayCache.get(sym);
  return fresh ? fresh.data : [];
}
