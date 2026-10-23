import { NextRequest, NextResponse } from "next/server";
import { searchSymbols } from "@/lib/symbol-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/symbol-search?q=nvid
//
// Typeahead for the global palette and the watchlist's add form: any listed
// stock, ETF, fund, index, crypto pair or future — not only the symbols already
// in the local database. An empty query is a valid "nothing typed yet" and
// returns an empty list; a provider failure returns 502 with an `error` so the
// UI can distinguish "no such stock" from "search is down".
export async function GET(request: NextRequest) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!query) {
    return NextResponse.json({ query: "", suggestions: [], count: 0 });
  }

  try {
    const suggestions = await searchSymbols(query);
    return NextResponse.json({ query, suggestions, count: suggestions.length });
  } catch (e) {
    return NextResponse.json(
      {
        query,
        suggestions: [],
        count: 0,
        error: e instanceof Error ? e.message : "Symbol search failed.",
      },
      { status: 502 },
    );
  }
}
