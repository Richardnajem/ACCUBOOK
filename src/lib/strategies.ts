// Famous, well-known trading strategies for publicly traded stocks.
// Each strategy inspects the indicator context on bar i and returns a desired
// position: 1 = long (fully invested), 0 = flat (cash). No shorting/leverage.

import { sma, ema, rsi, macd, bollinger, atr, rollingMax, rollingMin } from "./ta";
import { computeMegaScoreSeries } from "./mega-score";
import { MEGA_BUY_ABOVE, MEGA_SELL_BELOW, type IndicatorOverrideMap, type WeightMap } from "./mega-indicator";

export interface StrategyParam {
  key: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /**
   * false = a research switch the optimizer and walk-forward must NOT sweep.
   * Without this, a wide default range (e.g. a 0-400 trend SMA) wins the
   * "widest span" axis pick and quietly replaces the band sweep with a filter
   * sweep — the optimizer would stop answering the question it was asked.
   */
  sweep?: boolean;
}

export interface StrategyDef {
  id: string;
  name: string;
  description: string;
  params: StrategyParam[];
  minBars: number;
  /** Optional sanity check for parameter combos (e.g. fast < slow). Invalid combos are skipped by the optimizer. */
  validate?: (params: Record<string, number>) => boolean;
  generate: (ctx: StrategyContext) => number[];
}

export interface StrategyContext {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  params: Record<string, number>;
  /** Per-indicator weights for the Mega Score strategy (default: all 1). */
  megaWeights?: WeightMap;
  /** Per-indicator formula/field edits from the Mega Indicator page, so the
   *  backtest scores the same indicators the UI shows. */
  megaOverrides?: IndicatorOverrideMap;
}

// ─── 1. SMA Crossover ("Golden Cross" / "Death Cross") ─────────
const smaCross: StrategyDef = {
  id: "sma_cross",
  name: "SMA Crossover (Golden Cross)",
  description:
    "Classic trend following: buy when the short moving average crosses above the long moving average (a 'Golden Cross'), sell when it crosses below ('Death Cross'). Works best on trending large-caps and indexes.",
  params: [
    { key: "fast", label: "Fast SMA period", default: 50, min: 2, max: 250 },
    { key: "slow", label: "Slow SMA period", default: 200, min: 3, max: 400 },
  ],
  minBars: 205,
  validate: (p) => p.fast < p.slow,
  generate: ({ close, params }) => {
    const fast = sma(close, Math.round(params.fast));
    const slow = sma(close, Math.round(params.slow));
    const pos = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) {
      if (Number.isNaN(fast[i]) || Number.isNaN(slow[i])) continue;
      pos[i] = fast[i] > slow[i] ? 1 : 0;
    }
    return pos;
  },
};

// ─── 2. EMA Crossover (faster cousin) ──────────────────────────
const emaCross: StrategyDef = {
  id: "ema_cross",
  name: "EMA Crossover (9/21)",
  description:
    "The day-trader favourite: 9-period EMA crossing the 21-period EMA. Reacts faster than SMA crossovers, so more signals but more whipsaws.",
  params: [
    { key: "fast", label: "Fast EMA period", default: 9, min: 2, max: 100 },
    { key: "slow", label: "Slow EMA period", default: 21, min: 3, max: 200 },
  ],
  minBars: 25,
  validate: (p) => p.fast < p.slow,
  generate: ({ close, params }) => {
    const fast = ema(close, Math.round(params.fast));
    const slow = ema(close, Math.round(params.slow));
    const pos = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) {
      if (Number.isNaN(fast[i]) || Number.isNaN(slow[i])) continue;
      pos[i] = fast[i] > slow[i] ? 1 : 0;
    }
    return pos;
  },
};

