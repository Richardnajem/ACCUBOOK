import { NextRequest, NextResponse } from "next/server";
import { getLiveQuote, getIntradayBars } from "@/lib/live-quotes";
import { fetchMultiSourceQuote } from "@/lib/quote-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live-quote?ticker=AAPL
//
// Multi-source live quote: five keyless providers are queried in parallel
// (Yahoo, Nasdaq, CBOE, TradingView, CNBC). The headline price comes from the
// source with the freshest last-trade timestamp (extended-hours aware), and
// each source's raw data is returned so the UI can display cross-verification
// ("5/5 sources agree") at a glance.
//
// The Yahoo path also provides the intraday 1m sparkline (60s TTL cache) and
// remains the fallback if every multi-source provider fails.

interface VerificationDTO {
  priceHint?: number | null;
}

interface SourceQuoteDTO {
  source: string;
  ok: boolean;
  error?: string;
  price: number | null;
  changePercent: number | null;
  tradeTime: number | null;
  marketState: string | null;
  extended: boolean;
  ms: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json({ error: "ticker query param is required." }, { status: 400 });
    }

    const [multi, yahoo, sparkResult] = await Promise.all([
      fetchMultiSourceQuote(ticker).catch(() => null),
      getLiveQuote(ticker).catch(() => null),
      getIntradayBars(ticker)
        .then((bars) => ({ bars, error: null as string | null }))
        .catch((e: unknown) => ({ bars: [] as Array<{ t: number; price: number }>, error: e instanceof Error ? e.message : "Failed to load intraday bars." })),
    ]);

    if (!multi && !yahoo) {
      return NextResponse.json(
        { error: `All market data sources failed for ${ticker}.` },
        { status: 502 }
      );
    }

    // Choose the headline quote: multi-source aggregate when available
    // (freshest trade time wins), Yahoo otherwise.
    const y = yahoo
      ? {
          price: yahoo.displayPrice ?? yahoo.price,
          previousClose: yahoo.previousClose,
          changePercent: yahoo.displayChangePercent ?? yahoo.changePercent,
          dayHigh: yahoo.dayHigh,
          dayLow: yahoo.dayLow,
          volume: yahoo.volume,
          marketState: yahoo.marketState,
          tradeTime: yahoo.lastTradeTime ?? yahoo.quoteTime,
        }
      : null;

    const multiIsFresher =
      multi && multi.price !== null &&
      (y === null || y.price === null || (multi.tradeTime ?? 0) >= (y.tradeTime ?? 0));

    const headline = multiIsFresher && multi
      ? {
          price: multi.price,
          previousClose: multi.previousClose,
          changePercent: multi.changePercent,
          dayHigh: multi.dayHigh ?? y?.dayHigh ?? null,
          dayLow: multi.dayLow ?? y?.dayLow ?? null,
          volume: multi.volume ?? y?.volume ?? null,
          marketState: multi.marketState ?? y?.marketState ?? null,
          tradeTime: multi.tradeTime,
        }
      : y;

    const sources: SourceQuoteDTO[] = multi
      ? multi.sources.map((s) => ({
          source: s.source,
          ok: s.ok,
          error: s.error,
          price: s.price,
          changePercent: s.changePercent,
          tradeTime: s.tradeTime,
          marketState: s.marketState,
          extended: s.extended,
          ms: s.ms,
          bid: s.bid,
          ask: s.ask,
          bidSize: s.bidSize,
          askSize: s.askSize,
        }))
      : y
        ? [{ source: "Yahoo", ok: true, price: y.price, changePercent: y.changePercent, tradeTime: y.tradeTime, marketState: y.marketState, extended: true, ms: 0, bid: null, ask: null, bidSize: null, askSize: null }]
        : [];

    return NextResponse.json({
      quote: {
        symbol: ticker,
        price: headline?.price ?? null,
        previousClose: headline?.previousClose ?? null,
        change: headline?.price != null && headline?.previousClose != null ? headline.price - headline.previousClose : null,
        changePercent: headline?.changePercent ?? null,
        dayHigh: headline?.dayHigh ?? null,
        dayLow: headline?.dayLow ?? null,
        volume: headline?.volume ?? null,
        marketState: headline?.marketState ?? null,
        lastTradeTime: headline?.tradeTime ?? null,
        quoteTime: y?.tradeTime ?? null,
        name: yahoo?.name ?? null,
        yearLow: yahoo?.yearLow ?? null,
        yearHigh: yahoo?.yearHigh ?? null,
        priceHint: multi?.priceHint ?? yahoo?.priceHint ?? null,
        // Top-of-book: best bid/ask across sources
        bid: multi?.bid ?? null,
        ask: multi?.ask ?? null,
        bidSize: multi?.bidSize ?? null,
        askSize: multi?.askSize ?? null,
        bidSource: multi?.bidSource ?? null,
        askSource: multi?.askSource ?? null,
        spreadAbs: multi?.spreadAbs ?? null,
        spreadPct: multi?.bookSpreadPct ?? null,
        // Session inference for the extended-hours badge
        displaySession: (headline?.marketState ?? "").startsWith("PRE") ? "pre"
          : (headline?.marketState ?? "").startsWith("POST") ? "post"
          : "regular",
      },
      // Cross-verification block for the UI
      verification: {
        priceHint: multi?.priceHint ?? null,
        sourceCount: sources.length,
        agreeing: multi?.agreeing ?? (y ? 1 : 0),
        spreadPct: multi?.spreadPct ?? null,
        verifiedBy: multi?.verifiedBy ?? [],
        sources,
      },
      spark: sparkResult.bars,
      sparkError: sparkResult.error,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch live quote." },
      { status: 500 }
    );
  }
}
