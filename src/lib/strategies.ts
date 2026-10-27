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
 */
export function megaRegimePosition(smoothed: number[], entry: number, exit: number): number[] {
  const pos = new Array(smoothed.length).fill(0);
  let inPos = false;
  for (let i = 0; i < smoothed.length; i++) {
    if (Number.isFinite(smoothed[i])) {
      if (!inPos && smoothed[i] >= entry) inPos = true;
      else if (inPos && smoothed[i] < exit) inPos = false;
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
    "Entry must stay at or above exit. Signals fill at the next day's open and every input indicator uses trailing windows only (no look-ahead).",
  params: [
    { key: "entry", label: "Entry score (buy ≥)", default: MEGA_BUY_ABOVE, min: 10, max: 90 },
    { key: "exit", label: "Exit score (sell <)", default: MEGA_SELL_BELOW, min: 5, max: 85 },
    { key: "smooth", label: "Score smoothing (days)", default: 5, min: 1, max: 60 },
  ],
  minBars: 210,
  validate: (p) => p.entry >= p.exit,
  generate: ({ open, high, low, close, volume, params, megaWeights, megaOverrides }) => {
    // Honors the user's Mega Indicator weights (from the Mega Indicator page,
    // piped through config) so the backtest trades the same composite the UI shows.
    const { score } = computeMegaScoreSeries({ high, low, close, volume, open }, megaWeights, undefined, megaOverrides);
    // Optional smoothing of the composite (trailing SMA — causal).
    const s = params.smooth > 1 ? sma(score, Math.round(params.smooth)) : score;
    return megaRegimePosition(s, params.entry, params.exit);
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
