// Mega Score calibration — a reproducible way to choose the composite's
// per-indicator weights and its BUY/SELL bands instead of guessing them.
//
// Method (and why it is shaped this way)
// --------------------------------------
// 1. Every indicator's 0-100 score series is computed ONCE per symbol, causal at
//    every bar (lib/mega-score), so a weight change never requires recomputing
//    indicators — only re-blending them.
// 2. The history is split chronologically: the first `trainFraction` is the ONLY
//    data the search may look at; the tail is a held-out test window that is
//    never touched while choosing weights or bands.
// 3. Weights are chosen by coordinate descent over SEARCH UNITS, not 50 free
//    parameters. The 16 SMA/EMA readings share one unit (the same trend counted
//    16 times — StockCharts calls this "the multiple counting of the same
//    information"), Stochastic %K/%D and StochRSI %K/%D are each one unit, and
//    every other indicator is its own unit. A small L1 penalty keeps the answer
//    close to the prior unless the data insists otherwise.
// 4. The bands are searched as a small pre-specified grid (entry/exit) with the
//    weights frozen, then weights and bands alternate once or twice — they
//    interact, because different weights move the score's distribution.
// 5. The number of candidate evaluations is counted. A train Sharpe is compared
//    with the best Sharpe pure luck would produce over that many tries
//    (`expectedMaxSharpeByChance`) — the anchor behind "is this edge real?".
//
// Everything here is pure: no network, no DB, no React. The API route and the
// Training tab feed it bars; tests feed it synthetic bars with a known edge.

import {
  ALL_SPECS,
  MA_PERIODS,
  MEGA_BASELINE,
  defaultWeightFor,
  type IndicatorSpec,
  type WeightMap,
} from "./mega-indicator";
import { CAUSAL_SPECS, computeMegaScoreSeries } from "./mega-score";

/** Minimum OHLCV shape needed (market-data's `Bar` satisfies it). */
export interface CalibrationBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Search units ──────────────────────────────────────────────
// One axis of the coordinate descent. A unit holds the indicators that move
// together, so correlated readings cannot be counted as independent evidence.

export interface SearchUnit {
  key: string;
  label: string;
  /** Indicator ids that receive the unit's weight. */
  ids: string[];
  /** Candidate per-member weights, ascending. */
  levels: number[];
  /** True when the unit is only searched on request (catalogue indicators). */
  optional: boolean;
}

const MA_FAMILY_IDS: string[] = MA_PERIODS.flatMap((p) => [`ta-sma-${p}`, `ta-ema-${p}`]);

/** Every causal spec that takes part in the composite. The kernel indicators are
 *  centred filters and are deliberately excluded from the score, so they cannot
 *  be trained either. */
export const TRAINABLE_SPECS: IndicatorSpec[] = CAUSAL_SPECS;

const specById = (id: string) => ALL_SPECS.find((s) => s.id === id);

const SINGLE_UNIT_IDS: string[] = TRAINABLE_SPECS
  .filter((s) => !MA_FAMILY_IDS.includes(s.id))
  // %K/%D of the same oscillator are one signal.
  .filter((s) => s.id !== "ta-stoch-d" && s.id !== "ta-stochrsi-d")
  .map((s) => s.id);

/**
 * The axes a training run searches. The SMA/EMA family is one axis (16 members);
 * everything else is searched on its own.
 */
export const SEARCH_UNITS: SearchUnit[] = [
  {
    key: "ma-family",
    label: `SMA/EMA family (${MA_FAMILY_IDS.length} periods)`,
    ids: MA_FAMILY_IDS,
    // Prior is 0.5 per member → the family carries 8 of 100.
    levels: [0, 0.1, 0.25, 0.5, 1, 2],
    optional: false,
  },
  ...SINGLE_UNIT_IDS.map((id): SearchUnit => {
    if (id === "ta-stoch-k") {
      return {
        key: "stoch",
        label: "Stochastic %K/%D",
        ids: ["ta-stoch-k", "ta-stoch-d"],
        levels: [0, 0.5, 1, 2, 3, 5],
        optional: false,
      };
    }
    if (id === "ta-stochrsi-k") {
      return {
        key: "stochrsi",
        label: "StochRSI %K/%D",
        ids: ["ta-stochrsi-k", "ta-stochrsi-d"],
        levels: [0, 0.5, 1, 2, 3, 5],
        optional: false,
      };
    }
    const spec = specById(id);
    const optional = !!spec?.optional;
    return {
      key: id,
      label: spec?.name ?? id,
      ids: [id],
      levels: optional ? [0, 0.5, 1, 2, 3] : [0, 0.5, 1, 2, 3, 5],
      optional,
    };
  }),
];

// ─── Prepared per-symbol data ──────────────────────────────────

/** One symbol's causal score series, ready to be re-blended with any weights. */
export interface CalibrationFrame {
  symbol: string;
  dates: string[];
  open: number[];
  close: number[];
  /** id -> 0-100 score per bar (NaN during warm-up). */
  scores: Record<string, number[]>;
  /** ids with at least one reading. */
  ids: string[];
  /** The weight each id gets when a map does not name it. */
  defaults: Record<string, number>;
}

/** Compute every indicator's score series once from the bars. */
export function prepareFrame(symbol: string, bars: CalibrationBar[]): CalibrationFrame {
  const series = computeMegaScoreSeries({
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  });

  const scores: Record<string, number[]> = {};
  const defaults: Record<string, number> = {};
  const ids: string[] = [];
  for (const spec of TRAINABLE_SPECS) {
    const s = series.indicators[spec.id];
    if (!s || !s.some((v) => Number.isFinite(v))) continue;
    scores[spec.id] = s;
    defaults[spec.id] = defaultWeightFor(spec.id, spec.optional);
    ids.push(spec.id);
  }

  return {
    symbol,
    dates: bars.map((b) => b.date),
    open: bars.map((b) => b.open),
    close: bars.map((b) => b.close),
    scores,
    ids,
    defaults,
  };
}

// ─── Weight helpers ────────────────────────────────────────────

/** The weight the composite gives one id under `weights`. */
function weightOf(frame: CalibrationFrame, weights: WeightMap, id: string): number {
  const raw = weights[id];
  const w = raw ?? frame.defaults[id] ?? 0;
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/** Per-bar weighted sum and weight sum — the composite's two parts. */
interface BlendState {
  ws: Float64Array;
  wsum: Float64Array;
}

function blendState(frame: CalibrationFrame, weights: WeightMap): BlendState {
  const n = frame.close.length;
  const ws = new Float64Array(n);
  const wsum = new Float64Array(n);
  for (const id of frame.ids) {
    const w = weightOf(frame, weights, id);
    if (w <= 0) continue;
    const s = frame.scores[id];
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (Number.isFinite(v)) {
        ws[i] += v * w;
        wsum[i] += w;
      }
    }
  }
  return { ws, wsum };
}

