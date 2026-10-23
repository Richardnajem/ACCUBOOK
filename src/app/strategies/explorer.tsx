"use client";

import { useMemo, useState } from "react";

import {
  METHOD_NOTE,
  SORT_OPTIONS,
  STRATEGIES,
  STRATEGY_BUILD,
  STRATEGY_CATEGORIES,
  WORKBOOK_STRATEGIES,
  categoryCount,
  findStrategy,
  horizonCounts,
  matchesQuery,
  medianRisk,
  rankedCount,
  sortForDisplay,
  strategiesWithHorizon,
  type CategoryId,
  type Horizon,
  type SortKey,
  type Strategy,
} from "@/lib/strategies-catalog";
import { adjacentFor } from "@/lib/strategy-adjacent";
import { CatalogueTabs } from "@/components/strategies/catalogue-tabs";
import { StrategyCard, StrategyDrawer } from "@/components/strategies/strategy-ui";

const PAGE_STEP = 24;

const HORIZON_PILL: Record<Horizon, string> = {
  short: "Short-term (<1yr)",
  medium: "Medium-term (1–5yr)",
  long: "Long-term (5yr+)",
};

export interface ExplorerParams {
  /** Category id from ?cat=, ignored when it is not a real category. */
  initialCategory?: string | null;
  /** Search text from ?q=. */
  initialQuery?: string | null;
  /** Strategy id from ?open= — a deep link from the top-5 board. */
  initialOpen?: string | null;
}

/**
 * The explorer reads its URL state from props rather than useSearchParams so the
 * page renders in full on the server: a static shell that needs JavaScript to
 * show anything would be a regression from the page it replaces.
 */
