// Event-driven portfolio simulator for long-only stock strategies.
// Signals execute at the NEXT bar's open (no look-ahead bias), with
// commissions, slippage, and position sizing as a percent of equity.

import { getDailyBars, Bar } from "./market-data";
import { getStrategy, defaultParams, STRATEGIES, type StrategyDef } from "./strategies";
import { sma, atr } from "./ta";
import { barCadence, resampleBars, type BarInterval, type BarUnit } from "./bar-resample";
import { computeMegaScoreSeries } from "./mega-score";
import { ALL_SPECS, defaultWeights, type IndicatorOverrideMap, type WeightMap } from "./mega-indicator";

export interface BacktestConfig {
  symbol: string;
  strategyId: string;
  initialCapital: number;
  years: number;
  commissionBps: number;   // per-side commission, basis points of trade value
  slippageBps: number;     // per-side slippage, basis points of price
  positionPct: number;     // percent of equity deployed per position
  params: Record<string, number>;
  stopLossPct?: number;    // 0/undefined = disabled; else exit if price falls this % below entry
  takeProfitPct?: number;  // 0/undefined = disabled; else exit if price rises this % above entry
  /** Hard entry budget: no new position once this many trades have been opened (0/undefined = unlimited). */
  maxTrades?: number;
  /**
   * Day-trading mode: close whatever is open at each session's last bar (fill at
   * that bar's close) and never open a position whose fill lands in the next
   * session. Ignored on daily bars, where it would mean "always flat".
   */
  flatAtSessionEnd?: boolean;
  /**
   * How often the rule is allowed to act: daily (default), weekly or monthly.
   * The daily series is resampled before the simulation, so the same strategy
   * and the same costs are compared at each frequency.
   */
  barInterval?: BarInterval;
  /**
   * Quality floor: the run should close at least this many trades. A single
   * backtest is flagged when it falls short, and the optimizer / walk-forward
   * refuse to rank a candidate below the floor (0/undefined = no minimum).
   */
  minTrades?: number;
  benchmarkSymbol?: string; // default: same ticker (its buy & hold)
  megaWeights?: WeightMap; // per-indicator weights for the Mega Score strategy/chart overlay
  /** Per-indicator formula/field edits from the Mega Indicator page (same ones
   *  the live composite uses), applied to the strategy and the chart overlay. */
  megaOverrides?: IndicatorOverrideMap;
}

export interface TradeRecord {
  id: number;
  entryDate: string;
  exitDate: string | null;   // null = still open at end of backtest
  side: "long";
  shares: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number;
  returnPct: number;
  bars: number;
  reason: string;
  /** The reading that triggered the entry (the signal bar — one session before
   *  the fill), i.e. the Mega Score after the strategy's smoothing when it
   *  smooths. Null when the run skipped the score series (bulk compare/optimize)
   *  or the bar had no reading yet. */
  entryScore?: number | null;
  /** The bar whose close produced the entry signal (one session before the fill).
   *  Used to pull that day's per-indicator breakdown. */
  entrySignalDate?: string | null;
  /** Mega Score on the entry fill day's close (the fill itself is at its open). */
  entryFillScore?: number | null;
  /** Mega Score that triggered the exit. For a signal exit that is the previous
   *  close (smoothed like the entry); a stop/target exit fires intra-bar, so it
   *  is the exit day's score. Null for an end-of-test close. */
  exitScore?: number | null;
  /** The bar whose reading triggered the exit (null for an end-of-test close). */
  exitSignalDate?: string | null;
  /** Mega Score on the exit fill day's close. */
  exitFillScore?: number | null;
  /** True when this long re-opened right after a stop/target exit while the
   *  regime was still long — no fresh score crossing caused it, so its signal
   *  reading can legitimately sit below the buy band. */
  reentry?: boolean;
}

export type ExitReason =
  | "signal"
  | "stop-loss"
  | "take-profit"
  | "trailing-stop"
  /** Closed at the last bar of the session because `flatAtSessionEnd` is set (day-trading mode). */
  | "session-close"
  | "end-of-test";

export interface RiskStats {
  expectancyPct: number;       // avg return per trade (what a "typical" trade yields)
  payoffRatio: number;         // avg win $ / avg loss $ (>1 = winners bigger than losers)
  maxConsecutiveLosses: number;
  maxConsecutiveWins: number;
  recoveryFactor: number;      // total return / max drawdown
}

export interface WalkForwardFold {
  trainFrom: string; trainTo: string;
  testFrom: string; testTo: string;
  bestParams: Record<string, number>;
  trainSharpe: number;
  testSharpe: number;
  testReturnPct: number;
  testMaxDrawdownPct: number;
  testTrades: number;
  /** False when the out-of-sample window closed fewer trades than the min-trades floor. */
  meetsMinTrades: boolean;
  isFail: boolean; // test Sharpe < 50% of train Sharpe (overfit warning per fold)
}

export interface WalkForwardResult {
  symbol: string;
  strategyId: string;
  strategyName: string;
  dateFrom: string;
  dateTo: string;
  bars: number;
  dataSource: "cache" | "yahoo";
  trainBars: number;
  testBars: number;
  /** The min-trades floor used to pick parameters inside each fold (null = none). */
  minTrades: number | null;
  folds: WalkForwardFold[];
  oosSharpe: number;         // Sharpe of the stitched out-of-sample equity curve
  oosReturnPct: number;
  oosMaxDrawdownPct: number;
  stitchedEquity: Array<{ date: string; equity: number; benchmark: number }>;
  benchmarkReturnPct: number;
  warnings: string[];
}

export interface EquityPoint {
  date: string;
  equity: number;
  benchmark: number;         // benchmark indexed to 100 at start
  drawdownPct: number;
  price: number;
  invested: boolean;
}

/**
 * The run's risk profile, all measured from the same daily equity curve the
 * Sharpe ratio uses — no modelled inputs except the risk factor itself.
 */
export interface RiskMetrics {
  /** Annualized stdev of the strategy's daily returns, %. */
  annualVolPct: number;
  /** Annualized stdev of the benchmark's daily returns over the same days, %. */
  benchmarkVolPct: number;
  /** Strategy beta to the benchmark (daily returns). 1 = moves with it. */
  beta: number;
  /** Annualized downside deviation (negative days only), %. */
  downsideDevPct: number;
  /** Ulcer index: RMS of daily drawdown depth in percentage points (lower = calmer). */
  ulcerIndex: number;
  /**
   * 0-100 risk factor (lower = calmer), modelled from three measured pieces:
   *   40 % volatility relative to the benchmark (1× benchmark = 20 points,
   *         2× or more = 40 points)
   *   35 % Ulcer index (15 points of ulcer depth = 35)
   *   25 % max drawdown (50 % drawdown = 25)
   * It exists so two runs can be compared on one number; the three components
   * are always shown beside it, and no component is hidden in the blend.
   */
  riskFactor: number;
  /** Bucket for the risk factor: <25 Low, <45 Moderate, <65 Elevated, else High. */
  riskLevel: "Low" | "Moderate" | "Elevated" | "High";
}

export interface BacktestSummary extends RiskStats {
  finalEquity: number;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownPct: number;
  benchmarkMaxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  avgTradeReturnPct: number;
  bestTradePct: number;
  worstTradePct: number;
  avgBarsHeld: number;
  timeInMarketPct: number;
  /** Closed trades per year — the frequency the win rate and avg trade belong to. */
  tradesPerYear: number;
  /** Median minutes between bars: 1440 daily, 10080 weekly, ~43200 monthly, 5 intraday. */
  barMinutes: number;
  /** What one bar represents — drives every "per day" label in the UI. */
  barUnit: BarUnit;
  /**
   * Bars per year used to annualize Sharpe/Sortino/volatility: 252 daily, 52
   * weekly, 12 monthly, 252 × (390 / barMinutes) intraday. Derived from the bar
   * spacing, because annualizing a weekly Sharpe with sqrt(252) overstates it by
   * 2.2× and a monthly one by 4.6×.
   */
  periodsPerYear: number;
  /** Volatility, beta, downside, ulcer and the 0-100 risk factor. */
  risk: RiskMetrics;
}

