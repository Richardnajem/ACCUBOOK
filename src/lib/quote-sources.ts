// ─── Multi-source quote aggregation with cross-verification ─────────────
//
// Every source below is keyless and free. They disagree with each other in
// predictable ways — the point of this module is to surface the freshest
// extended-hours price AND show the user exactly what each source reports,
// so "is this live?" can be answered at a glance:
//
//   Yahoo v8 chart   — regular + pre/post 1m bars; fulldayPrice meta = newest trade
//   Nasdaq api       — OFFICIAL exchange feed, real-time pre/post market
//   CBOE delayed     — 15-min delayed but reliable; current_price follows ext-hours
//   TradingView      — fast, premarket fields in scanner API
//   CNBC             — regular session only (exthrs ignored); useful for the close
//
// The aggregator picks the quote with the NEWEST last-trade timestamp as the
// headline and reports per-source data so the UI can display agreement.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SRC_TIMEOUT_MS = 8_000;

export interface SourceQuote {
  source: string;          // "Yahoo" | "Nasdaq" | "CBOE" | "TradingView" | "CNBC"
  ok: boolean;
  error?: string;
  price: number | null;          // headline price this source shows right now
  previousClose: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  marketState: string | null;
  /** epoch ms of the trade this price came from (null = unknown) */
  tradeTime: number | null;
  /** true when the source's headline price covers extended hours */
  extended: boolean;
  /** source latency in ms */
  ms: number;
  /** decimal places the exchange quotes this symbol at (sub-$1 = 4) */
  priceHint: number | null;
  /** top-of-book, when the source publishes it */
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface AggregatedQuote {
  price: number | null;
  previousClose: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  marketState: string | null;
  tradeTime: number | null;
  /** best bid across sources (highest) */
  bid: number | null;
  /** best ask across sources (lowest) */
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  /** which sources supplied the winning bid/ask */
  bidSource: string | null;
  askSource: string | null;
  /** ask − bid, in price units and % of the midpoint */
  spreadAbs: number | null;
  /** book spread as % of the mid price */
  bookSpreadPct: number | null;
  sources: SourceQuote[];
  /** how many sources reported a price */
  agreeing: number;
  /** spread across source PRICES (disagreement), in percent of the median */
  spreadPct: number | null;
  /** names of sources whose price is within 1% of the chosen median */
  verifiedBy: string[];
  /** exchange quoting decimals for this symbol (sub-$1 = 4) */
  priceHint: number | null;
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SRC_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[$,%\s]/g, "").replace(/,/g, "");
    const n = parseFloat(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

// Tie-break when sources stamp the same trade second: the exchange's own
// feed is authoritative, aggregators can lag by a tick.
const SOURCE_PRIORITY: Record<string, number> = {
  Nasdaq: 5,
  Yahoo: 4,
  CBOE: 3,
  TradingView: 2,
  CNBC: 1,
};

// Nasdaq sends "Oct 1, 2026 7:44 AM ET" — parse to epoch ms.
function parseNasdaqTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return null;
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = months[m[1]];
  if (mon === undefined) return null;
  let hour = parseInt(m[4], 10);
  const ap = m[6];
  if (ap === "PM" && hour < 12) hour += 12;
  if (ap === "AM" && hour === 12) hour = 0;
  // ET offset: -4 during DST, -5 otherwise. Derive via a fixed-grid trick.
  const etOffset = getEtOffsetHours(Date.UTC(+m[3], mon, +m[2]));
  const ms = Date.UTC(+m[3], mon, +m[2], hour, parseInt(m[5], 10)) - etOffset * 3600_000;
  return ms;
}

// US Eastern offset at a given UTC instant (DST rules 2007+: 2nd Sun Mar – 1st Sun Nov).
function getEtOffsetHours(utcMs: number): number {
  const y = new Date(utcMs).getUTCFullYear();
  const mar1 = Date.UTC(y, 2, 1);
  const nov1 = Date.UTC(y, 10, 1);
  // Second Sunday of March: first Sunday = (7 - weekday(Mar1)) % 7 days in, +7 more.
  const dstStart = mar1 + (((7 - new Date(mar1).getUTCDay()) % 7) + 7) * 86400_000 + 2 * 3600_000;
  // First Sunday of November.
  const dstEnd = nov1 + ((7 - new Date(nov1).getUTCDay()) % 7) * 86400_000 + 2 * 3600_000;
  return utcMs >= dstStart && utcMs < dstEnd ? -4 : -5;
}

// ─── 1. Yahoo v8 chart (already the workhorse) ─────────────────
export async function yahooQuote(sym: string): Promise<SourceQuote> {
  const started = Date.now();
  try {
    const res = await timedFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) throw new Error("empty chart result");
    const m = r.meta ?? {};
    const ts: number[] = Array.isArray(r.timestamp) ? r.timestamp : [];
    const closes: unknown[] = r.indicators?.quote?.[0]?.close ?? [];
    // newest non-null bar close = newest trade (pre + regular + post)
    let price = typeof m.fulldayPrice === "number" ? m.fulldayPrice : null;
    let tradeTime: number | null = null;
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c)) {
        if (price === null) price = c;
        tradeTime = ts[i] * 1000;
        break;
      }
    }
    if (price === null) price = typeof m.regularMarketPrice === "number" ? m.regularMarketPrice : null;
    const prev = num(m.chartPreviousClose) ?? num(m.previousClose);
    return {
      source: "Yahoo", ok: true, ms: Date.now() - started,
      price, previousClose: prev,
      changePercent: price !== null && prev ? ((price - prev) / prev) * 100 : null,
      dayHigh: num(m.regularMarketDayHigh), dayLow: num(m.regularMarketDayLow),
      volume: num(m.regularMarketVolume),
      marketState: typeof m.marketState === "string" ? m.marketState : null,
      tradeTime, extended: true,
      priceHint: num(m.priceHint),
      // v8 chart meta doesn't carry top-of-book; peers fill it in.
      bid: null, ask: null, bidSize: null, askSize: null,
    };
  } catch (e) {
    return { source: "Yahoo", ok: false, error: e instanceof Error ? e.message : "failed", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: Date.now() - started, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null };
  }
}

