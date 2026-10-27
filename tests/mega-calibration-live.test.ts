// Live calibration harness — REAL market data, opt-in.
//
//   npm run test:calibrate
//
// `npm run test:calibrate` is the supported way in: it sets MEGA_LIVE=1 AND
// passes --disableConsoleIntercept, without which Vitest captures console and
// every line of the report below is invisible — a run then "passes" in ~a minute
// having shown nobody anything. Running vitest directly works only with that flag.
//
// It is skipped in `npm test` because it needs the network (Yahoo/Stooq via
// lib/market-data) and takes a minute. Its job is not to assert a specific
// Sharpe — it prints a side-by-side report of the settings a human then chooses
// between, and the same code path is what /api/mega-train runs.
//
// Optional: MEGA_UNIVERSE="SPY,QQQ,..." MEGA_YEARS=15

import { describe, it, expect } from "vitest";
import { DEFAULT_WEIGHTS, MEGA_BASELINE } from "../src/lib/mega-indicator";
import {
  equalWeights,
  evaluateVariant,
  prepareFrame,
  splitIndex,
  trainMegaWeights,
  type CalibrationFrame,
  type CalibrationResult,
  type TrainingOptions,
} from "../src/lib/mega-calibration";
import { getDailyBars } from "../src/lib/market-data";

const LIVE = process.env.MEGA_LIVE === "1";

const UNIVERSE = (process.env.MEGA_UNIVERSE ??
  "SPY,QQQ,IWM,DIA,AAPL,MSFT,NVDA,GOOGL,AMZN,META,JPM,XOM,JNJ,PG,KO,WMT," +
  "TSLA,AMD,NFLX,MU,FSLR,GME,MSTR,SMCI")
  .split(/[\s,;]+/)
  .filter(Boolean);
const YEARS = Number(process.env.MEGA_YEARS ?? 15);

interface Config {
  key: string;
  label: string;
  split: number;
  options: Partial<TrainingOptions>;
}

const CONFIGS: Config[] = [
  { key: "std-70", label: "built-ins, 2 passes, 70/30", split: 0.7, options: { passes: 2 } },
  { key: "std-60", label: "built-ins, 2 passes, 60/40", split: 0.6, options: { passes: 2 } },
  { key: "std-80", label: "built-ins, 2 passes, 80/20", split: 0.8, options: { passes: 2 } },
  { key: "deep-70", label: "built-ins, 3 passes, 70/30", split: 0.7, options: { passes: 3 } },
  { key: "catalogue-70", label: "built-ins + catalogue, 2 passes, 70/30", split: 0.7, options: { passes: 2, includeCatalogue: true } },
];

