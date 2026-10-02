import { NextRequest, NextResponse } from "next/server";
import { getMegaHistory } from "@/lib/mega-history";
import type { WeightMap } from "@/lib/mega-indicator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mega-history?ticker=AAPL&years=3&weights={"ta-rsi-14":2}
// Returns the composite + per-indicator scores at every historical bar,
// for the score-over-time graph. Sub-year windows are allowed: years=0.08
// (~1 month / 30 days) and years=0.5 (6 months).
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = (searchParams.get("ticker") || "").trim();
    const years = Math.min(10, Math.max(1 / 12, Number(searchParams.get("years")) || 3));
    if (!ticker) {
      return NextResponse.json({ error: "ticker query param is required." }, { status: 400 });
    }

    let weights: WeightMap | undefined;
    const weightsParam = searchParams.get("weights");
    if (weightsParam) {
      try {
        const parsed = JSON.parse(weightsParam);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          weights = Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, Math.max(0, Number(v) || 0)])
          );
        }
      } catch { /* ignore malformed weights */ }
    }

    const result = await getMegaHistory(ticker, weights, years);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute mega history." },
      { status: 500 }
    );
  }
}
