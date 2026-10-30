// ─── Market Circle: allocation grouped by asset class or market ─────────────
//
// The portfolio donut groups by symbol; this groups the same money into the
// buckets an investor actually thinks in. Two sources, both honest:
//
//   • **Asset class** — a label the user assigns per symbol. Nothing is inferred
//     from a ticker, because a symbol alone does not say "ETF" or "crypto"; an
//     untouched position stays `Unclassified` and is shown as such.
//   • **Market** — the live quote's currency (USD, EUR, DKK …). That is a real
//     value from the price feed, and an unknown one is named `Unknown market`
//     rather than folded into a guess.
//
// Cash is added as its own group and both groupings sum to total equity, so the
// circle never claims more than the account holds.

export const ASSET_CLASSES = [
  "Stocks",
  "ETFs",
  "Crypto",
  "Bonds",
  "Real estate",
  "Commodities",
  "Other",
] as const;

export type AssetClassPreset = (typeof ASSET_CLASSES)[number];

export const UNCLASSIFIED = "Unclassified";
export const UNKNOWN_MARKET = "Unknown market";
export const CASH_GROUP = "Cash";

/** Symbol (upper-case) → user-assigned class. Local to this device. */
export type AssetClassMap = Record<string, string>;

export type GroupMode = "class" | "market";

export interface AllocationRow {
  symbol: string;
  marketValue: number;
  /** Quote currency when the grouping is by market; null when the feed had none. */
  currency?: string | null;
}

export interface AllocationGroup {
  name: string;
  value: number;
  color: string;
}

/** Steady palette so a group keeps its colour between renders. */
export const GROUP_COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#8b5cf6",
  "#ef4444",
  "#0ea5e9",
  "#84cc16",
  "#f97316",
  "#64748b",
] as const;

const STORAGE_KEY = "stockfolio:asset-class:v1";

const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();

/** Saved assignments; corrupted or non-string values are dropped, never guessed. */
export function loadAssetClasses(): AssetClassMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: AssetClassMap = {};
    for (const [symbol, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const label = value.trim();
      if (!symbol.trim() || !label) continue;
      clean[normalizeSymbol(symbol)] = label.slice(0, 40);
    }
    return clean;
  } catch {
    return {};
  }
}

/** Assign (`value`) or clear (`null`) one symbol's class. Returns the new map. */
export function saveAssetClass(symbol: string, value: string | null): AssetClassMap {
  const map = loadAssetClasses();
  const key = normalizeSymbol(symbol);
  if (value && value.trim()) map[key] = value.trim().slice(0, 40);
  else delete map[key];
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      // Storage full/blocked — the in-memory map is still returned so the UI
      // shows the assignment for this session instead of silently reverting.
    }
  }
  return map;
}

/**
 * Group market value into buckets, largest first. Rows worth 0 or less (a fully
 * closed position) are ignored; cash is added as its own group.
 */
export function groupAllocation(
  rows: AllocationRow[],
  options: { mode: GroupMode; classes?: AssetClassMap; cash?: number; palette?: readonly string[] },
): AllocationGroup[] {
  const palette = options.palette?.length ? options.palette : GROUP_COLORS;
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (!(row.marketValue > 0)) continue;
    const key =
      options.mode === "market"
        ? (row.currency?.trim().toUpperCase() || UNKNOWN_MARKET)
        : (options.classes?.[normalizeSymbol(row.symbol)]?.trim() || UNCLASSIFIED);
    totals.set(key, (totals.get(key) ?? 0) + row.marketValue);
  }

  const cash = options.cash ?? 0;
  if (cash > 0) totals.set(CASH_GROUP, (totals.get(CASH_GROUP) ?? 0) + cash);

  return [...totals.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, value], index) => ({
      name,
      value,
      color: palette[index % palette.length],
    }));
}

/** Total of a group list — the circle's centre figure and its percentage base. */
export function allocationTotal(groups: AllocationGroup[]): number {
  return groups.reduce((sum, group) => sum + group.value, 0);
}