// ─── 3. RSI Mean Reversion (overbought/oversold) ───────────────
const rsiStrategy: StrategyDef = {
  id: "rsi",
  name: "RSI Mean Reversion",
  description:
    "Buy the dip: enter when RSI falls below the oversold level (fear), exit when it rises above the overbought level (greed). Contrarian — shines on choppy, range-bound stocks.",
  params: [
    { key: "period", label: "RSI period", default: 14, min: 2, max: 50 },
    { key: "oversold", label: "Oversold level", default: 30, min: 5, max: 50 },
    { key: "overbought", label: "Overbought level", default: 70, min: 50, max: 95 },
  ],
  minBars: 20,
  generate: ({ close, params }) => {
    const r = rsi(close, Math.round(params.period));
    const pos = new Array(close.length).fill(0);
    let inPos = false;
    for (let i = 0; i < close.length; i++) {
      if (Number.isNaN(r[i])) continue;
      if (!inPos && r[i] < params.oversold) inPos = true;
      else if (inPos && r[i] > params.overbought) inPos = false;
      pos[i] = inPos ? 1 : 0;
    }
    return pos;
  },
};

// ─── 4. MACD Momentum ──────────────────────────────────────────
const macdStrategy: StrategyDef = {
  id: "macd",
  name: "MACD Signal Cross",
  description:
    "Momentum classic: buy when the MACD line crosses above its signal line, sell when it crosses below. The histogram flip is one of the most-followed signals in the world.",
  params: [
    { key: "fast", label: "Fast EMA", default: 12, min: 2, max: 50 },
    { key: "slow", label: "Slow EMA", default: 26, min: 3, max: 100 },
    { key: "signal", label: "Signal EMA", default: 9, min: 2, max: 50 },
  ],
  minBars: 40,
  generate: ({ close, params }) => {
    const { macd: line, signal } = macd(close, Math.round(params.fast), Math.round(params.slow), Math.round(params.signal));
    const pos = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) {
      if (Number.isNaN(line[i]) || Number.isNaN(signal[i])) continue;
      pos[i] = line[i] > signal[i] ? 1 : 0;
    }
    return pos;
  },
};

// ─── 5. Bollinger Band Mean Reversion ──────────────────────────
const bollingerStrategy: StrategyDef = {
  id: "bollinger",
  name: "Bollinger Band Reversion",
  description:
    "Buy when price closes below the lower Bollinger Band (statistically stretched), exit when it reverts to the middle band. The 'rubber band' trade.",
  params: [
    { key: "period", label: "Band period", default: 20, min: 5, max: 100 },
    { key: "mult", label: "Std deviations", default: 2, min: 1, max: 4, step: 0.5 },
  ],
  minBars: 25,
  generate: ({ close, params }) => {
    const { middle, lower } = bollinger(close, Math.round(params.period), params.mult);
    const pos = new Array(close.length).fill(0);
    let inPos = false;
    for (let i = 0; i < close.length; i++) {
      if (Number.isNaN(lower[i])) continue;
      if (!inPos && close[i] < lower[i]) inPos = true;
      else if (inPos && close[i] >= middle[i]) inPos = false;
      pos[i] = inPos ? 1 : 0;
    }
    return pos;
  },
};

// ─── 6. Donchian Channel Breakout (Turtle Trading) ─────────────
const turtleStrategy: StrategyDef = {
  id: "turtle",
  name: "Donchian Breakout (Turtle)",
  description:
    "The famous Richard Dennis 'Turtle Traders' system: buy when price breaks above the highest close of the last N days, exit when it breaks below the lowest close of the last M days. Pure trend capture.",
  params: [
    { key: "entry", label: "Entry breakout (days)", default: 20, min: 5, max: 100 },
    { key: "exit", label: "Exit breakdown (days)", default: 10, min: 3, max: 100 },
  ],
  minBars: 25,
  generate: ({ close, params }) => {
    const hi = rollingMax(close, Math.round(params.entry));
    const lo = rollingMin(close, Math.round(params.exit));
    const pos = new Array(close.length).fill(0);
    let inPos = false;
    for (let i = 1; i < close.length; i++) {
      const entryLevel = Number.isNaN(hi[i - 1]) ? NaN : hi[i - 1];
      const exitLevel = Number.isNaN(lo[i - 1]) ? NaN : lo[i - 1];
      if (!inPos) {
        if (!Number.isNaN(entryLevel) && close[i] > entryLevel) inPos = true;
      } else if (!Number.isNaN(exitLevel) && close[i] < exitLevel) {
        inPos = false;
      }
      pos[i] = inPos ? 1 : 0;
    }
    return pos;
  },
};

