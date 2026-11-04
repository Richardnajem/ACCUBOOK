// ─── Forward-return study for the fundamentals composite ─────────────────────
//
// QUESTION: does `scoreCompany`'s 0-100 composite say anything about the NEXT 12
// months? The technical composite has been measured and failed (AGENTS.md), but
// the fundamental one has never been tested. This module is the measurement, not
// a model: it builds point-in-time observations and describes them.
//
// Three rules, because a study like this is easy to ruin:
//
//   1. **No look-ahead.** A fiscal year's score is readable only once its 10-K is
//      public. `publicDate` uses the row's exact filing date when the caller has
//      one, and otherwise the statutory deadline (period end + 90 days). The
//      app's `AnnualRow` does not carry a filing date, so the default path takes
//      the later, conservative date: no observation enters before it could have.
//   2. **The baseline is the cohort, not zero.** A 12-month window in a rising
//      market makes every score bucket look profitable. Excess is measured
//      against the equal-weight mean of the observations that were readable in
//      the SAME calendar year.
//   3. **The sample size is printed with the result.** Annual filings give one
//      observation per symbol-year, so 30 symbols × 10 years is ~300 points —
//      enough to see a strong effect, nowhere near enough to resolve a weak one.
//      The luck band in `compareScores` is what says so.
//
// One known limitation, stated rather than hidden: prior-year rows may contain
// later restatements, so a small share of the *inputs* can be newer than the
// observation's public date. The outcome (the forward return) is always measured
// strictly after it. `AnnualRow` drops the per-metric filing dates that would let
// this be filtered exactly.

import type { AnnualRow } from "./research";
import { scoreCompany } from "./analytics/scoring";

export interface PriceBar {
  date: string;
  close: number;
}

/** Statutory 10-K deadline used when no exact filing date is known. */
export const FILING_LAG_DAYS = 90;
/** The horizon under test: one year, in calendar days. */
export const FORWARD_DAYS = 365;
/** Piotroski and the trend tests need the current year plus two priors. */
export const MIN_STATEMENT_YEARS = 3;

const DAY_MS = 86_400_000;
const toTime = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const t = toTime(date);
  return Number.isFinite(t) ? iso(t + days * DAY_MS) : "";
}

/**
 * When a fiscal year's numbers were first readable by the public.
 * An exact `filed` date wins; otherwise the period end + 90 days, which is later
 * than a large accelerated filer's 60-day deadline — the bias runs against the
 * score, never for it.
 */
export function publicDate(periodEnd: string, filed?: string | null): string | null {
  if (filed && Number.isFinite(toTime(filed))) return filed;
  if (!periodEnd || !Number.isFinite(toTime(periodEnd))) return null;
  return addDays(periodEnd, FILING_LAG_DAYS);
}

/** First session on or after an ISO date. `bars` must be sorted ascending. */
export function firstBarAtOrAfter(bars: PriceBar[], date: string): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < bars.length ? lo : -1;
}

/**
 * The move from `entryIndex` to the first session at or after `horizonDays`
 * later. Null when the cached history ends before the window closes — an open
 * window is not a return and must not be counted as one.
 */
export function forwardReturn(
  bars: PriceBar[],
  entryIndex: number,
  horizonDays = FORWARD_DAYS
): { pct: number; bars: number; exitDate: string } | null {
  if (entryIndex < 0 || entryIndex >= bars.length) return null;
  const entry = bars[entryIndex];
  if (!(entry.close > 0)) return null;
  const target = addDays(entry.date, horizonDays);
  if (!target) return null;
  const exitIndex = firstBarAtOrAfter(bars, target);
  if (exitIndex <= entryIndex) return null;
  const exit = bars[exitIndex];
  if (!(exit.close > 0)) return null;
  return { pct: (exit.close / entry.close - 1) * 100, bars: exitIndex - entryIndex, exitDate: exit.date };
}

export interface PointInTimeScore {
  symbol: string;
  fy: number;
  periodEnd: string;
  /** The first date the score could have been read. */
  knownFrom: string;
  score: number;
  compositeBasis: string;
  /** Session actually used to enter, and its close. */
  entryDate: string | null;
  entryClose: number | null;
  /** 12-month move; null when the window is incomplete. */
  forwardReturnPct: number | null;
  forwardBars: number | null;
}

export interface SkippedYear {
  fy: number;
  reason: string;
}

