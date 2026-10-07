// Per-indicator "formula" overrides for the Mega Indicator.
//
// Every Mega indicator turns a raw value into a 0-100 health score using a
// formula of (direction, thresholds) — see normalizeScore() in mega-indicator.ts.
// The UI lets the user right-click an indicator to tweak that formula (and its
// weight) without editing code. This module holds the pure logic so it can be
// unit-tested and reused by both the UI and the backtest overlay.
//
// Keeping it pure (no React) means the exact same code path is exercised by the
// tests as by the app.

import { normalizeScore, type Direction, type IndicatorSpec } from "./mega-indicator";

export const LS_MEGA_OVERRIDES = "mega-indicator:overrides:v1";

/** A user edit to one indicator's scoring formula. Missing fields = keep base. */
export interface ScoreOverride {
  direction?: Direction;
  thresholds?: [number, number];
}

/** indicator id -> formula override. */
export type ScoreOverrideMap = Record<string, ScoreOverride>;

/** Minimal shape needed to normalize a raw value into a score. */
export interface ScoringFormula {
  direction: Direction;
  thresholds: [number, number];
}

function isFinitePair(t: unknown): t is [number, number] {
  return (
    Array.isArray(t) &&
    t.length === 2 &&
    Number.isFinite(Number(t[0])) &&
    Number.isFinite(Number(t[1]))
  );
}

function isDirection(v: unknown): v is Direction {
  return v === "higher" || v === "lower" || v === "band";
}

/** Merge a base formula with a user override; invalid parts fall back to base. */
export function mergeFormula(base: ScoringFormula, override?: ScoreOverride): ScoringFormula {
  if (!override) return { direction: base.direction, thresholds: [base.thresholds[0], base.thresholds[1]] };
  return {
    direction: isDirection(override.direction) ? override.direction : base.direction,
    thresholds: isFinitePair(override.thresholds)
      ? [Number(override.thresholds[0]), Number(override.thresholds[1])]
      : [base.thresholds[0], base.thresholds[1]],
  };
}

/** Normalize a raw value to 0-100 using the base formula plus any override. */
export function scoreWithOverride(value: number, base: ScoringFormula, override?: ScoreOverride): number {
  const merged = mergeFormula(base, override);
  // normalizeScore only reads direction + thresholds from the spec.
  return normalizeScore(value, merged as unknown as IndicatorSpec);
}

/** True when the override actually changes the formula away from the base. */
export function isFormulaChanged(base: ScoringFormula, override?: ScoreOverride): boolean {
  if (!override) return false;
  const m = mergeFormula(base, override);
  return (
    m.direction !== base.direction ||
    m.thresholds[0] !== base.thresholds[0] ||
    m.thresholds[1] !== base.thresholds[1]
  );
}

/** Drop invalid / empty entries so corrupted storage can never break the page. */
export function sanitizeOverrides(raw: unknown): ScoreOverrideMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ScoreOverrideMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const override: ScoreOverride = {};
    if (isDirection(rec.direction)) override.direction = rec.direction;
    if (isFinitePair(rec.thresholds)) {
      override.thresholds = [Number(rec.thresholds[0]), Number(rec.thresholds[1])];
    }
    if (Object.keys(override).length > 0) out[id] = override;
  }
  return out;
}

/** Apply a partial edit to one indicator, returning a new map (never mutates). */
export function setOverride(map: ScoreOverrideMap, id: string, patch: ScoreOverride): ScoreOverrideMap {
  const merged = { ...(map[id] || {}), ...patch };
  const clean = sanitizeOverrides({ [id]: merged });
  const next = { ...map };
  if (clean[id]) next[id] = clean[id];
  else delete next[id];
  return next;
}

/** Remove one indicator's override. */
export function clearOverride(map: ScoreOverrideMap, id: string): ScoreOverrideMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Human label for a formula, e.g. "higher ≥ 0.05" or "band 35 – 65". */
export function formulaLabel(f: ScoringFormula): string {
  const [a, b] = f.thresholds;
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""));
  if (f.direction === "higher") return `higher: ${n(a)} → ${n(b)}`;
  if (f.direction === "lower") return `lower: ${n(a)} → ${n(b)}`;
  return `band: ${n(a)} – ${n(b)}`;
}

export function loadOverrides(): ScoreOverrideMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LS_MEGA_OVERRIDES);
    if (!raw) return {};
    return sanitizeOverrides(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveOverrides(map: ScoreOverrideMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_MEGA_OVERRIDES, JSON.stringify(map));
  } catch {
    /* storage unavailable — ignore */
  }
}