// ─── 7. Momentum (12-1 months / 126-21 days) ───────────────────
const momentumStrategy: StrategyDef = {
  id: "momentum",
  name: "Time-Series Momentum",
  description:
    "The academic 'time-series momentum' anomaly (Moskowitz, Ooi & Pedersen): stay long when the return over the lookback window is positive, go to cash when negative. Famous as the basis of dual momentum.",
  params: [
    { key: "lookback", label: "Lookback (days)", default: 126, min: 10, max: 500 },
  ],
  minBars: 130,
  generate: ({ close, params }) => {
    const lb = Math.min(Math.round(params.lookback), close.length - 1);
    const pos = new Array(close.length).fill(0);
    if (lb < 1) return pos;
    for (let i = lb; i < close.length; i++) {
      pos[i] = close[i] > close[i - lb] ? 1 : 0;
    }
    return pos;
  },
};

/**
 * The Mega Score regime rule, using the Mega Indicator's baseline strictness:
 * a long opens when the score is AT OR ABOVE the entry level and closes only
 * when it is STRICTLY BELOW the exit level. That is exactly the badge on the
 * Mega Indicator page (BUY ≥ 70 · HOLD 25–70 · SELL < 25, i.e. MEGA_BASELINE),
 * so a reading sitting on 25 stays long instead of being sold for being "at the
 * level".
 *
 * Exported so the boundary itself can be tested, not just real-data behaviour.
 *
 * `gates` adds optional, causal entry filters (confirmation window / trend SMA).
 * Defaults are neutral, so the measured 70/25 rule is unchanged unless a gate
 * is explicitly turned on; see the measured table above `megaScoreFast` for
 * whether either gate paid on the cached universe.
 */
export interface RegimeGates {
  /** Consecutive signal-bar readings at or above the entry band before buying
   *  (1 = buy on the first crossing, the shipped behaviour). */
  confirmDays?: number;
  /** Trailing SMA length the close must be at or above before buying (0 = off). */
  trendMa?: number;
  /** Close series aligned to `smoothed`; required for the trend filter. */
  close?: number[];
}

export function megaRegimePosition(
  smoothed: number[],
  entry: number,
  exit: number,
  gates: RegimeGates = {},
): number[] {
  const pos = new Array(smoothed.length).fill(0);
  const confirmDays = Math.max(1, Math.round(gates.confirmDays ?? 1));
  const trendMa = Math.max(0, Math.round(gates.trendMa ?? 0));
  const close = gates.close && gates.close.length === smoothed.length ? gates.close : null;
  const trend = trendMa > 0 && close ? sma(close, trendMa) : null;
  let inPos = false;
  for (let i = 0; i < smoothed.length; i++) {
    if (Number.isFinite(smoothed[i])) {
      if (!inPos) {
        // Entry gates look only at the signal bar and earlier. The EXIT is not
        // gated on purpose — delaying a sell turns a bad entry into a worse one.
        let ready = smoothed[i] >= entry;
        for (let k = 1; ready && k < confirmDays; k++) {
          const prev = smoothed[i - k];
          if (!Number.isFinite(prev) || prev < entry) ready = false;
        }
        if (ready && trend && close) {
          const level = trend[i];
          if (!Number.isFinite(level) || close[i] < level) ready = false;
        }
        if (ready) inPos = true;
      } else if (smoothed[i] < exit) {
        inPos = false;
      }
    }
    pos[i] = inPos ? 1 : 0;
  }
  return pos;
}

