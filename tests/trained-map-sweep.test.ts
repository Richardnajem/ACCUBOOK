/**
 * OPT-IN: train the Mega Score weights under several splits, with and without
 * the indicator catalogue, then ask whether any trained map separates losers.
 *
 *   npm run test:trained
 *
 * Offline against `portfolio.db`:
 *   1. prepare calibration frames for every cached ticker,
 *   2. train maps: built-in 70 % (the shipped reference), catalogue-included at
 *      60 / 70 / 80 %,
 *   3. run the regime rule at 55/45 with every map on TWO COMMON held-out
 *      windows — the last 40 % and the last 20 % — so the maps are compared on
 *      the same sessions rather than on their own differently-sized tails,
 *   4. report loss rate, Sharpe, and the two separation measures that answer the
 *      question: mean entry reading of winners vs losers, and AUC (probability a
 *      random winner's entry reading is higher than a random loser's; 0.5 = no
 *      separation at all).
 *
 * `end-of-test` closes are excluded from the loss stats.
 */

import { describe, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { simulateCore, type BacktestConfig, type ResolvedCosts, type TradeRecord } from "../src/lib/backtest-engine";
import { megaRegimePosition, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { DEFAULT_WEIGHTS, type WeightMap } from "../src/lib/mega-indicator";
import {
  prepareFrame,
  scoreDistribution,
  splitIndex,
  trainMegaWeights,
  type CalibrationFrame,
} from "../src/lib/mega-calibration";
import { sma } from "../src/lib/ta";
import type { Bar } from "../src/lib/market-data";

const RUN = process.env.TRAINED_SWEEP === "1";
const VOLATILE = ["TSLA", "AMD", "NVDA", "MSTR", "SMCI", "COIN", "FSLR", "MU", "GME"];
const BANDS = { entry: 55, exit: 45 };
const SMOOTH = 5;

const COSTS: ResolvedCosts = {
  initialCapital: 100_000,
  commissionBps: 2,
  slippageBps: 2,
  positionPct: 100,
  years: 30,
};

interface TrainConfig {
  key: string;
  split: number;
  includeCatalogue: boolean;
}

const CONFIGS: TrainConfig[] = [
  { key: "builtin-70", split: 0.7, includeCatalogue: false },
  { key: "catalogue-60", split: 0.6, includeCatalogue: true },
  { key: "catalogue-70", split: 0.7, includeCatalogue: true },
  { key: "catalogue-80", split: 0.8, includeCatalogue: true },
];

const WINDOWS = [
  { key: "last 40%", from: 0.6 },
  { key: "last 20%", from: 0.8 },
];

function loadBars(): Map<string, Bar[]> {
  const db = new Database(path.join(process.cwd(), "portfolio.db"), { readonly: true });
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM price_bars ORDER BY symbol").all() as Array<{ symbol: string }>)
    .map((r) => r.symbol);
  const stmt = db.prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE symbol = ? ORDER BY date");
  const out = new Map<string, Bar[]>();
  for (const symbol of symbols) {
    const rows = stmt.all(symbol) as Bar[];
    if (rows.length > 320) out.set(symbol, rows);
  }
  db.close();
  return out;
}

const round = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : 0);
const pctOf = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Rank-based separation: chance a random winner's entry reading beats a random
 * loser's. 0.5 is a coin flip, and unlike the mean gap it cannot be moved by one
 * outlier trade.
 */
function separationAuc(entryWinners: number[], entryLosers: number[]): number | null {
  if (entryWinners.length === 0 || entryLosers.length === 0) return null;
  let score = 0;
  for (const w of entryWinners) {
    for (const l of entryLosers) score += w > l ? 1 : w === l ? 0.5 : 0;
  }
  return score / (entryWinners.length * entryLosers.length);
}

interface LossStats {
  trades: number;
  losers: number;
  wins: number;
  sumReturn: number;
  sumWin: number;
  sumLoss: number;
  sharpe: number;
  returnPct: number;
  entryLosers: number[];
  entryWinners: number[];
  holdLosers: number[];
  holdWinners: number[];
  symbols: number;
}

const blank = (): LossStats => ({
  trades: 0, losers: 0, wins: 0, sumReturn: 0, sumWin: 0, sumLoss: 0,
  sharpe: 0, returnPct: 0, entryLosers: [], entryWinners: [], holdLosers: [], holdWinners: [], symbols: 0,
});

function add(stats: LossStats, trades: TradeRecord[], sharpe: number, totalReturnPct: number) {
  stats.symbols += 1;
  stats.sharpe += sharpe;
  stats.returnPct += totalReturnPct;
  for (const t of trades) {
    if (t.exitDate === null || t.reason === "end-of-test") continue;
    stats.trades += 1;
    stats.sumReturn += t.returnPct;
    const entry = typeof t.entryScore === "number" ? t.entryScore : null;
    if (t.pnl <= 0) {
      stats.losers += 1;
      stats.sumLoss += t.returnPct;
      stats.holdLosers.push(t.bars);
      if (entry !== null) stats.entryLosers.push(entry);
    } else {
      stats.wins += 1;
      stats.sumWin += t.returnPct;
      stats.holdWinners.push(t.bars);
      if (entry !== null) stats.entryWinners.push(entry);
    }
  }
}

function probeStrategy(positions: number[]): StrategyDef {
  return { id: "trained_probe", name: "trained probe", description: "", params: [], minBars: 210, generate: () => positions };
}

(RUN ? describe : describe.skip)("trained weights across splits", () => {
  it("trains 60/70/80 with the catalogue and compares held-out loser separation", { timeout: 900_000 }, () => {
    const barsBySymbol = loadBars();
    const frames: CalibrationFrame[] = [];
    for (const [symbol, bars] of barsBySymbol) frames.push(prepareFrame(symbol, bars));
    console.log(`\nPrepared ${frames.length} frames from portfolio.db`);

    const prior = DEFAULT_WEIGHTS as Record<string, number>;

    // ── Train every configuration ──
    interface MapEntry { key: string; weights: WeightMap | null; split: number | null }
    const maps: MapEntry[] = [{ key: "default", weights: null, split: null }];
    const seriesByMapSymbol = new Map<string, { score: number[]; smoothed: number[] }>();

    for (const cfg of CONFIGS) {
      const started = Date.now();
      const result = trainMegaWeights(frames, prior, {
        passes: 2,
        trainFraction: cfg.split,
        includeCatalogue: cfg.includeCatalogue,
      });
      const weights = result.weights as WeightMap;
      const tuned = result.variants.find((v) => v.key === "tuned")!;
      const priorRun = result.variants.find((v) => v.key === "prior")!;
      const split = splitIndex(frames, cfg.split);

      // Train-window score distribution for this map (scale check): reuse the
      // per-symbol series below rather than recomputing.
      const scores: number[] = [];
      for (const [symbol, bars] of barsBySymbol) {
        const input = {
          open: bars.map((b) => b.open),
          high: bars.map((b) => b.high),
          low: bars.map((b) => b.low),
          close: bars.map((b) => b.close),
          volume: bars.map((b) => b.volume),
        };
        const { score } = computeMegaScoreSeries(input, weights);
        seriesByMapSymbol.set(`${cfg.key}|${symbol}`, { score, smoothed: sma(score, SMOOTH) });
        scores.push(...score.slice(0, split).filter((v) => Number.isFinite(v)));
      }
      const dist = scoreDistribution(scores);

      maps.push({ key: cfg.key, weights, split });
      console.log(
        "\nTRAIN " +
          JSON.stringify({
            config: cfg.key,
            split: `${Math.round(cfg.split * 100)}%`,
            catalogue: cfg.includeCatalogue,
            ms: Date.now() - started,
            trials: result.trials,
            tunedBands: `${result.tuned.entry}/${result.tuned.exit}`,
            testSharpe: round(tuned.test.meanSharpe),
            priorSharpe: round(priorRun.test.meanSharpe),
            testExcess: round(tuned.test.meanExcessSharpe),
            priorExcess: round(priorRun.test.meanExcessSharpe),
            luckExcessBar: round(result.luckExcessSharpe),
            clearsExcessBar: tuned.test.meanExcessSharpe > result.luckExcessSharpe,
            scoreDist: `${round(dist.p10, 1)}/${round(dist.p50, 1)}/${round(dist.p90, 1)}`,
            topWeights: Object.entries(weights)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([id, w]) => `${id}=${w}`),
            moved: result.searchUnits.filter((u) => u.tuned !== u.prior).length,
          }),
      );
    }

    // Default map's series, needed for the same runs.
    for (const [symbol, bars] of barsBySymbol) {
      const input = {
        open: bars.map((b) => b.open),
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close: bars.map((b) => b.close),
        volume: bars.map((b) => b.volume),
      };
      const { score } = computeMegaScoreSeries(input);
      seriesByMapSymbol.set(`default|${symbol}`, { score, smoothed: sma(score, SMOOTH) });
    }

    // ── Run every map on the same held-out windows ──
    const stats = new Map<string, LossStats>();
    /** Per-symbol last-20 % detail, every ticker, with the entry readings needed for AUC. */
    const perSymbol = new Map<
      string,
      {
        trades: number;
        losers: number;
        sumReturn: number;
        entryWinners: number[];
        entryLosers: number[];
      }
    >();

    for (const [symbol, bars] of barsBySymbol) {
      for (const map of maps) {
        const series = seriesByMapSymbol.get(`${map.key}|${symbol}`);
        if (!series) continue;
        for (const window of WINDOWS) {
          const start = Math.floor(bars.length * window.from);
          const wBars = bars.slice(start);
          if (wBars.length < 260) continue;
          const positions = megaRegimePosition(series.smoothed.slice(start), BANDS.entry, BANDS.exit);
          const config: BacktestConfig = {
            symbol,
            strategyId: "trained_probe",
            initialCapital: COSTS.initialCapital,
            years: 30,
            commissionBps: COSTS.commissionBps,
            slippageBps: COSTS.slippageBps,
            positionPct: COSTS.positionPct,
            params: {},
            megaWeights: map.weights ?? undefined,
          };
          const run = simulateCore(
            wBars,
            { symbol, name: symbol, currency: "USD", exchange: "cache" },
            "cache",
            probeStrategy(positions),
            COSTS,
            config,
            true,
          );

          const decisions = run.trades.filter((t) => t.exitDate !== null && t.reason !== "end-of-test");
          if (window.key === "last 20%") {
            const entryOf = (t: TradeRecord) => (typeof t.entryScore === "number" ? t.entryScore : null);
            perSymbol.set(`${map.key}|${symbol}`, {
              trades: decisions.length,
              losers: decisions.filter((t) => t.pnl <= 0).length,
              sumReturn: decisions.reduce((s, t) => s + t.returnPct, 0),
              entryWinners: decisions
                .filter((t) => t.pnl > 0)
                .map(entryOf)
                .filter((v): v is number => v !== null),
              entryLosers: decisions
                .filter((t) => t.pnl <= 0)
                .map(entryOf)
                .filter((v): v is number => v !== null),
            });
          }

          for (const universe of ["all", "volatile"]) {
            if (universe === "volatile" && !VOLATILE.includes(symbol)) continue;
            const key = `${map.key}|${universe}|${window.key}`;
            const bucket = stats.get(key) ?? blank();
            add(bucket, run.trades, run.summary.sharpe, run.summary.totalReturnPct);
            stats.set(key, bucket);
          }
        }
      }
    }

    for (const window of WINDOWS) {
      for (const universe of ["all", "volatile"]) {
        console.log(`\n=== ${window.key} (held out for every map) · ${universe} names · 55/45 · 2 bps + 2 bps ===`);
        console.log(
          ["map", "trades", "losers", "loss rate", "avg win", "avg loss", "avg trade", "sharpe", "return/sym", "entry win/lose", "gap", "AUC"]
            .map((h) => h.padEnd(10))
            .join(" "),
        );
        for (const map of maps) {
          const s = stats.get(`${map.key}|${universe}|${window.key}`);
          if (!s || s.trades === 0) {
            console.log(`${map.key.padEnd(10)} no trades`);
            continue;
          }
          const entryW = mean(s.entryWinners);
          const entryL = mean(s.entryLosers);
          const gap = entryW !== null && entryL !== null ? entryW - entryL : null;
          const auc = separationAuc(s.entryWinners, s.entryLosers);
          console.log(
            [
              map.key.padEnd(10),
              String(s.trades).padStart(9),
              String(s.losers).padStart(9),
              pctOf(s.losers, s.trades).padStart(9),
              `${round(s.sumWin / Math.max(1, s.wins), 1)}%`.padStart(9),
              `${round(s.sumLoss / Math.max(1, s.losers), 1)}%`.padStart(9),
              `${round(s.sumReturn / s.trades, 2)}%`.padStart(9),
              round(s.sharpe / s.symbols).toFixed(2).padStart(9),
              `${round(s.returnPct / s.symbols, 0)}%`.padStart(9),
              `${entryW !== null ? round(entryW, 1) : "—"}/${entryL !== null ? round(entryL, 1) : "—"}`.padStart(11),
              (gap !== null ? `${gap >= 0 ? "+" : ""}${round(gap, 2)}` : "—").padStart(9),
              (auc !== null ? auc.toFixed(3) : "—").padStart(9),
            ].join(" "),
          );
        }
      }
    }

    // ── Per-symbol AUC on the strictest window (every cached ticker) ──
    const symbols = [...barsBySymbol.keys()].sort();
    console.log("\n=== Last 20 % per-symbol AUC by map (only cells with ≥ 5 completed trades) ===");
    console.log(["symbol", ...maps.map((m) => m.key), "all ≥0.55"].map((h) => h.padEnd(12)).join(" "));
    const clearByMap = new Map<string, number>();
    const judgedByMap = new Map<string, number>();
    const consistentSymbols: string[] = [];
    for (const symbol of symbols) {
      const cells: string[] = [];
      let judged = 0;
      let allClear = true;
      for (const map of maps) {
        const s = perSymbol.get(`${map.key}|${symbol}`);
        if (!s || s.trades < 5) {
          cells.push("—".padStart(12));
          continue;
        }
        judged += 1;
        judgedByMap.set(map.key, (judgedByMap.get(map.key) ?? 0) + 1);
        const auc = separationAuc(s.entryWinners, s.entryLosers);
        if (auc === null) {
          allClear = false;
          cells.push("n/a".padStart(12));
          continue;
        }
        if (auc >= 0.55) clearByMap.set(map.key, (clearByMap.get(map.key) ?? 0) + 1);
        else allClear = false;
        cells.push(auc.toFixed(3).padStart(12));
      }
      const ok = judged >= 2 && allClear;
      if (ok) consistentSymbols.push(symbol);
      console.log(`${symbol.padEnd(12)} ${cells.join(" ")} ${ok ? "yes" : ""}`);
    }
    console.log(
      "\nSymbols clearing AUC 0.55 by map: " +
        maps
          .map((m) => `${m.key} ${clearByMap.get(m.key) ?? 0}/${judgedByMap.get(m.key) ?? 0} (≥5 trades)`)
          .join(" · "),
    );
    console.log(
      `Symbols clearing 0.55 on EVERY map that could judge them (≥ 2 maps): ${
        consistentSymbols.length ? consistentSymbols.join(", ") : "none"
      }`,
    );
  });
});
