// Mega Indicator history — recomputes the composite (and per-indicator) scores
// at every historical bar so the score can be charted over time.
//
// Look-ahead safety: the score for date D is derived exclusively from data up
// to D (trailing windows) — guaranteed by the shared lib/mega-score module,
// which deliberately excludes the centered Nadaraya-Watson kernel indicators
// (their centered variant peeks at future bars; the live snapshot keeps them).
//
// Performance: the walk is O(bars × specs) with small per-spec windows, and
// results are cached in SQLite per (symbol, weights-hash) so repeat views are
// instant and the graph survives moves/updates.

import { getDailyBars } from "./market-data";
import { getDb } from "./db";
import { CAUSAL_SPECS, computeMegaScoreSeries } from "./mega-score";
import type { WeightMap } from "./mega-indicator";

export interface HistoryPoint {
  date: string;
  score: number;               // composite 0-100
  grade: string;
  indicators: Record<string, number>; // per-indicator 0-100 scores at this date
  close: number;
}

export interface MegaHistoryResult {
  symbol: string;
  from: string;
  to: string;
  points: HistoryPoint[];
  indicatorNames: Record<string, string>; // id → name for chart legends
  cached: boolean;
  warnings: string[];
}

function gradeFor(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  if (score >= 35) return "E";
  return "F";
}

// Hash the weights so a changed weighting invalidates the cache.
function hashWeights(weights?: WeightMap): string {
  if (!weights || Object.keys(weights).length === 0) return "even";
  const keys = Object.keys(weights).sort();
  let h = 0;
  const str = keys.map((k) => `${k}:${weights[k]}`).join("|");
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function getMegaHistory(
  symbol: string,
  weights?: WeightMap,
  years = 3,
): Promise<MegaHistoryResult> {
  const sym = symbol.trim().toUpperCase();
  // Sub-year windows (1M ≈ 0.08y, 6M = 0.5y) must be part of the cache key,
  // otherwise the 1M chart would be served the cached 3Y series trimmed client-side.
  const wHash = `${hashWeights(weights)}:${years}`;
  const warnings: string[] = [];

  // ─── Cache lookup ───────────────────────────────────────────
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS mega_history_cache (
      symbol TEXT NOT NULL,
      weights_hash TEXT NOT NULL,
      points_json TEXT NOT NULL,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (symbol, weights_hash)
    );
  `);

  const { bars } = await getDailyBars(sym, years);
  const lastDate = bars[bars.length - 1]?.date ?? null;

  const cachedRow = db
    .prepare("SELECT points_json FROM mega_history_cache WHERE symbol = ? AND weights_hash = ?")
    .get(sym, wHash) as { points_json: string } | undefined;

  if (cachedRow) {
    try {
      const parsed = JSON.parse(cachedRow.points_json) as { to: string; points: HistoryPoint[] };
      const fromCut = new Date(Date.now() - years * 365.25 * 86400_000).toISOString().slice(0, 10);
      if (
        parsed.to === lastDate &&
        Array.isArray(parsed.points) && parsed.points.length > 0 &&
        parsed.points[0]?.date <= fromCut // covers the requested window
      ) {
        return {
          symbol: sym,
          from: parsed.points[0].date,
          to: parsed.to,
          points: parsed.points,
          indicatorNames: Object.fromEntries(CAUSAL_SPECS.map((s) => [s.id, s.name])),
          cached: true,
          warnings,
        };
      }
      // stale — falls through to recompute
    } catch { /* corrupted cache row — recompute */ }
  }

  // ─── Compute ────────────────────────────────────────────────
  if (bars.length < 210) {
    warnings.push(`Only ${bars.length} bars available — 200-day indicators need more history, early scores will be partial (neutral 50).`);
  }

  const { score, indicators } = computeMegaScoreSeries(
    {
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      close: bars.map((b) => b.close),
      volume: bars.map((b) => b.volume),
    },
    weights
  );

  const points: HistoryPoint[] = bars.map((bar, i) => {
    const indScores: Record<string, number> = {};
    for (const spec of CAUSAL_SPECS) {
      const v = indicators[spec.id]?.[i];
      if (v !== undefined && Number.isFinite(v)) indScores[spec.id] = Math.round(v * 10) / 10;
    }
    return {
      date: bar.date,
      score: score[i],
      grade: gradeFor(score[i]),
      indicators: indScores,
      close: bar.close,
    };
  });

  const result: MegaHistoryResult = {
    symbol: sym,
    from: points[0]?.date ?? lastDate ?? "",
    to: lastDate ?? "",
    points,
    indicatorNames: Object.fromEntries(CAUSAL_SPECS.map((s) => [s.id, s.name])),
    cached: false,
    warnings,
  };

  // ─── Cache write ────────────────────────────────────────────
  try {
    db.prepare(
      "INSERT INTO mega_history_cache (symbol, weights_hash, points_json, computed_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(symbol, weights_hash) DO UPDATE SET points_json = excluded.points_json, computed_at = CURRENT_TIMESTAMP"
    ).run(sym, wHash, JSON.stringify({ to: result.to, points }));
  } catch { /* cache write failure is non-fatal */ }

  return result;
}