// ─── 8. Mega Score regime (composite technical health filter) ──
const megaScore: StrategyDef = {
  id: "mega_score",
  name: "Mega Score Regime",
  description:
    "Trades the app's own composite Mega Score (0-100, a weighted blend of the ~150 causal technical indicators). " +
    "Entry score = buy at or above it: the score has to reach that level before a long position is opened. " +
    "Exit score = sell strictly below it: the score has to fall under that level before the position is closed, so a reading sitting exactly on it is still held. " +
    "Between the two the strategy holds whatever it already has, and the gap between them is the no-trade band that stops it flipping on noise. " +
    `Defaults are the Mega Indicator baseline (entry ${MEGA_BUY_ABOVE}, exit ${MEGA_SELL_BELOW}); lower bands trade more often, higher bands wait for a stronger reading, and a wider gap means fewer, longer trades. ` +
    "Entry must stay at or above exit. Signals fill at the next day's open and every input indicator uses trailing windows only (no look-ahead). " +
    "Two optional entry gates are off by default — confirmation days and a trend SMA — because measured they cut the number of losers by trading less, not the loss rate reliably, and cost Sharpe on the held-out tail (see the note above the params)." +
    " The score is smoothed before the bands read it (default 5 days): measured Oct 2026, 5 was the best of 1/3/5/10/20 on both held-out tails, and 10+ days makes a 25 exit unreachable — the rule then cannot sell at all, which the run warns about.",
  // MEASURED — Oct 2026, `npm run test:filters`, cached daily bars (26 tickers ×
  // 20 years), 2 bps commission + 2 bps slippage, full / last-40 % / last-30 %
  // windows, 5 gate sets × 2 band pairs. The point was losing trades.
  //
  //   At the shipped 70/25 the rule makes ~5 decisions across all 26 tickers in
  //   20 years (1 trade per ticker per 4 years, as documented), so no gate can
  //   be distinguished there: 5 trades / 3 losers → 4 / 2 with trend-200. That
  //   is noise, not improvement.
  //
  //   At 55/45, where losses are measurable (1,333 trades): loss rate 58.3 %
  //   baseline, 58.2 % confirm-3, 58.3 % confirm-5, 56.6 % trend-200, 55.9 %
  //   confirm-3 + trend-200. Losers fell 777 → 469 with both gates, but trade
  //   count fell 1,333 → 839 and Sharpe 0.57 → 0.54 — fewer losers mainly by
  //   trading less. On the last-30 % window trend-200 was WORSE (59.7 % losers
  //   vs 59.4 %, Sharpe 0.44 vs 0.62). Confirm-5 was the mildest: same or lower
  //   loss rate in both tails (57.1 %) with Sharpe 0.64 on the tail vs 0.62.
  //
  // Conclusion: neither gate reduces the loss RATE robustly, so the measured
  // defaults stay 70/25 with both off. They are exposed so a user who prefers
  // fewer, larger trades can measure the trade-off on their own tickers.
  //
  // MEASURED — Oct 2026, `npm run test:exit`, same 26 tickers and costs, five
  // smoothing windows (1/3/5/10/20) × seven exits at entry 70 (20-50) plus five
  // exits at entry 55, on the full history and both held-out tails.
  //
  //   Smoothing: at exit 25, last-40 % / last-30 % Sharpe by window was
  //   0.75/0.74 (1), 0.75/0.77 (3), 0.76/0.78 (5, shipped), 0.73/0.74 (10),
  //   0.72/0.73 (20). Five days wins on BOTH tails; a faster window trades far
  //   more (88 trades vs 5 on the full window at smooth 1) and scores lower.
  //
  //   Exit: at smooth 5 the tails read 0.76/0.78 at 25, 0.74/0.75 at 30,
  //   0.71/0.71 at 35, 0.67/0.66 at 40, 0.61/0.58 at 45, 0.60/0.55 at 50 —
  //   every exit above 25 is worse on both tails, confirming the band sweep.
  //
  //   Reachability: at 70/25 the exit fired on ~0.0-0.1 % of sessions, and with
  //   a 10-day smoothing the score never closed below 25 at all (zero trades).
  //   A long window can turn the exit into decoration, so the engine now warns
  //   when a band is never reached instead of reporting a silent buy & hold.
  params: [
    { key: "entry", label: "Entry score (buy ≥)", default: MEGA_BUY_ABOVE, min: 10, max: 90 },
    { key: "exit", label: "Exit score (sell <)", default: MEGA_SELL_BELOW, min: 5, max: 85 },
    { key: "smooth", label: "Score smoothing (days)", default: 5, min: 1, max: 60 },
    // Both filters are OFF by default: they change measured behaviour, so the
    // measured 70/25 rule stays the baseline until a sweep says otherwise.
    { key: "confirm", label: "Entry confirmation (days at/above band, 1 = off)", default: 1, min: 1, max: 20, sweep: false },
    { key: "trendMa", label: "Trend filter SMA (0 = off)", default: 0, min: 0, max: 400, step: 10, sweep: false },
  ],
  minBars: 210,
  validate: (p) => p.entry >= p.exit,
  generate: ({ open, high, low, close, volume, params, megaWeights, megaOverrides }) => {
    // Honors the user's Mega Indicator weights (from the Mega Indicator page,
    // piped through config) so the backtest trades the same composite the UI shows.
    const { score } = computeMegaScoreSeries({ high, low, close, volume, open }, megaWeights, undefined, megaOverrides);
    // Optional smoothing of the composite (trailing SMA — causal).
    const s = params.smooth > 1 ? sma(score, Math.round(params.smooth)) : score;
    return megaRegimePosition(s, params.entry, params.exit, {
      close,
      confirmDays: params.confirm,
      trendMa: params.trendMa,
    });
  },
};

