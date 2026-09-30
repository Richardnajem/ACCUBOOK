import { NextResponse } from "next/server";
import { getTrades } from "@/lib/db";
import { buildPortfolio, enrichWithQuotes } from "@/lib/portfolio";
import { getLiveQuote } from "@/lib/live-quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/portfolio — full holdings snapshot enriched with live quotes.
export async function GET() {
  const trades = getTrades();
  const snapshot = buildPortfolio(trades);
  const symbols = snapshot.positions.filter((p) => p.shares > 0).map((p) => p.symbol);

  const quotes: Record<string, { price: number; change: number; changePercent: number; name: string | null; currency: string }> = {};
  const errors: Record<string, string> = {};

  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const q = await getLiveQuote(sym);
        quotes[sym] = {
          price: q.price ?? 0,
          change: q.change ?? 0,
          changePercent: q.changePercent ?? 0,
          name: q.name,
          currency: q.currency ?? "USD",
        };
      } catch (e) {
        errors[sym] = e instanceof Error ? e.message : "Quote unavailable";
      }
    }),
  );

  const enriched = enrichWithQuotes(snapshot, quotes, errors);
  return NextResponse.json(enriched);
}
