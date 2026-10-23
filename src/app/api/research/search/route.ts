import { NextRequest, NextResponse } from "next/server";
import { searchCompanies } from "@/lib/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/research/search?q=novo
//
// Ticker/name lookup against the SEC registrant list. One cached download
// backs every keystroke, so this stays cheap. Returns an empty list (not an
// error) when nothing matches.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ matches: [] });
  try {
    const matches = await searchCompanies(q);
    return NextResponse.json({ matches });
  } catch (e) {
    return NextResponse.json(
      { matches: [], error: e instanceof Error ? e.message : "Search failed." },
      { status: 502 }
    );
  }
}
