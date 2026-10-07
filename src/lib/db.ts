import Database from "better-sqlite3";
import path from "path";

// Packaged Electron passes an explicit writable path (userData dir);
// in dev/web the DB sits in the project root (cwd).
export const DB_PATH =
  process.env.STOCKFOLIO_DB_PATH ||
  process.env.ACCUBOOKS_DB_PATH || // legacy env name kept for compatibility
  path.join(process.cwd(), "portfolio.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeDatabase();
    seedDemoPortfolioIfEmpty();
  }
  return db;
}

// Price-history cache tables. Owned by the schema module (and created on
// EVERY first run, not lazily): a brand-new database — fresh PC, first
// launch — used to answer /api/data with "no such table: price_bars",
// because market-data.ts only created these when a price fetch happened.
export const PRICE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS price_bars (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    PRIMARY KEY (symbol, date)
  );
  CREATE TABLE IF NOT EXISTS price_meta (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    currency TEXT,
    exchange TEXT,
    last_refreshed TEXT,
    source TEXT
  );
`;

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'fee')),
      symbol TEXT,
      shares REAL,
      price REAL,
      fees REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      notes TEXT,
      target_price REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Same statement market-data.ts runs, so there is exactly one definition
  // of these tables and both connections see them.
  db.exec(PRICE_TABLES_SQL);
}

// ─── App settings (key-value; panel layouts, misc prefs) ────────
export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
    .run(key, value);
}

export function getSettingsByPrefix(prefix: string): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM app_settings WHERE key LIKE ?")
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ─── Types ──────────────────────────────────────────────────────
export type TradeType = "buy" | "sell" | "dividend" | "deposit" | "withdrawal" | "fee";

export interface Trade {
  id: number;
  date: string;
  type: TradeType;
  symbol: string | null;
  shares: number | null;
  price: number | null;
  fees: number;
  notes: string | null;
  created_at: string;
}

export interface WatchlistItem {
  id: number;
  symbol: string;
  notes: string | null;
  target_price: number | null;
  created_at: string;
}

// ─── Trades ─────────────────────────────────────────────────────
export function getTrades(): Trade[] {
  return getDb().prepare("SELECT * FROM trades ORDER BY date DESC, id DESC").all() as Trade[];
}

export function createTrade(t: {
  date: string;
  type: TradeType;
  symbol?: string | null;
  shares?: number | null;
  price?: number | null;
  fees?: number;
  notes?: string | null;
}) {
  return getDb()
    .prepare("INSERT INTO trades (date, type, symbol, shares, price, fees, notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(t.date, t.type, t.symbol ?? null, t.shares ?? null, t.price ?? null, t.fees ?? 0, t.notes ?? null);
}

export function updateTrade(id: number, fields: Partial<Omit<Trade, "id" | "created_at">>) {
  const allowed: Array<keyof Omit<Trade, "id" | "created_at">> = ["date", "type", "symbol", "shares", "price", "fees", "notes"];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (key in fields && fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key] as unknown);
    }
  }
  if (sets.length === 0) return getTradeById(id);
  params.push(id);
  getDb().prepare(`UPDATE trades SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTradeById(id);
}

export function deleteTrade(id: number) {
  return getDb().prepare("DELETE FROM trades WHERE id = ?").run(id);
}

export function getTradeById(id: number) {
  return getDb().prepare("SELECT * FROM trades WHERE id = ?").get(id) as Trade | undefined;
}

export function upsertTradeByFingerprint(fp: { date: string; type: string; symbol: string | null; shares: number; price: number }) {
  const existing = getDb()
    .prepare("SELECT id FROM trades WHERE date = ? AND type = ? AND symbol IS ? AND ABS(shares - ?) < 0.0001 AND ABS(price - ?) < 0.0001")
    .get(fp.date, fp.type, fp.symbol, fp.shares, fp.price) as { id: number } | undefined;
  if (existing) return { inserted: false, id: existing.id };
  const res = getDb()
    .prepare("INSERT INTO trades (date, type, symbol, shares, price) VALUES (?, ?, ?, ?, ?)")
    .run(fp.date, fp.type, fp.symbol, fp.shares, fp.price);
  return { inserted: true, id: Number(res.lastInsertRowid) };
}

// ─── Watchlist ──────────────────────────────────────────────────
export function getWatchlist() {
  return getDb().prepare("SELECT * FROM watchlist ORDER BY created_at DESC").all() as WatchlistItem[];
}

export function addWatchlistItem(symbol: string, notes?: string | null, targetPrice?: number | null) {
  return getDb()
    .prepare("INSERT INTO watchlist (symbol, notes, target_price) VALUES (?, ?, ?) ON CONFLICT(symbol) DO NOTHING")
    .run(symbol.toUpperCase(), notes ?? null, targetPrice ?? null);
}

export function updateWatchlistItem(id: number, fields: { notes?: string | null; target_price?: number | null }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.notes !== undefined) { sets.push("notes = ?"); params.push(fields.notes); }
  if (fields.target_price !== undefined) { sets.push("target_price = ?"); params.push(fields.target_price); }
  if (sets.length === 0) return;
  params.push(id);
  return getDb().prepare(`UPDATE watchlist SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteWatchlistItem(id: number) {
  return getDb().prepare("DELETE FROM watchlist WHERE id = ?").run(id);
}

// ─── Demo Portfolio Seed ────────────────────────────────────────
function seedDemoPortfolioIfEmpty() {
  const existing = getDb().prepare("SELECT COUNT(*) as count FROM trades").get() as { count: number };
  if (existing.count > 0) return;

  const db = getDb();
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split("T")[0];
  };

  const insert = db.prepare(
    "INSERT INTO trades (date, type, symbol, shares, price, fees, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  // Cash ledger (amount lives in `price` for cash events)
  insert.run(daysAgo(260), "deposit", null, null, 100000, 0, "Initial funding");
  insert.run(daysAgo(120), "deposit", null, null, 50000, 0, "Additional funding");

  // Positions
  insert.run(daysAgo(250), "buy", "AAPL", 50, 172.40, 1.0, "Starter position");
  insert.run(daysAgo(210), "buy", "MSFT", 30, 328.10, 1.0, "Core holding");
  insert.run(daysAgo(180), "buy", "NVDA", 25, 118.55, 1.0, "AI growth");
  insert.run(daysAgo(150), "buy", "SPY", 40, 505.20, 1.0, "Index anchor");
  insert.run(daysAgo(90), "buy", "AAPL", 20, 196.85, 1.0, "Add on dip");
  insert.run(daysAgo(60), "buy", "SPY", 15, 545.90, 1.0, "DCA contribution");

  // Trimming / income
  insert.run(daysAgo(45), "sell", "NVDA", 5, 620.30, 1.0, "Trim after run-up");
  insert.run(daysAgo(100), "dividend", "SPY", null, 78.60, 0, "Quarterly dividend");
  insert.run(daysAgo(10), "dividend", "SPY", null, 84.20, 0, "Quarterly dividend");
  insert.run(daysAgo(30), "dividend", "AAPL", null, 24.50, 0, "Dividend");

  // Watchlist
  const wl = db.prepare("INSERT INTO watchlist (symbol, notes, target_price) VALUES (?, ?, ?)");
  wl.run("TSLA", "Awaiting pullback to trend", 220.0);
  wl.run("AMZN", "Cloud margin expansion story", 190.0);
  wl.run("GOOGL", null, 175.0);
  wl.run("JPM", "Financials exposure", null);
  wl.run("KO", "Defensive dividend play", null);
}
