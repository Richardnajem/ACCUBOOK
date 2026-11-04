// Live forward-return study — fundamentals composite, REAL SEC + price data.
//
//   npm run test:fundamentals
//
// That script sets FUNDAMENTALS_LIVE=1 and passes --disableConsoleIntercept;
// without the flag Vitest captures console and the whole report is invisible, so
// a run "passes" having shown nobody anything.
//
// Skipped in `npm test`: it hits SEC companyfacts and the price sources, and a
// full universe takes minutes. Its job is NOT to assert that the composite
// predicts anything — the question is open. It prints the measurement a human
// then records in AGENTS.md. What it must never do is quietly cheat, and those
// rules (no look-ahead, cohort baseline, two independent reads) are pinned on
// synthetic data in tests/fundamentals-forward.test.ts.
//
// Optional:
//   FUNDAMENTALS_UNIVERSE="JNJ,PG,KO,…"
//   FUNDAMENTALS_YEARS=15          price history to load
//   FUNDAMENTALS_ANNUAL_YEARS=20   fiscal years of statements to rebuild

import { describe, it, expect } from "vitest";
import { buildAnnualStatements, fetchCompanyFacts } from "../src/lib/research";
import {
  buildPointInTimeScores,
  compareScores,
  type StudyRow,
} from "../src/lib/fundamentals-forward";
import { getDailyBars } from "../src/lib/market-data";

const LIVE = process.env.FUNDAMENTALS_LIVE === "1";

/** Long-lived US filers across sectors; the study needs history, not ideas. */
const UNIVERSE = (
  process.env.FUNDAMENTALS_UNIVERSE ??
  "AAPL,MSFT,GOOGL,AMZN,META,NVDA,INTC,CSCO,ORCL,IBM,TXN,ADBE," +
    "JNJ,PFE,MRK,ABT,UNH,PG,KO,PEP,WMT,COST,TGT,HD,LOW,MCD,SBUX,NKE,DIS,MMM," +
    "CAT,BA,GE,F,GM,JPM,BAC,WFC,GS,CVX,XOM"
)
  .split(/[\s,;]+/)
  .filter(Boolean);

const PRICE_YEARS = Number(process.env.FUNDAMENTALS_YEARS ?? 15);
const ANNUAL_YEARS = Number(process.env.FUNDAMENTALS_ANNUAL_YEARS ?? 20);

const sign = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
const pt = (v: number) => `${sign(v, 1)} pt`;
const table = (headers: string[], rows: string[][], widths: number[]) =>
  [
    headers.map((h, i) => h.padEnd(widths[i])).join(" "),
    ...rows.map((r) => r.map((c, i) => c.padStart(widths[i])).join(" ")),
  ].join("\n");