export default function StrategiesExplorer({ initialCategory, initialQuery, initialOpen }: ExplorerParams) {
  const validCategory = STRATEGY_CATEGORIES.some((c) => c.id === initialCategory)
    ? (initialCategory as CategoryId)
    : null;

  const [category, setCategory] = useState<CategoryId | null>(validCategory);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sort, setSort] = useState<SortKey>("rank");
  const [horizon, setHorizon] = useState<Horizon | null>(null);
  const [shown, setShown] = useState(PAGE_STEP);
  const [selected, setSelected] = useState<Strategy | null>(() => findStrategy(initialOpen));

  const baseFiltered = useMemo(() => {
    const base = category ? STRATEGIES.filter((s) => s.category === category) : STRATEGIES;
    return base.filter((s) => matchesQuery(s, query));
  }, [category, query]);

  const filtered = useMemo(
    () => sortForDisplay(strategiesWithHorizon(baseFiltered, horizon), sort),
    [baseFiltered, horizon, sort],
  );

  const horizonAvailable = useMemo(
    () => horizonCounts(category ? STRATEGIES.filter((s) => s.category === category) : STRATEGIES),
    [category],
  );
  const horizonShown = useMemo(() => horizonCounts(baseFiltered), [baseFiltered]);
  const horizonTotals = useMemo(() => horizonCounts(), []);

  const visible = filtered.slice(0, shown);
  const activeCategory = category ? STRATEGY_CATEGORIES.find((c) => c.id === category) : null;
  const median = medianRisk();

  return (
    <div className="max-w-[1400px] mx-auto">
      <CatalogueTabs active="all" />

      {/* header */}
      <header className="mt-5 mb-5">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
          Research workbook · Master_Investment_Strategies.xlsx
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Investment strategies</h1>
        <p className="text-sm text-[var(--muted)] mt-2 max-w-3xl leading-relaxed">
          {STRATEGIES.length} strategies in {STRATEGY_CATEGORIES.length} categories —{" "}
          {WORKBOOK_STRATEGIES.length} read straight from the research workbook, plus{" "}
          {STRATEGIES.length - WORKBOOK_STRATEGIES.length} researched additions (index cores, cash ladders,
          options income, real-estate methods, allocation frameworks) carrying sourced risk, viability,
          return and horizon data. {rankedCount()} carry the workbook&apos;s own rank.
        </p>
      </header>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Kpi
          label="Strategies"
          value={String(STRATEGIES.length)}
          hint={`${STRATEGY_BUILD.sheetRows} workbook rows + ${STRATEGIES.length - WORKBOOK_STRATEGIES.length} researched additions`}
        />
        <Kpi
          label="Categories"
          value={String(STRATEGY_CATEGORIES.length)}
          hint="General Arbitrage re-filed into the markets it covers"
        />
        <Kpi
          label="Median risk"
          value={median == null ? "—" : `${Math.round(median * 100)}%`}
          hint="the sheet's Risk Level column"
        />
        <Kpi label="Workbook-ranked" value={String(rankedCount())} hint={`${STRATEGIES.length - rankedCount()} carry no rank`} />
        <Kpi
          label="Horizon-tagged"
          value={String(horizonTotals.short + horizonTotals.medium + horizonTotals.long)}
          hint={`${horizonTotals.short} short · ${horizonTotals.medium} medium · ${horizonTotals.long} long-term`}
        />
      </div>

      {/* filters */}
      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-3 mb-4">
        <div className="flex flex-col lg:flex-row gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setShown(PAGE_STEP); }}
              placeholder="Search names, risks, rationale, research fields…"
              className="w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <CategoryPill
            active={category === null}
            onClick={() => { setCategory(null); setShown(PAGE_STEP); }}
            label="All"
            count={STRATEGIES.length}
          />
          {STRATEGY_CATEGORIES.map((c) => (
            <CategoryPill
              key={c.id}
              active={category === c.id}
              onClick={() => { setCategory(category === c.id ? null : c.id); setShown(PAGE_STEP); }}
              label={c.label}
              count={categoryCount(c.id)}
            />
          ))}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--card-border)] pt-3">
          <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">Horizon</span>
          <CategoryPill
            active={horizon === null}
            onClick={() => { setHorizon(null); setShown(PAGE_STEP); }}
            label="Any"
            count={horizonAvailable.short + horizonAvailable.medium + horizonAvailable.long}
          />
          {(["short", "medium", "long"] as Horizon[]).map((h) => (
            <CategoryPill
              key={h}
              active={horizon === h}
              onClick={() => { setHorizon(horizon === h ? null : h); setShown(PAGE_STEP); }}
              label={HORIZON_PILL[h]}
              count={horizonShown[h]}
            />
          ))}
        </div>
      </div>

      {/* result count */}
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="text-xs text-[var(--muted)]">
          {activeCategory
            ? activeCategory.blurb
            : "Every strategy the catalogue lists — workbook rows and researched additions — grouped the way it is traded."}
        </p>
        <p className="text-xs text-[var(--muted)] shrink-0">
          {filtered.length} of {category ? categoryCount(category) : STRATEGIES.length}
        </p>
      </div>

      {/* cards */}
      {visible.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((s) => (
            <StrategyCard key={s.id} strategy={s} onOpen={setSelected} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-10 text-center">
          <p className="text-sm font-medium">Nothing matches “{query}”.</p>
          <p className="text-xs text-[var(--muted)] mt-1">
            Try a shorter term, or{" "}
            <button className="text-indigo-500 hover:underline" onClick={() => { setQuery(""); setCategory(null); }}>
              clear the filters
            </button>
            .
          </p>
        </div>
      )}

      {shown < filtered.length && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setShown((n) => n + PAGE_STEP)}
            className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-2 text-sm hover:bg-[var(--card-hover)]"
          >
            Show {Math.min(PAGE_STEP, filtered.length - shown)} more · {shown} of {filtered.length}
          </button>
        </div>
      )}

      {/* Broader methods in the selected category */}
      {category && <AdjacentPanel categoryId={category} />}

      {/* method */}
      <section className="mt-8 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-5">
        <h2 className="text-sm font-semibold mb-2">How this list is built</h2>
        <p className="text-xs text-[var(--muted)] leading-relaxed">{METHOD_NOTE}</p>
        <ul className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-[var(--muted)]">
          <li>{STRATEGY_BUILD.sheetRows} sheet rows → {WORKBOOK_STRATEGIES.length} workbook strategies ({STRATEGY_BUILD.mergedSpellings.length} spellings merged).</li>
          <li>{STRATEGY_BUILD.sectionHeadingsDropped} emoji section headings and {STRATEGY_BUILD.duplicatesDropped.length} self-declared duplicate dropped.</li>
          <li>The workbook files {STRATEGY_BUILD.generalArbitrageSplit.split ?? 0} rows under one “General Arbitrage” heading; they are re-filed by what they trade.</li>
          <li>Blank sheet fields stay blank: the drawer says which ones were never filled.</li>
          <li className="sm:col-span-2">
            {STRATEGIES.length - WORKBOOK_STRATEGIES.length} researched additions were curated outside the
            workbook in October2026 — each with its own sources, risk level, viability verdict, horizon and,
            where one honestly exists, a return figure (otherwise the row says why it has none).
          </li>
        </ul>
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Regenerate after editing the workbook with{" "}
          <code className="rounded bg-[var(--input-bg)] px-1.5 py-0.5 font-mono">node scripts/build-strategies.mjs</code>.
        </p>
      </section>

      {selected && <StrategyDrawer strategy={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AdjacentPanel({ categoryId }: { categoryId: CategoryId }) {
  const methods = adjacentFor(categoryId);
  if (!methods.length) return null;
  return (
    <section className="mt-6 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-5">
      <h2 className="text-sm font-semibold">
        {methods.length} more methods in this category the workbook does not list
      </h2>
      <p className="text-[11px] text-[var(--muted)] mt-1">
        The sheet is heavy on arbitrage and thin on whole families of investment. These belong to
        the same category but were never assessed, so they carry no return, risk or ranking.
      </p>
      <ul className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {methods.map((m) => (
          <li key={m.name}>
            <p className="text-[12px] font-medium">{m.name}</p>
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">{m.how}</p>
            <p className="text-[11px] leading-relaxed text-[var(--muted)] italic">{m.why}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</p>
      <p className="text-2xl font-semibold tracking-tight mt-0.5">{value}</p>
      <p className="text-[11px] text-[var(--muted)] mt-0.5 leading-tight">{hint}</p>
    </div>
  );
}

function CategoryPill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "border-indigo-500/50 bg-indigo-600/15 text-indigo-500 dark:text-indigo-400"
          : "border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
      }`}
    >
      {label}
      <span className="ml-1.5 opacity-60">{count}</span>
    </button>
  );
}
