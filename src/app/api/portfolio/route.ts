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
    price: number; change: number | null; changePercent: number | null; previousClose: number | null;
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
        // A feed that answers without a usable price is NOT a $0 quote: writing
        // 0 here valued the whole position at zero (−100 % unrealized). Leave
        // the symbol unquoted instead, with the reason surfaced.
        const last = q.displayPrice ?? q.price;
        if (last == null || !Number.isFinite(last) || last <= 0) {
          errors[sym] = `The quote feed returned no usable price (${q.exchange ?? "unknown source"}); the position is valued at cost.`;
          return;
        }
        quotes[sym] = {
          price: last,
          change: q.displayChange ?? q.change,
          changePercent: q.displayChangePercent ?? q.changePercent,
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