export interface BacktestOutput {
  symbol: string;
  strategyId: string;
  strategyName: string;
  strategyDescription: string;
  meta: { name: string; currency: string; exchange: string };
  dateFrom: string;
  dateTo: string;
  bars: number;
  dataSource: "cache" | "yahoo";
  config: BacktestConfig;
  summary: BacktestSummary;
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  monthlyReturns: Array<{ month: string; ret: number }>;
  priceSeries: Array<{ date: string; close: number; ma1: number | null; ma2: number | null; mega: number | null }>;
  megaScoreDescription: string;
  /** The min-trades floor this run was measured against (null = none set). */
  minTrades: number | null;
  /** True when the floor is unset or the run closed at least that many trades. */
  meetsMinTrades: boolean;
  warnings: string[];
}

export interface ResolvedCosts {
  initialCapital: number;
  commissionBps: number;
  slippageBps: number;
  positionPct: number;
  years: number;
}

/** Normalized min-trades floor: a positive integer, or null when unset. */
export function minTradesFloor(minTrades?: number): number | null {
  return minTrades && minTrades > 0 && Number.isFinite(minTrades) ? Math.floor(minTrades) : null;
}

export interface TradeFloorResult<T> {
  /** Candidates allowed to be ranked as "best". Falls back to all of them when none clears the floor. */
  pool: T[];
  /** How many candidates were dropped for closing fewer trades than the floor. */
  belowFloor: number;
  /** True when nothing cleared the floor, so the pool ignores it (reported, never hidden). */
  usedFallback: boolean;
  /** Human-readable consequence, or null when every candidate cleared the floor. */
  warning: string | null;
}

/**
 * Apply the min-trades quality floor to a set of candidate runs (optimizer
 * combinations, walk-forward parameter sets). A Sharpe computed from two trades
 * is noise, so anything below the floor cannot be ranked as the best — unless
 * *nothing* clears it, in which case the full set is returned with a warning
 * rather than pretending the sweep found nothing.
 */
export function applyTradeFloor<T>(
  items: T[],
  minTrades: number | null | undefined,
  tradesOf: (item: T) => number
): TradeFloorResult<T> {
  const floor = minTradesFloor(minTrades ?? undefined);
  if (floor === null || items.length === 0) {
    return { pool: items, belowFloor: 0, usedFallback: false, warning: null };
  }
  const eligible = items.filter((item) => tradesOf(item) >= floor);
  const belowFloor = items.length - eligible.length;
  const trades = `${floor} trade${floor === 1 ? "" : "s"}`;
  if (eligible.length === 0) {
    return {
      pool: items,
      belowFloor,
      usedFallback: true,
      warning: `No candidate closed at least ${trades} — the picks below ignore your minimum-trades floor.`,
    };
  }
  return {
    pool: eligible,
    belowFloor,
    usedFallback: false,
    warning:
      belowFloor > 0
        ? `${belowFloor} of ${items.length} candidates closed fewer than ${trades} and were excluded from the best picks.`
        : null,
  };
}

export function resolveCosts(config: BacktestConfig): ResolvedCosts {
  return {
    initialCapital: clamp(config.initialCapital || 100000, 1000, 1e9),
    commissionBps: clamp(config.commissionBps ?? 0, 0, 100),
    slippageBps: clamp(config.slippageBps ?? 0, 0, 200),
    positionPct: clamp(config.positionPct ?? 100, 1, 100),
    years: clamp(config.years ?? 10, 1 / 12, 30), // min 1 month (sub-year windows allowed)
  };
}

async function loadBars(
  symbol: string,
  years: number,
  strategy: StrategyDef,
  interval: BarInterval = "daily"
) {
  const { bars, meta, source } = await getDailyBars(symbol, years);
  // The minimum-history check is on the RAW series: a strategy that needs 210
  // daily bars cannot be judged on 180 monthly bars, but resampling is not a
  // reason to refuse the run either — the caller sees the shorter series and the
  // cadence warning.
  if (bars.length < Math.min(strategy.minBars, 60)) {
    throw new Error(
      `"${meta.name}" has only ${bars.length} daily bars; ${strategy.name} needs about ${strategy.minBars}. Pick a longer history or another ticker.`
    );
  }
  return { bars: resampleBars(bars, interval), meta, source, rawBars: bars.length, interval };
}

export async function runStockBacktest(config: BacktestConfig): Promise<BacktestOutput> {
  const strategy = getStrategy(config.strategyId);
  if (!strategy) throw new Error(`Unknown strategy "${config.strategyId}".`);
  const costs = resolveCosts(config);
  const params = { ...defaultParams(strategy), ...(config.params || {}) };
  if (strategy.validate && !strategy.validate(params)) {
    throw new Error(`Invalid parameters for ${strategy.name}: ${strategy.params.map(p => `${p.label}: ${params[p.key]}`).join(', ')}.`);
  }
  const { bars, meta, source } = await loadBars(config.symbol, costs.years, strategy, config.barInterval ?? "daily");

  // Optional external benchmark (e.g. run NVDA vs SPY). Falls back to the
  // strategy ticker's own buy & hold when the benchmark can't be loaded.
  const benchSym = config.benchmarkSymbol?.trim().toUpperCase();
  let benchmarkBars: Bar[] | undefined;
  const extraWarnings: string[] = [];
  if (benchSym && benchSym !== config.symbol.trim().toUpperCase()) {
    try {
      const b = await getDailyBars(benchSym, costs.years);
      if (b.bars.length > 20) benchmarkBars = b.bars;
      else extraWarnings.push(`Benchmark "${benchSym}" has too little history — using ${meta.symbol} buy & hold instead.`);
    } catch {
      extraWarnings.push(`Benchmark "${benchSym}" could not be loaded — using ${meta.symbol} buy & hold instead.`);
    }
  }

  const out = simulateCore(bars, meta, source, strategy, costs, config, true, benchmarkBars);
  out.warnings.unshift(...extraWarnings);
  return out;
}

