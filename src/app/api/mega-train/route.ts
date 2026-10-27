import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_WEIGHTS, MEGA_BASELINE, type WeightMap } from "@/lib/mega-indicator";
import {
  DEFAULT_TRAINING_OPTIONS,
  SEARCH_UNITS,
  prepareFrame,
  splitIndex,
  trainMegaWeights,
  type CalibrationFrame,
  type TrainingOptions,
} from "@/lib/mega-calibration";
import { getDailyBars, listCachedSymbols } from "@/lib/market-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Per-symbol indicator series are expensive to build (≈50 indicators × N bars)
// and are weight-independent, so a run's frames are reused for the next run.
export const maxDuration = 300;

/**
 * Default training universe: broad index + sector coverage, liquid, long history
 * — plus a deliberate high-volatility block.
 *
 * The index/large-cap half alone is mostly slow uptrends, and a timing rule that
 * is only ever tested on slow uptrends learns to sit long: the composite's bands
 * look fine there because nothing sells off hard. The volatile half (EV, chips,
 * streaming, memory, solar, meme retail, a bitcoin proxy, an AI server maker)
 * is what makes the search pay for its exits — those series contain the 40-90%
 * drawdowns a regime filter is supposed to avoid.
 */
export const TRAINING_UNIVERSE = [
  "SPY", "QQQ", "IWM", "DIA",
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META",
  "JPM", "XOM", "JNJ", "PG", "KO", "WMT",
  // High volatility, long enough history to survive a 15-year 70/30 split.
  "TSLA", "AMD", "NFLX", "MU", "FSLR", "GME", "MSTR", "SMCI",
];

// 40 leaves room to add your own names on top of the 24-ticker default universe
// (the tab reads this cap from GET, so the counter in the UI follows it).
const MAX_SYMBOLS = 40;
const MAX_YEARS = 25;
/** A ticker needs at least this many bars after the split to have a real test window. */
const MIN_TEST_BARS = 60;

interface CachedFrames {
  frames: CalibrationFrame[];
  prepared: Array<{ symbol: string; bars: number; from: string; to: string }>;
  fetchedAt: number;
  failures: string[];
  /** True when these frames came from the in-process cache, not a fresh build. */
  fromCache: boolean;
}

const frameCache = new Map<string, CachedFrames>();
const FRAME_TTL_MS = 30 * 60 * 1000;

function sanitizeSymbols(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    const sym = String(item).trim().toUpperCase();
    if (!sym) continue;
    if (!/^[A-Z0-9.\-^=]{1,12}$/.test(sym)) continue;
    if (!out.includes(sym)) out.push(sym);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

function sanitizeWeights(raw: unknown): WeightMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([k, v]) => [String(k).slice(0, 64), Math.max(0, Math.min(100, Number(v) || 0))] as const)
    .filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

/** Build (or reuse) the per-symbol frames for a universe. */
async function loadFrames(symbols: string[], years: number): Promise<CachedFrames> {
  const key = `${years}|${symbols.join(",")}`;
  const hit = frameCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < FRAME_TTL_MS) return { ...hit, fromCache: true };

  const frames: CalibrationFrame[] = [];
  const prepared: CachedFrames["prepared"] = [];
  const failures: string[] = [];

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const { bars } = await getDailyBars(symbol, years);
        if (bars.length < 300) return { symbol, error: "less than ~14 months of history" };
        return { symbol, bars };
      } catch (e) {
        return { symbol, error: e instanceof Error ? e.message : "price history unavailable" };
      }
    })
  );

  for (const r of results) {
    if ("error" in r) {
      failures.push(`${r.symbol}: ${r.error}`);
      continue;
    }
    const frame = prepareFrame(r.symbol, r.bars);
    if (frame.ids.length === 0) {
      failures.push(`${r.symbol}: no indicator produced a reading`);
      continue;
    }
    frames.push(frame);
    prepared.push({ symbol: r.symbol, bars: r.bars.length, from: r.bars[0].date, to: r.bars[r.bars.length - 1].date });
  }

  const value: CachedFrames = { frames, prepared, fetchedAt: Date.now(), failures, fromCache: false };
  if (frames.length > 0) frameCache.set(key, value);
  return value;
}