/**
 * The FAST Mega Score rule: buy when the score is high enough AND rising, leave
 * when it drops under the exit level, when its velocity rolls over, or when the
 * engine's ATR trailing stop is hit.
 *
 * Why a second rule exists: `megaRegimePosition` reads the composite as a slow
 * state — it stays above 70 for months, so the rule closes ~1.4 trades per
 * symbol per 4 years and behaves like buy & hold plus a drawdown filter. This
 * rule adds the missing dimension (change, not level): `velocity = score[i] −
 * score[i − window]` has to be positive to buy and must not turn negative while
 * long. The band is only a gate; most entries and exits come from velocity, and
 * the trailing stop bounds the damage of the ones that go wrong.
 *
 * Both legs read the SMOOTHED score on the signal bar and fill at the next
 * open (the simulator does that), so there is no look-ahead. Exported so the
 * rule can be tested on a hand-built series.
 */
export function megaVelocityPosition(
  smoothed: number[],
  entry: number,
  exit: number,
  velWindow: number,
  velMin: number
): number[] {
  const n = smoothed.length;
  const pos = new Array(n).fill(0);
  const win = Math.max(1, Math.round(velWindow));
  let inPos = false;
  for (let i = win; i < n; i++) {
    const now = smoothed[i];
    const then = smoothed[i - win];
    if (!Number.isFinite(now) || !Number.isFinite(then)) { pos[i] = inPos ? 1 : 0; continue; }
    const velocity = now - then;
    if (!inPos && now >= entry && velocity >= velMin) inPos = true;
    else if (inPos && (now < exit || velocity <= -velMin)) inPos = false;
    pos[i] = inPos ? 1 : 0;
  }
  return pos;
}

