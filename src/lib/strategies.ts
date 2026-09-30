// Famous, well-known trading strategies for publicly traded stocks.
// Each strategy inspects the indicator context on bar i and returns a desired
// position: 1 = long (fully invested), 0 = flat (cash). No shorting/leverage.

import { sma, ema, rsi, macd, bollinger, atr, rollingMax, rollingMin } from "./ta";
import { computeMegaScoreSeries } from "./mega-score";
import type { WeightMap } from "./mega-indicator";

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

// ─── 8. Mega Score regime (composite technical health filter) ──
const megaScore: StrategyDef = {
  id: "mega_score",
  name: "Mega Score Regime",
  description:
    "Uses the app's own composite Mega Indicator: stay long only while the weighted technical health score is in a strong regime, step aside when it deteriorates. Entry threshold turns bullish earlier (lower), exit threshold is the bearish trigger — entry < exit creates hysteresis so the position doesn't flip on noise. Every input indicator is computed with trailing windows only (no look-ahead).",
  params: [
    { key: "entry", label: "Entry score ≥", default: 55, min: 10, max: 90 },
    { key: "exit", label: "Exit score ≤", default: 45, min: 5, max: 85 },
    { key: "smooth", label: "Score smoothing (days)", default: 5, min: 1, max: 60 },
  ],
  minBars: 210,
  validate: (p) => p.entry >= p.exit,
  generate: ({ high, low, close, volume, params, megaWeights }) => {
    // Honors the user's Mega Indicator weights (from the Mega Indicator page,
    // piped through config) so the backtest trades the same composite the UI shows.
    const { score } = computeMegaScoreSeries({ high, low, close, volume }, megaWeights);
    // Optional smoothing of the composite (trailing SMA — causal).
    const s = params.smooth > 1 ? sma(score, Math.round(params.smooth)) : score;
    const pos = new Array(close.length).fill(0);
    let inPos = false;
    for (let i = 0; i < close.length; i++) {
      if (Number.isFinite(s[i])) {
        if (!inPos && s[i] >= params.entry) inPos = true;
        else if (inPos && s[i] <= params.exit) inPos = false;
      }
      pos[i] = inPos ? 1 : 0;
    }
    return pos;
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
