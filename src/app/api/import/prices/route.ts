import { NextRequest, NextResponse } from "next/server";
import { parsePriceWorkbook } from "@/lib/price-import";
import { getCacheDb } from "@/lib/market-data";

export const runtime = "nodejs";

// ─── POST: parse a price-history workbook → preview ─────────────
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    const wb = parsePriceWorkbook(buf, file.name);
    if (wb.totalRows === 0) {
      return NextResponse.json(
        { error: wb.warnings[0] ?? "No price rows found in this workbook." },
        { status: 422 },
      );
    }
    return NextResponse.json(wb);
  } catch (err) {
    console.error("Price import parse failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to parse file" },
      { status: 500 },
    );
  }
}

// ─── PUT: commit rows into the price cache ──────────────────────
// Rows land in the same price_bars / price_meta tables the app already uses
// for market data, so imported symbols immediately work in backtests, the
// Mega Indicator, and the watchlist. Imported rows never auto-refetch from
// the internet: price_meta.source is set to "import" and the refresher only
// overwrites when a live fetch succeeds for that symbol.
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { rows?: unknown };
    const rows: Record<string, unknown>[] = Array.isArray(body.rows)
      ? (body.rows as Record<string, unknown>[])
      : [];
    if (rows.length === 0) return NextResponse.json({ error: "No rows to import" }, { status: 400 });

    const clean: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const symbol = String(r?.symbol ?? "").trim().toUpperCase();
      const date = String(r?.date ?? "").trim();
      const open = Number(r?.open), high = Number(r?.high), low = Number(r?.low), close = Number(r?.close);
      if (!/^[A-Z0-9.\-^=]{1,12}$/.test(symbol)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
      const key = `${symbol}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ symbol, date, open, high, low, close, volume: Number.isFinite(Number(r?.volume)) && Number(r.volume) > 0 ? Number(r.volume) : 0 });
    }
    if (clean.length === 0) {
      return NextResponse.json({ error: "No valid rows (need symbol, ISO date, and positive OHLC)." }, { status: 422 });
    }

    const db = getCacheDb();
    const upsert = db.prepare(
      `INSERT INTO price_bars (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, date) DO UPDATE SET
         open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
    );
    const meta = db.prepare(
      `INSERT INTO price_meta (symbol, name, currency, exchange, last_refreshed, source) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET last_refreshed=excluded.last_refreshed, source=CASE WHEN price_meta.source='import' THEN 'import' ELSE excluded.source END`,
    );

    const symbols = [...new Set(clean.map((r) => r.symbol))];
    const today = new Date().toISOString().slice(0, 10);
    const tx = db.transaction(() => {
      for (const r of clean) upsert.run(r.symbol, r.date, r.open, r.high, r.low, r.close, r.volume);
      for (const sym of symbols) meta.run(sym, sym, "USD", "imported", today, "import");
    });
    tx();

    const bySymbol: Record<string, number> = {};
    for (const r of clean) bySymbol[r.symbol] = (bySymbol[r.symbol] ?? 0) + 1;

    return NextResponse.json({ inserted: clean.length, symbols: bySymbol, at: today });
  } catch (err) {
    console.error("Price import commit failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to import price rows" },
      { status: 500 },
    );
  }
}

// ─── GET: list cached symbols (imported first) ──────────────────
export async function GET() {
  const db = getCacheDb();
  const rows = db
    .prepare(
      `SELECT m.symbol, m.source, COUNT(b.date) AS bars, MIN(b.date) AS from, MAX(b.date) AS to
       FROM price_meta m LEFT JOIN price_bars b ON b.symbol = m.symbol
       GROUP BY m.symbol ORDER BY (m.source = 'import') DESC, m.symbol`,
    )
    .all() as { symbol: string; source: string | null; bars: number; from: string | null; to: string | null }[];
  return NextResponse.json({ symbols: rows });
}