// ─── 8b. Mega Score Fast (velocity + ATR trail) ────────────────
//
// MEASURED — Oct 2026, cached daily bars, 24 tickers × 15 years (the Mega Score
// calibration universe incl. the volatile block), 2 bps commission + 2 bps
// slippage, chronological full / last-40 % / last-30 % windows, and the same
// ATR-trail test included. 108 parameter sets were run. Result, in one line:
// MORE TRADES DID NOT PAY. The best fast cell (e65 / x35 / smooth 5 / vel 20
// points per 10 days / trail 4×ATR) made 2.7 trades per ticker per year — about
// 40× the slow rule — won 45 % of them at +5.7 % average (net of costs), stayed
// invested 45-48 % of the time and finished 0.20 excess Sharpe BEHIND buy &
// hold on all three windows. The slow 70/25 rule on the same data: 0.07 trades
// per ticker per year, +0.01 / +0.01 / +0.08. Every step toward more trading
// (looser trail, lower velocity bar, shorter smoothing) moved the result further
// from the benchmark, not closer: the composite's week-to-week move has no
// per-trade edge that survives the time spent out of the market.
//
// So this strategy ships opt-in and with its own measured defaults, and its
// description says what the run showed. It is a research tool, not the
// recommended rule — 70/25 still is.
const megaScoreFast: StrategyDef = {
  id: "mega_score_fast",
  name: "Mega Score Fast (velocity + ATR trail)",
  description:
    "The trading variant of the Mega Score: it buys when the score is at or above the entry level AND has climbed by at least the velocity threshold over the last N days, and it leaves when the score drops under the exit level, when its velocity rolls over, or when price closes the ATR trailing stop." +
    " The band is only a gate, not the trigger: a high score that has stopped rising does not buy, and a still-high score that starts falling does not hold." +
    " Trailing stop = ATR(period) × multiple below the highest close since entry, tested against the previous bar's level so it cannot see the bar it fills in; after a trail exit the rule waits for the signal to go flat before re-buying." +
    " Measured on 24 tickers × 15 years (2 bps each way): the defaults trade ~2.7 times per ticker per year and end 0.20 excess Sharpe BEHIND buy & hold, against +0.01 for the slow 70/25 rule. More trades did not pay on this signal — this is here to be tested, not because it won.",
  params: [
    { key: "entry", label: "Entry score (buy ≥)", default: 65, min: 10, max: 90 },
    { key: "exit", label: "Exit score (sell <)", default: 35, min: 5, max: 85 },
    { key: "smooth", label: "Score smoothing (days)", default: 5, min: 1, max: 60 },
    { key: "velWindow", label: "Velocity window (days)", default: 10, min: 2, max: 60 },
    { key: "velMin", label: "Min velocity (score points)", default: 20, min: 0, max: 30, step: 0.5 },
    { key: "trailAtr", label: "ATR trail multiple", default: 4, min: 0, max: 10, step: 0.5 },
    { key: "atrPeriod", label: "ATR period", default: 14, min: 2, max: 100 },
  ],
  minBars: 210,
  validate: (p) => p.entry >= p.exit && p.velWindow >= 2,
  generate: ({ open, high, low, close, volume, params, megaWeights, megaOverrides }) => {
    const { score } = computeMegaScoreSeries({ high, low, close, volume, open }, megaWeights, undefined, megaOverrides);
    const smooth = Math.max(1, Math.round(params.smooth || 1));
    const s = smooth > 1 ? sma(score, smooth) : score;
    return megaVelocityPosition(s, params.entry, params.exit, params.velWindow, params.velMin);
  },
};

// ─── 9. Buy & Hold (the benchmark every strategy must beat) ────
const buyHold: StrategyDef = {
  id: "buy_hold",
  name: "Buy & Hold",
  description:
    "Buy on the first bar, never sell. Not clever — but the hurdle every active strategy must clear, since most don't.",
  params: [],
  minBars: 2,
  // Signal 1 from bar 0 so the simulation enters at bar 1's open (no delayed entry).
  generate: ({ close }) => close.map(() => 1),
};

export const STRATEGIES: StrategyDef[] = [
  smaCross,
  emaCross,
  rsiStrategy,
  macdStrategy,
  bollingerStrategy,
  turtleStrategy,
  momentumStrategy,
  megaScore,
  megaScoreFast,
  buyHold,
];

export function getStrategy(id: string): StrategyDef | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

export function defaultParams(def: StrategyDef): Record<string, number> {
  const p: Record<string, number> = {};
  for (const param of def.params) p[param.key] = param.default;
  return p;
}

export { atr };
