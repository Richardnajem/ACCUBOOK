/**
 * OPT-IN: does a trained Mega Score map help on a ticker held out ENTIRELY?
 *
 *   npm run test:leaveout
 *
 * The training tab's own hold-out is a time split: the weights never see the
 * last 30 % of the SAME tickers they learned from. That still lets a map learn
 * "this universe's" quirks. This harness removes that comfort:
 *
 *   1. for each volatile ticker, train on every OTHER cached ticker (70 %, the
 *      shipped search space, no catalogue),
 *   2. evaluate three maps on the excluded ticker's last 30 % only:
 *        prior        — hands-off defaults at 70/25 (what ships today)
 *        weights-only — trained weights at 70/25 (isolates the weights)
 *        tuned        — trained weights at the bands the training run chose
 *   3. also train on the excluded ticker's OWN first 70 % and test its tail —
 *      an upper bound for "is there any learnable structure in this name at
 *      all". If that cannot beat the prior, nothing can transfer.
 *
 * Every row reports Sharpe, excess over buy & hold, loss rate, and the Training
 * tab's separation metric (mean entry reading of winners vs losers, gap, AUC).
 * `end-of-test` closes are excluded from the trade stats.
 */

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { DEFAULT_WEIGHTS, MEGA_BASELINE, type WeightMap } from "../src/lib/mega-indicator";
import {
  collectEntryOutcomes,
  compositeSeries,
  evaluateVariant,
  prepareFrame,
  summarizeEntrySeparation,
  trainMegaWeights,
  type CalibrationFrame,
  type EntryOutcome,
  type EntrySeparation,
} from "../src/lib/mega-calibration";
import type { Bar } from "../src/lib/market-data";

const RUN = process.env.LEAVE_ONE_OUT === "1";
const HOLDOUTS = ["TSLA", "AMD", "NVDA", "MSTR", "SMCI", "COIN", "FSLR", "MU", "GME"];
const TRAIN_FRACTION = 0.7;
const PRIOR_BANDS = { entry: MEGA_BASELINE.entry, exit: MEGA_BASELINE.exit };
const COSTS = { commissionBps: 2, slippageBps: 2 };
const MIN_TAIL_BARS = 120;

