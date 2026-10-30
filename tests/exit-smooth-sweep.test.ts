/**
 * OPT-IN measurement harness: the EXIT band and the SCORE SMOOTHING.
 *
 *   npm run test:exit
 *
 * Why this exists: `test:filters` swept entry gates and risk exits, and
 * `test:trained` swept weights, but neither answered the two questions the
 * losing-trade report raises:
 *
 *   1. smoothing is 5 bars — does a shorter (faster) or longer (steadier) window
 *      actually pay, on the full history AND on both held-out tails?
 *   2. the exit sits at 25 while the composite's floor on most tickers is 23-34,
 *      so on many names it can never fire. Does ANY exit level reduce losses
 *      without giving back more than it saves?
 *
 * Offline against portfolio.db. For every cached ticker the composite is
 * computed ONCE, then each (smoothing × entry/exit) cell is simulated with the
 * real engine on the same bars and the same costs. `end-of-test` closes are
 * excluded from the loss stats because they are the harness closing the book,
 * not a decision the rule made.
 *
 * Prints, per cell: trades, loss rate, average hold, average total return and
 * Sharpe, plus how often the signal was even below the exit (reachability).
 */

import { describe, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { simulateCore, type BacktestConfig, type ResolvedCosts } from "../src/lib/backtest-engine";
import { megaRegimePosition, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { sma } from "../src/lib/ta";
import type { Bar } from "../src/lib/market-data";

const RUN = process.env.EXIT_SWEEP === "1";

const SMOOTHINGS = [1, 3, 5, 10, 20];

/** Entry-70 cells answer "fix the shipped rule"; entry-55 cells make losses measurable. */
const BAND_ROWS = [
  { entry: 70, exits: [20, 25, 30, 35, 40, 45, 50] },
  { entry: 55, exits: [30, 35, 40, 45, 50] },
];

const WINDOWS = [
  { label: "full", from: 0 },
  { label: "last 40%", from: 0.6 },
  { label: "last 30%", from: 0.7 },
];

const COSTS: ResolvedCosts = {
  initialCapital: 100_000,
  commissionBps: 2,
  slippageBps: 2,
  positionPct: 100,
  years: 30,
};

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

function sweepStrategy(positions: number[]): StrategyDef {
  return { id: "exit_sweep", name: "exit sweep", description: "", params: [], minBars: 210, generate: () => positions };
}

interface Tally {
  symbols: number;
  trades: number;
  losers: number;
  bars: number;
  returnPct: number;
  sharpe: number;
  drawdown: number;
  reachable: number; // bars whose signal sits below the exit
  readings: number;  // finite signal bars
  min: number;       // lowest signal reading seen
}

const blank = (): Tally => ({
  symbols: 0, trades: 0, losers: 0, bars: 0, returnPct: 0, sharpe: 0,
  drawdown: 0, reachable: 0, readings: 0, min: Number.POSITIVE_INFINITY,
});

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

(RUN ? describe : describe.skip)("exit + smoothing sweep", () => {
  it("measures every smoothing × exit cell on the cached universe", { timeout: 1_800_000 }, () => {
    const barsBySymbol = loadBars();
    const cells = new Map<string, Record<string, Tally>>();
    const floorBySymbol: Array<{ symbol: string; min: number; p05: number; p10: number }> = [];

    for (const [symbol, bars] of barsBySymbol) {
      const close = bars.map((b) => b.close);
      const { score } = computeMegaScoreSeries({
        open: bars.map((b) => b.open),
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close,
        volume: bars.map((b) => b.volume),
      });

      // Where the composite actually lives on this ticker — the reason an
      // absolute exit can be unreachable.
      const finite = score.filter(Number.isFinite);
      const sorted = [...finite].sort((a, b) => a - b);
      floorBySymbol.push({
        symbol,
        min: sorted[0] ?? NaN,
        p05: sorted[Math.floor(sorted.length * 0.05)] ?? NaN,
        p10: sorted[Math.floor(sorted.length * 0.1)] ?? NaN,
      });

      for (const smoothing of SMOOTHINGS) {
        const signal = smoothing > 1 ? sma(score, smoothing) : score;
        for (const window of WINDOWS) {
          const start = window.from > 0 ? Math.floor(bars.length * window.from) : 0;
          const wBars = bars.slice(start);
          const wClose = close.slice(start);
          const wSignal = signal.slice(start);
          if (wBars.length < 260) continue;

          for (const row of BAND_ROWS) {
            for (const exit of row.exits) {
              const positions = megaRegimePosition(wSignal, row.entry, exit, { close: wClose });
              const config: BacktestConfig = {
                symbol,
                strategyId: "exit_sweep",
                initialCapital: COSTS.initialCapital,
                years: 30,
                commissionBps: COSTS.commissionBps,
                slippageBps: COSTS.slippageBps,
                positionPct: COSTS.positionPct,
                params: {},
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

              const key = `${row.entry}/${exit}|smooth ${smoothing}`;
              const perWindow = cells.get(key) ?? {};
              cells.set(key, perWindow);
              const t = perWindow[window.label] ?? (perWindow[window.label] = blank());
              t.symbols += 1;
              t.returnPct += result.summary.totalReturnPct;
              t.sharpe += result.summary.sharpe;
              t.drawdown += result.summary.maxDrawdownPct;
              for (let i = 0; i < wSignal.length; i++) {
                if (!Number.isFinite(wSignal[i])) continue;
                t.readings += 1;
                if (wSignal[i] < exit) t.reachable += 1;
                if (wSignal[i] < t.min) t.min = wSignal[i];
              }
              for (const trade of result.trades) {
                if (trade.exitDate === null || trade.reason === "end-of-test") continue;
                t.trades += 1;
                t.bars += trade.bars;
                if (trade.pnl <= 0) t.losers += 1;
              }
            }
          }
        }
      }
    }

    console.log("\n=== Composite floor per ticker (raw score, full history) ===");
    console.log(
      ["symbol", "min", "p05", "p10", "exit 25 reachable", "exit 35 reachable"]
        .map((h) => h.padEnd(18))
        .join(""),
    );
    for (const f of floorBySymbol.sort((a, b) => a.min - b.min)) {
      console.log(
        [f.symbol.padEnd(18), f.min.toFixed(1).padStart(6), f.p05.toFixed(1).padStart(8), f.p10.toFixed(1).padStart(8)]
          .join("") +
          `${f.min < 25 ? "yes" : "NO"}`.padStart(22) +
          `${f.min < 35 ? "yes" : "NO"}`.padStart(20),
      );
    }

    for (const window of WINDOWS) {
      for (const row of BAND_ROWS) {
        console.log(`\n=== ${window.label} · entry ${row.entry} · all names · 2 bps + 2 bps ===`);
        console.log(
          ["smoothing", "exit", "trades", "losers", "loss rate", "avg hold", "return/sym", "sharpe", "maxDD", "exit reached"]
            .map((h) => h.padEnd(12))
            .join(""),
        );
        for (const smoothing of SMOOTHINGS) {
          for (const exit of row.exits) {
            const t = cells.get(`${row.entry}/${exit}|smooth ${smoothing}`)?.[window.label];
            if (!t) continue;
            const sharpe = t.sharpe / t.symbols;
            console.log(
              [
                String(smoothing).padEnd(12),
                String(exit).padEnd(12),
                String(t.trades).padEnd(12),
                String(t.losers).padEnd(12),
                pct(t.losers, t.trades).padEnd(12),
                (t.trades > 0 ? (t.bars / t.trades).toFixed(0) + "d" : "—").padEnd(12),
                (t.returnPct / t.symbols).toFixed(0).padStart(8) + "%   ",
                sharpe.toFixed(2).padStart(6) + "    ",
                (t.drawdown / t.symbols).toFixed(1).padStart(6) + "%   ",
                pct(t.reachable, t.readings).padEnd(12),
              ].join(""),
            );
          }
        }
      }
    }
  });
});
