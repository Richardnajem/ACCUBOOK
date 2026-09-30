import { NextRequest, NextResponse } from "next/server";
import { createTrade, getDb, getTrades, type TradeType } from "@/lib/db";

const TRADE_TYPES: TradeType[] = ["buy", "sell", "dividend", "deposit", "withdrawal", "fee"];

export async function GET() {
  const trades = getTrades();
  return NextResponse.json({ trades });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { date, type, symbol, shares, price, fees, notes } = body ?? {};

  if (!date || !TRADE_TYPES.includes(type)) {
    return NextResponse.json({ error: "Date and a valid trade type are required" }, { status: 400 });
  }
  const needsSymbol = ["buy", "sell", "dividend"].includes(type);
  const needsShares = ["buy", "sell"].includes(type);

  if (needsSymbol && !symbol) {
    return NextResponse.json({ error: "Symbol is required for buys, sells, and dividends" }, { status: 400 });
  }
  if (needsShares && (!shares || Number(shares) <= 0)) {
    return NextResponse.json({ error: "Share count is required for buys and sells" }, { status: 400 });
  }
  if (!needsShares && (price === undefined || price === null || Number(price) <= 0)) {
    // For cash events price holds the cash amount
    return NextResponse.json({ error: "Amount is required for cash events" }, { status: 400 });
  }

  // Oversell guard: reject sells that exceed held shares (FIFO engine assumes long-only)
  if (type === "sell") {
    const sym = String(symbol).toUpperCase();
    const held = getDb()
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'buy' THEN shares ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN type = 'sell' THEN shares ELSE 0 END), 0) AS held
         FROM trades WHERE symbol = ?`
      )
      .get(sym) as { held: number };
    if (Number(held.held) < Number(shares)) {
      return NextResponse.json(
        { error: `Cannot sell ${shares} ${sym} — you only hold ${held.held} shares.` },
        { status: 400 }
      );
    }
  }

  const result = createTrade({
    date,
    type,
    symbol: needsSymbol ? String(symbol).toUpperCase() : null,
    shares: needsShares ? Number(shares) : null,
    price: price != null ? Number(price) : null,
    fees: fees ? Number(fees) : 0,
    notes: notes || null,
  });

  return NextResponse.json({ message: "Trade recorded", tradeId: Number(result.lastInsertRowid) });
}
