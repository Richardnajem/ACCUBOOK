import { NextResponse } from "next/server";
import { getTrades } from "@/lib/db";
import { buildPortfolio, enrichWithQuotes } from "@/lib/portfolio";
import { getLiveQuote } from "@/lib/live-quotes";
import { fetchMultiSourceQuote } from "@/lib/quote-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/portfolio — full holdings snapshot enriched with live quotes.
// Uses the extended-hours display price (newest trade across pre/regular/post)
// so valuations track what the web shows, not just the 4pm close.
// Also attaches the best bid/ask (broker-ladder style) from the multi-source
// book — taken from a single freshest source so the spread is never crossed.
export async function GET() {
  const trades = getTrades();
  const snapshot = buildPortfolio(trades);
  const symbols = snapshot.positions.filter((p) => p.shares > 0).map((p) => p.symbol);

  const quotes: Record<string, {
    price: number; change: number; changePercent: number; previousClose: number | null;
    name: string | null; currency: string;
    bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null;
    spreadPct: number | null; bookSource: string | null;
  }> = {};
  const errors: Record<string, string> = {};

  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const [q, book] = await Promise.all([
          getLiveQuote(sym),
          fetchMultiSourceQuote(sym).catch(() => null),
        ]);
        quotes[sym] = {
          price: q.displayPrice ?? q.price ?? 0,
          change: q.displayChange ?? q.change ?? 0,
          changePercent: q.displayChangePercent ?? q.changePercent ?? 0,
          previousClose: q.lastRegularClose ?? q.previousClose,
          name: q.name,
          currency: q.currency ?? "USD",
          bid: book?.bid ?? null,
          ask: book?.ask ?? null,
          bidSize: book?.bidSize ?? null,
          askSize: book?.askSize ?? null,
          spreadPct: book?.bookSpreadPct ?? null,
          bookSource: book?.bidSource ?? book?.askSource ?? null,
        };
      } catch (e) {
        errors[sym] = e instanceof Error ? e.message : "Quote unavailable";
      }
    }),
  );

  const enriched = enrichWithQuotes(snapshot, quotes, errors);
  return NextResponse.json(enriched);
}