// Core simulation, separated from data loading so comparison/optimization can
// fetch bars once and run many strategy/param combinations over them.
// Exported for tests/smoke scripts that run it over synthetic bars.
export function simulateCore(
  bars: Bar[],
  meta: { symbol: string; name: string; currency: string; exchange: string },
  source: "cache" | "yahoo",
  strategy: StrategyDef,
  costs: ResolvedCosts,
  config: BacktestConfig,
  charts = true,
  benchmarkBars?: Bar[]
): BacktestOutput {
  const { initialCapital, commissionBps, slippageBps, positionPct } = costs;

  const open = bars.map(b => b.open);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const volume = bars.map(b => b.volume);

  // ── Bar cadence ─────────────────────────────────────────────
  // Daily, weekly, monthly and intraday bars all arrive through the same `Bar`
  // shape, so the engine works out which one it has from the spacing instead of
  // trusting a flag — and annualizes on what it found.
  const { barMinutes, periodsPerYear, barUnit } = barCadence(bars);
  const intraday = barUnit === "minute";
  /** True on the last bar of each session — where day-trading mode flattens. */
  const sessionLast: boolean[] = bars.map(
    (b, i) => i === bars.length - 1 || b.date.slice(0, 10) !== bars[i + 1].date.slice(0, 10)
  );
  const flatAtSessionEnd = Boolean(config.flatAtSessionEnd) && intraday;

  const params = { ...defaultParams(strategy), ...(config.params || {}) };
  const positions = strategy.generate({
    open, high, low, close, volume, params,
    megaWeights: config.megaWeights,
    megaOverrides: config.megaOverrides,
  });

  const commissionRate = commissionBps / 10000;
  const slippageRate = slippageBps / 10000;

  // Optional fixed-percentage risk exits (0/undefined = disabled).
  const stopMult = config.stopLossPct && config.stopLossPct > 0 ? 1 - config.stopLossPct / 100 : null;
  const tpMult = config.takeProfitPct && config.takeProfitPct > 0 ? 1 + config.takeProfitPct / 100 : null;

  // Optional ATR trailing stop, driven by the strategy's own params so only the
  // strategies that ask for it (mega_score_fast) get one. The stop trails the
  // highest CLOSE since entry by `trailAtr × ATR(atrPeriod)`. It is evaluated
  // against yesterday's ATR and yesterday's high-water mark, then the high-water
  // mark is advanced — a bar never sets the level it is tested against.
  const trailMultRaw = Number(params.trailAtr);
  const trailMult = Number.isFinite(trailMultRaw) && trailMultRaw > 0 ? trailMultRaw : null;
  const trailAtrPeriod = Math.max(2, Math.round(Number(params.atrPeriod) || 14));
  const trailAtr = trailMult !== null ? atr(high, low, close, trailAtrPeriod) : null;
  let trailHigh = 0;

  // Optional trade budget (cap on entries) and quality floor (warning only).
  const maxTrades = config.maxTrades && config.maxTrades > 0 ? Math.floor(config.maxTrades) : null;
  const minTrades = minTradesFloor(config.minTrades);
  let hitTradeLimit = false;

  // Benchmark series aligned to the strategy's dates (forward-filled for
  // calendar mismatches when the benchmark is a different ticker), indexed to
  // 100 at the start like the equity curve.
  let benchClose = close;
  if (benchmarkBars && benchmarkBars.length > 1) {
    const bMap = new Map(benchmarkBars.map(b => [b.date, b.close]));
    let seed = benchmarkBars[0].close;
    for (const b of benchmarkBars) { if (b.date <= bars[0].date) seed = b.close; else break; }
    const aligned: number[] = [];
    let last = seed;
    for (const b of bars) {
      const v = bMap.get(b.date);
      if (v !== undefined) last = v;
      aligned.push(last);
    }
    benchClose = aligned;
  }

  // ── Simulation state ────────────────────────────────────────
  let cash = initialCapital;
  let shares = 0;
  let entryBar = 0;
  /** Bar of the last stop/target exit — the next bar's buy is a re-entry. */
  let lastRiskExitBar = -1;
  /**
   * True after an ATR trailing stop fired: the strategy's own signal is still
   * "long" (the trail left before the score did), and re-buying on that stale
   * signal is how a trailing stop turns into a churn machine — buy, stop out,
   * buy again on the same reading. The block clears only once the signal has gone
   * flat, i.e. when the rule itself would re-enter. Fixed stop-loss/target exits
   * keep their existing behaviour (they are the user's own risk layer).
   */
  let trailBlocked = false;
  // Mega Score per bar, so each trade can carry the reading on its actual
  // entry/exit day. Only full single runs compute it (the price chart needs the
  // same series); bulk compare/optimize skip it, exactly like `priceSeries`.
  const megaScores: number[] | null = charts
    ? computeMegaScoreSeries({ high, low, close, volume, open }, config.megaWeights, undefined, config.megaOverrides).score
    : null;
  // The Mega Score strategy compares its bands against the smoothed series, so
  // the log records that exact number (plus the raw fill-day reading) — a
  // "sell < 25" exit should never show 25.1 with no explanation.
  const smoothDays = strategy.id === "mega_score" ? Math.max(1, Math.round(Number(params.smooth) || 1)) : 1;
  const signalScores: number[] | null = megaScores && smoothDays > 1 ? sma(megaScores, smoothDays) : megaScores;
  const round1 = (v: number | undefined): number | null =>
    v != null && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  /** Raw Mega Score on bar i (what the chart plots). */
  const scoreAt = (i: number): number | null => round1(megaScores?.[i]);
  /** Score after the strategy's smoothing — the number its bands check. */
  const signalScoreAt = (i: number): number | null => round1(signalScores?.[i]);
  let peak = initialCapital;
  let maxDD = 0;
  let benchPeak = initialCapital;
  let benchDD = 0;
  let investedBars = 0;
  const equityCurve: EquityPoint[] = [];
  const trades: TradeRecord[] = [];

  const buy = (i: number) => {
    // The budget caps entries, not exits: a position already open still runs
    // to its own signal/stop/target.
    if (maxTrades !== null && trades.length >= maxTrades) {
      hitTradeLimit = true;
      return;
    }
    if (trailMult !== null) trailHigh = open[i]; // fresh high-water mark for the new position
    const fill = open[i] * (1 + slippageRate);
    const budget = Math.min((cash + shares * close[i - 1]) * (positionPct / 100), cash);
    const sh = Math.floor(budget / (fill * (1 + commissionRate)));
    if (sh < 1) return;
    const gross = sh * fill;
    cash -= gross * (1 + commissionRate);
    shares += sh;
    if (trades.length === 0 || trades[trades.length - 1].exitDate !== null) {
      trades.push({
        id: trades.length + 1,
        entryDate: bars[i].date,
        exitDate: null,
        side: "long",
        shares: sh,
        entryPrice: fill,
        exitPrice: null,
        pnl: 0,
        returnPct: 0,
        bars: 0,
        reason: "signal",
        entryScore: signalScoreAt(i - 1),
        entrySignalDate: bars[i - 1]?.date ?? null,
        entryFillScore: scoreAt(i),
        exitScore: null,
        exitSignalDate: null,
        exitFillScore: null,
        reentry: lastRiskExitBar === i - 1,
      });
    } else {
      // Pyramiding is unreachable with binary signals (buy only fires when
      // flat), but keep the blended-average math correct in case strategies
      // gain fractional position sizing later.
      const t = trades[trades.length - 1];
      t.entryPrice = (t.entryPrice * t.shares + fill * sh) / (t.shares + sh);
      t.shares += sh;
    }
    entryBar = i;
  };

  const sell = (i: number) => sellAt(i, open[i] * (1 - slippageRate), "signal");

  // Single exit path: realizes the position at an arbitrary fill price with a
  // reason tag, so regular signals, stops, targets, and the final close all
  // share identical accounting.
  const sellAt = (i: number, fill: number, reason: ExitReason) => {
    if (shares === 0) return;
    const gross = shares * fill;
    const exitFee = gross * commissionRate;
    cash += gross - exitFee;
    const t = trades[trades.length - 1];
    if (t && t.exitDate === null) {
      t.exitDate = bars[i].date;
      t.exitPrice = fill;
      t.bars = i - entryBar;
      t.reason = reason;
      t.exitFillScore = scoreAt(i);
      // No score triggered an end-of-test close, so leave the signal reading out
      // rather than mislabel the last bar's score as a sell signal.
      t.exitScore = reason === "signal" ? signalScoreAt(i - 1) : reason === "end-of-test" ? null : scoreAt(i);
      t.exitSignalDate = reason === "end-of-test" ? null : reason === "signal" ? bars[i - 1]?.date ?? null : bars[i].date;
      if (reason === "stop-loss" || reason === "take-profit" || reason === "trailing-stop") lastRiskExitBar = i;
      if (reason === "trailing-stop") trailBlocked = true;
      const costBasis = t.shares * t.entryPrice;
      const entryFee = costBasis * commissionRate;
      t.pnl = gross - exitFee - costBasis - entryFee;
      t.returnPct = costBasis > 0 ? (t.pnl / costBasis) * 100 : 0;
    }
    shares = 0;
  };

  // ── Main loop: signal from bar i-1, execute at bar i's open ──
  for (let i = 1; i < bars.length; i++) {
    // Day-trading mode: a signal on the session's last bar would fill at the next
    // session's open, i.e. it would be an overnight position. Refuse it.
    const signalLong = positions[i - 1] > 0 && !(flatAtSessionEnd && sessionLast[i - 1]);
    if (!signalLong) trailBlocked = false; // the rule went flat — a new crossing may buy
    const wantLong = signalLong && !trailBlocked;
    const haveLong = shares > 0;
    if (wantLong && !haveLong) buy(i);
    else if (!wantLong && haveLong) sell(i);

    // ── Intra-bar risk exits (checked AFTER regular fills, same bar) ──
    // Conservative fill model: the stop assumes a gap through it (fill at
    // min(stop, open) with slippage), the target assumes no gap (fill at the
    // target price). If both levels sit inside one bar's range, the stop wins
    // (pessimistic — we don't know the intrabar path).
    if (shares > 0) {
      const entryPx = trades[trades.length - 1]?.entryPrice ?? open[i];
      const stopPx = stopMult !== null ? entryPx * stopMult : null;
      const tpPx = tpMult !== null ? entryPx * tpMult : null;
      const openFill = open[i] * (1 - slippageRate);
      if (stopPx !== null && open[i] <= stopPx) {
        sellAt(i, openFill, "stop-loss");          // gapped below the stop at the open
      } else if (tpPx !== null && open[i] >= tpPx) {
        sellAt(i, tpPx * (1 - slippageRate), "take-profit"); // gapped above the target
      } else if (stopPx !== null && low[i] <= stopPx) {
        sellAt(i, stopPx * (1 - slippageRate), "stop-loss");  // touched intrabar
      } else if (tpPx !== null && high[i] >= tpPx) {
        sellAt(i, tpPx * (1 - slippageRate), "take-profit");
      }
    }

    // ── ATR trailing stop (checked after the fixed risk exits) ──
    // Stop level comes from the previous bar's high-water mark and ATR; a gap
    // through it fills at the open, otherwise the stop price is the fill.
    if (shares > 0 && trailMult !== null && trailAtr) {
      const aPrev = trailAtr[i - 1];
      if (Number.isFinite(aPrev) && trailHigh > 0) {
        const trailPx = trailHigh - trailMult * aPrev;
        if (open[i] <= trailPx) {
          sellAt(i, open[i] * (1 - slippageRate), "trailing-stop");
        } else if (low[i] <= trailPx) {
          sellAt(i, trailPx * (1 - slippageRate), "trailing-stop");
        }
      }
      if (shares > 0) trailHigh = Math.max(trailHigh, close[i]);
    }

    // ── Day-trading mode: flat by the close ──
    // Fills at the last bar's close, so the position never carries overnight
    // gap risk — which is the whole point of asking whether day trading helps.
    if (flatAtSessionEnd && shares > 0 && sessionLast[i]) {
      sellAt(i, close[i] * (1 - slippageRate), "session-close");
    }

    const equity = cash + shares * close[i];
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;

    const benchBase = benchClose[0] || 1;
    const bench = initialCapital * (benchClose[i] / benchBase);
    if (bench > benchPeak) benchPeak = bench;
    const bdd = ((benchPeak - bench) / benchPeak) * 100;
    if (bdd > benchDD) benchDD = bdd;

    if (shares > 0) investedBars++;
    equityCurve.push({
      date: bars[i].date,
      equity,
      benchmark: (benchClose[i] / benchBase) * 100,
      drawdownPct: dd,
      price: close[i],
      invested: shares > 0,
    });
  }

  // ── Close any position still open at the final close ────────
  if (shares > 0) {
    const last = bars.length - 1;
    sellAt(last, close[last], "end-of-test");
    const finalEq = cash + shares * close[last];
    // The equity curve's last point already reflects cash + shares * close[last]
    // (computed in the loop), so just mark the position as closed.
    const lastPoint = equityCurve[equityCurve.length - 1];
    if (lastPoint) lastPoint.invested = false;
    cash = finalEq;
    shares = 0;
  }

  // ── Metrics ─────────────────────────────────────────────────
  const closed = trades.filter(t => t.exitDate !== null);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Risk-quality stats
  let maxConsecLosses = 0, maxConsecWins = 0, curLosses = 0, curWins = 0;
  for (const t of closed) {
    if (t.pnl <= 0) { curLosses++; curWins = 0; maxConsecLosses = Math.max(maxConsecLosses, curLosses); }
    else { curWins++; curLosses = 0; maxConsecWins = Math.max(maxConsecWins, curWins); }
  }

  const finalEquity = cash;
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;
  const benchmarkReturnPct = (benchClose[benchClose.length - 1] / (benchClose[0] || 1) - 1) * 100;

  const msPerDay = 86400_000;
  const days = Math.max(1, (new Date(bars[bars.length - 1].date).getTime() - new Date(bars[0].date).getTime()) / msPerDay);
  const yearsElapsed = days / 365.25;
  const cagr = finalEquity > 0 && yearsElapsed > 0
    ? (Math.pow(finalEquity / initialCapital, 1 / yearsElapsed) - 1) * 100
    : -100;

  // Per-bar returns for Sharpe/Sortino (rf = 0), annualized with
  // sqrt(periodsPerYear). The bar count per year is derived from the spacing
  // rather than assumed: on 5-minute bars there are 78 bars in a 6.5-hour
  // session, so sqrt(252) would overstate the ratio by ~8.8×.
  const daily: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    daily.push(equityCurve[i].equity / equityCurve[i - 1].equity - 1);
  }
  const meanDaily = daily.length ? daily.reduce((s, r) => s + r, 0) / daily.length : 0;
  const sdDaily = daily.length > 1
    ? Math.sqrt(daily.reduce((s, r) => s + Math.pow(r - meanDaily, 2), 0) / (daily.length - 1))
    : 0;
  const downside = daily.filter(r => r < 0);
  const downsideDev = downside.length > 1
    ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
    : 0;
  const sharpe = sdDaily > 0 ? (meanDaily / sdDaily) * Math.sqrt(periodsPerYear) : 0;
  const sortino = downsideDev > 0 ? (meanDaily / downsideDev) * Math.sqrt(periodsPerYear) : 0;

  const timeInMarketPct = equityCurve.length ? (investedBars / equityCurve.length) * 100 : 0;

  // Month-over-month strategy returns
  const monthly: Array<{ month: string; ret: number }> = [];
  if (equityCurve.length > 0) {
    let curMonth = equityCurve[0].date.slice(0, 7);
    let mStart = initialCapital; // equity before the first point
    for (let i = 0; i < equityCurve.length; i++) {
      const m = equityCurve[i].date.slice(0, 7);
      if (m !== curMonth) {
        // Close out the previous month: return from mStart to last equity of that month
        monthly.push({ month: curMonth, ret: (equityCurve[i - 1].equity / mStart - 1) * 100 });
        curMonth = m;
        // New month starts from the last equity of the previous month (the transition point)
        mStart = equityCurve[i - 1].equity;
      }
    }
    // Final partial or complete month
    const lastEq = equityCurve[equityCurve.length - 1].equity;
    monthly.push({ month: curMonth, ret: (lastEq / mStart - 1) * 100 });
  }

  // Calmar ratio: annualized return / max drawdown (higher is better)
  const calmar = maxDD > 0 ? cagr / maxDD : cagr > 0 ? 99 : 0;

  // ── Risk profile ────────────────────────────────────────────
  // Volatility, beta and downside deviation come from the same daily returns
  // the Sharpe ratio uses; the benchmark is the aligned series the equity
  // curve plots, so the comparison is like-for-like (same sessions).
  // Same day pairs as `daily`: equityCurve[k] is bar k+1, so a strategy return
  // spans bars k+1 -> k+2 and the matching benchmark return starts at bar 2.
  const benchDaily: number[] = [];
  for (let i = 2; i < benchClose.length; i++) {
    const prev = benchClose[i - 1];
    benchDaily.push(prev > 0 ? benchClose[i] / prev - 1 : 0);
  }
  const annVol = sdDaily * Math.sqrt(periodsPerYear) * 100;
  const benchPairs = Math.min(daily.length, benchDaily.length);
  const benchMeanDaily = benchPairs ? benchDaily.slice(0, benchPairs).reduce((s, r) => s + r, 0) / benchPairs : 0;
  const benchSdDaily = benchPairs > 1
    ? Math.sqrt(benchDaily.slice(0, benchPairs).reduce((s, r) => s + Math.pow(r - benchMeanDaily, 2), 0) / (benchPairs - 1))
    : 0;
  const annBenchVol = benchSdDaily * Math.sqrt(periodsPerYear) * 100;
  let covDaily = 0;
  for (let i = 0; i < benchPairs; i++) covDaily += (daily[i] - meanDaily) * (benchDaily[i] - benchMeanDaily);
  const beta = benchPairs > 1 && benchSdDaily > 0 ? (covDaily / (benchPairs - 1)) / (benchSdDaily * benchSdDaily) : 0;
  const annDownside = downsideDev * Math.sqrt(periodsPerYear) * 100;
  // Ulcer index: root-mean-square of the drawdown depths already on the curve.
  const ulcerIndex = equityCurve.length
    ? Math.sqrt(equityCurve.reduce((s, p) => s + p.drawdownPct * p.drawdownPct, 0) / equityCurve.length)
    : 0;
  // 0-100 factor — the blend is printed next to it in the UI, never hidden.
  const riskFactor = Math.round(
    100 * (
      0.40 * Math.min(1, annVol / Math.max(1, annBenchVol * 2)) +
      0.35 * Math.min(1, ulcerIndex / 15) +
      0.25 * Math.min(1, maxDD / 50)
    ) * 10
  ) / 10;
  const riskLevel: RiskMetrics["riskLevel"] =
    riskFactor < 25 ? "Low" : riskFactor < 45 ? "Moderate" : riskFactor < 65 ? "Elevated" : "High";
  const risk: RiskMetrics = {
    annualVolPct: annVol,
    benchmarkVolPct: annBenchVol,
    beta,
    downsideDevPct: annDownside,
    ulcerIndex,
    riskFactor,
    riskLevel,
  };
  const tradesPerYear = closed.length / Math.max(yearsElapsed, 1 / 12);

  const summary: BacktestSummary = {
    finalEquity,
    totalReturnPct,
    benchmarkReturnPct,
    cagr,
    sharpe,
    sortino,
    calmar,
    maxDrawdownPct: maxDD,
    benchmarkMaxDrawdownPct: benchDD,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    totalTrades: closed.length,
    avgTradeReturnPct: closed.length ? closed.reduce((s, t) => s + t.returnPct, 0) / closed.length : 0,
    bestTradePct: closed.length ? Math.max(...closed.map(t => t.returnPct)) : 0,
    worstTradePct: closed.length ? Math.min(...closed.map(t => t.returnPct)) : 0,
    avgBarsHeld: closed.length ? closed.reduce((s, t) => s + t.bars, 0) / closed.length : 0,
    timeInMarketPct,
    tradesPerYear,
    barMinutes,
    barUnit,
    periodsPerYear,
    risk,
    expectancyPct: closed.length ? closed.reduce((s, t) => s + t.returnPct, 0) / closed.length : 0,
    payoffRatio: (() => {
      const avgWin = wins.length ? grossProfit / wins.length : 0;
      const avgLoss = losses.length ? grossLoss / losses.length : 0;
      if (avgLoss <= 0) return avgWin > 0 ? 99 : 0;
      return avgWin / avgLoss;
    })(),
    maxConsecutiveLosses: maxConsecLosses,
    maxConsecutiveWins: maxConsecWins,
    recoveryFactor: maxDD > 0 ? totalReturnPct / maxDD : totalReturnPct > 0 ? 99 : 0,
  };

  // Context overlay for the price chart (skipped in bulk comparison/optimization runs).
  // Includes the look-ahead-safe Mega Score so the UI can plot it under price.
  let priceSeries: BacktestOutput["priceSeries"] = [];
  let megaScoreDescription = "";
  if (charts) {
    const maF = sma(close, 50);
    const maS = sma(close, 200);
    // Same series the trades were annotated from, so chart and log agree.
    priceSeries = bars.map((b, i) => ({
      date: b.date,
      close: b.close,
      ma1: i >= 49 ? maF[i] : null,
      ma2: i >= 199 ? maS[i] : null,
      mega: scoreAt(i),
    }));
    megaScoreDescription = describeMegaWeights(config.megaWeights);
  }

  const meetsMinTrades = minTrades === null || closed.length >= minTrades;

  const warnings: string[] = [];
  if (closed.length > 0 && closed.length < 5) {
    warnings.push("Fewer than 5 closed trades — results are not statistically meaningful.");
  }
  if (maxTrades !== null && minTrades !== null && minTrades > maxTrades) {
    warnings.push(
      `Max trades (${maxTrades}) is below the minimum of ${minTrades} — the minimum can never be met.`
    );
  }
  if (minTrades !== null && closed.length < minTrades) {
    warnings.push(
      `Only ${closed.length} closed trade${closed.length === 1 ? "" : "s"} — below the minimum of ${minTrades} you set. ` +
      "Treat the statistics as indicative, not proven."
    );
  }
  if (minTrades !== null && closed.length === 0) {
    warnings.push(
      "No trades were closed at all — the thresholds are too strict (or too wide a band) for this history."
    );
  }
  if (hitTradeLimit && maxTrades !== null) {
    warnings.push(
      `Entry limit reached: no new trades were opened after ${maxTrades} trade${maxTrades === 1 ? "" : "s"}.`
    );
  }
  if (barUnit !== "day" && barUnit !== "minute" && bars.length < strategy.minBars) {
    warnings.push(
      `${strategy.name} usually needs about ${strategy.minBars} daily bars; on ${barUnit}ly bars this run has ${bars.length}. ` +
        "The signal is valid but its history is short — lengthen the window for a meaningful read."
    );
  }
  if (config.flatAtSessionEnd && !intraday) {
    warnings.push(
      "Flat-at-session-end was ignored: this series is daily, so closing at every session's last bar would mean never holding a position."
    );
  }

  return {
    symbol: config.symbol.trim().toUpperCase(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    strategyDescription: strategy.description,
    meta,
    dateFrom: bars[0].date,
    dateTo: bars[bars.length - 1].date,
    bars: bars.length,
    dataSource: source,
    // `params` here is the merged set the run actually used, so a caller that
    // sent {} still sees the strategy's real bands (e.g. Mega Score 70 / 25)
    // instead of an empty object.
    config: { ...config, params, initialCapital, commissionBps, slippageBps, positionPct, years: costs.years },
    summary,
    equityCurve,
    trades: trades.map((t, idx) => ({ ...t, id: idx + 1 })),
    monthlyReturns: monthly,
    priceSeries,
    megaScoreDescription,
    minTrades,
    meetsMinTrades,
    warnings,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}



// Human-readable description of the weights behind the plotted mega score
// (defaults, a named preset, or a custom weight map).
//
// The app's default is the BALANCED baseline (RSI/Bollinger lead), not an
// equal-weight average — so a run that sends no weights must say "balanced",
// and "Everything" is the preset that actually equal-weights the built-ins.
function describeMegaWeights(weights?: WeightMap): string {
  const baseline = defaultWeights(ALL_SPECS);
  const isDefault = (w: WeightMap) =>
    ALL_SPECS.every((spec) => (w[spec.id] ?? baseline[spec.id] ?? 0) === (baseline[spec.id] ?? 0));
  const isEverything = (w: WeightMap) =>
    ALL_SPECS.every((spec) => (w[spec.id] ?? 0) === (spec.optional ? 0 : 1));

  if (!weights || Object.keys(weights).length === 0 || isDefault(weights)) {
    return "⚖️ Balanced baseline weights (RSI and Bollinger position 20 weight each ≈21% of the composite, MACD 10, the rest sized by signal — calibrated Oct 2026) — composite 0-100, trailing windows only, no look-ahead.";
  }
  if (isEverything(weights)) {
    return "⚖️ Everything preset — all built-in indicators equally weighted, catalogue indicators excluded (0-100), trailing windows only, no look-ahead.";
  }
  const presets: Array<{ match: (w: WeightMap) => boolean; label: string }> = [
    { match: (w) => w["ta-trend-50-200"] === 4 && w["ta-kernel-slope"] === 4, label: "🧭 Trend preset" },
    { match: (w) => w["ta-rsi-14"] === 4 && w["ta-macd-hist"] === 4 && w["ta-mom-63"] === 4, label: "🚀 Momentum preset" },
    { match: (w) => w["ta-bb-pos"] === 4 && w["ta-rsi-14"] === 4 && w["ta-dist-52w-high"] === 4, label: "🔄 Mean Reversion preset" },
    { match: (w) => w["ta-er-10"] === 4 && w["ta-kernel-residual"] === 4, label: "🌊 Smooth Trends preset" },
  ];
  const preset = presets.find((p) => p.match(weights));
  if (preset) return `${preset.label}: composite of all technical indicators (0-100), trailing windows only — no look-ahead.`;
  return "Custom weighted composite of all technical indicators (0-100), trailing windows only — no look-ahead.";
}

// ─── Strategy Comparison ────────────────────────────────────────
// Runs every strategy over the same ticker/history and ranks by Sharpe.
// Charts and per-trade detail are suppressed; only summary metrics are kept.

export interface ComparisonRow {
  strategyId: string;
  strategyName: string;
  totalReturnPct: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  /** Closed trades per year, so frequency is comparable across strategies. */
  tradesPerYear: number;
  /** Average return per closed trade, net of costs. */
  avgTradeReturnPct: number;
  /** 0-100 modelled risk factor (lower = calmer). */
  riskFactor: number;
  riskLevel: RiskMetrics["riskLevel"];
  timeInMarketPct: number;
  beatsBuyHold: boolean;
  error: string | null;
}

export interface ComparisonResult {
  symbol: string;
  meta: { name: string; currency: string; exchange: string };
  dateFrom: string;
  dateTo: string;
  bars: number;
  /** Bars per year and the bar length, so the table can label its own cadence. */
  periodsPerYear: number;
  barMinutes: number;
  barUnit: BarUnit;
  dataSource: "cache" | "yahoo";
  benchmarkReturnPct: number;
  benchmarkMaxDrawdownPct: number;
  benchmarkSharpe: number;
  rows: ComparisonRow[];
}

export async function runStrategyComparison(config: BacktestConfig): Promise<ComparisonResult> {
  const costs = resolveCosts(config);
  const buyHold = getStrategy("buy_hold");
  if (!buyHold) throw new Error("buy_hold strategy missing");
  const { bars, meta, source } = await loadBars(config.symbol, costs.years, buyHold, config.barInterval ?? "daily");

  const rows: ComparisonRow[] = [];
  for (const strategy of STRATEGIES) {
    if (strategy.id === "buy_hold") continue; // reported as the benchmark instead
    try {
      const out = simulateCore(bars, meta, source, strategy, costs, config, false);
      rows.push({
        strategyId: out.strategyId,
        strategyName: out.strategyName,
        totalReturnPct: out.summary.totalReturnPct,
        cagr: out.summary.cagr,
        sharpe: out.summary.sharpe,
        sortino: out.summary.sortino,
        calmar: out.summary.calmar,
        maxDrawdownPct: out.summary.maxDrawdownPct,
        winRate: out.summary.winRate,
        profitFactor: out.summary.profitFactor,
        totalTrades: out.summary.totalTrades,
        tradesPerYear: out.summary.tradesPerYear,
        avgTradeReturnPct: out.summary.avgTradeReturnPct,
        riskFactor: out.summary.risk.riskFactor,
        riskLevel: out.summary.risk.riskLevel,
        timeInMarketPct: out.summary.timeInMarketPct,
        beatsBuyHold: out.summary.totalReturnPct > out.summary.benchmarkReturnPct,
        error: null,
      });
    } catch (e) {
      rows.push({
        strategyId: strategy.id,
        strategyName: strategy.name,
        totalReturnPct: 0, cagr: 0, sharpe: 0, sortino: 0, calmar: 0, maxDrawdownPct: 0,
        winRate: 0, profitFactor: 0, totalTrades: 0, timeInMarketPct: 0,
        tradesPerYear: 0, avgTradeReturnPct: 0, riskFactor: 0, riskLevel: "Low",
        beatsBuyHold: false,
        error: e instanceof Error ? e.message : "failed",
      });
    }
  }

  // Buy & hold benchmark metrics, computed the same way as the strategies
  const bench = simulateCore(bars, meta, source, buyHold, costs, config, false);

  rows.sort((a, b) => b.sharpe - a.sharpe);

  return {
    symbol: config.symbol.trim().toUpperCase(),
    meta,
    dateFrom: bars[0].date,
    dateTo: bars[bars.length - 1].date,
    bars: bars.length,
    periodsPerYear: bench.summary.periodsPerYear,
    barMinutes: bench.summary.barMinutes,
    barUnit: bench.summary.barUnit,
    dataSource: source,
    benchmarkReturnPct: bench.summary.totalReturnPct,
    benchmarkMaxDrawdownPct: bench.summary.maxDrawdownPct,
    benchmarkSharpe: bench.summary.sharpe,
    rows,
  };
}

// ─── Parameter Optimization (grid sweep) ────────────────────────

export interface OptimizePoint {
  params: Record<string, number>;
  totalReturnPct: number;
  cagr: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownPct: number;
  winRate: number;
  totalTrades: number;
  /** False when this combination closed fewer trades than the min-trades floor. */
  meetsMinTrades: boolean;
}

export interface OptimizeResult {
  symbol: string;
  strategyId: string;
  strategyName: string;
  dateFrom: string;
  dateTo: string;
  bars: number;
  dataSource: "cache" | "yahoo";
  benchmarkReturnPct: number;
  xAxis: string;
  yAxis: string;
  points: OptimizePoint[];
  /** The min-trades floor applied to the picks (null = none). */
  minTrades: number | null;
  /** Combinations dropped from the best picks for closing fewer trades than the floor. */
  belowFloor: number;
  best: OptimizePoint | null;
  byReturn: OptimizePoint | null;
  byDrawdown: OptimizePoint | null;
  skippedCombos: number;
  warnings: string[];
}

const MAX_COMBOS = 300;

// Linspace over [min, max] producing `steps` points, clamped to integer steps
// when the param is declared with integer steps (the default).
function sweepValues(param: { min?: number; max?: number; default: number; step?: number }, steps: number): number[] {
  const lo = Math.round(param.min ?? Math.max(2, Math.round(param.default / 4)));
  const hi = Math.round(param.max ?? param.default * 2);
  const n = Math.max(2, Math.min(10, steps));
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(lo + ((hi - lo) * i) / (n - 1));
  const isInt = (param.step ?? 1) >= 1;
  const vals = raw.map(v => (isInt ? Math.round(v) : Math.round(v * 2) / 2));
  return Array.from(new Set(vals)).sort((a, b) => a - b);
}

export async function runStrategyOptimization(config: BacktestConfig): Promise<OptimizeResult> {
  const strategy = getStrategy(config.strategyId);
  if (!strategy) throw new Error(`Unknown strategy "${config.strategyId}".`);
  if (strategy.params.length === 0) {
    throw new Error(`${strategy.name} has no parameters to optimize.`);
  }

  const costs = resolveCosts(config);
  const { bars, meta, source } = await loadBars(config.symbol, costs.years, strategy, config.barInterval ?? "daily");

  // Pick the two axes: the two params with the widest [min, max] span.
  // A third (if present) is swept along with the second so it isn't ignored.
  const ranked = [...strategy.params].sort((a, b) =>
    ((b.max ?? b.default * 2) - (b.min ?? b.default / 4)) -
    ((a.max ?? a.default * 2) - (a.min ?? a.default / 4))
  );
  const xAxisParam = ranked[0];
  const yAxisParam = ranked[1] || ranked[0];
  const zParam = strategy.params.length > 2 ? ranked[2] : null;

  const xVals = sweepValues(xAxisParam, 10);
  const yVals = sweepValues(yAxisParam, 6);
  const zVals = zParam ? sweepValues(zParam, 3) : [0];

  const warnings: string[] = [];
  const totalCombos = xVals.length * yVals.length * zVals.length;
  let combos: Array<{ p: Record<string, number> }> = [];
  for (const x of xVals)
    for (const y of yVals)
      for (const z of zVals) {
        const p: Record<string, number> = {};
        p[xAxisParam.key] = x;
        p[yAxisParam.key] = y;
        if (zParam) p[zParam.key] = z;
        combos.push({ p });
      }

  // Fill any params not on an axis with their defaults
  for (const c of combos) {
    for (const param of strategy.params) {
      if (c.p[param.key] === undefined) c.p[param.key] = param.default;
    }
  }

  let skippedCombos = 0;
  if (totalCombos > MAX_COMBOS) {
    // Keep the grid rectangular: trim the y-axis values (least granular) first.
    const keepY = Math.max(2, Math.floor(MAX_COMBOS / (xVals.length * zVals.length)));
    const yKeep = yVals.slice(0, keepY);
    const kept = new Set(yKeep);
    combos = combos.filter(c => kept.has(c.p[yAxisParam.key]));
    skippedCombos = totalCombos - combos.length;
    warnings.push(
      `Grid capped at ${MAX_COMBOS} combinations — y-axis granularity reduced (${skippedCombos} combos skipped).`
    );
  }

  const points: OptimizePoint[] = [];
  for (const combo of combos) {
    try {
      if (strategy.validate && !strategy.validate(combo.p)) {
        skippedCombos++;
        continue;
      }
      const out = simulateCore(bars, meta, source, strategy, costs, { ...config, params: combo.p }, false);
      points.push({
        params: combo.p,
        totalReturnPct: out.summary.totalReturnPct,
        cagr: out.summary.cagr,
        sharpe: out.summary.sharpe,
        sortino: out.summary.sortino,
        calmar: out.summary.calmar,
        maxDrawdownPct: out.summary.maxDrawdownPct,
        winRate: out.summary.winRate,
        totalTrades: out.summary.totalTrades,
        meetsMinTrades: out.meetsMinTrades,
      });
    } catch {
      // e.g. fast >= slow — skip invalid combinations
      skippedCombos++;
    }
  }

  if (points.length === 0) {
    throw new Error("All parameter combinations failed — check the parameter ranges.");
  }

  // Min-trades floor: a combination that only traded twice cannot win on
  // Sharpe. The pool keeps the floor unless nothing clears it (then the sweep
  // says so instead of silently returning nothing).
  const minTrades = minTradesFloor(config.minTrades);
  const floor = applyTradeFloor(points, minTrades, (p) => p.totalTrades);
  if (floor.warning) warnings.push(floor.warning);

  const bySharpe = [...floor.pool].sort((a, b) => b.sharpe - a.sharpe);
  const byReturn = [...floor.pool].sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const byDrawdown = [...floor.pool].sort((a, b) => a.maxDrawdownPct - b.maxDrawdownPct);

  warnings.push(
    "Optimization finds the best parameters for this exact window — treat the result as descriptive, not predictive (overfitting risk)."
  );

  return {
    symbol: config.symbol.trim().toUpperCase(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    dateFrom: bars[0].date,
    dateTo: bars[bars.length - 1].date,
    bars: bars.length,
    dataSource: source,
    benchmarkReturnPct: (bars[bars.length - 1].close / bars[0].close - 1) * 100,
    xAxis: xAxisParam.key,
    yAxis: yAxisParam.key,
    points,
    minTrades,
    belowFloor: floor.belowFloor,
    best: bySharpe[0],
    byReturn: byReturn[0],
    byDrawdown: byDrawdown[0],
    skippedCombos,
    warnings,
  };
}

// ─── Walk-Forward Optimization ──────────────────────────────────
// The honest way to optimize: repeatedly pick parameters on a training window,
// then evaluate them on the unseen data right after it. The stitched
// out-of-sample curve shows what the strategy would ACTUALLY have delivered
// using this re-optimization process live — overfitted parameter sets fall
// apart here, which is the point.

const WF_MIN_TRAIN_BARS = 400;

export async function runWalkForwardOptimization(
  config: BacktestConfig,
  opts?: { trainYears?: number; testYears?: number; bars?: Bar[] }
): Promise<WalkForwardResult> {
  const strategy = getStrategy(config.strategyId);
  if (!strategy) throw new Error(`Unknown strategy "${config.strategyId}".`);
  if (strategy.params.length === 0) {
    throw new Error(`${strategy.name} has no parameters to walk-forward.`);
  }
  const costs = resolveCosts(config);
  const trainYears = Math.max(1 / 12, Math.min(15, opts?.trainYears ?? 3));
  const testYears = Math.max(1 / 12, Math.min(5, opts?.testYears ?? 1));

  // Pull enough history for all folds, not just the requested window
  // (callers may inject bars directly — tests/synthetic runs).
  const totalNeeded = trainYears + testYears + 1;
  const { bars, meta, source } = opts?.bars
    ? { bars: opts.bars, meta: { symbol: config.symbol.trim().toUpperCase(), name: config.symbol.trim().toUpperCase(), currency: "USD", exchange: "injected" }, source: "cache" as const }
    : await loadBars(config.symbol, Math.max(costs.years, totalNeeded), strategy, config.barInterval ?? "daily");

  const warnings: string[] = [];
  const msPerYear = 365.25 * 86400_000;
  const startT = new Date(bars[0].date).getTime();
  const endT = new Date(bars[bars.length - 1].date).getTime();

  const minTrades = minTradesFloor(config.minTrades);
  /** Folds where no parameter set cleared the min-trades floor on the training window. */
  let floorFallbackFolds = 0;

  const folds: WalkForwardFold[] = [];
  const stitched: WalkForwardResult["stitchedEquity"] = [];
  let stitchedPrevEq = 0;
  const dailyTestReturns: number[] = [];

  // Param sweep per fold — a modest grid around the defaults (fast, and the
  // full 300-combo grid would be needlessly slow repeated per fold).
  const axis = strategy.params[0];
  const axis2 = strategy.params[1];
  const grid: Record<string, number>[] = [];
  const xs = sweepValues(axis, 6);
  const ys = axis2 ? sweepValues(axis2, 4) : [0];
  for (const x of xs)
    for (const y of ys) {
      const p = { ...defaultParams(strategy) };
      p[axis.key] = x;
      if (axis2) p[axis2.key] = y;
      if (strategy.validate && !strategy.validate(p)) continue;
      grid.push(p);
    }
  if (grid.length === 0) throw new Error("No valid parameter combinations for walk-forward.");

  let cursorT = startT;
  while (true) {
    const trainFromT = cursorT;
    const trainToT = trainFromT + trainYears * msPerYear;
    const testToT = trainToT + testYears * msPerYear;
    if (trainToT >= endT) break;

    const train = bars.filter(b => {
      const t = new Date(b.date).getTime();
      return t >= trainFromT && t < trainToT;
    });
    const test = bars.filter(b => {
      const t = new Date(b.date).getTime();
      return t >= trainToT && t < testToT;
    });
    if (train.length < WF_MIN_TRAIN_BARS || test.length < 40) {
      // Not enough data for another meaningful fold.
      if (train.length >= WF_MIN_TRAIN_BARS && test.length > 0) {
        warnings.push("Final test window was too short and was skipped.");
      }
      break;
    }

    // Pick the best params on the training window only, applying the
    // min-trades floor so a two-trade fluke cannot win a fold.
    const candidates: Array<{ params: Record<string, number>; sharpe: number; totalTrades: number }> = [];
    for (const p of grid) {
      try {
        const out = simulateCore(train, meta, source, strategy, costs, { ...config, params: p }, false);
        candidates.push({ params: p, sharpe: out.summary.sharpe, totalTrades: out.summary.totalTrades });
      } catch { /* invalid combo — skip */ }
    }
    const foldFloor = applyTradeFloor(candidates, minTrades, (c) => c.totalTrades);
    if (foldFloor.usedFallback) floorFallbackFolds++;
    const best = [...foldFloor.pool].sort((a, b) => b.sharpe - a.sharpe)[0] ?? null;
    if (!best) {
      warnings.push(`Fold starting ${new Date(trainFromT).toISOString().slice(0, 10)}: every parameter combination failed.`);
      cursorT = trainToT;
      continue;
    }

    // Run the winning params over train (for reporting) and test (the truth).
    const trainRun = simulateCore(train, meta, source, strategy, costs, { ...config, params: best.params }, false);
    const testRun = simulateCore(test, meta, source, strategy, costs, { ...config, params: best.params }, false);

    // Stitch the OOS equity curves together (compounded across folds).
    const scale = stitchedPrevEq > 0 ? stitchedPrevEq / 100 : 1; // curves are indexed to 100
    for (const pt of testRun.equityCurve) {
      stitched.push({ date: pt.date, equity: pt.equity * scale, benchmark: 0 });
    }
    stitchedPrevEq = stitched.length ? stitched[stitched.length - 1].equity : stitchedPrevEq;

    // Daily returns within this fold's test window, for the OOS Sharpe.
    const ec = testRun.equityCurve;
    for (let i = 1; i < ec.length; i++) {
      const r = ec[i].equity / ec[i - 1].equity - 1;
      if (Number.isFinite(r)) dailyTestReturns.push(r);
    }

    folds.push({
      trainFrom: train[0].date,
      trainTo: train[train.length - 1].date,
      testFrom: test[0].date,
      testTo: test[test.length - 1].date,
      bestParams: best.params,
      trainSharpe: trainRun.summary.sharpe,
      testSharpe: testRun.summary.sharpe,
      testReturnPct: testRun.summary.totalReturnPct,
      testMaxDrawdownPct: testRun.summary.maxDrawdownPct,
      testTrades: testRun.summary.totalTrades,
      meetsMinTrades: minTrades === null || testRun.summary.totalTrades >= minTrades,
      isFail: trainRun.summary.sharpe > 0 && testRun.summary.sharpe < 0.5 * trainRun.summary.sharpe,
    });

    cursorT = trainToT; // rolling window: train advances by test length
  }

  if (folds.length === 0) {
    throw new Error(
      `Not enough history for walk-forward: need ≥ ${Math.round(trainYears)}y train + ${Math.round(testYears)}y test (got ${(bars.length / 252).toFixed(1)}y).`
    );
  }

  // Benchmark over the stitched OOS window (same ticker buy & hold).
  const oosFrom = stitched[0]?.date;
  const oosTo = stitched[stitched.length - 1]?.date;
  const oosBars = bars.filter(b => b.date >= oosFrom && b.date <= oosTo);
  const benchBase = oosBars[0]?.close ?? 1;
  const oosCloseByDate = new Map(oosBars.map(b => [b.date, b.close]));
  for (const pt of stitched) {
    const close = oosCloseByDate.get(pt.date);
    if (close !== undefined) pt.benchmark = (close / benchBase) * 100;
  }
  const benchmarkReturnPct = oosBars.length > 1 ? (oosBars[oosBars.length - 1].close / benchBase - 1) * 100 : 0;

  // OOS Sharpe/Sortino from the stitched daily returns.
  const mean = dailyTestReturns.length ? dailyTestReturns.reduce((s, r) => s + r, 0) / dailyTestReturns.length : 0;
  const sd = dailyTestReturns.length > 1
    ? Math.sqrt(dailyTestReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (dailyTestReturns.length - 1))
    : 0;
  const oosSharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;

  let oosPeak = 100;
  let oosDD = 0;
  for (const pt of stitched) {
    if (pt.equity > oosPeak) oosPeak = pt.equity;
    oosDD = Math.max(oosDD, ((oosPeak - pt.equity) / oosPeak) * 100);
  }
  const oosReturnPct = stitched.length ? (stitched[stitched.length - 1].equity / 100 - 1) * 100 : 0;

  if (minTrades !== null && floorFallbackFolds > 0) {
    warnings.push(
      `${floorFallbackFolds}/${folds.length} fold${folds.length === 1 ? "" : "s"} had no parameter set closing ${minTrades}+ trades on the training window — those folds fell back to the best Sharpe regardless of the floor.`
    );
  }
  if (minTrades !== null) {
    const shortFolds = folds.filter(f => !f.meetsMinTrades).length;
    if (shortFolds > 0) {
      warnings.push(
        `${shortFolds}/${folds.length} out-of-sample fold${folds.length === 1 ? "" : "s"} closed fewer than ${minTrades} trades — read those returns as indicative.`
      );
    }
  }

  const oosFails = folds.filter(f => f.isFail).length;
  if (oosFails > 0) {
    warnings.push(`${oosFails}/${folds.length} folds degraded badly out-of-sample (test Sharpe < 50% of train) — sign of overfitting.`);
  }
  warnings.push(
    "Walk-forward results are still one strategy at a time — re-run across tickers before trusting an edge."
  );

  return {
    symbol: config.symbol.trim().toUpperCase(),
    strategyId: strategy.id,
    strategyName: strategy.name,
    dateFrom: bars[0].date,
    dateTo: bars[bars.length - 1].date,
    bars: bars.length,
    dataSource: source,
    trainBars: Math.round(trainYears * 252),
    testBars: Math.round(testYears * 252),
    minTrades,
    folds,
    oosSharpe,
    oosReturnPct,
    oosMaxDrawdownPct: oosDD,
    stitchedEquity: stitched,
    benchmarkReturnPct,
    warnings,
  };
}
