import {
  STRATEGIES as WORKBOOK_STRATEGIES,
  STRATEGY_CATEGORIES,
  STRATEGY_BUILD,
  type CategoryId,
  type Strategy,
  type StrategyCategory,
} from "./strategies-db";
import {
  HORIZON_META,
  RESEARCHED_STRATEGIES,
  isResearched,
  type Horizon,
  type ResearchedStrategy,
  type Viability,
} from "./strategies-researched";

/**
 * Reading rules for the strategy catalogue.
 *
 * The workbook gives 17 strategies an "Overall Rank" and no comparable score for
 * the other 169, so "top 5 per category" needs a stated rule rather than a
 * hidden one:
 *
 *   1. a strategy the workbook ranks always sorts by that rank;
 *   2. then by RAR — the annualised midpoint of the sheet's own return range
 *      divided by the sheet's own risk level (higher is better);
 *   3. then by how much research the row actually carries, so a row with a
 *      worked-out rationale and 40 filed fields outranks a template row;
 *   4. then alphabetically.
 *
 * Nothing here is estimated: a return the sheet does not give stays null and the
 * row sorts after the ones that do carry a figure.
 */

/** The generated workbook rows only — used by the build-arithmetic tests. */
export { WORKBOOK_STRATEGIES };
/** Workbook rows plus the sourced additions in `strategies-researched.ts`. */
export const STRATEGIES: Strategy[] = [...WORKBOOK_STRATEGIES, ...RESEARCHED_STRATEGIES];
export { STRATEGY_CATEGORIES, STRATEGY_BUILD };
export type { CategoryId, Strategy, StrategyCategory, Horizon, ResearchedStrategy, Viability };
export { HORIZON_META, isResearched };

const TEMPLATE_RATIONALE = /^(flexible\.?|high safety\.?)$/i;

export function outlookWeight(outlook: string): number {
  const t = outlook.toLowerCase();
  if (t.includes("very bullish")) return 4;
  if (t.includes("strong")) return 3;
  if (t.includes("bullish")) return 3;
  if (t.includes("steady")) return 2;
  if (t.includes("bearish")) return 0;
  return 1;
}

/** How much the workbook actually says about this row. */
export function evidenceScore(s: Strategy): number {
  return (
    s.facts.length +
    (s.coreRank != null ? 50 : 0) +
    (TEMPLATE_RATIONALE.test(s.rationale.trim()) ? 0 : 3) +
    (outlookWeight(s.outlook) !== 1 ? 1 : 0)
  );
}

export const TOP_N = 5;

/** Category order for every list and board. */
export function sortedCategories(): StrategyCategory[] {
  return STRATEGY_CATEGORIES;
}

export function strategiesInCategory(categoryId: CategoryId | null): Strategy[] {
  return categoryId ? STRATEGIES.filter((s) => s.category === categoryId) : STRATEGIES;
}

export function rankWithinCategory(list: Strategy[]): Strategy[] {
  return [...list].sort(
    (a, b) =>
      (a.coreRank ?? Number.POSITIVE_INFINITY) - (b.coreRank ?? Number.POSITIVE_INFINITY) ||
      (b.score ?? -1) - (a.score ?? -1) ||
      evidenceScore(b) - evidenceScore(a) ||
      a.name.localeCompare(b.name),
  );
}

export interface CategoryBoard {
  category: StrategyCategory;
  total: number;
  rows: Strategy[];
}

/** The top `n` per category, in category order. */
export function topByCategory(n: number = TOP_N): CategoryBoard[] {
  return STRATEGY_CATEGORIES.map((category) => {
    const all = STRATEGIES.filter((s) => s.category === category.id);
    return { category, total: all.length, rows: rankWithinCategory(all).slice(0, n) };
  });
}

export type SortKey = "rank" | "return" | "risk" | "horizon" | "name" | "evidence";

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "rank", label: "Best first (workbook rank, then RAR)" },
  { value: "horizon", label: "Shortest horizon first (short-term → long-term)" },
  { value: "return", label: "Highest stated return" },
  { value: "risk", label: "Lowest risk" },
  { value: "evidence", label: "Best researched" },
  { value: "name", label: "Name A–Z" },
];

export function sortForDisplay(list: Strategy[], key: SortKey): Strategy[] {
  switch (key) {
    case "return":
      return [...list].sort(
        (a, b) =>
          (b.retAnnual ?? -1) - (a.retAnnual ?? -1) ||
          (a.coreRank ?? Number.POSITIVE_INFINITY) - (b.coreRank ?? Number.POSITIVE_INFINITY) ||
          a.name.localeCompare(b.name),
      );
    case "risk":
      return [...list].sort(
        (a, b) =>
          (a.risk ?? 2) - (b.risk ?? 2) ||
          (b.retAnnual ?? -1) - (a.retAnnual ?? -1) ||
          a.name.localeCompare(b.name),
      );
    case "horizon":
      return [...list].sort((a, b) => {
        const ha = horizonOf(a);
        const hb = horizonOf(b);
        const oa = ha ? HORIZON_META[ha].order : Number.MAX_SAFE_INTEGER;
        const ob = hb ? HORIZON_META[hb].order : Number.MAX_SAFE_INTEGER;
        return oa - ob || (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name);
      });
    case "name":
      return [...list].sort((a, b) => a.name.localeCompare(b.name));
    case "evidence":
      return [...list].sort(
        (a, b) => evidenceScore(b) - evidenceScore(a) || a.name.localeCompare(b.name),
      );
    case "rank":
    default:
      return rankWithinCategory(list);
  }
}

