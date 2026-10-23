// ─── Analytics configuration ───────────────────────────────────────────────
//
// One JSON object in app_settings under `analytics.config`, so the numbers on
// every analytics screen are reproducible and the user can see their own
// assumptions (benchmark, risk-free rate, MAR, target weights, tags, goal).
// Parsing is defensive: a partially written or hand-edited row falls back to
// defaults field by field instead of breaking the screen.

import { getSetting, setSetting } from "../db";

export interface GoalConfig {
  monthlyContribution: number;
  years: number;
  expectedReturnPct: number;
  inflationPct: number;
  target: number | null;
}

export interface AnalyticsConfig {
  benchmark: string;
  /** Annual risk-free rate in %, used by Sharpe/Treynor/Martin. */
  riskFreePct: number;
  /** Annual minimum acceptable return in %, used by Sortino. */
  marPct: number;
  /** Years of history to analyse. */
  years: number;
  /** Single-position concentration guardrail, in %. */
  maxWeightPct: number;
  /** Group targets in % (tags like "Technology", "Bonds", "Cash"). */
  targets: Record<string, number>;
  /** symbol → group, used for allocation drift and grouped contribution. */
  tags: Record<string, string>;
  goal: GoalConfig;
}

export const DEFAULT_CONFIG: AnalyticsConfig = {
  benchmark: "SPY",
  riskFreePct: 4,
  marPct: 0,
  years: 5,
  maxWeightPct: 25,
  targets: {},
  tags: {},
  goal: {
    monthlyContribution: 500,
    years: 10,
    expectedReturnPct: 7,
    inflationPct: 2.5,
    target: null,
  },
};

const SETTING_KEY = "analytics.config";

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** Merge a stored config with defaults, clamping every numeric field. */
export function normaliseConfig(raw: unknown): AnalyticsConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const goalRaw = (r.goal && typeof r.goal === "object" ? r.goal : {}) as Record<string, unknown>;
  const targetsRaw = (r.targets && typeof r.targets === "object" ? r.targets : {}) as Record<string, unknown>;
  const tagsRaw = (r.tags && typeof r.tags === "object" ? r.tags : {}) as Record<string, unknown>;

  const targets: Record<string, number> = {};
  for (const [k, v] of Object.entries(targetsRaw)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) targets[k] = v;
  }
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(tagsRaw)) {
    if (typeof v === "string" && v.trim()) tags[k.toUpperCase()] = v.trim();
  }

  return {
    benchmark: typeof r.benchmark === "string" && r.benchmark.trim() ? r.benchmark.trim().toUpperCase() : DEFAULT_CONFIG.benchmark,
    riskFreePct: num(r.riskFreePct, DEFAULT_CONFIG.riskFreePct, -10, 30),
    marPct: num(r.marPct, DEFAULT_CONFIG.marPct, -30, 50),
    years: Math.round(num(r.years, DEFAULT_CONFIG.years, 1, 20)),
    maxWeightPct: num(r.maxWeightPct, DEFAULT_CONFIG.maxWeightPct, 1, 100),
    targets,
    tags,
    goal: {
      monthlyContribution: num(goalRaw.monthlyContribution, DEFAULT_CONFIG.goal.monthlyContribution, 0, 1_000_000),
      years: Math.round(num(goalRaw.years, DEFAULT_CONFIG.goal.years, 1, 50)),
      expectedReturnPct: num(goalRaw.expectedReturnPct, DEFAULT_CONFIG.goal.expectedReturnPct, -20, 30),
      inflationPct: num(goalRaw.inflationPct, DEFAULT_CONFIG.goal.inflationPct, 0, 20),
      target:
        typeof goalRaw.target === "number" && Number.isFinite(goalRaw.target) && goalRaw.target > 0
          ? goalRaw.target
          : null,
    },
  };
}

export function loadConfig(): AnalyticsConfig {
  try {
    const raw = getSetting(SETTING_KEY);
    return normaliseConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(patch: unknown): AnalyticsConfig {
  const current = loadConfig();
  const p = (patch && typeof patch === "object" ? patch : {}) as Partial<AnalyticsConfig>;
  // Deep-ish merge: a PUT of just `{ riskFreePct }` must not wipe the user's
  // target weights or symbol tags.
  const merged = normaliseConfig({
    ...current,
    ...p,
    goal: { ...current.goal, ...(p.goal ?? {}) },
    targets: { ...current.targets, ...(p.targets ?? {}) },
    tags: { ...current.tags, ...(p.tags ?? {}) },
  });
  setSetting(SETTING_KEY, JSON.stringify(merged));
  return merged;
}
