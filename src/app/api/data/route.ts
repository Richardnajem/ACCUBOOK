import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/data — export all data as JSON backup
export async function GET() {
  const db = getDb();
  const data = {
    version: 2,
    app: "stockfolio",
    exportedAt: new Date().toISOString(),
    trades: db.prepare("SELECT * FROM trades ORDER BY date, id").all(),
    watchlist: db.prepare("SELECT * FROM watchlist ORDER BY symbol").all(),
    priceBars: db.prepare("SELECT COUNT(*) as count FROM price_bars").get() as { count: number },
    priceMeta: db.prepare("SELECT * FROM price_meta").all(),
  };
  return NextResponse.json(data, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="stockfolio-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}

// POST /api/data — import data from JSON backup
export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body || !body.version) {
    return NextResponse.json({ error: "Invalid backup file" }, { status: 400 });
  }

  const db = getDb();
  const results = { imported: 0, skipped: 0, errors: [] as string[] };

  const tx = db.transaction(() => {
    // Import trades (skip exact duplicates by date+type+symbol+shares+price)
    if (Array.isArray(body.trades)) {
      const existing = db
        .prepare("SELECT date, type, symbol, shares, price FROM trades")
        .all() as Array<{ date: string; type: string; symbol: string | null; shares: number | null; price: number | null }>;
      const seen = new Set(
        existing.map((t) => `${t.date}|${t.type}|${t.symbol}|${t.shares}|${t.price}`)
      );
      const insert = db.prepare(
        "INSERT INTO trades (date, type, symbol, shares, price, fees, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const t of body.trades) {
        const key = `${t.date}|${t.type}|${t.symbol}|${t.shares}|${t.price}`;
        if (seen.has(key)) { results.skipped++; continue; }
        insert.run(t.date, t.type, t.symbol, t.shares, t.price, t.fees ?? 0, t.notes ?? null);
        results.imported++;
      }
    }

    // Import watchlist (skip duplicates by symbol)
    if (Array.isArray(body.watchlist)) {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO watchlist (symbol, notes, target_price) VALUES (?, ?, ?)"
      );
      for (const w of body.watchlist) {
        const r = insert.run(w.symbol, w.notes ?? null, w.target_price ?? null);
        if (r.changes > 0) results.imported++; else results.skipped++;
      }
    }
  });

  try {
    tx();
    return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Import failed", ...results }, { status: 500 });
  }
}
