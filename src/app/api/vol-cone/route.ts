import { NextRequest, NextResponse } from "next/server";
import { getDailyBars } from "@/lib/market-data";
import { buildVolatilityCone } from "@/lib/vol-cone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/vol-cone?ticker=AAPL&years=2
 *
 * A driftless ±1σ price band from trailing realized volatility: p16 / p50 / p84
 * of a lognormal. The median is today's price by construction — this endpoint
 * carries no direction, on purpose. `source` says where the closes came from
 * (cache or a fresh fetch) so the UI can show it rather than imply freshness.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json({ error: "ticker query param is required." }, { status: 400 });
    }
    const years = Math.min(20, Math.max(1, Number(searchParams.get("years") ?? 2) || 2));

    const { bars, source } = await getDailyBars(ticker, years);
    const cone = buildVolatilityCone(bars.map((b) => ({ date: b.date, close: b.close })));
    if (!cone) {
      return NextResponse.json(
        {
          error: `Not enough daily closes for ${ticker} to estimate volatility — needs at least 31 clean sessions.`,
        },
        { status: 422 }
      );
    }

    return NextResponse.json({ cone, source });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to build the price range." },
      { status: 500 }
    );
  }
}