/** Add (wNew − wOld) for one id — the O(bars) update a coordinate step needs. */
function blendPatch(state: BlendState, frame: CalibrationFrame, id: string, wOld: number, wNew: number): void {
  const delta = wNew - wOld;
  if (delta === 0) return;
  const s = frame.scores[id];
  for (let i = 0; i < state.ws.length; i++) {
    const v = s[i];
    if (!Number.isFinite(v)) continue;
    state.ws[i] += v * delta;
    state.wsum[i] += delta;
  }
}

function compositeFrom(state: BlendState): number[] {
  const out = new Array<number>(state.ws.length);
  for (let i = 0; i < state.ws.length; i++) {
    const w = state.wsum[i];
    out[i] = w > 0 ? state.ws[i] / w : 50;
  }
  return out;
}

/** The blended 0-100 composite for one map, one reading per bar. */
export function compositeSeries(frame: CalibrationFrame, weights: WeightMap): number[] {
  return compositeFrom(blendState(frame, weights));
}

/** Rescale a weight map so its positive weights sum to `total` (100 by default). */
export function normalizeWeights(weights: WeightMap, total = 100): WeightMap {
  const sum = Object.values(weights).reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  const out: WeightMap = {};
  if (sum <= 0) return out;
  for (const [id, v] of Object.entries(weights)) {
    if (!Number.isFinite(v) || v <= 0) continue;
    out[id] = Math.round((v / sum) * total * 10) / 10;
  }
  return out;
}

/** Share of the composite each id carries, in 0-1 units. */
export function shareMap(frames: FrameSet, weights: WeightMap): Record<string, number> {
  const ids = unionIds(frames);
  const totals: Record<string, number> = {};
  let grand = 0;
  for (const id of ids) {
    const w = weightOf(frames[0], weights, id);
    if (w <= 0) continue;
    totals[id] = w;
    grand += w;
  }
  const out: Record<string, number> = {};
  for (const [id, w] of Object.entries(totals)) out[id] = grand > 0 ? w / grand : 0;
  return out;
}

function unionIds(frames: FrameSet): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of frames) for (const id of f.ids) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** Every built-in at weight 1, catalogue 0 — the flat-average ablation. */
export function equalWeights(frames: FrameSet): WeightMap {
  const w: WeightMap = {};
  for (const id of unionIds(frames)) w[id] = specById(id)?.optional ? 0 : 1;
  return w;
}

// ─── Regime simulation ─────────────────────────────────────────
// Long/flat on the composite with hysteresis: enter at `entry`, leave strictly
// below `exit`, execute at the NEXT bar's open (no look-ahead). Deliberately a
// small, separate model rather than a call into backtest-engine: thousands of
// candidate evaluations must run without building charts, trades or reports, and
// the fill rule here is the same one (next-open, commission + slippage). Each
// window starts flat, so a test window never inherits a position.

export interface RegimeCosts {
  commissionBps: number;
  slippageBps: number;
}

export interface RegimeResult {
  totalReturnPct: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  calmar: number;
  trades: number;
  winRate: number;
  avgTradePct: number;
  /** Average win ÷ average |loss| across trades (99 = no losing trade). */
  payoffRatio: number;
  exposurePct: number;
  /** Normalized equity (1 = start), one point per bar in the window. */
  equity: number[];
  /**
   * Buy & hold of the same window, normalized to 1 at the window's first close,
   * one point per bar. The summary stats below would be enough to *report* the
   * benchmark; the series is kept because the multiple-testing bar for the
   * excess-Sharpe measure needs the rule↔benchmark return correlation
   * (see expectedMaxExcessSharpeByChance).
   */
  benchmarkEquity: number[];
  bars: number;
  /** Buy & hold of the SAME window, so the rule is judged against its benchmark. */
  benchmarkSharpe: number;
  benchmarkMaxDrawdownPct: number;
  benchmarkTotalReturnPct: number;
}

/** Sharpe / Sortino / drawdown / CAGR of one normalized equity curve. */
function curveStats(equity: number[]): {
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  cagr: number;
  totalReturnPct: number;
} {
  const finalEq = equity.length ? equity[equity.length - 1] : 1;
  const daily: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) {
      const r = equity[i] / prev - 1;
      if (Number.isFinite(r)) daily.push(r);
    }
  }
  const meanDaily = daily.length ? daily.reduce((s, r) => s + r, 0) / daily.length : 0;
  const sdDaily =
    daily.length > 1
      ? Math.sqrt(daily.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / (daily.length - 1))
      : 0;
  const downside = daily.filter((r) => r < 0);
  const downDev =
    downside.length > 1 ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : 0;

  let peak = 1;
  let maxDD = 0;
  for (const eq of equity) {
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const years = equity.length > 0 ? equity.length / 252 : 1 / 252;
  const cagr = finalEq > 0 ? (Math.pow(finalEq, 1 / years) - 1) * 100 : -100;
  return {
    sharpe: sdDaily > 0 ? (meanDaily / sdDaily) * Math.sqrt(252) : 0,
    sortino: downDev > 0 ? (meanDaily / downDev) * Math.sqrt(252) : 0,
    maxDrawdownPct: maxDD,
    cagr,
    totalReturnPct: (finalEq - 1) * 100,
  };
}

export interface RegimeWindow {
  /** First bar index of the window (inclusive). */
  from: number;
  /** Last bar index of the window (exclusive). */
  to: number;
}

/**
 * Simulate the Mega Score regime rule over `scores` (one entry per bar) on the
 * given window. Equity is marked at each bar's close; the position fills at the
 * next bar's open after a signal. CAGR assumes 252 trading days per year.
 */