describe.runIf(LIVE)("live Mega Score calibration", () => {
  it("fetches the universe once and reports every search setting", async () => {
    const frames: CalibrationFrame[] = [];
    const failures: string[] = [];
    for (const symbol of UNIVERSE) {
      try {
        const { bars } = await getDailyBars(symbol, YEARS);
        if (bars.length < 300) throw new Error(`only ${bars.length} bars`);
        frames.push(prepareFrame(symbol, bars));
      } catch (e) {
        failures.push(`${symbol}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }
    console.log(`\nLoaded ${frames.length}/${UNIVERSE.length} tickers`);
    if (failures.length) console.log("Skipped:", failures.join("; "));
    expect(frames.length).toBeGreaterThanOrEqual(8);

    const prior = DEFAULT_WEIGHTS as Record<string, number>;
    const summary: unknown[] = [];
    /** Every run's full result, so later sections can derive their probes from it. */
    const runs: Array<{ cfg: Config; result: CalibrationResult }> = [];

    for (const cfg of CONFIGS) {
      const started = Date.now();
      const result = trainMegaWeights(frames, prior, { ...cfg.options, trainFraction: cfg.split });
      const tuned = result.variants.find((v) => v.key === "tuned")!;
      const priorRun = result.variants.find((v) => v.key === "prior")!;
      const bandsOnly = result.variants.find((v) => v.key === "bands-only")!;
      const weightsOnly = result.variants.find((v) => v.key === "weights-only")!;
      const equal = result.variants.find((v) => v.key === "equal")!;

      const row = {
        config: cfg.key,
        label: cfg.label,
        bands: `${result.tuned.entry}/${result.tuned.exit}`,
        trials: result.trials,
        // Raw-Sharpe bar. Reported for continuity — it is NOT the bar the search's
        // objective is judged against; see luckExcessBar / clearsExcessBar.
        luckBar: result.luckSharpe,
        luckExcessBar: result.luckExcessSharpe,
        returnCorr: round(result.returnCorrelation),
        clearsExcessBar: tuned.test.meanExcessSharpe > result.luckExcessSharpe,
        trainSharpe: round(tuned.train.meanSharpe),
        testSharpe: round(tuned.test.meanSharpe),
        testExcessSharpe: round(tuned.test.meanExcessSharpe),
        testCagr: round(tuned.test.meanCagr),
        benchSharpe: round(tuned.test.meanBenchmarkSharpe),
        benchMaxDD: round(tuned.test.meanBenchmarkMaxDrawdownPct),
        testMaxDD: round(tuned.test.meanMaxDrawdownPct),
        testTrades: round(tuned.test.meanTrades, 1),
        testWinRate: round(tuned.test.meanWinRate, 0),
        testExposure: round(tuned.test.meanExposurePct, 0),
        priorTestSharpe: round(priorRun.test.meanSharpe),
        priorTestExcess: round(priorRun.test.meanExcessSharpe),
        priorTestCagr: round(priorRun.test.meanCagr),
        distTrain: `${result.distribution.train.p10}/${result.distribution.train.p50}/${result.distribution.train.p90}`,
        distTest: `${result.distribution.test.p10}/${result.distribution.test.p50}/${result.distribution.test.p90}`,
        bandsOnlyTestSharpe: round(bandsOnly.test.meanSharpe),
        weightsOnlyTestSharpe: round(weightsOnly.test.meanSharpe),
        equalTestSharpe: round(equal.test.meanSharpe),
        trainTo: result.trainTo,
        ms: Date.now() - started,
        topWeights: Object.entries(result.weights)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id, w]) => `${id}=${w}`),
        perSymbolTest: tuned.perSymbol
          .map(
            (s) =>
              `${s.symbol}: x${round(s.test.sharpe - s.buyHoldTestSharpe)} / ${round(s.test.totalReturnPct, 0)}% / ` +
              `${round(s.test.maxDrawdownPct, 0)}dd / ${s.test.trades}t (bh ${round(s.buyHoldTestSharpe)}, ${round(s.buyHoldTestPct, 0)}%)`
          )
          .join("\n  "),
        axes: result.searchUnits
          .filter((u) => u.prior !== u.tuned)
          .map((u) => `${u.key}:${u.prior}->${u.tuned}`)
          .join(" "),
      };
      summary.push(row);
      runs.push({ cfg, result });
      console.log("\n" + JSON.stringify(row, null, 2));
    }

    const testSharpes = summary.map((r) => (r as { testSharpe: number }).testSharpe);
    console.log("\nTest Sharpes across settings:", testSharpes.join(" | "));
    console.log("Median test Sharpe:", median(testSharpes));

    // The bar that matters is the one for the measure the search maximizes. Each
    // row carries both; this line counts who clears the EXCESS bar, and states the
    // correlation that separates the two scales.
    const clears = summary.filter((r) => (r as { clearsExcessBar: boolean }).clearsExcessBar).length;
    console.log(
      `\nHeld-out EXCESS Sharpe vs its own luck bar: ${clears}/${summary.length} setting(s) clear it.` +
        `\n  (each row also prints luckBar, but that one is on the raw-Sharpe scale — a raw Sharpe can sit above it` +
        `\n   while the excess over buy & hold is negative, which is why it does not decide anything here.)`
    );

    // ── Do the weights depend on where the search starts? ──────
    // If a run that starts from a flat average converges to the same heavy
    // indicators, the answer is a property of the data, not of the prior.
    const starts: Array<{ key: string; prior: Record<string, number> }> = [
      { key: "from-defaults", prior },
      { key: "from-equal", prior: equalWeights(frames) },
    ];
    for (const start of starts) {
      const res = trainMegaWeights(frames, start.prior, { passes: 2, trainFraction: 0.7 });
      const tuned = res.variants.find((v) => v.key === "tuned")!;
      const priorRun = res.variants.find((v) => v.key === "prior")!;
      const wins = tuned.perSymbol.filter(
        (s) => s.test.sharpe - s.buyHoldTestSharpe > priorRun.perSymbol.find((p) => p.symbol === s.symbol)!.test.sharpe -
          priorRun.perSymbol.find((p) => p.symbol === s.symbol)!.buyHoldTestSharpe
      ).length;
      console.log(
        `\nSTART ${start.key}\n` +
          JSON.stringify(
            {
              bands: `${res.tuned.entry}/${res.tuned.exit}`,
              testExcess: round(tuned.test.meanExcessSharpe),
              priorExcess: round(priorRun.test.meanExcessSharpe),
              symbolsTunedBeatsPrior: `${wins}/${tuned.perSymbol.length}`,
              topShares: Object.entries(res.weights)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([id, w]) => `${id}=${w}`),
            },
            null,
            2
          )
      );
    }

    // ── Are the weights load-bearing, or is it all the bands? ──
    // Same trained bands, three weight maps. If the flat average matches the
    // balanced blend, the weights are cosmetic and only the bands matter.
    const split = splitIndex(frames, 0.7);
    const evalOpts = { split, costs: { commissionBps: 2, slippageBps: 2 }, minTrades: 4 };
    // The shipped baseline bands, so this compares weights only.
    const tunedBands = { entry: MEGA_BASELINE.entry, exit: MEGA_BASELINE.exit };
    for (const [label, weights] of [
      ["balanced (app defaults)", prior],
      ["equal weights", equalWeights(frames)],
      ["RSI only", { "ta-rsi-14": 1 }],
    ] as Array<[string, Record<string, number>]>) {
      const v = evaluateVariant(frames, weights, tunedBands.entry, tunedBands.exit, evalOpts);
      console.log(
        `\nWEIGHTS ${label} @ ${tunedBands.entry}/${tunedBands.exit}: ` +
          JSON.stringify({
            testSharpe: round(v.test.meanSharpe),
            testExcess: round(v.test.meanExcessSharpe),
            trades: round(v.test.meanTrades, 1),
            winRate: round(v.test.meanWinRate, 0),
          })
      );
    }

    // ── A/B the weight moves the primary run actually proposed ──
    // Derived from this run's own search result, never hand-copied: the probe is
    // the prior plus the axis moves the 70/30 run chose, and each one has to
    // survive the OTHER splits, not just the one that found it. (0.7 is skipped
    // for that reason — the probe was fitted there.)
    //
    // This block previously hard-coded the moves an older calibration proposed
    // (trend 4→1, ATR 4→3, CCI 3→1, vol 1→0.5). Once those values were adopted
    // into DEFAULT_WEIGHTS the probe became byte-identical to the prior, so the
    // A/B compared the shipped weight map with itself and printed a perfect tie
    // — and that tie was then read as "the proposed tweaks are inert". It now
    // derives the probe and refuses to present a self-comparison as evidence.
    const primary = runs.find((r) => r.cfg.key === "std-70")!;
    const moved = primary.result.searchUnits.filter((u) => u.tuned !== u.prior);
    const probe: Record<string, number> = { ...prior };
    for (const u of moved) for (const id of u.ids) probe[id] = u.tuned;
    /** What a map actually gives an id: the map, else the frame default. */
    const effectivePrior = (id: string): number => prior[id] ?? frames[0].defaults[id] ?? 0;
    const probeChangesSomething = moved.some((u) =>
      u.ids.some((id) => effectivePrior(id) !== u.tuned)
    );

    console.log(
      `\nAB probe from ${primary.cfg.label}: ${moved.length} moved axis/axes` +
        (moved.length ? ` — ${moved.map((u) => `${u.key}:${u.prior}->${u.tuned}`).join(" ")}` : "") +
        (moved.length ? "" : " (the search proposed no move, so there is nothing to A/B)")
    );
    if (moved.length > 0 && !probeChangesSomething) {
      // A reported move that leaves the map unchanged would make the A/B below a
      // self-comparison again. That is a defect, not a result — fail loudly.
      throw new Error(
        "A/B probe is identical to the prior weight map despite reported axis moves — the A/B would be comparing the map with itself."
      );
    }

    if (probeChangesSomething) {
      for (const frac of [0.6, 0.8]) {
        const sp = splitIndex(frames, frac);
        const o = { split: sp, costs: { commissionBps: 2, slippageBps: 2 }, minTrades: 4 };
        // Bands held at the shipped baseline so this isolates the weights.
        const a = evaluateVariant(frames, prior, MEGA_BASELINE.entry, MEGA_BASELINE.exit, o);
        const b = evaluateVariant(frames, probe, MEGA_BASELINE.entry, MEGA_BASELINE.exit, o);
        const wins = b.perSymbol.filter(
          (s) =>
            s.test.sharpe - s.buyHoldTestSharpe >
            a.perSymbol.find((p) => p.symbol === s.symbol)!.test.sharpe -
              a.perSymbol.find((p) => p.symbol === s.symbol)!.buyHoldTestSharpe
        ).length;
        console.log(
          `\nAB proposed moves @ ${Math.round(frac * 100)}% train, bands held at ${MEGA_BASELINE.entry}/${MEGA_BASELINE.exit}: ` +
            JSON.stringify({
              priorExcess: round(a.test.meanExcessSharpe),
              probeExcess: round(b.test.meanExcessSharpe),
              priorSharpe: round(a.test.meanSharpe),
              probeSharpe: round(b.test.meanSharpe),
              probeBeatsPriorOn: `${wins}/${b.perSymbol.length}`,
            })
        );
      }
    }

    // ── Final band choice under the proposed weights ───────────
    // The candidate map here is the primary run's proposal (`probe`), or the prior
    // itself when the search proposed no move — so this grid always grades a map
    // that actually came out of this run.
    const cells: Array<[number, number]> = [[65, 35], [70, 27.5], [75, 27.5], [75, 25], [70, 25], [65, 25]];
    for (const frac of [0.6, 0.7, 0.8]) {
      const sp = splitIndex(frames, frac);
      const o = { split: sp, costs: { commissionBps: 2, slippageBps: 2 }, minTrades: 4 };
      const line = cells.map(([e, x]) => {
        const v = evaluateVariant(frames, probe, e, x, o);
        return `${e}/${x}: T${round(v.train.meanExcessSharpe)} S${round(v.test.meanExcessSharpe)} (${round(v.test.meanTrades, 1)}t ${round(v.test.meanWinRate, 0)}wr)`;
      });
      console.log(`\nBANDS @ ${Math.round(frac * 100)}% train — ` + line.join("  ·  "));
    }

    // ── Is the trained band a plateau or a spike? ─────────────
    // A narrow optimum means the band search memorised this history.
    console.log("\nBAND SENSITIVITY (balanced weights) — entry/exit: trainExcess | testExcess");
    for (const entry of [55, 60, 65, 70, 75, 80]) {
      const row: string[] = [];
      for (const exit of [20, 27.5, 35, 45]) {
        const v = evaluateVariant(frames, prior, entry, exit, evalOpts);
        row.push(
          `${entry}/${exit}: ${round(v.train.meanExcessSharpe)} | ${round(v.test.meanExcessSharpe)} ` +
            `(${round(v.test.meanTrades, 1)}t, ${round(v.test.meanWinRate, 0)}%wr)`
        );
      }
      console.log("  " + row.join("  ·  "));
    }

    expect(summary.length).toBe(CONFIGS.length);
  }, 600_000);
});

function round(v: number, d = 2): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
