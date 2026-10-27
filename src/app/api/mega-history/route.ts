import { NextRequest, NextResponse } from "next/server";
import { getMegaHistory } from "@/lib/mega-history";
import type { IndicatorOverrideMap, WeightMap } from "@/lib/mega-indicator";
import { sanitizeCustomList, type CustomIndicatorDef } from "@/lib/custom-indicators";
import { sanitizeOverrides } from "@/lib/mega-overrides";

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

    let custom: CustomIndicatorDef[] = [];
    const customParam = searchParams.get("custom");
    if (customParam) {
      try {
        const rawCustom: unknown = JSON.parse(customParam);
        if (Array.isArray(rawCustom)) custom = sanitizeCustomList(rawCustom);
      } catch { /* ignore malformed custom defs */ }
    }

    // Per-indicator edits from the right-click editor, so the history the badge
    // and the chart compare against is the same composite the page displays.
    let overrides: IndicatorOverrideMap = {};
    const overridesParam = searchParams.get("overrides");
    if (overridesParam) {
      try {
        overrides = sanitizeOverrides(JSON.parse(overridesParam));
      } catch { /* ignore malformed overrides */ }
    }

    const result = await getMegaHistory(ticker, weights, years, custom, overrides);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute mega history." },
      { status: 500 }
    );
  }
}