export function simulateRegime(
  scores: number[],
  frame: Pick<CalibrationFrame, "open" | "close">,
  entry: number,
  exit: number,
  costs: RegimeCosts = { commissionBps: 0, slippageBps: 0 },
  window?: RegimeWindow
): RegimeResult {
  const from = Math.max(0, window?.from ?? 0);
  const to = Math.min(window?.to ?? scores.length, scores.length);
  const bars = Math.max(0, to - from);
  const comm = Math.max(0, costs.commissionBps) / 10000;
  const slip = Math.max(0, costs.slippageBps) / 10000;

  let cash = 1;
  let shares = 0;
  let held = false;
  let pending = false;
  let entryCash = 1;
  let invested = 0;
  const tradeReturns: number[] = [];
  const equity: number[] = [];

  for (let i = from; i < to; i++) {
    // A signal from the previous close fills at this bar's open.
    if (i > from) {
      if (pending && !held) {
        const px = frame.open[i] * (1 + slip);
        if (Number.isFinite(px) && px > 0) {
          const sh = cash / (px * (1 + comm));
          if (Number.isFinite(sh) && sh > 0) {
            entryCash = cash;
            cash -= sh * px * (1 + comm);
            shares = sh;
            held = true;
          }
        }
      } else if (!pending && held) {
        cash += shares * frame.open[i] * (1 - slip) * (1 - comm);
        tradeReturns.push(entryCash > 0 ? (cash / entryCash - 1) * 100 : 0);
        shares = 0;
        held = false;
      }
    }
    if (held) invested++;
    equity.push(held ? cash + shares * frame.close[i] : cash);

    const s = scores[i];
    if (Number.isFinite(s)) pending = held ? s >= exit : s >= entry;
  }

  // Close anything still open at the window's last close.
  if (held && to > from) {
    cash += shares * frame.close[to - 1] * (1 - slip) * (1 - comm);
    tradeReturns.push(entryCash > 0 ? (cash / entryCash - 1) * 100 : 0);
    shares = 0;
    held = false;
    equity[equity.length - 1] = cash;
  }

  const stats = curveStats(equity);
  const wins = tradeReturns.filter((r) => r > 0);
  const losses = tradeReturns.filter((r) => r <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : 0;

  // Buy & hold of the same window (from the first close to the last), so every
  // reading carries its own benchmark instead of being compared with the
  // market's long-run average.
  const benchEquity: number[] = [];
  const base = frame.close[from] > 0 ? frame.close[from] : 1;
  for (let i = from; i < to; i++) benchEquity.push(frame.close[i] / base);
  const bench = curveStats(benchEquity);

  return {
    totalReturnPct: stats.totalReturnPct,
    cagr: stats.cagr,
    sharpe: stats.sharpe,
    sortino: stats.sortino,
    maxDrawdownPct: stats.maxDrawdownPct,
    calmar: stats.maxDrawdownPct > 0 ? stats.cagr / stats.maxDrawdownPct : stats.cagr > 0 ? 99 : 0,
    trades: tradeReturns.length,
    winRate: tradeReturns.length ? (wins.length / tradeReturns.length) * 100 : 0,
    avgTradePct: tradeReturns.length ? tradeReturns.reduce((s, r) => s + r, 0) / tradeReturns.length : 0,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0,
    exposurePct: bars > 0 ? (invested / bars) * 100 : 0,
    equity,
    benchmarkEquity: benchEquity,
    bars,
    benchmarkSharpe: bench.sharpe,
    benchmarkMaxDrawdownPct: bench.maxDrawdownPct,
    benchmarkTotalReturnPct: bench.totalReturnPct,
  };
}

// ─── Entry-reading separation ──────────────────────────────────
//
// A trained map can post a lower loss rate just by trading a different set of
// names and days. The question this answers is narrower: does the composite
// reading that OPENS a trade say anything about whether that trade wins? Every
// completed round trip is tagged with the reading on its signal bar, then the
// winners' and losers' readings are compared by mean gap and by AUC (chance a
// random winner's reading beats a random loser's). AUC 0.5 = no information.

export interface EntryOutcome {
  /** Composite reading on the signal bar that opened the trade. */
  score: number;
  /** Bars held, fill bar to exit fill bar. */
  bars: number;
  /** Net return of the completed round trip, %. */
  returnPct: number;
}

export interface EntrySeparation {
  trades: number;
  losers: number;
  lossRatePct: number;
  meanEntryWinners: number | null;
  meanEntryLosers: number | null;
  /** winners − losers, in score points. Positive = the reading favours winners. */
  gap: number | null;
  /** P(random winner's entry reading > random loser's). 0.5 = no separation. */
  auc: number | null;
  meanBarsWinners: number | null;
  meanBarsLosers: number | null;
}

/**
 * Replay the regime rule on a composite and record the reading that opened each
 * COMPLETED trade. A trade still open when the window ends is skipped: the
 * harness would close it at a price no signal asked for, so its outcome says
 * nothing about the entry reading. Fill model matches `simulateRegime`.
 */
export function collectEntryOutcomes(
  scores: number[],
  frame: Pick<CalibrationFrame, "open" | "close">,
  entry: number,
  exit: number,
  opts: { window?: RegimeWindow; costs?: RegimeCosts } = {}
): { wins: EntryOutcome[]; losses: EntryOutcome[] } {
  const from = Math.max(0, opts.window?.from ?? 0);
  const to = Math.min(opts.window?.to ?? scores.length, scores.length);
  const comm = Math.max(0, opts.costs?.commissionBps ?? 0) / 10000;
  const slip = Math.max(0, opts.costs?.slippageBps ?? 0) / 10000;
  const wins: EntryOutcome[] = [];
  const losses: EntryOutcome[] = [];

  let held = false;
  let pending = false;
  let entryScore = Number.NaN;
  let entryBar = 0;
  let shares = 0;

  for (let i = from; i < to; i++) {
    if (i > from) {
      if (pending && !held) {
        const px = frame.open[i] * (1 + slip);
        if (Number.isFinite(px) && px > 0) {
          const sh = 1 / (px * (1 + comm));
          if (Number.isFinite(sh) && sh > 0) {
            shares = sh;
            held = true;
            entryBar = i;
          }
        }
      } else if (!pending && held) {
        const cash = shares * frame.open[i] * (1 - slip) * (1 - comm);
        const outcome: EntryOutcome = { score: entryScore, bars: i - entryBar, returnPct: (cash - 1) * 100 };
        (outcome.returnPct > 0 ? wins : losses).push(outcome);
        held = false;
        shares = 0;
      }
    }

    const s = scores[i];
    if (Number.isFinite(s)) {
      if (held) {
        pending = s >= exit;
      } else {
        pending = s >= entry;
        // This is the signal bar; the fill lands on the next open.
        if (pending) entryScore = s;
      }
    }
  }

  // A position still open at `to` is ignored on purpose (see the doc comment).
  return { wins, losses };
}

export function summarizeEntrySeparation(wins: EntryOutcome[], losses: EntryOutcome[]): EntrySeparation {
  const trades = wins.length + losses.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const meanW = mean(wins.map((w) => w.score).filter((v) => Number.isFinite(v)));
  const meanL = mean(losses.map((l) => l.score).filter((v) => Number.isFinite(v)));

  let auc: number | null = null;
  if (wins.length > 0 && losses.length > 0) {
    let score = 0;
    for (const w of wins) {
      for (const l of losses) score += w.score > l.score ? 1 : w.score === l.score ? 0.5 : 0;
    }
    auc = score / (wins.length * losses.length);
  }

  return {
    trades,
    losers: losses.length,
    lossRatePct: trades > 0 ? (losses.length / trades) * 100 : 0,
    meanEntryWinners: meanW,
    meanEntryLosers: meanL,
    gap: meanW !== null && meanL !== null ? meanW - meanL : null,
    auc,
    meanBarsWinners: mean(wins.map((w) => w.bars)),
    meanBarsLosers: mean(losses.map((l) => l.bars)),
  };
}

// ─── Objective ─────────────────────────────────────────────────

export interface AggregateStats {
  meanSharpe: number;
  meanSortino: number;
  meanCagr: number;
  meanTotalReturnPct: number;
  meanMaxDrawdownPct: number;
  meanCalmar: number;
  meanExposurePct: number;
  meanWinRate: number;
  meanTrades: number;
  totalTrades: number;
  /** Buy & hold the same windows, for the same symbols. */
  meanBenchmarkSharpe: number;
  meanBenchmarkMaxDrawdownPct: number;
  meanBenchmarkTotalReturnPct: number;
  /** meanSharpe − meanBenchmarkSharpe: what timing the composite actually added. */
  meanExcessSharpe: number;
  /** Symbols that cleared the per-symbol trade floor. */
  validSymbols: number;
  symbols: number;
}

export function aggregate(results: RegimeResult[]): AggregateStats {
  const n = results.length || 1;
  const mean = (pick: (r: RegimeResult) => number) => results.reduce((s, r) => s + pick(r), 0) / n;
  return {
    meanSharpe: mean((r) => r.sharpe),
    meanSortino: mean((r) => r.sortino),
    meanCagr: mean((r) => r.cagr),
    meanTotalReturnPct: mean((r) => r.totalReturnPct),
    meanMaxDrawdownPct: mean((r) => r.maxDrawdownPct),
    meanCalmar: mean((r) => r.calmar),
    meanExposurePct: mean((r) => r.exposurePct),
    meanWinRate: mean((r) => r.winRate),
    meanTrades: mean((r) => r.trades),
    totalTrades: results.reduce((s, r) => s + r.trades, 0),
    meanBenchmarkSharpe: mean((r) => r.benchmarkSharpe),
    meanBenchmarkMaxDrawdownPct: mean((r) => r.benchmarkMaxDrawdownPct),
    meanBenchmarkTotalReturnPct: mean((r) => r.benchmarkTotalReturnPct),
    meanExcessSharpe: mean((r) => r.sharpe - r.benchmarkSharpe),
    validSymbols: 0,
    symbols: results.length,
  };
}

/**
 * The scalar the search maximizes: the mean Sharpe *in excess of buy & hold* on
 * the same window, plus a credit for cutting the drawdown, across symbols that
 * closed at least `minTrades` trades. A candidate that barely trades on most of
 * the universe returns -Infinity unless at least half the universe clears the
 * floor.
 *
 * Why excess over buy & hold, and not raw Sharpe: the composite is a *timing*
 * signal on stocks that mostly go up. Raw Sharpe quietly rewards staying fully
 * invested — the first version of this function did exactly that and "learned"
 * to hold 95% of the time and trade 1.4 times per symbol, which is buy & hold
 * with extra steps. Measuring each window against its own buy & hold makes the
 * search pay for *avoiding* the bad stretches, which is the point of the score.
 */
export function objectiveValue(
  results: RegimeResult[],
  minTrades: number,
  drawdownPenalty = 0.5
): { value: number; validSymbols: number } {
  const valid = results.filter((r) => r.trades >= minTrades);
  const need = Math.max(1, Math.ceil(results.length / 2));
  if (valid.length < need) return { value: -Infinity, validSymbols: valid.length };
  const meanExcess = valid.reduce((s, r) => s + (r.sharpe - r.benchmarkSharpe), 0) / valid.length;
  const ddImprovement =
    valid.reduce((s, r) => s + (r.benchmarkMaxDrawdownPct - r.maxDrawdownPct), 0) / valid.length;
  return { value: meanExcess + drawdownPenalty * (ddImprovement / 100), validSymbols: valid.length };
}

// ─── Multiple-testing diagnostic ───────────────────────────────

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

/**
 * The annualized Sharpe that pure luck is expected to produce when you pick the
 * best of `trials` candidates on `years` of data: the expected maximum of
 * `trials` standard normals, scaled by the Sharpe's standard error (≈ 1/√years
 * for a zero true Sharpe). Bailey & López de Prado's deflated-Sharpe idea in one
 * number — used to ask whether a train Sharpe is more than search.
 *
 * NOTE the scale: this is the bar for a strategy's RAW Sharpe, judged against
 * zero. The search's objective is different (Sharpe in excess of buy & hold), so
 * a raw Sharpe must not be compared with this number when the question is "did
 * timing the composite beat holding the stock". For that comparison use
 * expectedMaxExcessSharpeByChance below, which is this number rescaled by the
 * measured rule↔benchmark return correlation.
 */
export function expectedMaxSharpeByChance(years: number, trials: number): number {
  if (!(years > 0) || !(trials > 0)) return 0;
  const g = 0.5772156649015329; // Euler–Mascheroni
  const n = Math.max(2, trials);
  const z1 = normalQuantile(1 - 1 / n);
  const z2 = normalQuantile(1 - 1 / (n * Math.E));
  return Math.max(0, ((1 - g) * z1 + g * z2) / Math.sqrt(years));
}

/**
 * The same expected-maximum bar, on the measure the search actually maximizes:
 * mean Sharpe in EXCESS of buy & hold.
 *
 * The raw bar scales the expected maximum of `trials` draws by the Sharpe
 * estimator's standard error (≈ 1/√years). That is the right scale for one
 * strategy judged against zero, but the decision here is the difference
 * SR_rule − SR_benchmark. Both legs are estimated from the same bars and move
 * together — the rule is holding the stock most of the time — so
 * Var(SR_rule − SR_benchmark) ≈ (2 − 2ρ)/years, not 2/years, for a per-bar
 * return correlation ρ.
 *
 * Ignoring that made the two scales disagree, and the disagreement is not
 * academic: a run's *raw* held-out Sharpe can sit above the raw bar while its
 * excess over buy & hold is negative, which reads as "cleared the bar" for a
 * rule that added nothing. Comparing an excess Sharpe against the excess bar is
 * the only comparison the objective poses.
 *
 * ρ = 1 (the rule IS its benchmark, so its excess is identically zero) gives a
 * bar of 0 — correct in the limit. An unmeasurable ρ falls back to 0, i.e. two
 * independent legs, which is the conservative direction (a wider bar).
 */
export function expectedMaxExcessSharpeByChance(
  years: number,
  trials: number,
  correlation: number
): number {
  const rho = Number.isFinite(correlation) ? Math.min(1, Math.max(-1, correlation)) : 0;
  return expectedMaxSharpeByChance(years, trials) * Math.sqrt(Math.max(0, 2 - 2 * rho));
}

/**
 * Pooled per-bar return correlation between a set of runs' equity curves and
 * their own buy & hold benchmarks — the ρ the excess-Sharpe bar needs.
 *
 * Bars where the rule is flat sit at a 0% return while the benchmark keeps
 * moving. They are counted deliberately: they are exactly the information the
 * correction needs, because the more the rule sits out, the lower the
 * correlation and the wider (more demanding) the bar becomes.
 *
 * Returns 0 — the conservative fallback — when there are too few overlapping
 * bars or either series has no variance.
 */
export function ruleBenchmarkCorrelation(runs: RegimeResult[]): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (const run of runs) {
    const a = run.equity;
    const b = run.benchmarkEquity;
    const len = Math.min(a.length, b.length);
    for (let i = 1; i < len; i++) {
      if (!(a[i - 1] > 0) || !(b[i - 1] > 0)) continue;
      const ra = a[i] / a[i - 1] - 1;
      const rb = b[i] / b[i - 1] - 1;
      if (!Number.isFinite(ra) || !Number.isFinite(rb)) continue;
      n++;
      sa += ra;
      sb += rb;
      saa += ra * ra;
      sbb += rb * rb;
      sab += ra * rb;
    }
  }
  if (n < 3) return 0;
  const ma = sa / n;
  const mb = sb / n;
  const va = saa / n - ma * ma;
  const vb = sbb / n - mb * mb;
  const cov = sab / n - ma * mb;
  const denom = Math.sqrt(va * vb);
  if (!(denom > 0)) return 0;
  return Math.min(1, Math.max(-1, cov / denom));
}

