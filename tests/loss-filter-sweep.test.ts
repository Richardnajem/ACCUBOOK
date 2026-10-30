/**
 * OPT-IN measurement harness: why does the Mega Score rule lose trades, and
 * does any filter or risk exit reduce that?
 *
 * Not part of `npm test` (skipped unless LOSS_SWEEP=1). Run it with:
 *
 *   npm run test:filters
 *
 * What it does, on the bars already cached in `portfolio.db` (no network):
 *   1. computes the Mega Score ONCE per symbol (the expensive step),
 *   2. smooths it exactly as the shipped strategy does (SMA 5),
 *   3. runs the real engine (`simulateCore`) for each candidate — entry gates,
 *      fixed stop-loss (with and without waiting for a fresh signal), ATR
 *      trailing stops — on the whole cache and on the volatile names alone,
 *   4. prints a loss autopsy for the baseline: exit reasons and the worst trades.
 *
 * `end-of-test` closes are excluded from the loss stats: they are the harness
 * closing the book, not a decision the rule made.
 */

import { describe, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { simulateCore, type BacktestConfig, type ResolvedCosts, type TradeRecord } from "../src/lib/backtest-engine";
import { megaRegimePosition, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { sma } from "../src/lib/ta";
import type { Bar } from "../src/lib/market-data";

const RUN = process.env.LOSS_SWEEP === "1";

/** The names whose daily swings make a bad entry expensive. */
const VOLATILE = ["TSLA", "AMD", "NVDA", "MSTR", "SMCI", "COIN", "FSLR", "MU", "GME"];

interface Variant {
  label: string;
  confirm: number;
  trendMa: number;
  stopLossPct?: number;
  trailAtr?: number;
  reentryNeedsSignal?: boolean;
}

const VARIANTS: Variant[] = [
  { label: "baseline", confirm: 1, trendMa: 0 },
  { label: "confirm 5", confirm: 5, trendMa: 0 },
  { label: "trend 200", confirm: 1, trendMa: 200 },
  { label: "stop 15", confirm: 1, trendMa: 0, stopLossPct: 15 },
  { label: "stop 15 + wait", confirm: 1, trendMa: 0, stopLossPct: 15, reentryNeedsSignal: true },
  { label: "stop 20 + wait", confirm: 1, trendMa: 0, stopLossPct: 20, reentryNeedsSignal: true },
  { label: "trail 3xATR", confirm: 1, trendMa: 0, trailAtr: 3 },
  { label: "trail 4xATR", confirm: 1, trendMa: 0, trailAtr: 4 },
  { label: "confirm 5 + trail 3xATR", confirm: 5, trendMa: 0, trailAtr: 3 },
  { label: "trend 200 + stop 15 + wait", confirm: 1, trendMa: 200, stopLossPct: 15, reentryNeedsSignal: true },
];

const BANDS = [
  { entry: 70, exit: 25 }, // shipped baseline
  { entry: 55, exit: 45 }, // a band that actually trades, so losses are measurable
];

const WINDOWS = [
  { label: "full", from: 0 },
  { label: "last 40%", from: 0.6 },
  { label: "last 30%", from: 0.7 },
];

interface Tally {
  trades: number;
  losers: number;
  wins: number;
  sumReturn: number;
  sumLoss: number;
  sumWin: number;
  worst: number;
  returnPct: number;
  sharpe: number;
  symbols: number;
}

const blank = (): Tally => ({
  trades: 0, losers: 0, wins: 0, sumReturn: 0, sumLoss: 0, sumWin: 0,
  worst: 0, returnPct: 0, sharpe: 0, symbols: 0,
});

function loadBars(): Map<string, Bar[]> {
  const db = new Database(path.join(process.cwd(), "portfolio.db"), { readonly: true });
  const symbols = (db.prepare("SELECT DISTINCT symbol FROM price_bars ORDER BY symbol").all() as Array<{ symbol: string }>)
    .map((r) => r.symbol);
  const out = new Map<string, Bar[]>();
  const stmt = db.prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE symbol = ? ORDER BY date");
  for (const symbol of symbols) {
    const rows = stmt.all(symbol) as Bar[];
    if (rows.length > 300) out.set(symbol, rows);
  }
  db.close();
  return out;
}

function sweepStrategy(positions: number[]): StrategyDef {
  return { id: "loss_sweep", name: "loss sweep", description: "", params: [], minBars: 210, generate: () => positions };
}

const COSTS: ResolvedCosts = {
  initialCapital: 100_000,
  commissionBps: 2,
  slippageBps: 2,
  positionPct: 100,
  years: 30,
};

const pctOf = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");
const num = (n: number) => n.toFixed(1);

(RUN ? describe : describe.skip)("loss filter sweep", () => {
  it("measures entry gates and risk exits on the cached universe", { timeout: 900_000 }, () => {
    const barsBySymbol = loadBars();
    const byCell = new Map<string, Record<string, Tally>>();
    /** Baseline (55/45) diagnosis material, volatile names only. */
    const autopsy: Array<{ symbol: string; trades: TradeRecord[] }> = [];
    const equityByReason = new Map<string, { count: number; losers: number; sumReturn: number; sumBars: number }>();

    for (const [symbol, bars] of barsBySymbol) {
      const close = bars.map((b) => b.close);
      const { score } = computeMegaScoreSeries({
        open: bars.map((b) => b.open),
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close,
        volume: bars.map((b) => b.volume),
      });
      const smoothed = sma(score, 5);
      const universes: Array<{ label: string; include: boolean }> = [
        { label: "all", include: true },
        { label: "volatile", include: VOLATILE.includes(symbol) },
      ];

      for (const window of WINDOWS) {
        const start = window.from > 0 ? Math.floor(bars.length * window.from) : 0;
        const wBars = bars.slice(start);
        const wClose = close.slice(start);
        const wScore = smoothed.slice(start);
        if (wBars.length < 260) continue;

        for (const band of BANDS) {
          for (const variant of VARIANTS) {
            const positions = megaRegimePosition(wScore, band.entry, band.exit, {
              close: wClose,
              confirmDays: variant.confirm,
              trendMa: variant.trendMa,
            });
            const config: BacktestConfig = {
              symbol,
              strategyId: "loss_sweep",
              initialCapital: COSTS.initialCapital,
              years: 30,
              commissionBps: COSTS.commissionBps,
              slippageBps: COSTS.slippageBps,
              positionPct: COSTS.positionPct,
              params: { trailAtr: variant.trailAtr ?? 0, atrPeriod: 14 },
              stopLossPct: variant.stopLossPct,
              reentryNeedsSignal: variant.reentryNeedsSignal,
            };
            const result = simulateCore(
              wBars,
              { symbol, name: symbol, currency: "USD", exchange: "cache" },
              "cache",
              sweepStrategy(positions),
              COSTS,
              config,
              false,
            );

            // Diagnosis uses the plain baseline at 55/45, full window. Re-run it
            // with charts on: `charts` is what makes the engine record the Mega
            // Score on each trade, and the point of the autopsy is to see whether
            // losers were bought at a different reading than winners.
            if (band.entry === 55 && variant.label === "baseline" && window.label === "full" && VOLATILE.includes(symbol)) {
              const detailed = simulateCore(
                wBars,
                { symbol, name: symbol, currency: "USD", exchange: "cache" },
                "cache",
                sweepStrategy(positions),
                COSTS,
                config,
                true,
              );
              autopsy.push({ symbol, trades: detailed.trades });
            }

            for (const universe of universes) {
              const key = `${universe.label}|${band.entry}/${band.exit}|${variant.label}`;
              const perWindow = byCell.get(key) ?? {};
              byCell.set(key, perWindow);
              const tally = perWindow[window.label] ?? (perWindow[window.label] = blank());
              tally.symbols += 1;
              tally.returnPct += result.summary.totalReturnPct;
              tally.sharpe += result.summary.sharpe;

              for (const trade of result.trades) {
                if (trade.exitDate === null || trade.reason === "end-of-test") continue;
                tally.trades += 1;
                tally.sumReturn += trade.returnPct;
                if (trade.pnl <= 0) {
                  tally.losers += 1;
                  tally.sumLoss += trade.returnPct;
                  tally.worst = Math.min(tally.worst, trade.returnPct);
                } else {
                  tally.wins += 1;
                  tally.sumWin += trade.returnPct;
                }
                if (band.entry === 55 && variant.label === "baseline" && window.label === "full" && VOLATILE.includes(symbol)) {
                  const bucket = equityByReason.get(trade.reason) ?? { count: 0, losers: 0, sumReturn: 0, sumBars: 0 };
                  bucket.count += 1;
                  if (trade.pnl <= 0) bucket.losers += 1;
                  bucket.sumReturn += trade.returnPct;
                  bucket.sumBars += trade.bars;
                  equityByReason.set(trade.reason, bucket);
                }
              }
            }
          }
        }
      }
    }

    for (const window of WINDOWS) {
      for (const universe of ["all", "volatile"]) {
        console.log(`\n=== ${window.label} · ${universe} names · 2 bps + 2 bps ===`);
        console.log(
          ["bands · candidate", "trades", "losers", "loss rate", "avg win", "avg loss", "worst", "avg trade", "return", "sharpe"]
            .map((h) => h.padEnd(10))
            .join(" "),
        );
        for (const band of BANDS) {
          for (const variant of VARIANTS) {
            const tally = byCell.get(`${universe}|${band.entry}/${band.exit}|${variant.label}`)?.[window.label];
            const label = `${band.entry}/${band.exit} · ${variant.label}`;
            if (!tally || tally.trades === 0) {
              console.log(`${label.padEnd(34)} ${"no trades".padStart(90)}`);
              continue;
            }
            console.log(
              [
                label.padEnd(34),
                String(tally.trades).padStart(10),
                String(tally.losers).padStart(10),
                pctOf(tally.losers, tally.trades).padStart(10),
                `${num(tally.sumWin / Math.max(1, tally.wins))}%`.padStart(10),
                `${num(tally.sumLoss / Math.max(1, tally.losers))}%`.padStart(10),
                `${num(tally.worst)}%`.padStart(10),
                `${(tally.sumReturn / tally.trades).toFixed(2)}%`.padStart(10),
                `${(tally.returnPct / tally.symbols).toFixed(0)}%`.padStart(10),
                (tally.sharpe / tally.symbols).toFixed(2).padStart(10),
              ].join(" "),
            );
          }
        }
      }
    }

    // ── Loss autopsy: baseline 55/45, volatile names, full window ──
    if (equityByReason.size > 0) {
      console.log("\n=== Loss autopsy · baseline 55/45 · volatile names · full window ===");
      console.log(["exit reason", "trades", "losers", "loss rate", "avg return", "avg bars"].map((h) => h.padEnd(14)).join(" "));
      for (const [reason, bucket] of [...equityByReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(
          [
            reason.padEnd(14),
            String(bucket.count).padStart(10),
            String(bucket.losers).padStart(10),
            pctOf(bucket.losers, bucket.count).padStart(10),
            `${num(bucket.sumReturn / bucket.count)}%`.padStart(10),
            num(bucket.sumBars / bucket.count).padStart(10),
          ].join(" "),
        );
      }

      const worst = autopsy
        .flatMap(({ symbol, trades }) =>
          trades
            .filter((t) => t.exitDate !== null && t.reason !== "end-of-test" && t.pnl <= 0)
            .map((t) => ({ symbol, t })),
        )
        .sort((a, b) => a.t.returnPct - b.t.returnPct)
        .slice(0, 12);
      console.log("\nWorst 12 losing decisions:");
      for (const { symbol, t } of worst) {
        console.log(
          `${symbol.padEnd(6)} ${t.entryDate} → ${t.exitDate}  ${num(t.returnPct)}%  ` +
            `${t.bars}d  reason=${t.reason.padEnd(13)} entryScore=${t.entryScore ?? "—"} exitScore=${t.exitScore ?? "—"}`,
        );
      }

      const avgEntry = (rows: TradeRecord[]) => {
        const vals = rows.map((t) => t.entryScore).filter((v): v is number => typeof v === "number");
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      const allTrades = autopsy.flatMap((a) => a.trades).filter((t) => t.exitDate !== null && t.reason !== "end-of-test");
      const winners = allTrades.filter((t) => t.pnl > 0);
      const losers = allTrades.filter((t) => t.pnl <= 0);
      console.log(
        `\nEntry readings: winners ${avgEntry(winners)?.toFixed(1) ?? "—"} · losers ${avgEntry(losers)?.toFixed(1) ?? "—"}` +
          ` · avg hold winners ${num(winners.reduce((s, t) => s + t.bars, 0) / Math.max(1, winners.length))}d` +
          ` · losers ${num(losers.reduce((s, t) => s + t.bars, 0) / Math.max(1, losers.length))}d`,
      );
    }
  });
});