export function matchesQuery(s: Strategy, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const words = q.split(/\s+/);
  const researched = isResearched(s)
    ? `${HORIZON_META[s.horizon].label} ${s.horizonText} ${s.viability} ${s.viabilityNote} ${s.sources
        .map((x) => `${x.title} ${x.note}`)
        .join(" ")}`
    : "";
  const haystack = [
    s.name,
    s.band,
    s.retText,
    s.outlook,
    s.rationale,
    s.keyRisk,
    s.description,
    s.sheetCategory,
    s.aliases.join(" "),
    s.facts.map((f) => f.value).join(" "),
    researched,
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/* ------------------------------------------------------------- horizon -- */

/** Read the largest duration mentioned in a text like "3-12 months" or "5+ years". */
function horizonMonthsFrom(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(/(\d+)\s*(?:-|–|to)?\s*(\d+)?\s*(days?|weeks?|months?|years?)/gi)) {
    const unit = m[3].toLowerCase();
    const top = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0);
    const months = unit.startsWith("d") ? top / 30 : unit.startsWith("w") ? top / 4 : unit.startsWith("m") ? top : top * 12;
    if (max == null || months > max) max = months;
  }
  return max;
}

/** short < ~1 year · medium ~1–5 years · long5+ years. Null when the row never says. */
export function horizonFromMonths(months: number | null): Horizon | null {
  if (months == null) return null;
  if (months <= 12) return "short";
  if (months <= 60) return "medium";
  return "long";
}

/**
 * The holding-period class of a strategy. Researched rows carry it directly;
 * workbook rows get it from their own "Minimum horizon" research field when the
 * sheet filled one in, and stay null when it did not.
 */
export function horizonOf(s: Strategy): Horizon | null {
  if (isResearched(s)) return s.horizon;
  const fact = s.facts.find((f) => /horizon/i.test(f.label) && /\d/.test(f.value));
  return horizonFromMonths(fact ? horizonMonthsFrom(fact.value) : null);
}

/** Horizon counts over a list (usually the current filtered category). */
export function horizonCounts(list: Strategy[] = STRATEGIES): Record<Horizon, number> {
  const counts: Record<Horizon, number> = { short: 0, medium: 0, long: 0 };
  for (const s of list) {
    const h = horizonOf(s);
    if (h) counts[h] += 1;
  }
  return counts;
}

export function strategiesWithHorizon(list: Strategy[], horizon: Horizon | null): Strategy[] {
  return horizon ? list.filter((s) => horizonOf(s) === horizon) : list;
}

export function categoryMeta(id: CategoryId): StrategyCategory {
  return STRATEGY_CATEGORIES.find((c) => c.id === id) ?? STRATEGY_CATEGORIES[0];
}

export function categoryCount(id: CategoryId): number {
  return STRATEGIES.filter((s) => s.category === id).length;
}

/** "annual" → "per year", the way the card labels the figure. */
export function basisLabel(s: Strategy): string {
  switch (s.retBasis) {
    case "annual":
      return /net/i.test(s.retText) ? "per year, net" : "per year";
    case "monthly":
      return "per month (×12 to compare)";
    case "per deal":
      return "per deal — not annualised";
    case "asymmetric":
      return "asymmetric";
    default:
      // A researched row can carry a measured historical window that is not an
      // annual rate; a workbook blank has nothing to label at all.
      return s.retText ? "historical window — not annualised" : "no sourced figure";
  }
}

export function riskPercent(s: Strategy): number | null {
  return s.risk == null ? null : Math.round(s.risk * 100);
}

export function medianRisk(): number | null {
  const risks = STRATEGIES.map((s) => s.risk).filter((r): r is number => r != null).sort((a, b) => a - b);
  if (!risks.length) return null;
  const mid = Math.floor(risks.length / 2);
  return risks.length % 2 ? risks[mid] : (risks[mid - 1] + risks[mid]) / 2;
}

export function rankedCount(): number {
  return STRATEGIES.filter((s) => s.coreRank != null).length;
}

export function findStrategy(id: string | null | undefined): Strategy | null {
  if (!id) return null;
  return STRATEGIES.find((s) => s.id === id) ?? null;
}

/** The one-line method note both pages print, so the ranking is never implicit. */
export const METHOD_NOTE =
  "Ordered by the workbook's own Overall Rank where it gives one, then by RAR — the annualised midpoint of the sheet's return range ÷ its risk level. Ties fall to how much research the row carries, then name. Workbook figures are the sheet's and blanks stay blank; the " +
  `${RESEARCHED_STRATEGIES.length} researched additions carry their own sourced risk, viability, return and horizon data and are labelled as such.`;