// ─── Score distribution ────────────────────────────────────────

export interface ScoreDistribution {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  bars: number;
}

/** Percentiles of the composite over a window — what the bands sit inside. */
export function scoreDistribution(scores: number[], window?: RegimeWindow): ScoreDistribution {
  const from = Math.max(0, window?.from ?? 0);
  const to = Math.min(window?.to ?? scores.length, scores.length);
  const vals: number[] = [];
  for (let i = from; i < to; i++) if (Number.isFinite(scores[i])) vals.push(scores[i]);
  vals.sort((a, b) => a - b);
  const q = (p: number) => {
    if (vals.length === 0) return 50;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)));
    return Math.round(vals[idx] * 10) / 10;
  };
  return { p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), bars: vals.length };
}

// ─── Frames → evaluation ───────────────────────────────────────

export type FrameSet = CalibrationFrame[];

/** Index where each symbol's training window ends (its own 70% by default). */
export function splitIndex(frames: FrameSet, trainFraction: number): number {
  const lens = frames.map((f) => f.close.length).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const frac = Math.min(0.95, Math.max(0.3, trainFraction));
  return Math.max(60, Math.floor(median * frac));
}

export interface SymbolReport {
  symbol: string;
  bars: number;
  train: Omit<RegimeResult, "equity" | "benchmarkEquity">;
  test: Omit<RegimeResult, "equity" | "benchmarkEquity">;
  /** Buy & hold over the same held-out window. */
  buyHoldTestSharpe: number;
  buyHoldTestMaxDrawdownPct: number;
  buyHoldTestPct: number;
}

