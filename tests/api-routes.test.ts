// API-route tests. The routes are what the UI actually calls, and /api/import
// is the path money data enters the app through — so these exercise handlers
// end-to-end (parse → commit → query) rather than only the pure libraries.
//
// The database is isolated to a temp file BEFORE any route module loads:
// db.ts reads STOCKFOLIO_DB_PATH at import time.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stockfolio-api-"));
process.env.STOCKFOLIO_DB_PATH = path.join(TMP, "portfolio.db");

const tradesRoute = await import("../src/app/api/trades/route");
const importRoute = await import("../src/app/api/import/route");
const pricesRoute = await import("../src/app/api/import/prices/route");
const backupRoute = await import("../src/app/api/backup/route");
const db = await import("../src/lib/db");

/** Route handlers are typed against NextRequest; a plain Request satisfies
 *  them at runtime because none of them touch Next-only fields. */
function req(url: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${url}`, init);
}
function jsonReq(url: string, method: string, body: unknown): Request {
  return req(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("schema migrations", () => {
  it("runs to the current version and stamps user_version", () => {
    const d = db.getDb();
    expect(db.SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number(d.pragma("user_version", { simple: true }))).toBe(db.SCHEMA_VERSION);
    // Base tables exist for a brand-new database (the first-run bug this
    // schema module was written to fix).
    for (const table of ["trades", "watchlist", "app_settings", "price_bars", "price_meta"]) {
      expect(
        d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toEqual({ n: 1 });
    }
  });
});

describe("GET/POST /api/trades", () => {
  it("returns the seeded ledger", async () => {
    const res = await tradesRoute.GET();
    expect(res.ok).toBe(true);
    const { trades } = (await res.json()) as { trades: unknown[] };
    expect(trades.length).toBeGreaterThan(0);
  });

  it("rejects invalid input with 400", async () => {
    const badType = await tradesRoute.POST(jsonReq("/api/trades", "POST", { date: "2026-01-01", type: "yolo" }) as never);
    expect(badType.status).toBe(400);

    const noSymbol = await tradesRoute.POST(
      jsonReq("/api/trades", "POST", { date: "2026-01-01", type: "buy", shares: 1, price: 10 }) as never,
    );
    expect(noSymbol.status).toBe(400);
  });

  it("rejects selling more than is held", async () => {
    const res = await tradesRoute.POST(
      jsonReq("/api/trades", "POST", {
        date: "2026-01-02",
        type: "sell",
        symbol: "ZZZZ",
        shares: 5,
        price: 10,
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/only hold/i);
  });

  it("accepts a valid buy and it shows up in the ledger", async () => {
    const before = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;
    const res = await tradesRoute.POST(
      jsonReq("/api/trades", "POST", {
        date: "2026-01-03",
        type: "buy",
        symbol: "MSFT",
        shares: 3,
        price: 400,
        fees: 1,
      }) as never,
    );
    expect(res.ok).toBe(true);
    const after = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;
    expect(after).toBe(before + 1);
  });
});

describe("POST/PUT /api/import (trade import)", () => {
  it("parses a broker workbook and commits it exactly once", async () => {
    // Cash rows (dividends) need an Amount column: shares+price only covers
    // buys and sells, which is exactly how the importer classifies them.
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Date", "Description", "Symbol", "Shares", "Price", "Amount"],
      ["2026-02-03", "BUY 10 AAPL @ 150.25", "AAPL", "10", "150.25", ""],
      ["2026-02-10", "SELL 5 AAPL @ 160.50", "AAPL", "5", "160.50", ""],
      ["2026-02-15", "AAPL dividend", "AAPL", "", "", "12.00"],
      // Empty row — importers must skip, not crash.
      ["", "", "", "", "", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer;

    const form = new FormData();
    form.append("file", new File([buf], "broker-feb.xlsx", { type: "application/octet-stream" }));
    const preview = await importRoute.POST(new Request("http://127.0.0.1/api/import", { method: "POST", body: form }) as never);
    expect(preview.ok).toBe(true);
    const parsed = (await preview.json()) as { totalRows: number; rows: Array<Record<string, unknown>> };
    expect(parsed.totalRows).toBe(3);

    const before = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;

    const commit = await importRoute.PUT(
      jsonReq("/api/import", "PUT", { rows: parsed.rows }) as never,
    );
    expect(commit.ok).toBe(true);
    expect(((await commit.json()) as { inserted: number }).inserted).toBe(3);

    const after = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;
    expect(after).toBe(before + 3);

    // Re-importing the same file must not duplicate anything.
    const again = await importRoute.PUT(jsonReq("/api/import", "PUT", { rows: parsed.rows }) as never);
    const againBody = (await again.json()) as { inserted: number; skipped: number };
    expect(againBody.inserted).toBe(0);
    expect(againBody.skipped).toBe(3);
    const finalCount = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;
    expect(finalCount).toBe(after);
  });

  it("rejects an empty commit", async () => {
    const res = await importRoute.PUT(jsonReq("/api/import", "PUT", { rows: [] }) as never);
    expect(res.status).toBe(400);
  });
});

describe("price workbook import (/api/import/prices)", () => {
  const WORKBOOK = fileURLToPath(new URL("../tehnival analysis 19926.xlsx", import.meta.url));
  const hasWorkbook = fs.existsSync(WORKBOOK);
  // Personal fixture: gitignored, so it exists on the dev machine and never on
  // a CI runner — run when present, skip when not (same rule as
  // technical-workbook.test.ts).

  it("parses the real six-sheet workbook", { skip: !hasWorkbook, timeout: 30000 }, async () => {
    const buf = fs.readFileSync(WORKBOOK);
    const form = new FormData();
    form.append("file", new File([buf], "tehnival analysis 19926.xlsx"));
    const res = await pricesRoute.POST(new Request("http://127.0.0.1/api/import/prices", { method: "POST", body: form }) as never);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { totalRows: number; rows: unknown[]; sheets?: unknown };
    expect(body.totalRows).toBeGreaterThan(0);
    expect(body.rows.length).toBeGreaterThan(0);
  });

  it("parses a synthetic price workbook without the personal fixture", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Date", "Open", "High", "Low", "Close", "Volume"],
      ["2026-01-02", 100, 105, 99, 104, 1234567],
      ["2026-01-03", 104, 106, 102, 105.5, 987654],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Prices");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as ArrayBuffer;

    const form = new FormData();
    form.append("file", new File([buf], "prices.xlsx"));
    const res = await pricesRoute.POST(new Request("http://127.0.0.1/api/import/prices", { method: "POST", body: form }) as never);
    expect(res.ok).toBe(true);
    expect(((await res.json()) as { totalRows: number }).totalRows).toBeGreaterThan(0);
  });
});

describe("backup / restore (/api/backup)", () => {
  it("snapshots, lists and restores — and the restored database still works", async () => {
    const before = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;

    // 1. Snapshot the current state.
    const create = await backupRoute.POST(jsonReq("/api/backup", "POST", { action: "create", label: "test" }) as never);
    expect(create.ok).toBe(true);
    const created = (await create.json()) as { backup: { name: string; sizeBytes: number } };
    expect(created.backup.sizeBytes).toBeGreaterThan(0);

    // 2. Change the data.
    await tradesRoute.POST(
      jsonReq("/api/trades", "POST", {
        date: "2026-03-01",
        type: "buy",
        symbol: "TSLA",
        shares: 1,
        price: 100,
      }) as never,
    );
    expect(((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length).toBe(before + 1);

    // 3. The snapshot is listed.
    const list = await backupRoute.GET();
    const listed = (await list.json()) as { backups: Array<{ name: string }> };
    expect(listed.backups.some((b) => b.name === created.backup.name)).toBe(true);

    // 4. Restore it: the trade from step 2 must be gone.
    const restore = await backupRoute.POST(
      jsonReq("/api/backup", "POST", { action: "restore", name: created.backup.name }) as never,
    );
    expect(restore.status).toBe(200);
    expect(((await restore.json()) as { ok: boolean }).ok).toBe(true);

    const after = ((await (await tradesRoute.GET()).json()) as { trades: unknown[] }).trades.length;
    expect(after).toBe(before);

    // 5. The database is fully usable after the swap (reopened + re-migrated).
    expect(Number(db.getDb().pragma("user_version", { simple: true }))).toBe(db.SCHEMA_VERSION);
  });

  it("refuses path traversal", async () => {
    const res = await backupRoute.POST(
      jsonReq("/api/backup", "POST", { action: "restore", name: "../../portfolio.db" }) as never,
    );
    expect(res.status).toBe(400);
  });
});