/**
 * Score every fiscal year of one company from the statements that were public at
 * the time, then attach the 12-month move that followed.
 *
 * Market cap is rebuilt as `price on entry × shares outstanding in that year's
 * filing` rather than today's market cap: a Z-score computed against today's cap
 * would be a different company's score.
 */
export function buildPointInTimeScores(
  symbol: string,
  annual: AnnualRow[],
  bars: PriceBar[],
  options: { horizonDays?: number } = {}
): { observations: PointInTimeScore[]; skipped: SkippedYear[] } {
  const horizon = options.horizonDays ?? FORWARD_DAYS;
  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const observations: PointInTimeScore[] = [];
  const skipped: SkippedYear[] = [];

  for (let i = 0; i < annual.length; i++) {
    const row = annual[i];
    if (!row?.end) {
      skipped.push({ fy: row?.fy ?? 0, reason: "no period end" });
      continue;
    }
    if (annual.length - i < MIN_STATEMENT_YEARS) {
      skipped.push({
        fy: row.fy,
        reason: `only ${annual.length - i} statement year(s) left (needs ${MIN_STATEMENT_YEARS})`,
      });
      continue;
    }
    const filed = (row as AnnualRow & { filed?: string | null }).filed ?? null;
    const knownFrom = publicDate(row.end, filed);
    if (!knownFrom) {
      skipped.push({ fy: row.fy, reason: "unreadable period end" });
      continue;
    }
    const entryIndex = firstBarAtOrAfter(sorted, knownFrom);
    if (entryIndex < 0) {
      skipped.push({ fy: row.fy, reason: `no cached session on/after ${knownFrom}` });
      continue;
    }
    const entry = sorted[entryIndex];
    const shares = row.sharesOutstanding;
    const marketCap =
      entry.close > 0 && typeof shares === "number" && shares > 0 ? entry.close * shares : null;

    const scored = scoreCompany(annual.slice(i), marketCap, entry.close);
    if (scored.composite === null) {
      skipped.push({ fy: row.fy, reason: "composite unavailable (too few scored inputs)" });
      continue;
    }

    const fwd = forwardReturn(sorted, entryIndex, horizon);
    observations.push({
      symbol,
      fy: row.fy,
      periodEnd: row.end,
      knownFrom,
      score: scored.composite,
      compositeBasis: scored.compositeBasis,
      entryDate: entry.date,
      entryClose: entry.close,
      forwardReturnPct: fwd ? fwd.pct : null,
      forwardBars: fwd ? fwd.bars : null,
    });
  }

  return { observations, skipped };
}

// ─── Statistics ─────────────────────────────────────────────────────────────

const nz = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function quantileOf(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return NaN;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sortedValues[lo] : sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/**
 * Mann-Whitney style separation: the chance that a randomly chosen observation
 * with a better forward return also had the higher score. 0.5 = no separation,
 * which is what an uninformative score produces.
 *
 * Pairs with equal forward returns are dropped: a tie says nothing about which
 * reading was better. Observations sharing a score still count 0.5.
 */
export function auc(points: Array<{ score: number; ret: number }>): number | null {
  let wins = 0;
  let pairs = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      if (a.ret === b.ret) continue;
      const better = a.ret > b.ret ? a : b;
      const worse = a.ret > b.ret ? b : a;
      pairs++;
      if (better.score > worse.score) wins += 1;
      else if (better.score === worse.score) wins += 0.5;
    }
  }
  return pairs > 0 ? wins / pairs : null;
}

/**
 * The AUC a score with NO information would produce at this sample size.
 * Hanley–McNeil with two equal groups: SE ≈ √((n+1) / (3n²)). An AUC inside this
 * band is indistinguishable from a coin flip, and that is the only luck bar this
 * study claims — it is not adjusted for trying several buckets afterwards.
 */
export function luckBand(n: number): { low: number; high: number; se: number } {
  const se = n > 4 ? Math.sqrt((n + 1) / (3 * n * n)) : 0;
  return { low: 0.5 - 1.96 * se, high: 0.5 + 1.96 * se, se };
}

function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const rank = (i + j) / 2 + 1; // average rank across ties
    for (let k = i; k <= j; k++) out[order[k].i] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation; ties get average ranks. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

export interface StudyRow {
  symbol: string;
  fy: number;
  knownFrom: string;
  score: number;
  forwardReturnPct: number;
}

