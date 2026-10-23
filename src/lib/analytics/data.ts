// ─── Price history for analytics (server only) ──────────────────────────────
//
// Two modes, on purpose:
//   • default: read only what is already cached in price_bars, so opening an
//     analytics tab is instant and works offline;
//   • refresh=1: call market-data.getDailyBars (which fetches when the cache is
//     stale) for every symbol that needs it, then report what failed.
//
// Nothing here invents a price. A symbol with no cache is returned in `missing`
// and the UI names it.

import { getDb } from "../db";
import { getDailyBars } from "../market-data";
import type { BarLite } from "./history";

export interface BarSet {
  bars: Record<string, BarLite[]>;
  /** price_meta.source per symbol (yahoo / nasdaq / csv …) */
  sources: Record<string, string | null>;
  names: Record<string, string | null>;
  missing: string[];
  fetched: string[];
  errors: Record<string, string>;
}

const BAR_LOOKBACK_BUFFER_DAYS = 10;

function earliestFor(years: number): string {
  const days = Math.round(years * 365.25) + BAR_LOOKBACK_BUFFER_DAYS;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function readCache(symbols: string[], years: number): BarSet {
  const db = getDb();
  const earliest = earliestFor(years);
  const out: BarSet = { bars: {}, sources: {}, names: {}, missing: [], fetched: [], errors: {} };
  const barsStmt = db.prepare(
    "SELECT date, close FROM price_bars WHERE symbol = ? AND date >= ? ORDER BY date ASC",
  );
  const metaStmt = db.prepare("SELECT name, source FROM price_meta WHERE symbol = ?");

  for (const raw of symbols) {
    const sym = raw.trim().toUpperCase();
    if (!sym) continue;
    const rows = barsStmt.all(sym, earliest) as Array<{ date: string; close: number }>;
    if (rows.length >= 2) {
      out.bars[sym] = rows;
      const meta = metaStmt.get(sym) as { name: string | null; source: string | null } | undefined;
      out.sources[sym] = meta?.source ?? null;
      out.names[sym] = meta?.name ?? null;
    } else {
      out.missing.push(sym);
    }
  }
  return out;
}

/**
 * Load daily closes for `symbols`. With `refresh`, cached-but-stale series are
 * refetched; failures are collected instead of thrown so one dead ticker does
 * not blank the whole report.
 */
export async function loadBars(symbols: string[], years: number, refresh = false): Promise<BarSet> {
  const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (!refresh) return readCache(unique, years);

  const cached = readCache(unique, years);
  // getDailyBars owns its own request timeouts and failure backoff.
  await Promise.all(
      unique.map(async (sym) => {
        try {
          const { bars, meta, source } = await getDailyBars(sym, years);
          const lite = bars
            .filter((b) => Number.isFinite(b.close) && b.close > 0 && b.date)
            .map((b) => ({ date: b.date, close: b.close }));
          if (lite.length >= 2) {
            cached.bars[sym] = lite;
            cached.sources[sym] = source === "cache" ? cached.sources[sym] ?? "cache" : "yahoo";
            cached.names[sym] = meta.name ?? cached.names[sym] ?? null;
            cached.missing = cached.missing.filter((m) => m !== sym);
            if (source === "yahoo") cached.fetched.push(sym);
          } else {
            if (!cached.missing.includes(sym)) cached.missing.push(sym);
            cached.errors[sym] = "fewer than two usable daily bars returned";
          }
        } catch (e) {
          if (!cached.missing.includes(sym)) cached.missing.push(sym);
          cached.errors[sym] = e instanceof Error ? e.message : "price fetch failed";
        }
      }),
    );
  return cached;
}

/** Last cached close per symbol — the offline fallback for position weights. */
export function lastCachedClose(symbol: string): number | null {
  const row = getDb()
    .prepare("SELECT close FROM price_bars WHERE symbol = ? ORDER BY date DESC LIMIT 1")
    .get(symbol.trim().toUpperCase()) as { close: number } | undefined;
  return row?.close ?? null;
}