export interface VariantRun {
  train: AggregateStats;
  test: AggregateStats;
  perSymbol: SymbolReport[];
  curve: Array<{ date: string; equity: number }>;
}

const stripEquity = (r: RegimeResult): Omit<RegimeResult, "equity" | "benchmarkEquity"> => ({
  totalReturnPct: r.totalReturnPct,
  cagr: r.cagr,
  sharpe: r.sharpe,
  sortino: r.sortino,
  maxDrawdownPct: r.maxDrawdownPct,
  calmar: r.calmar,
  trades: r.trades,
  winRate: r.winRate,
  avgTradePct: r.avgTradePct,
  payoffRatio: r.payoffRatio,
  exposurePct: r.exposurePct,
  bars: r.bars,
  benchmarkSharpe: r.benchmarkSharpe,
  benchmarkMaxDrawdownPct: r.benchmarkMaxDrawdownPct,
  benchmarkTotalReturnPct: r.benchmarkTotalReturnPct,
});

/**
 * Equal-weight portfolio curve across the universe: average each symbol's daily
 * return, compound it. Built from the test window and aligned to the right-hand
 * edge (all histories end on the same session), so it reads as "what the rule
 * would have done on data it never saw".
 */
function portfolioCurve(frames: FrameSet, results: RegimeResult[]): Array<{ date: string; equity: number }> {
  const reference = frames.reduce((a, b) => (a.dates.length >= b.dates.length ? a : b));
  const count = Math.min(...results.map((r) => r.equity.length).filter((n) => n > 0));
  if (!Number.isFinite(count) || count <= 0) return [];
  const dates = reference.dates.slice(reference.dates.length - count);

  const rets = new Array(count).fill(0);
  const counts = new Array(count).fill(0);
  for (const r of results) {
    const offset = r.equity.length - count;
    for (let k = 1; k < count; k++) {
      const prev = r.equity[offset + k - 1];
      if (prev > 0) {
        rets[k - 1] += r.equity[offset + k] / prev - 1;
        counts[k - 1]++;
      }
    }
  }

  let eq = 1;
  const out: Array<{ date: string; equity: number }> = [{ date: dates[0] ?? "", equity: 1 }];
  for (let k = 0; k < count; k++) {
    if (counts[k] > 0) eq *= 1 + rets[k] / counts[k];
    if (k > 0) out.push({ date: dates[k] ?? "", equity: eq });
  }
  return out;
}

/**
 * Run one weight/band configuration over the whole universe and report both
 * windows. Used for the prior, the ablations and the tuned answer, so every row
 * of the comparison table is measured the same way.
 */