export interface BucketReport {
  label: string;
  from: number;
  to: number;
  n: number;
  meanPct: number;
  medianPct: number;
  winRate: number;
  /** Mean forward return minus the same observation's cohort mean. */
  meanExcessPct: number;
}

export interface SymbolReport {
  symbol: string;
  n: number;
  meanScore: number;
  meanPct: number;
  /** Score vs forward return inside this symbol alone (needs ≥3 years). */
  ic: number | null;
}

export interface ForwardStudyReport {
  n: number;
  symbols: number;
  cohorts: number;
  years: { from: string; to: string };
  meanPct: number;
  buckets: BucketReport[];
  /** Top bucket minus bottom bucket, percentage points. */
  spreadPct: number;
  rawAuc: number | null;
  /** Separation after each symbol's own average year is removed. */
  withinSymbolAuc: number | null;
  luck: { low: number; high: number; se: number } | null;
  cohortIc: Array<{ year: string; n: number; ic: number }>;
  meanIc: number | null;
  icPositiveShare: number | null;
  icT: number | null;
  perSymbol: SymbolReport[];
  clears: { auc: boolean; ic: boolean; overall: boolean; reason: string };
}

/**
 * Describe the sample by score bucket and measure whether any ordering survives.
 *
 * Two independent reads, both required for `clears.overall`:
 *   - **pooled AUC** outside its luck band (does a higher score raise the odds of
 *     a better year across everything), and
 *   - **cross-sectional IC** with a t-stat of at least 2 and a positive sign in
 *     most cohorts (does the ordering repeat within the years, which is the only
 *     version of the claim that is not just "the sample drifted up").
 *
 * Requiring both is deliberate: a single pooled AUC is exactly the statistic that
 * flatters an uninformative score whenever the whole sample happens to rise.
 */
