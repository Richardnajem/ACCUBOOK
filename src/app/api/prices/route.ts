import { NextRequest, NextResponse } from "next/server";
import { getDailyBars } from "@/lib/market-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A source caps how far back it serves; 60 years is beyond any listed history. */
const MAX_YEARS = 60;

// GET /api/prices?symbol=AAPL&years=5
//
// Daily OHLCV for one ticker, exactly as the cache/source stores it — no
// forward-filling and no synthetic sessions. The Excel workbook (every day plus
// every indicator) is /api/export/prices; this endpoint only feeds the tab's
// chart, table and CSV download.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || searchParams.get("ticker") || "").trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ error: "symbol query param is required (e.g. AAPL)." }, { status: 400 });
    }

    const requested = Number(searchParams.get("years"));
    const years = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_YEARS, requested)
      : 5;

    const { bars, meta, source } = await getDailyBars(symbol, years);
    if (bars.length === 0) {
      return NextResponse.json({ error: `No price history available for ${symbol}.` }, { status: 404 });
    }

    return NextResponse.json(
      { symbol, meta, source, yearsRequested: years, bars },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Error loading price history:", error);
    const message = error instanceof Error ? error.message : "Could not load price history.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