describe.runIf(LIVE)("fundamentals composite → 12-month forward return", () => {
  it("scores every public fiscal year and reports the buckets, AUC and IC", { timeout: 900_000 }, async () => {
    const rows: StudyRow[] = [];
    const skipped: string[] = [];
    const coverage: Array<{ symbol: string; scored: number; years: number }> = [];

    for (const symbol of UNIVERSE) {
      try {
        const facts = await fetchCompanyFacts(symbol);
        if (!facts) throw new Error("no SEC registrant (ETF, fund or non-US listing)");
        const statements = buildAnnualStatements(facts, ANNUAL_YEARS);
        if (statements.currency !== "USD") {
          throw new Error(`reports in ${statements.currency}; the score has no FX step, so it is out of scope`);
        }
        if (statements.annual.length < 4) {
          throw new Error(`only ${statements.annual.length} annual statement(s) in companyfacts`);
        }

        const { bars } = await getDailyBars(symbol, PRICE_YEARS);
        if (bars.length < 300) throw new Error(`only ${bars.length} price bar(s)`);

        const built = buildPointInTimeScores(
          symbol,
          statements.annual,
          bars.map((b) => ({ date: b.date, close: b.close }))
        );
        const usable = built.observations.filter((o) => o.forwardReturnPct !== null);
        for (const o of usable) {
          rows.push({
            symbol: o.symbol,
            fy: o.fy,
            knownFrom: o.knownFrom,
            score: o.score,
            forwardReturnPct: o.forwardReturnPct as number,
          });
        }
        coverage.push({ symbol, scored: usable.length, years: statements.annual.length });
        if (usable.length === 0) {
          skipped.push(
            `${symbol}: scored none of ${statements.annual.length} years` +
              (built.skipped[0] ? ` (${built.skipped[0].reason})` : "")
          );
        }
      } catch (e) {
        skipped.push(`${symbol}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }

    const report = compareScores(rows);
    const usableCoverage = coverage.filter((c) => c.scored > 0);

    console.log("\n=== Fundamentals composite → 12-month forward return ===");
    console.log(
      `Universe: ${UNIVERSE.length} requested · ${usableCoverage.length} scored · ` +
        `${rows.length} symbol-year observations`
    );
    console.log(
      `Price history: ${PRICE_YEARS}Y requested · statements rebuilt: up to ${ANNUAL_YEARS} fiscal years`
    );
    if (skipped.length) {
      console.log(`\nSkipped (${skipped.length}):`);
      for (const line of skipped) console.log(`  · ${line}`);
    }
    if (!report) {
      console.log("\nNot enough observations to measure anything (need ≥ 10).");
      expect(report).not.toBeNull();
      return;
    }

    console.log(
      `\nSample: ${report.n} observations · ${report.symbols} symbols · ${report.cohorts} filing-year cohorts · ` +
        `${report.years.from} → ${report.years.to}`
    );
    console.log(
      `Mean 12-month return across the whole sample: ${sign(report.meanPct)}% ` +
        "(this is the drift every bucket starts from)"
    );
    console.log(
      "Excess = that observation's return minus the equal-weight mean of its own filing-year cohort\n"
    );

    console.log(
      table(
        ["bucket", "score range", "n", "mean 12m", "median", "% up", "mean excess"],
        report.buckets.map((b) => [
          b.label,
          `${b.from.toFixed(0)}–${b.to.toFixed(0)}`,
          String(b.n),
          `${sign(b.meanPct)}%`,
          `${sign(b.medianPct)}%`,
          `${Math.round(b.winRate * 100)}%`,
          pt(b.meanExcessPct),
        ]),
        [8, 12, 5, 10, 9, 6, 12]
      )
    );
    console.log(`\nTop bucket minus bottom bucket: ${pt(report.spreadPct)}`);

    const luck = report.luck!;
    console.log("\nSeparation — chance a better year had the higher score (0.5 = none)");
    console.log(
      table(
        ["measure", "value", "read"],
        [
          [
            "pooled AUC",
            report.rawAuc === null ? "—" : report.rawAuc.toFixed(3),
            `null band ${luck.low.toFixed(3)}–${luck.high.toFixed(3)} → ` +
              (report.clears.auc ? "outside" : "inside"),
          ],
          [
            "within-symbol AUC",
            report.withinSymbolAuc === null ? "—" : report.withinSymbolAuc.toFixed(3),
            "each symbol's own average year removed",
          ],
          [
            "mean cross-sectional IC",
            report.meanIc === null ? "—" : sign(report.meanIc, 3),
            `${report.cohortIc.length} cohorts · ` +
              `${report.icPositiveShare === null ? "—" : Math.round(report.icPositiveShare * 100)}% positive · ` +
              `t ${report.icT === null ? "—" : Number.isFinite(report.icT) ? report.icT.toFixed(2) : "∞"}`,
          ],
        ],
        [24, 9, 60]
      )
    );

    if (report.cohortIc.length) {
      console.log("\nPer filing-year cohort");
      console.log(
        table(
          ["year", "names", "IC"],
          report.cohortIc.map((c) => [c.year, String(c.n), sign(c.ic, 3)]),
          [8, 7, 8]
        )
      );
    }

    const withIc = report.perSymbol.filter((s) => s.ic !== null);
    if (withIc.length) {
      const sorted = [...withIc].sort((a, b) => (b.ic as number) - (a.ic as number));
      // A small universe would otherwise print the same rows in both halves.
      const shown = [...sorted.slice(0, 5), ...sorted.slice(-5)].filter(
        (s, i, all) => all.findIndex((x) => x.symbol === s.symbol) === i
      );
      console.log("\nPer symbol — best and worst score→return ordering");
      console.log(
        table(
          ["symbol", "years", "mean score", "mean 12m", "IC"],
          shown.map((s) => [
            s.symbol,
            String(s.n),
            s.meanScore.toFixed(0),
            `${sign(s.meanPct)}%`,
            sign(s.ic as number, 3),
          ]),
          [8, 7, 12, 10, 8]
        )
      );
    }

    console.log(
      `\nVERDICT: ${report.clears.overall ? "CLEARS the bar" : "DOES NOT CLEAR the bar"}` +
        (report.clears.reason ? `\n  ${report.clears.reason}` : "")
    );
    console.log(
      "\nCaveats to carry with any number above:\n" +
        "  · One observation per symbol-year, twelve months apart — these do not overlap\n" +
        "    (unlike the Mega Indicator decile panel), but a symbol's years do share a company.\n" +
        "  · The universe is today's listed large caps: survivorship bias. Any quality score\n" +
        "    is flattered by it, so a positive result is weaker than it looks.\n" +
        "  · Prior-year inputs may include later restatements (AnnualRow carries no per-metric\n" +
        "    filing date); the outcome is always measured strictly after the public date.\n" +
        "  · Non-USD filers are excluded because the score has no FX step.\n" +
        "  · One test per run. Picking the best bucket or horizon afterwards would need a\n" +
        "    stricter bar than the one printed here.\n" +
        "  · Record the measured numbers in AGENTS.md before describing the composite as\n" +
        "    predictive, or as not predictive."
    );

    expect(rows.length).toBeGreaterThan(20);
  });
});
