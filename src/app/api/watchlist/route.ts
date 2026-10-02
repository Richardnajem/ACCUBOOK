import { NextRequest, NextResponse } from "next/server";
import { addWatchlistItem, deleteWatchlistItem, getWatchlist, updateWatchlistItem } from "@/lib/db";
import { getLiveQuote } from "@/lib/live-quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/watchlist — saved symbols with live quotes + target price alerts.
// Extended-hours display price so watchlist cards match Yahoo web after 4pm.
export async function GET() {
  const items = getWatchlist();

  const rows = await Promise.all(
    items.map(async (item) => {
      try {
        const q = await getLiveQuote(item.symbol);
        const dispPrice = q.displayPrice ?? q.price;
        const prevClose = q.lastRegularClose ?? q.previousClose;
        const distPct =
          item.target_price && dispPrice
            ? ((item.target_price - dispPrice) / dispPrice) * 100
            : null;
        return {
          ...item,
          quote: {
            price: dispPrice,
            change: q.displayChange ?? q.change,
            changePercent: q.displayChangePercent ?? q.changePercent,
            previousClose: prevClose,
            name: q.name,
            marketState: q.marketState,
          },
          distanceToTargetPct: distPct,
          error: null as string | null,
        };
      } catch (e) {
        return {
          ...item,
          quote: null,
          distanceToTargetPct: null,
          error: e instanceof Error ? e.message : "Quote unavailable",
        };
      }
    }),
  );

  return NextResponse.json({ items: rows });
}

// POST /api/watchlist — add a symbol
export async function POST(request: NextRequest) {
  const { symbol, notes, targetPrice } = await request.json();
  if (!symbol || !String(symbol).trim()) {
    return NextResponse.json({ error: "Symbol is required" }, { status: 400 });
  }
  addWatchlistItem(String(symbol).trim().toUpperCase(), notes ?? null, targetPrice ?? null);
  return NextResponse.json({ message: "Added to watchlist" });
}

// PATCH /api/watchlist — update notes / target price
export async function PATCH(request: NextRequest) {
  const { id, notes, targetPrice } = await request.json();
  if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
  updateWatchlistItem(Number(id), {
    notes: notes !== undefined ? notes : undefined,
    target_price: targetPrice !== undefined ? targetPrice : undefined,
  });
  return NextResponse.json({ message: "Updated" });
}

// DELETE /api/watchlist?id=1 — remove a symbol
export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });
  deleteWatchlistItem(Number(id));
  return NextResponse.json({ message: "Removed" });
}
