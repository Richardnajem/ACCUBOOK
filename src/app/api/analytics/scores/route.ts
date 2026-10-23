import { NextRequest, NextResponse } from "next/server";
import { getTrades } from "@/lib/db";
import { buildPortfolio } from "@/lib/portfolio";
import { getLiveQuote } from "@/lib/live-quotes";
import { fetchCompanyResearch } from "@/lib/research";
import { scoreCompany } from "@/lib/analytics/scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ScoredRow {
  symbol: string;
  name: string | null;
  fiscalYear: number | null;
  currency: string | null;
  marketCap: number | null;
  price: number | null;
  scores: ReturnType<typeof scoreCompany> | null;
  error: string | null;
  notes: string[];
}

/**
 * GET /api/analytics/scores
 *
 * Runs the fundamental scorecard (Piotroski, Altman, Beneish, Sloan, DuPont,
 * Graham, Magic Formula, PEG, EV/EBITDA, FCF yield, owner earnings) for every
 * held symbol, using SEC XBRL annual statements already fetched by the research
 * module. This is the only analytics endpoint that hits the network (SEC), so
 * the page loads it on demand instead of on every visit.
 *
 * Symbols without an SEC registrant (ETFs, funds, non-US listings) come back
 * with `scores: null` and an explanatory `error` — never with fabricated
 * fundamentals.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(40, Math.max(1, Number(searchParams.get("limit") ?? 25)));
  const snapshot = buildPortfolio(getTrades());
  const symbols = snapshot.positions.filter((p) => p.shares > 0).map((p) => p.symbol).slice(0, limit);
  if (symbols.length === 0) {
    return NextResponse.json({ rows: [], note: "No open positions — add a holding first." });
  }

  const rows: ScoredRow[] = [];
  // SEC asks for at most ~10 requests/second; 3 concurrent keeps us well under
  // that while still finishing a 20-name portfolio in a few seconds.
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      let quote: { price: number | null } | null = null;
      try {
        const q = await getLiveQuote(symbol);
        const price = q.displayPrice ?? q.price;
        if (price && price > 0) quote = { price };
      } catch {
        quote = null;
      }
      try {
        const research = await fetchCompanyResearch({
          ticker: symbol,
          quote: quote
            ? {
                price: quote.price,
                previousClose: null,
                changePercent: null,
                dayHigh: null,
                dayLow: null,
                marketState: null,
                tradeTime: null,
                source: null,
              }
            : null,
        });
        const price = research.quote?.price ?? quote?.price ?? null;
        rows.push({
          symbol,
          name: research.profile.name,
          fiscalYear: research.annual[0]?.fy ?? null,
          currency: research.currency,
          marketCap: research.valuation.marketCap,
          price,
          scores: scoreCompany(research.annual, research.valuation.marketCap, price),
          error: null,
          notes: research.notes.slice(0, 4),
        });
      } catch (e) {
        rows.push({
          symbol,
          name: null,
          fiscalYear: null,
          currency: null,
          marketCap: null,
          price: quote?.price ?? null,
          scores: null,
          error: e instanceof Error ? e.message : "Research failed.",
          notes: [],
        });
      }
    }
  });
  await Promise.all(workers);

  rows.sort((a, b) => {
    const av = a.scores?.composite;
    const bv = b.scores?.composite;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return bv - av;
  });

  return NextResponse.json({
    rows,
    note:
      "Scores are computed from filed annual statements only. Missing inputs make a score unavailable (shown as —), never zero. Thresholds are conventions, not predictions; this is not investment advice.",
  });
}
