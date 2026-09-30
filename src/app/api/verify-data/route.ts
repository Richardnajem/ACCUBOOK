import { NextRequest, NextResponse } from "next/server";
import { verifyDataSources } from "@/lib/market-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/verify-data?ticker=AAPL&days=90
// Cross-checks Yahoo vs Stooq daily returns for the same window.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = (searchParams.get("ticker") || "").trim();
    const days = Math.min(365, Math.max(7, Number(searchParams.get("days")) || 90));
    if (!ticker) {
      return NextResponse.json({ error: "ticker query param is required." }, { status: 400 });
    }
    const report = await verifyDataSources(ticker, days);
    return NextResponse.json(report);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Verification failed." },
      { status: 500 }
    );
  }
}
