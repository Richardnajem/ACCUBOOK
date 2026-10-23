import { NextRequest, NextResponse } from "next/server";
import { getTrades } from "@/lib/db";
import { buildPortfolio, enrichWithQuotes } from "@/lib/portfolio";
import { getLiveQuote } from "@/lib/live-quotes";
import { loadConfig, normaliseConfig, saveConfig } from "@/lib/analytics/config";
import { lastCachedClose, loadBars } from "@/lib/analytics/data";
import { buildAnalyticsReport } from "@/lib/analytics/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics?refresh=1&benchmark=SPY&years=5
 *
 * Everything the analytics screens need, computed from the local ledger and
 * cached daily bars. The default read never touches the network; `refresh=1`
 * refetches stale/missing price history first (that is what the "Load price
 * history" button calls).
 *
 * A quote failure never fails the report: weights fall back to the last cached
 * close, then to cost, and `dataQuality.warnings` says so.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "1";
  const base = loadConfig();
  const config = normaliseConfig({
    ...base,
    benchmark: searchParams.get("benchmark") || base.benchmark,
    years: searchParams.get("years") ? Number(searchParams.get("years")) : base.years,
  });

  const trades = getTrades();
  const snapshot = buildPortfolio(trades);
  const symbols = snapshot.positions.filter((p) => p.shares > 0).map((p) => p.symbol);

  const [bars, benchmarkSet] = await Promise.all([
    loadBars(symbols, config.years, refresh),
    loadBars([config.benchmark], config.years, refresh),
  ]);

  // Live quotes are best-effort; the analytics math only needs prices to weight
  // positions, so a failure degrades to the last cached close rather than "—".
  const quotes: Record<string, {
    price: number;
    change: number;
    changePercent: number;
    previousClose: number | null;
    name: string | null;
    currency: string;
  }> = {};
  const quoteErrors: string[] = [];
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const q = await getLiveQuote(sym);
        const price = q.displayPrice ?? q.price;
        if (price && price > 0) {
          quotes[sym] = {
            price,
            change: q.displayChange ?? q.change ?? 0,
            changePercent: q.displayChangePercent ?? q.changePercent ?? 0,
            previousClose: q.lastRegularClose ?? q.previousClose ?? null,
            name: q.name ?? null,
            currency: q.currency ?? "USD",
          };
          return;
        }
      } catch {
        /* fall through to cache */
      }
      const cached = lastCachedClose(sym);
      if (cached && cached > 0) {
        quotes[sym] = {
          price: cached,
          change: 0,
          changePercent: 0,
          previousClose: null,
          name: bars.names[sym] ?? null,
          currency: "USD",
        };
        quoteErrors.push(`${sym}: live quote failed, using the last cached close.`);
      }
    }),
  );

  const errors: Record<string, string> = {};
  for (const sym of symbols) {
    if (!quotes[sym]) errors[sym] = bars.errors[sym] ?? "no price available — valued at cost";
  }

  const enriched = enrichWithQuotes(snapshot, quotes, errors);
  const report = buildAnalyticsReport({
    trades,
    snapshot: enriched.snapshot,
    quoted: enriched.quoted,
    bars: bars.bars,
    priceSources: bars.sources,
    benchmarkBars: benchmarkSet.bars[config.benchmark] ?? [],
    benchmarkSymbol: config.benchmark,
    config,
  });

  if (quoteErrors.length > 0) report.dataQuality.warnings.push(...quoteErrors);
  for (const [sym, message] of Object.entries(bars.errors)) {
    report.dataQuality.warnings.push(`${sym}: ${message}`);
  }

  return NextResponse.json(report);
}

/** POST /api/analytics — persist benchmark, risk-free/MAR, targets, tags, goal. */
export async function POST(request: NextRequest) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const config = saveConfig(body);
  return NextResponse.json({ config });
}
