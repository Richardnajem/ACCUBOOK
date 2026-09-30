// Client-side bridge to the Mega Indicator page's saved preferences.
//
// The Mega Indicator page persists the user's per-indicator weights, the chosen
// preset, and the ticker in localStorage (see mega-indicator/page.tsx). The
// backtest reuses those weights so the "Mega Score Regime" strategy and the
// price-chart overlay trade/plot the exact composite the user tuned there.
//
// Browser-only: every export guards `window` so importing this from server
// code never crashes (it just reports "nothing saved").

import type { WeightMap } from "./mega-indicator";

// Keys must match LS_* constants in dashboard/mega-indicator/page.tsx.
const LS_WEIGHTS = "mega-indicator:weights:v1";
const LS_PRESET = "mega-indicator:preset:v1";
const LS_TICKER = "mega-indicator:ticker:v1";

export type MegaPresetKey = "all" | "trend" | "momentum" | "reversal" | "smooth" | "custom";

export const MEGA_PRESET_LABELS: Record<MegaPresetKey, string> = {
  all: "⚖️ Everything (even weights)",
  trend: "🧭 Trend",
  momentum: "🚀 Momentum",
  reversal: "🔄 Mean Reversion",
  smooth: "🌊 Smooth Trends",
  custom: "✎ Custom weights",
};

export interface MegaPrefs {
  /** Saved per-indicator weights, or null when nothing usable is stored. */
  weights: WeightMap | null;
  /** Saved preset key, when it is one we know. */
  preset: MegaPresetKey | null;
  /** Ticker saved on the Mega Indicator page, if any. */
  ticker: string | null;
  /** True when the saved map actually differs from the all-ones default. */
  hasCustomWeights: boolean;
}

/** True when every weight is 1 (or missing) — i.e. the even default. */
export function isEvenWeights(w: WeightMap | null): boolean {
  if (!w) return true;
  return Object.values(w).every((v) => v === 1 || v === undefined);
}

export function loadMegaPrefs(): MegaPrefs {
  if (typeof window === "undefined") {
    return { weights: null, preset: null, ticker: null, hasCustomWeights: false };
  }
  let weights: WeightMap | null = null;
  let preset: MegaPresetKey | null = null;
  let ticker: string | null = null;

  try {
    const raw = window.localStorage.getItem(LS_WEIGHTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const clean: WeightMap = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) clean[k] = n;
        }
        if (Object.keys(clean).length > 0) weights = clean;
      }
    }
  } catch { /* corrupted — ignore */ }

  try {
    const raw = window.localStorage.getItem(LS_PRESET);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p === "string" && p in MEGA_PRESET_LABELS) preset = p as MegaPresetKey;
    }
  } catch { /* corrupted — ignore */ }

  try {
    const raw = window.localStorage.getItem(LS_TICKER);
    if (raw) {
      const t = JSON.parse(raw);
      if (typeof t === "string" && t) ticker = t;
    }
  } catch { /* corrupted — ignore */ }

  return { weights, preset, ticker, hasCustomWeights: weights !== null && !isEvenWeights(weights) };
}

/** Short human label for a saved weight map (preset name, "Custom", or default). */
export function megaWeightsLabel(prefs: MegaPrefs): string {
  if (!prefs.weights || isEvenWeights(prefs.weights)) return "Even weights (default)";
  if (prefs.preset && prefs.preset !== "all") return MEGA_PRESET_LABELS[prefs.preset];
  return MEGA_PRESET_LABELS.custom;
}

/** Weights to send to the API: null → omit (server default = even). */
export function activeMegaWeights(useCustom: boolean, prefs: MegaPrefs): WeightMap | null {
  if (!useCustom || !prefs.weights || isEvenWeights(prefs.weights)) return null;
  return prefs.weights;
}