function loadBars(): Map<string, Bar[]> {
  const db = new Database(path.join(process.cwd(), "portfolio.db"), { readonly: true });
  const symbols = (
    db.prepare("SELECT DISTINCT symbol FROM price_bars ORDER BY symbol").all() as Array<{ symbol: string }>
  ).map((r) => r.symbol);
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
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

interface RowResult {
  map: string;
  entry: number;
  exit: number;
  sharpe: number;
  excessSharpe: number;
  returnPct: number;
  trades: number;
  sep: EntrySeparation;
  wins: EntryOutcome[];
  losses: EntryOutcome[];
}

/** One map on the held-out ticker's tail: backtest + the Training tab's metric. */
function runRow(
  map: string,
  frame: CalibrationFrame,
  weights: WeightMap,
  entry: number,
  exit: number,
  split: number
): RowResult {
  const test = evaluateVariant([frame], weights, entry, exit, {
    split,
    costs: COSTS,
    minTrades: 4,
  }).test;
  const out = collectEntryOutcomes(compositeSeries(frame, weights), frame, entry, exit, {
    window: { from: split, to: frame.close.length },
    costs: COSTS,
  });
  return {
    map,
    entry,
    exit,
    sharpe: test.meanSharpe,
    excessSharpe: test.meanExcessSharpe,
    returnPct: test.meanTotalReturnPct,
    trades: test.totalTrades,
    sep: summarizeEntrySeparation(out.wins, out.losses),
    wins: out.wins,
    losses: out.losses,
  };
}

interface HoldoutResult {
  symbol: string;
  bars: number;
  split: number;
  trainedOn: number;
  trials: number;
  bands: string;
  rows: RowResult[];
  holdoutInTraining: boolean;
}

(RUN ? describe : describe.skip)("leave-one-ticker-out", () => {
  it("trains without each volatile ticker and tests it cold", { timeout: 900_000 }, () => {
    const barsBySymbol = loadBars();
    const frames = new Map<string, CalibrationFrame>();
    for (const [symbol, bars] of barsBySymbol) frames.set(symbol, prepareFrame(symbol, bars));

    const prior = DEFAULT_WEIGHTS as WeightMap;
    const results: HoldoutResult[] = [];

    console.log(
      "\nLOO " +
        JSON.stringify({
          cached: barsBySymbol.size,
          holdouts: HOLDOUTS.filter((s) => barsBySymbol.has(s)),
          trainFraction: TRAIN_FRACTION,
          bands: "trained",
        }),
    );

    for (const symbol of HOLDOUTS) {
      const frame = frames.get(symbol);
      if (!frame) {
        console.log(`LOO-SKIP ${symbol} not cached`);
        continue;
      }

      const trainFrames = [...frames.values()].filter((f) => f.symbol !== symbol);
      const trained = trainMegaWeights(trainFrames, prior, {
        passes: 2,
        trainFraction: TRAIN_FRACTION,
      });
      const weights = trained.weights as WeightMap;
      const split = trained.splitIndex;
      if (frame.close.length - split < MIN_TAIL_BARS) {
        // Late listings (COIN) begin after the shared split boundary, so their
        // tail would be empty — report the reason instead of a negative count.
        console.log(
          `LOO-SKIP ${symbol} has ${frame.close.length} bars, shorter than the ${split}-bar shared split — no tail left to test`,
        );
        continue;
      }

      const rows = [
        runRow("prior", frame, prior, PRIOR_BANDS.entry, PRIOR_BANDS.exit, split),
        runRow("weights-only", frame, weights, PRIOR_BANDS.entry, PRIOR_BANDS.exit, split),
        runRow("tuned", frame, weights, trained.tuned.entry, trained.tuned.exit, split),
      ];

      // Upper bound: a map fitted to THIS ticker's own first 70 %, tested on its
      // tail. Still out-of-sample in time, but it has seen the name's behaviour.
      const self = trainMegaWeights([frame], prior, { passes: 1, trainFraction: TRAIN_FRACTION });
      if (frame.close.length - self.splitIndex >= MIN_TAIL_BARS) {
        rows.push(runRow("self-trained", frame, self.weights as WeightMap, self.tuned.entry, self.tuned.exit, self.splitIndex));
      }

      results.push({
        symbol,
        bars: frame.close.length,
        split,
        trainedOn: trainFrames.length,
        trials: trained.trials,
        bands: `${trained.tuned.entry}/${trained.tuned.exit}`,
        rows,
        holdoutInTraining: trainFrames.some((f) => f.symbol === symbol),
      });

      for (const r of rows) {
        console.log(
          "LOOROW " +
            JSON.stringify({
              symbol,
              map: r.map,
              bands: `${r.entry}/${r.exit}`,
              trades: r.trades,
              losers: r.sep.losers,
              lossRate: round(r.sep.lossRatePct, 1),
              avgTrade: round(r.returnPct / Math.max(1, r.trades), 2),
              sharpe: round(r.sharpe),
              excess: round(r.excessSharpe),
              entryWin: r.sep.meanEntryWinners === null ? null : round(r.sep.meanEntryWinners, 1),
              entryLose: r.sep.meanEntryLosers === null ? null : round(r.sep.meanEntryLosers, 1),
              gap: r.sep.gap === null ? null : round(r.sep.gap),
              auc: r.sep.auc === null ? null : round(r.sep.auc, 3),
            }),
        );
      }
    }

    // ── Pooled across the held-out names ──
    const pooledFor = (map: string) => {
      const rows = results.map((r) => r.rows.find((x) => x.map === map)).filter((r): r is RowResult => !!r);
      const pooled = summarizeEntrySeparation(
        rows.flatMap((r) => r.wins),
        rows.flatMap((r) => r.losses),
      );
      return {
        map,
        names: rows.length,
        trades: pooled.trades,
        losers: pooled.losers,
        lossRate: pooled.lossRatePct,
        sharpe: rows.reduce((s, r) => s + r.sharpe, 0) / Math.max(1, rows.length),
        excess: rows.reduce((s, r) => s + r.excessSharpe, 0) / Math.max(1, rows.length),
        returnPct: rows.reduce((s, r) => s + r.returnPct, 0) / Math.max(1, rows.length),
        gap: pooled.gap,
        auc: pooled.auc,
      };
    };
    const pooled = ["prior", "weights-only", "tuned", "self-trained"].map(pooledFor);

    console.log("\n=== Pooled, out-of-universe tickers only (last 30 % of each) ===");
    console.log(
      ["map", "names", "trades", "loss rate", "avg ret", "sharpe", "excess", "entry gap", "AUC"]
        .map((h) => h.padEnd(11))
        .join(" "),
    );
    for (const p of pooled) {
      console.log(
        [
          p.map.padEnd(11),
          String(p.names).padStart(10),
          String(p.trades).padStart(10),
          pctOf(p.losers, p.trades).padStart(10),
          `${round(p.returnPct, 1)}%`.padStart(10),
          round(p.sharpe).toFixed(2).padStart(10),
          round(p.excess).toFixed(2).padStart(10),
          (p.gap === null ? "—" : `${p.gap >= 0 ? "+" : ""}${round(p.gap)}`).padStart(10),
          (p.auc === null ? "—" : p.auc.toFixed(3)).padStart(10),
        ].join(" "),
      );
    }

    // ── Per-name win/lose against the prior, and transfer ──
    const compare = (a: string, b: string) => {
      const rows = results
        .map((r) => {
          const left = r.rows.find((x) => x.map === a);
          const right = r.rows.find((x) => x.map === b);
          return left && right ? { symbol: r.symbol, left, right } : null;
        })
        .filter((r): r is { symbol: string; left: RowResult; right: RowResult } => !!r);
      const betterExcess = rows.filter((r) => r.left.excessSharpe > r.right.excessSharpe).length;
      const betterAuc = rows.filter((r) => (r.left.sep.auc ?? 0) > (r.right.sep.auc ?? 0)).length;
      const medianDeltaExcess = median(rows.map((r) => r.left.excessSharpe - r.right.excessSharpe));
      const medianDeltaAuc = median(rows.map((r) => (r.left.sep.auc ?? 0) - (r.right.sep.auc ?? 0)));
      const winners = rows.filter((r) => r.left.excessSharpe > r.right.excessSharpe).map((r) => r.symbol);
      return { names: rows.length, betterExcess, betterAuc, medianDeltaExcess, medianDeltaAuc, winners };
    };

    const tunedVsPrior = compare("tuned", "prior");
    const weightsVsPrior = compare("weights-only", "prior");
    const selfVsPrior = compare("self-trained", "prior");

    console.log(
      "\nLOOSUMMARY " +
        JSON.stringify({
          tunedBeatsPriorExcess: `${tunedVsPrior.betterExcess}/${tunedVsPrior.names}`,
          tunedBeatsPriorAuc: `${tunedVsPrior.betterAuc}/${tunedVsPrior.names}`,
          medianExcessDelta: round(tunedVsPrior.medianDeltaExcess),
          medianAucDelta: round(tunedVsPrior.medianDeltaAuc, 3),
          weightsOnlyBeatsPriorExcess: `${weightsVsPrior.betterExcess}/${weightsVsPrior.names}`,
          selfTrainedBeatsPriorExcess: `${selfVsPrior.betterExcess}/${selfVsPrior.names}`,
          namesTunedWins: tunedVsPrior.winners,
        }),
    );

    // The experiment only means something if it is what it claims to be.
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const r of results) {
      expect(r.holdoutInTraining).toBe(false);
      expect(r.trials).toBeGreaterThan(0);
      expect(r.rows.find((x) => x.map === "tuned")!.trades).toBeGreaterThanOrEqual(0);
    }
  });
});