export function compareScores(
  rows: StudyRow[],
  options: { buckets?: number; minCohort?: number } = {}
): ForwardStudyReport | null {
  const usable = rows.filter((r) => nz(r.score) && nz(r.forwardReturnPct));
  if (usable.length < 10) return null;

  const bucketCount = Math.max(2, options.buckets ?? 5);
  const minCohort = Math.max(4, options.minCohort ?? 8);

  // Cohort = the calendar year the score became readable, so every excess is
  // against names judged on the same market.
  const byCohort = new Map<string, StudyRow[]>();
  for (const r of usable) {
    const key = r.knownFrom.slice(0, 4);
    const list = byCohort.get(key) ?? [];
    list.push(r);
    byCohort.set(key, list);
  }
  const cohortMean = new Map<string, number>();
  for (const [key, list] of byCohort) {
    cohortMean.set(key, list.reduce((s, r) => s + r.forwardReturnPct, 0) / list.length);
  }
  const excessOf = (r: StudyRow) => r.forwardReturnPct - (cohortMean.get(r.knownFrom.slice(0, 4)) ?? 0);

  // Buckets are quintiles of the observed scores, not fixed 0-20 bands: the
  // composite clusters, and fixed bands would leave some buckets empty.
  const sortedScores = usable.map((r) => r.score).sort((a, b) => a - b);
  const edges: number[] = [];
  for (let b = 1; b < bucketCount; b++) edges.push(quantileOf(sortedScores, b / bucketCount));

  const bucketOf = (score: number): number => {
    let k = 0;
    while (k < edges.length && score > edges[k]) k++;
    return Math.min(bucketCount - 1, k);
  };

  const grouped: StudyRow[][] = Array.from({ length: bucketCount }, () => []);
  for (const r of usable) grouped[bucketOf(r.score)].push(r);

  // A bucket can come out empty when the composite clusters (or when only a few
  // distinct scores exist). Empty buckets are dropped rather than printed as a
  // row of NaN, and the surviving ones are re-labelled in order.
  const buckets: BucketReport[] = grouped.filter((list) => list.length > 0).map((list, i) => {
    const rets = list.map((r) => r.forwardReturnPct).sort((a, b) => a - b);
    const meanPct = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : NaN;
    return {
      label: `Q${i + 1}`,
      from: list.length ? Math.min(...list.map((r) => r.score)) : edges[i - 1] ?? 0,
      to: list.length ? Math.max(...list.map((r) => r.score)) : edges[i] ?? 100,
      n: list.length,
      meanPct,
      medianPct: quantileOf(rets, 0.5),
      winRate: rets.length ? rets.filter((v) => v > 0).length / rets.length : NaN,
      meanExcessPct: list.length ? list.reduce((s, r) => s + excessOf(r), 0) / list.length : NaN,
    };
  });

  const rawAuc = auc(usable.map((r) => ({ score: r.score, ret: r.forwardReturnPct })));

  const symbolMean = new Map<string, number>();
  for (const [symbol, list] of groupBy(usable, (r) => r.symbol)) {
    symbolMean.set(symbol, list.reduce((s, r) => s + r.forwardReturnPct, 0) / list.length);
  }
  const withinSymbolAuc = auc(
    usable.map((r) => ({ score: r.score, ret: r.forwardReturnPct - (symbolMean.get(r.symbol) ?? 0) }))
  );

  const cohortIc: Array<{ year: string; n: number; ic: number }> = [];
  for (const [year, list] of [...byCohort.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length < minCohort) continue;
    const ic = spearman(list.map((r) => r.score), list.map((r) => r.forwardReturnPct));
    if (ic !== null) cohortIc.push({ year, n: list.length, ic });
  }
  const meanIc = cohortIc.length ? cohortIc.reduce((s, c) => s + c.ic, 0) / cohortIc.length : null;
  const icPositiveShare = cohortIc.length
    ? cohortIc.filter((c) => c.ic > 0).length / cohortIc.length
    : null;
  let icT: number | null = null;    if (meanIc !== null && cohortIc.length >= 3) {
    const sd = Math.sqrt(
      cohortIc.reduce((s, c) => s + (c.ic - meanIc) ** 2, 0) / (cohortIc.length - 1)
    );
    // Identical positive ICs in every cohort have no between-cohort variance, so
    // the t-statistic is unbounded rather than undefined. Reporting null there
    // would make perfect consistency fail the bar.
    icT = sd > 0 ? meanIc / (sd / Math.sqrt(cohortIc.length)) : meanIc !== 0 ? Number.POSITIVE_INFINITY : 0;
  }

  const luck = luckBand(usable.length);
  const aucClears = rawAuc !== null && rawAuc > luck.high;
  const icClears =
    meanIc !== null && icT !== null && icT >= 2 && (icPositiveShare ?? 0) >= 0.6;

  const reasons: string[] = [];
  if (!aucClears) {
    reasons.push(
      rawAuc === null
        ? "AUC could not be computed"
        : `pooled AUC ${rawAuc.toFixed(3)} sits inside the ${luck.low.toFixed(3)}–${luck.high.toFixed(3)} luck band`
    );
  }
  if (!icClears) {
    reasons.push(
      meanIc === null
        ? "no cohort had enough names for a cross-sectional IC"
        : `mean IC ${meanIc.toFixed(3)} with t ${icT === null ? "—" : Number.isFinite(icT) ? icT.toFixed(2) : "∞"} (needs t ≥ 2 and most cohorts positive)`
    );
  }

  return {
    n: usable.length,
    symbols: symbolMean.size,
    cohorts: byCohort.size,
    years: {
      from: usable.reduce((m, r) => (r.knownFrom < m ? r.knownFrom : m), usable[0].knownFrom),
      to: usable.reduce((m, r) => (r.knownFrom > m ? r.knownFrom : m), usable[0].knownFrom),
    },
    meanPct: usable.reduce((s, r) => s + r.forwardReturnPct, 0) / usable.length,
    buckets,
    spreadPct: buckets[buckets.length - 1].meanPct - buckets[0].meanPct,
    rawAuc,
    withinSymbolAuc,
    luck,
    cohortIc,
    meanIc,
    icPositiveShare,
    icT,
    perSymbol: [...groupBy(usable, (r) => r.symbol).entries()]
      .map(([symbol, list]) => ({
        symbol,
        n: list.length,
        meanScore: list.reduce((s, r) => s + r.score, 0) / list.length,
        meanPct: list.reduce((s, r) => s + r.forwardReturnPct, 0) / list.length,
        ic: list.length >= 3 ? spearman(list.map((r) => r.score), list.map((r) => r.forwardReturnPct)) : null,
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    clears: { auc: aucClears, ic: icClears, overall: aucClears && icClears, reason: reasons.join("; ") },
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}