export function evaluateVariant(
  frames: FrameSet,
  weights: WeightMap,
  entry: number,
  exit: number,
  opts: { split: number; costs: RegimeCosts; minTrades: number }
): VariantRun {
  const perSymbol: SymbolReport[] = [];
  const trainResults: RegimeResult[] = [];
  const testResults: RegimeResult[] = [];

  for (const frame of frames) {
    const composite = compositeFrom(blendState(frame, weights));
    const n = frame.close.length;
    const edge = Math.min(opts.split, n);
    const train = simulateRegime(composite, frame, entry, exit, opts.costs, { from: 0, to: edge });
    const test = simulateRegime(composite, frame, entry, exit, opts.costs, { from: edge, to: n });
    trainResults.push(train);
    testResults.push(test);
    perSymbol.push({
      symbol: frame.symbol,
      bars: n - edge,
      train: stripEquity(train),
      test: stripEquity(test),
      buyHoldTestSharpe: test.benchmarkSharpe,
      buyHoldTestMaxDrawdownPct: test.benchmarkMaxDrawdownPct,
      buyHoldTestPct: test.benchmarkTotalReturnPct,
    });
  }

  const train = aggregate(trainResults);
  const test = aggregate(testResults);
  train.validSymbols = trainResults.filter((r) => r.trades >= opts.minTrades).length;
  test.validSymbols = testResults.filter((r) => r.trades >= opts.minTrades).length;

  return { train, test, perSymbol, curve: portfolioCurve(frames, testResults) };
}

// ─── Training ──────────────────────────────────────────────────

export interface TrainingOptions {
  /** Starting bands (the prior baseline unless the caller says otherwise). */
  entry: number;
  exit: number;
  /** Share of each symbol's history the search may look at. */
  trainFraction: number;
  commissionBps: number;
  slippageBps: number;
  /** Per-symbol trade floor: a symbol needs this many trades on a window to count. */
  minTrades: number;
  /** Coordinate-descent passes over the search units. */
  passes: number;
  /** Search the bands as well as the weights. */
  searchBands: boolean;
  /** Include the optional catalogue indicators as searchable axes. */
  includeCatalogue: boolean;
  /** L1 penalty on the distance from the prior, in normalized share units. */
  shrink: number;
  /** Entry/exit candidates for the band search. */
  entryGrid: number[];
  exitGrid: number[];
}

export const DEFAULT_TRAINING_OPTIONS: TrainingOptions = {
  entry: MEGA_BASELINE.entry,
  exit: MEGA_BASELINE.exit,
  trainFraction: 0.7,
  commissionBps: 2,
  slippageBps: 2,
  minTrades: 4,
  passes: 2,
  searchBands: true,
  includeCatalogue: false,
  shrink: 0.02,
  entryGrid: [50, 52.5, 55, 57.5, 60, 62.5, 65, 67.5, 70, 72.5, 75, 77.5, 80, 82.5, 85],
  exitGrid: [10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50],
};

export interface VariantReport {
  key: string;
  label: string;
  description: string;
  weights: WeightMap;
  entry: number;
  exit: number;
  train: AggregateStats;
  test: AggregateStats;
  perSymbol: SymbolReport[];
  curve: VariantRun["curve"];
}

export interface WeightDelta {
  id: string;
  name: string;
  unit: string;
  prior: number;
  tuned: number;
  priorSharePct: number;
  tunedSharePct: number;
}

export interface CalibrationResult {
  symbols: string[];
  bars: number;
  dateFrom: string;
  dateTo: string;
  trainTo: string;
  splitIndex: number;
  trainFraction: number;
  costs: RegimeCosts;
  minTrades: number;
  /** Candidate configurations evaluated on the training window. */
  trials: number;
  /** Train-window Sharpe pure luck would be expected to produce over `trials`.
   *  RAW-Sharpe scale — see `luckExcessSharpe` for the measure the objective uses. */
  luckSharpe: number;
  /**
   * The same bar on the excess-Sharpe scale. **This is the number the held-out
   * result must be compared against** (`variants.tuned.test.meanExcessSharpe`),
   * because the search maximizes excess over buy & hold, not raw Sharpe.
   */
  luckExcessSharpe: number;
  /** Measured per-bar return correlation between the tuned rule and its benchmark. */
  returnCorrelation: number;
  /** Years of training data the search saw. */
  trainYears: number;
  /** Objective actually maximized (described for the UI). */
  objective: string;
  prior: { entry: number; exit: number };
  tuned: { entry: number; exit: number };
  weights: WeightMap;
  variants: VariantReport[];
  deltas: WeightDelta[];
  distribution: { train: ScoreDistribution; test: ScoreDistribution };
  /**
   * Does the entry reading separate winners from losers on the held-out window,
   * at the bands this run would apply? Prior vs trained isolates the weights.
   * AUC 0.5 means the reading carries no information about the outcome.
   */
  separation: {
    prior: EntrySeparation;
    tuned: EntrySeparation;
    /** The trained map's metric per ticker, worst AUC first (unjudgeable last). */
    perSymbol: Array<{ symbol: string } & EntrySeparation>;
  };
  searchUnits: Array<{ key: string; label: string; ids: string[]; prior: number; tuned: number }>;
  warnings: string[];
}

interface Axis {
  unit: SearchUnit;
  /** Current per-member weight. */
  weight: number;
}

function priorWeightFor(frame: CalibrationFrame, id: string, prior: WeightMap): number {
  const w = prior[id];
  if (Number.isFinite(w)) return w as number;
  return defaultWeightFor(id, specById(id)?.optional);
}

/** The weight map the current axes describe (un-normalized, prior ids kept). */
function weightsFromAxes(frames: FrameSet, axes: Axis[], prior: WeightMap): WeightMap {
  const weights: WeightMap = { ...prior };
  for (const axis of axes) for (const id of axis.unit.ids) weights[id] = axis.weight;
  return weights;
}

interface BandSet {
  entry: number;
  exit: number;
}

/**
 * Best entry/exit pair on the training window for a frozen weight map. The grid
 * is small and declared up front, and pairs narrower than 10 points are skipped
 * because a hairline no-trade band just flips on noise.
 */
export function bestBands(
  frames: FrameSet,
  weights: WeightMap,
  opts: Pick<TrainingOptions, "entryGrid" | "exitGrid" | "entry" | "exit">,
  split: number,
  costs: RegimeCosts,
  minTrades: number
): BandSet {
  const blends = frames.map((f) => blendState(f, weights));
  let best: BandSet = { entry: opts.entry, exit: opts.exit };
  let bestValue = -Infinity;
  for (const entry of opts.entryGrid) {
    for (const exit of opts.exitGrid) {
      if (entry - exit < 10) continue;
      const results = frames.map((frame, i) =>
        simulateRegime(compositeFrom(blends[i]), frame, entry, exit, costs, {
          from: 0,
          to: Math.min(split, frame.close.length),
        })
      );
      const { value } = objectiveValue(results, minTrades);
      if (value > bestValue) {
        bestValue = value;
        best = { entry, exit };
      }
    }
  }
  return best;
}

