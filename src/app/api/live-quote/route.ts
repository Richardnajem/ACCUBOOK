import { NextRequest, NextResponse } from "next/server";
import { getLiveQuote, getIntradayBars } from "@/lib/live-quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/live-quote?ticker=AAPL
// Returns the live Yahoo quote (3s TTL cache) + intraday 1m sparkline (60s TTL).
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json({ error: "ticker query param is required." }, { status: 400 });
    }

    const quote = await getLiveQuote(ticker);

    let spark: Array<{ t: number; price: number }> = [];
    let sparkError: string | null = null;
    try {
      spark = await getIntradayBars(ticker);
    } catch (e) {
      sparkError = e instanceof Error ? e.message : "Failed to load intraday bars.";
    }

    return NextResponse.json({ quote, spark, sparkError });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to fetch live quote." },
      { status: 500 }
    );
  }
}