// ─── 2. Nasdaq official API (real-time incl. pre/post) ─────────
export async function nasdaqQuote(sym: string): Promise<SourceQuote> {
  const started = Date.now();
  try {
    const res = await timedFetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=stocks`, {
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data;
    const p = d?.primaryData;  // real-time (regular + pre/post)
    const s = d?.secondaryData; // previous regular close
    if (!p) throw new Error("no primaryData");
    const price = num(p.lastSalePrice);
    if (price === null) throw new Error("no price");
    const rt = p.isRealTime !== false;
    return {
      source: "Nasdaq", ok: true, ms: Date.now() - started,
      price,
      previousClose: num(s?.lastSalePrice),
      changePercent: num(p.percentageChange),
      dayHigh: num(d?.highPrice),
      dayLow: num(d?.lowPrice),
      volume: num(d?.volume) ?? num(p?.volume),
      marketState: rt ? "REALTIME" : "DELAYED",
      tradeTime: parseNasdaqTime(p.lastTradeTimestamp),
      extended: rt,
      priceHint: price < 1 ? 4 : 2,
      bid: num(p.bidPrice), ask: num(p.askPrice),
      bidSize: num(p.bidSize), askSize: num(p.askSize),
    };
  } catch (e) {
    return { source: "Nasdaq", ok: false, error: e instanceof Error ? e.message : "failed", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: Date.now() - started, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null };
  }
}

// ─── 3. CBOE delayed quotes (reliable, 15-min delayed) ─────────
export async function cboeQuote(sym: string): Promise<SourceQuote> {
  const started = Date.now();
  try {
    const res = await timedFetch(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${encodeURIComponent(sym)}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data;
    if (!d || typeof d.current_price !== "number") throw new Error("no data");
    // CBOE last_trade_time is ET-naive (e.g. "2026-09-30T15:59:59") — convert
    // to epoch by subtracting the ET offset from the naive-as-UTC parse.
    const lastTrade = typeof d.last_trade_time === "string"
      ? (() => {
          const asUtc = Date.parse(d.last_trade_time + "Z");
          return Number.isFinite(asUtc) ? asUtc - getEtOffsetHours(asUtc) * 3600_000 : null;
        })()
      : null;
    return {
      source: "CBOE", ok: true, ms: Date.now() - started,
      price: d.current_price,
      previousClose: num(d.close),
      changePercent: num(d.price_change_percent),
      dayHigh: num(d.high), dayLow: num(d.low),
      volume: num(d.volume),
      marketState: "DELAYED",
      tradeTime: lastTrade !== null && Number.isFinite(lastTrade) ? lastTrade : null,
      extended: true,
      priceHint: d.current_price < 1 ? 4 : 2,
      bid: num(d.bid), ask: num(d.ask),
      bidSize: num(d.bid_size), askSize: num(d.ask_size),
    };
  } catch (e) {
    return { source: "CBOE", ok: false, error: e instanceof Error ? e.message : "failed", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: Date.now() - started, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null };
  }
}

// ─── 4. TradingView scanner (fast, premarket fields) ───────────
export async function tradingViewQuote(sym: string, exchangeHint?: string | null): Promise<SourceQuote> {
  const started = Date.now();
  const ex = (exchangeHint || "NASDAQ").toUpperCase();
  const ticker = `${ex}:${sym}`;
  try {
    const res = await timedFetch("https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: [ticker], query: { types: [] } },
        columns: ["close", "change", "premarket_price", "premarket_change", "premarket_change_perc", "postmarket_price", "postmarket_change", "postmarket_change_perc", "last_trade_time", "volume", "high", "low"],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const row = json?.data?.[0]?.d;
    if (!row) throw new Error("no data");
    const [close, change, prePrice, preChange, prePct, postPrice, postChange, postPct, lastTrade, volume, high, low] = row;
    // Pick whichever extended field is non-null; fall back to regular close.
    let price = num(close);
    let changePercent = num(change);
    let session = "regular";
    if (prePrice != null && num(prePrice) !== null) { price = num(prePrice); changePercent = num(prePct) ?? changePercent; session = "pre"; }
    else if (postPrice != null && num(postPrice) !== null) { price = num(postPrice); changePercent = num(postPct) ?? changePercent; session = "post"; }
    const state = session === "regular" ? "REGULAR" : session === "pre" ? "PRE" : "POST";
    return {
      source: "TradingView", ok: true, ms: Date.now() - started,
      price, previousClose: price !== null && changePercent !== null && changePercent !== 0 ? price / (1 + changePercent / 100) : null,
      changePercent,
      dayHigh: num(high), dayLow: num(low),
      volume: num(volume),
      marketState: state,
      tradeTime: null,
      extended: session !== "regular",
      priceHint: price !== null && price < 1 ? 4 : 2,
      bid: null, ask: null, bidSize: null, askSize: null,
    };
  } catch (e) {
    return { source: "TradingView", ok: false, error: e instanceof Error ? e.message : "failed", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: Date.now() - started, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null };
  }
}

// ─── 5. CNBC quote service (regular session) ───────────────────
export async function cnbcQuote(sym: string): Promise<SourceQuote> {
  const started = Date.now();
  try {
    const res = await timedFetch(
      `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(sym)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q) throw new Error("no data");
    const last = num(q.last);
    const changePct = num(q.change_pct);
    // CNBC's last_timedate is date-only ("09/30/26 EDT") — no reliable
    // time-of-day, so report no tradeTime rather than a misleading midnight.
    return {
      source: "CNBC", ok: true, ms: Date.now() - started,
      price: last,
      previousClose: num(q.previous_day_closing),
      changePercent: changePct,
      dayHigh: num(q.high), dayLow: num(q.low),
      volume: num(q.volume),
      marketState: "REGULAR",
      tradeTime: null,
      extended: false,
      priceHint: last !== null && last < 1 ? 4 : 2,
      bid: num(q.bid), ask: num(q.ask),
      bidSize: null, askSize: null,
    };
  } catch (e) {
    return { source: "CNBC", ok: false, error: e instanceof Error ? e.message : "failed", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: Date.now() - started, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null };
  }
}

