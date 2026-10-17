import { NextResponse } from "next/server";
import {
  A_STRATEGIES,
  C_STRATEGIES,
  ALL_STRATEGIES,
  computeRiskScore,
  computeCompositeScore,
  TAXONOMY,
  SOURCES,
  CHANGELOG,
  CATEGORY_DISPLAY_NAMES,
  SHARIAH_DISPLAY_NAMES,
  type RiskSubScores,
} from "@/lib/strategies-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/strategies — return all strategies with summary stats
export async function GET() {
  try {
    return NextResponse.json({
      strategies: ALL_STRATEGIES,
      summary: {
        total: ALL_STRATEGIES.length,
        aStrategies: A_STRATEGIES.length,
        cStrategies: C_STRATEGIES.length,
        categories: Object.keys(TAXONOMY).length,
        sources: Object.keys(SOURCES).length,
        changelogEntries: CHANGELOG.length,
      },
      taxonomy: TAXONOMY,
      sources: SOURCES,
      categoryDisplayNames: CATEGORY_DISPLAY_NAMES,
      shariahDisplayNames: SHARIAH_DISPLAY_NAMES,
    });
  } catch (error) {
    console.error("Error fetching strategies:", error);
    return NextResponse.json(
      { error: "Failed to load strategies data" },
      { status: 500 }
    );
  }
}

// POST /api/strategies — compute risk and composite scores
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { subs, liqPenalty, feePenalty } = body;

    if (!subs || !Array.isArray(subs) || subs.length !== 6) {
      return NextResponse.json(
        { error: "Invalid subs array (expected 6 sub-scores)" },
        { status: 400 }
      );
    }

    const riskScore = computeRiskScore(subs as RiskSubScores);
    const compositeScore = computeCompositeScore(
      riskScore,
      liqPenalty || 0,
      feePenalty || 0
    );

    return NextResponse.json({
      riskScore: Number(riskScore.toFixed(2)),
      compositeScore: Number(compositeScore.toFixed(2)),
    });
  } catch (error) {
    console.error("Error computing scores:", error);
    return NextResponse.json({ error: "Failed to compute scores" }, { status: 500 });
  }
}