function buildOptions(data: Record<string, unknown>): Partial<TrainingOptions> {
  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    entry: Math.min(90, Math.max(10, num(data.entry, MEGA_BASELINE.entry))),
    exit: Math.min(85, Math.max(5, num(data.exit, MEGA_BASELINE.exit))),
    trainFraction: Math.min(0.9, Math.max(0.4, num(data.trainFraction, DEFAULT_TRAINING_OPTIONS.trainFraction))),
    commissionBps: Math.min(100, Math.max(0, num(data.commissionBps, DEFAULT_TRAINING_OPTIONS.commissionBps))),
    slippageBps: Math.min(200, Math.max(0, num(data.slippageBps, DEFAULT_TRAINING_OPTIONS.slippageBps))),
    minTrades: Math.min(60, Math.max(1, Math.round(num(data.minTrades, DEFAULT_TRAINING_OPTIONS.minTrades)))),
    passes: Math.min(4, Math.max(1, Math.round(num(data.passes, DEFAULT_TRAINING_OPTIONS.passes)))),
    searchBands: data.searchBands === undefined ? DEFAULT_TRAINING_OPTIONS.searchBands : Boolean(data.searchBands),
    includeCatalogue:
      data.includeCatalogue === undefined ? DEFAULT_TRAINING_OPTIONS.includeCatalogue : Boolean(data.includeCatalogue),
  };
}

// ─── GET — what the Training tab needs before it can run ────────
export async function GET() {
  try {
    return NextResponse.json({
      defaultUniverse: TRAINING_UNIVERSE,
      cachedSymbols: listCachedSymbols().map((s) => s.symbol),
      options: DEFAULT_TRAINING_OPTIONS,
      baseline: MEGA_BASELINE,
      units: SEARCH_UNITS.map((u) => ({ key: u.key, label: u.label, ids: u.ids, levels: u.levels, optional: u.optional })),
      unitCount: SEARCH_UNITS.length,
      priorWeights: DEFAULT_WEIGHTS,
      limits: { maxSymbols: MAX_SYMBOLS, maxYears: MAX_YEARS },
    });
  } catch (error) {
    console.error("Error in mega-train GET:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── POST — fetch the universe and run the calibration ──────────
export async function POST(request: NextRequest) {
  try {
    const data = (await request.json()) as Record<string, unknown>;
    const years = Math.min(MAX_YEARS, Math.max(2, Number(data.years) || 15));
    const symbols = sanitizeSymbols(data.symbols);
    if (symbols.length < 2) {
      return NextResponse.json(
        { error: "Training needs at least two tickers — a single stock cannot tell a robust weight from a lucky one." },
        { status: 400 }
      );
    }

    const options = buildOptions(data);
    const prior = sanitizeWeights(data.priorWeights) ?? (DEFAULT_WEIGHTS as WeightMap);

    const loaded = await loadFrames(symbols, years);
    const { prepared, fromCache } = loaded;
    const failures = [...loaded.failures];

    // The split is one index derived from the median history, so a ticker listed
    // recently ends up with an EMPTY test window: it would contribute a 0 Sharpe
    // to every aggregate and its "train" window would reach into the other
    // tickers' held-out tail. Drop it and say so instead of averaging in zeros.
    const trainFraction = options.trainFraction ?? DEFAULT_TRAINING_OPTIONS.trainFraction;
    const split = splitIndex(loaded.frames, trainFraction);
    const dropped: string[] = [];
    const frames = loaded.frames.filter((f) => {
      if (f.close.length - split >= MIN_TEST_BARS) return true;
      dropped.push(f.symbol);
      failures.push(
        `${f.symbol}: only ${f.close.length} bars, and the ${Math.round(trainFraction * 100)}% training split leaves under ${MIN_TEST_BARS} bars to test on`
      );
      return false;
    });
    // The run's ticker count must match what was actually trained.
    const usedPrepared = prepared.filter((p) => !dropped.includes(p.symbol));

    if (frames.length < 2) {
      return NextResponse.json(
        {
          error: `Not enough usable price history — ${frames.length} of ${symbols.length} tickers loaded. ${failures.join("; ")}`,
        },
        { status: 422 }
      );
    }

    const started = Date.now();
    const result = trainMegaWeights(frames, prior, options);
    if (failures.length > 0) {
      result.warnings.unshift(`Skipped ${failures.length} ticker${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}`);
    }

    return NextResponse.json({
      result,
      prepared: usedPrepared,
      failures,
      elapsedMs: Date.now() - started,
      framesFromCache: fromCache,
    });
  } catch (error) {
    console.error("Error in mega-train POST:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Training failed" },
      { status: 500 }
    );
  }
}