// ─── Aggregation: race all sources, pick the freshest price ─────
// Short TTL cache: portfolio/watchlist pages poll every 5s for N symbols;
// without this every poll would fire 5×N upstream requests. 3s matches the
// live-quote cache so the UI still feels real-time.
const AGG_TTL_MS = 3_000;
const aggCache = new Map<string, { at: number; data: AggregatedQuote }>();

export async function fetchMultiSourceQuote(sym: string): Promise<AggregatedQuote> {
  const cached = aggCache.get(sym);
  if (cached && Date.now() - cached.at < AGG_TTL_MS) return cached.data;

  const result = await aggregateMultiSource(sym);
  aggCache.set(sym, { at: Date.now(), data: result });
  return result;
}

async function aggregateMultiSource(sym: string): Promise<AggregatedQuote> {
  const results = await Promise.allSettled([
    yahooQuote(sym),
    nasdaqQuote(sym),
    cboeQuote(sym),
    tradingViewQuote(sym),
    cnbcQuote(sym),
  ]);
  const sources: SourceQuote[] = results.map(r => (r.status === "fulfilled" ? r.value : { source: "?", ok: false, error: "rejected", price: null, previousClose: null, changePercent: null, dayHigh: null, dayLow: null, volume: null, marketState: null, tradeTime: null, extended: false, ms: 0, priceHint: null, bid: null, ask: null, bidSize: null, askSize: null }));

  const priced = sources.filter(s => s.ok && s.price !== null && s.price > 0);
  const agreeing = priced.length;

  // Median price across sources — robust against one source being briefly
  // wrong or delayed; used both as the headline and the verification anchor.
  const prices = priced.map(s => s.price!).sort((a, b) => a - b);
  const median = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;

  // Headline: the source with the newest trade timestamp; on a tie (same
  // trade second) the exchange's own feed wins over aggregators. Fall back
  // to the median when no source stamps a time.
  const byFreshness = [...priced].sort((a, b) =>
    (b.tradeTime ?? 0) - (a.tradeTime ?? 0)
    || (b.extended ? 1 : 0) - (a.extended ? 1 : 0)
    || (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));
  const freshest = byFreshness[0];

  const verifiedBy = median !== null
    ? priced.filter(s => Math.abs(s.price! - median) / median < 0.01).map(s => s.source)
    : [];

  // Previous regular close: prefer the official exchange feed (Nasdaq's
  // secondaryData), then CBOE/CNBC. Yahoo's chartPreviousClose is the
  // last-session baseline and is WRONG for a new day during pre/post hours
  // (it points at the close before the last completed session).
  const prevFrom = (name: string) => sources.find(s => s.source === name && s.ok)?.previousClose ?? null;
  const previousClose =
    [prevFrom("Nasdaq"), prevFrom("CBOE"), prevFrom("CNBC")].find(v => v !== null && v > 0)
    ?? freshest?.previousClose
    ?? null;

  // Headline price + change recomputed against the true previous close so the
  // percentage matches what the exchanges and quote cards show.
  const headlinePrice = freshest?.price ?? median;
  const headlineChangePct =
    headlinePrice !== null && previousClose
      ? ((headlinePrice - previousClose) / previousClose) * 100
      : freshest?.changePercent ?? null;

  // Rebase every source's change% against the SAME consensus previous close —
  // a stale source (e.g. CBOE's own day-change) would otherwise show a
  // misleading percentage next to the fresh ones.
  const rebased = sources.map(s =>
    s.ok && s.price !== null && previousClose
      ? { ...s, changePercent: ((s.price - previousClose) / previousClose) * 100 }
      : s
  );

  // ── Best bid / ask (mini-NBBO) ──
  // IMPORTANT: take the book from the single FRESHEST source that publishes
  // one, never mix sources — a 15-min-delayed book (CBOE) crossed against a
  // real-time book (Nasdaq) produces a nonsense negative spread.
  const withBook = priced
    .filter(s => (s.bid !== null && s.bid > 0) || (s.ask !== null && s.ask > 0))
    .sort((a, b) =>
      (b.tradeTime ?? 0) - (a.tradeTime ?? 0)
      || (b.extended ? 1 : 0) - (a.extended ? 1 : 0)
      || (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));
  const bookEntry = withBook[0] ?? null;
  const bidEntry = bookEntry && bookEntry.bid !== null && bookEntry.bid > 0 ? bookEntry : null;
  const askEntry = bookEntry && bookEntry.ask !== null && bookEntry.ask > 0 ? bookEntry : null;
  const spreadAbs = bidEntry?.bid != null && askEntry?.ask != null ? askEntry.ask - bidEntry.bid : null;
  const mid = bidEntry?.bid != null && askEntry?.ask != null ? (bidEntry.bid + askEntry.ask) / 2 : null;
  const bookSpreadPct = spreadAbs !== null && mid ? (spreadAbs / mid) * 100 : null;

  // Disagreement across source PRICES (different from the bid/ask spread).
  const allPrices = priced.map(s => s.price!);
  const priceSpreadPct = median !== null && allPrices.length > 1
    ? ((Math.max(...allPrices) - Math.min(...allPrices)) / median) * 100
    : null;

  return {
    price: headlinePrice,
    previousClose,
    changePercent: headlineChangePct,
    dayHigh: priced.map(s => s.dayHigh).filter((v): v is number => v !== null && v > 0).sort((a, b) => b - a)[0] ?? null,
    dayLow: priced.map(s => s.dayLow).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b)[0] ?? null,
    volume: priced.map(s => s.volume).filter((v): v is number => v !== null && v > 0).sort((a, b) => b - a)[0] ?? null,
    marketState: freshest?.marketState ?? null,
    tradeTime: freshest?.tradeTime ?? null,
    sources: rebased,
    agreeing,
    spreadPct: priceSpreadPct,
    verifiedBy,
    priceHint: freshest?.priceHint ?? (median !== null ? (median < 1 ? 4 : 2) : null),
    bid: bidEntry?.bid ?? null,
    ask: askEntry?.ask ?? null,
    bidSize: bidEntry?.bidSize ?? null,
    askSize: askEntry?.askSize ?? null,
    bidSource: bidEntry?.source ?? null,
    askSource: askEntry?.source ?? null,
    spreadAbs,
    bookSpreadPct,
  };
}