/**
 * Choose weights + bands on the training window only.
 *
 * Protocol (all of it happens before the test window is read):
 *   • axes ordered as SEARCH_UNITS declares them — deterministic, no seed;
 *   • per axis, every candidate level is evaluated with a patched blend state;
 *   • `shrink` penalizes distance from the prior, so a level must earn its
 *     change rather than win on noise;
 *   • weights and bands alternate (`passes` rounds) because they interact:
 *     different weights put the score's distribution in a different place.
 */
export function trainMegaWeights(
  frames: FrameSet,
  prior: WeightMap,
  options: Partial<TrainingOptions> = {}
): CalibrationResult {
  if (frames.length === 0) throw new Error("No price history was prepared — nothing to train on.");
  const opts: TrainingOptions = { ...DEFAULT_TRAINING_OPTIONS, ...options };
  const costs: RegimeCosts = { commissionBps: opts.commissionBps, slippageBps: opts.slippageBps };
  const split = splitIndex(frames, opts.trainFraction);
  const minTrades = Math.max(1, Math.round(opts.minTrades));
  const warnings: string[] = [];
  const ids0 = unionIds(frames);

  const axes: Axis[] = SEARCH_UNITS.filter((u) => opts.includeCatalogue || !u.optional).map((unit) => ({
    unit,
    weight: priorWeightFor(frames[0], unit.ids[0], prior),
  }));

  // The MA family is one axis; seed it with the mean of its members' prior.
  const ma = axes.find((a) => a.unit.key === "ma-family");
  if (ma) {
    const vals = ma.unit.ids.map((id) => priorWeightFor(frames[0], id, prior)).filter((v) => v > 0);
    ma.weight = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  }

  const priorShares = shareMap(frames, prior);
  const distanceFromPrior = (weightMap: WeightMap): number => {
    const shares = shareMap(frames, weightMap);
    let d = 0;
    for (const id of ids0) d += Math.abs((shares[id] ?? 0) - (priorShares[id] ?? 0));
    return d;
  };
  const penalized = (value: number, weightMap: WeightMap): number =>
    Number.isFinite(value) ? value - opts.shrink * distanceFromPrior(weightMap) : -Infinity;

  let entry = opts.entry;
  let exit = opts.exit;
  let trials = 1;
  const states = frames.map((f) => blendState(f, weightsFromAxes(frames, axes, prior)));

  const trainObjective = (blends: BlendState[]): number => {
    const results = frames.map((frame, i) =>
      simulateRegime(compositeFrom(blends[i]), frame, entry, exit, costs, {
        from: 0,
        to: Math.min(split, frame.close.length),
      })
    );
    return objectiveValue(results, minTrades).value;
  };

  const searchBands = (): void => {
    if (!opts.searchBands) return;
    const candidate = bestBands(frames, weightsFromAxes(frames, axes, prior), opts, split, costs, minTrades);
    trials += opts.entryGrid.length * opts.exitGrid.length; // count the grid honestly
    if (candidate.entry !== entry || candidate.exit !== exit) {
      entry = candidate.entry;
      exit = candidate.exit;
    }
  };

  searchBands();

  for (let pass = 0; pass < Math.max(1, opts.passes); pass++) {
    for (const axis of axes) {
      const ids = axis.unit.ids.filter((id) => frames.some((f) => f.ids.includes(id)));
      if (ids.length === 0) continue;
      const base = axis.weight;
      let bestLevel = base;
      let bestScore = penalized(trainObjective(states), weightsFromAxes(frames, axes, prior));

      for (const level of axis.unit.levels) {
        if (level === base) continue;
        const candidateWeights = weightsFromAxes(frames, axes, prior);
        for (const id of ids) candidateWeights[id] = level;
        const patched = states.map((state, i) => {
          const copy: BlendState = {
            ws: Float64Array.from(state.ws),
            wsum: Float64Array.from(state.wsum),
          };
          for (const id of ids) blendPatch(copy, frames[i], id, base, level);
          return copy;
        });
        trials++;
        const score = penalized(trainObjective(patched), candidateWeights);
        if (score > bestScore) {
          bestScore = score;
          bestLevel = level;
        }
      }

      if (bestLevel !== base) {
        axis.weight = bestLevel;
        for (let i = 0; i < frames.length; i++) {
          for (const id of ids) blendPatch(states[i], frames[i], id, base, bestLevel);
        }
      }
    }
    searchBands();
  }

  // ── The answer and the ablations, all measured identically ─────
  const tunedRaw = weightsFromAxes(frames, axes, prior);
  const tunedNormalized = normalizeWeights(tunedRaw);
  const equal = equalWeights(frames);
  const bandsOnly = bestBands(frames, prior, opts, split, costs, minTrades);
  const evalOpts = { split, costs, minTrades };

  const variants: VariantReport[] = [
    {
      key: "prior",
      label: "Prior (hand-set defaults)",
      description: "The weights and bands the app shipped with before this training run.",
      weights: prior,
      entry: opts.entry,
      exit: opts.exit,
      ...evaluateVariant(frames, prior, opts.entry, opts.exit, evalOpts),
    },
    {
      key: "equal",
      label: "Everything equal",
      description: "Every built-in indicator weighted 1 — the flat average the balanced preset replaced.",
      weights: equal,
      entry: opts.entry,
      exit: opts.exit,
      ...evaluateVariant(frames, equal, opts.entry, opts.exit, evalOpts),
    },
    {
      key: "bands-only",
      label: "Bands tuned, weights untouched",
      description: "Prior weights with the training window's best bands — what band tuning alone buys.",
      weights: prior,
      entry: bandsOnly.entry,
      exit: bandsOnly.exit,
      ...evaluateVariant(frames, prior, bandsOnly.entry, bandsOnly.exit, evalOpts),
    },
    {
      key: "weights-only",
      label: "Weights tuned, prior bands",
      description: "Trained weights still judged against the original bands — what weight tuning alone buys.",
      weights: tunedNormalized,
      entry: opts.entry,
      exit: opts.exit,
      ...evaluateVariant(frames, tunedNormalized, opts.entry, opts.exit, evalOpts),
    },
    {
      key: "tuned",
      label: "Trained weights + trained bands",
      description: "The answer: weights and bands chosen on the training window, measured on both windows.",
      weights: tunedNormalized,
      entry,
      exit,
      ...evaluateVariant(frames, tunedNormalized, entry, exit, evalOpts),
    },
  ];

  const tunedShares = shareMap(frames, tunedNormalized);
  const deltas: WeightDelta[] = ids0
    .map((id) => {
      const spec = specById(id);
      return {
        id,
        name: spec?.name ?? id,
        unit: spec?.unit ?? "",
        prior: Math.round((prior[id] ?? priorShares[id] ?? 0) * 100) / 100,
        tuned: Math.round((tunedNormalized[id] ?? 0) * 100) / 100,
        priorSharePct: Math.round((priorShares[id] ?? 0) * 1000) / 10,
        tunedSharePct: Math.round((tunedShares[id] ?? 0) * 1000) / 10,
      };
    })
    .sort((a, b) => b.tunedSharePct - a.tunedSharePct);

  const longest = frames.reduce((a, b) => (a.close.length >= b.close.length ? a : b));
  const trainYears = Math.max(1 / 12, split / 252);

  // ── The bar the objective is actually judged against ───────────
  // The raw bar answers "is this Sharpe more than a search could produce from
  // noise". The decision the trainer poses is different — "did timing the
  // composite beat simply holding the same stocks" — so the bar belongs on the
  // EXCESS measure, whose standard error is smaller because the rule and its
  // benchmark are estimated from the same bars and largely move together. The
  // correlation is measured on the training window and the tuned rule, like every
  // other quantity the search is allowed to see.
  const returnCorrelation = ruleBenchmarkCorrelation(
    frames.map((frame) =>
      simulateRegime(compositeFrom(blendState(frame, tunedRaw)), frame, entry, exit, costs, {
        from: 0,
        to: Math.min(split, frame.close.length),
      })
    )
  );
  const luckSharpeRaw = expectedMaxSharpeByChance(trainYears, trials);
  const luckExcessSharpe = expectedMaxExcessSharpeByChance(trainYears, trials, returnCorrelation);

  const tunedComposite = compositeFrom(blendState(longest, tunedNormalized));

  // Entry-reading separation on the HELD-OUT window, at the bands this run
  // would apply. Prior is measured at the same bands, so the map is the only
  // variable. This is a warning sign, not a pass mark: a low loss rate with
  // AUC ≈ 0.5 means the map changed exposure, not its ability to pick entries.
  const separationFor = (weights: WeightMap) => {
    const wins: EntryOutcome[] = [];
    const losses: EntryOutcome[] = [];
    const perSymbol: Array<{ symbol: string } & EntrySeparation> = [];
    for (const frame of frames) {
      const edge = Math.min(split, frame.close.length);
      const out = collectEntryOutcomes(compositeSeries(frame, weights), frame, entry, exit, {
        window: { from: edge, to: frame.close.length },
        costs,
      });
      wins.push(...out.wins);
      losses.push(...out.losses);
      perSymbol.push({ symbol: frame.symbol, ...summarizeEntrySeparation(out.wins, out.losses) });
    }
    // Worst first so a misread ticker is the first thing the tab shows; an
    // unjudgeable one (one-sided sample) sorts last.
    perSymbol.sort((a, b) => (a.auc ?? 2) - (b.auc ?? 2));
    return { pooled: summarizeEntrySeparation(wins, losses), perSymbol };
  };
  const priorSeparation = separationFor(prior);
  const tunedSeparation = separationFor(tunedNormalized);
  const separation = {
    prior: priorSeparation.pooled,
    tuned: tunedSeparation.pooled,
    perSymbol: tunedSeparation.perSymbol,
  };

  const tunedVariant = variants.find((v) => v.key === "tuned")!;
  const priorVariant = variants.find((v) => v.key === "prior")!;
  if (tunedVariant.test.meanTrades < minTrades) {
    warnings.push(
      `The trained configuration averages fewer than ${minTrades} trades per symbol in the test window — read the held-out Sharpe as indicative, not proven.`
    );
  }
  if (tunedVariant.test.meanExcessSharpe <= priorVariant.test.meanExcessSharpe) {
    warnings.push(
      "The trained configuration did not beat the prior out of sample (on excess return over buy & hold). Keep the prior weights: the training window's edge did not survive."
    );
  }
  if (tunedVariant.test.meanExcessSharpe <= 0) {
    warnings.push(
      "Out of sample the trained rule did not beat buy & hold itself — timing the composite added nothing over simply holding the same stocks."
    );
  }
  warnings.push(
    `${trials} candidate configurations were evaluated on the training window. Pure luck over that many tries is expected to produce a mean Sharpe of about ${luckSharpeRaw.toFixed(2)} — and, on the measure the search actually maximizes (Sharpe in excess of buy & hold), an excess Sharpe of about ${luckExcessSharpe.toFixed(2)} (the rule's return correlation with its benchmark measured ${returnCorrelation.toFixed(2)}). Judge the held-out EXCESS number against that second bar: a raw Sharpe can clear the first while the rule still added nothing over holding the stock (Bailey & López de Prado's deflated-Sharpe idea).`
  );
  warnings.push(
    "Weights and bands were fitted on the training window only. The test column is the honest number — it is one universe over one history, not a guarantee."
  );

  return {
    symbols: frames.map((f) => f.symbol),
    bars: longest.close.length,
    dateFrom: longest.dates[0],
    dateTo: longest.dates[longest.dates.length - 1],
    trainTo: longest.dates[Math.min(split, longest.dates.length - 1)],
    splitIndex: split,
    trainFraction: opts.trainFraction,
    costs,
    minTrades,
    trials,
    luckSharpe: Math.round(luckSharpeRaw * 100) / 100,
    luckExcessSharpe: Math.round(luckExcessSharpe * 100) / 100,
    returnCorrelation: Math.round(returnCorrelation * 1000) / 1000,
    trainYears: Math.round(trainYears * 10) / 10,
    objective: `mean Sharpe in excess of buy & hold (plus 0.5 × any drawdown cut) across symbols closing ≥ ${minTrades} trades, on the training window only`,
    prior: { entry: opts.entry, exit: opts.exit },
    tuned: { entry, exit },
    weights: tunedNormalized,
    variants,
    deltas,
    separation,
    distribution: {
      train: scoreDistribution(tunedComposite, { from: 0, to: split }),
      test: scoreDistribution(tunedComposite.slice(Math.min(split, tunedComposite.length))),
    },
    searchUnits: axes.map((a) => ({
      key: a.unit.key,
      label: a.unit.label,
      ids: a.unit.ids,
      prior: Math.round(priorWeightFor(frames[0], a.unit.ids[0], prior) * 100) / 100,
      tuned: Math.round(a.weight * 100) / 100,
    })),
    warnings,
  };
}
