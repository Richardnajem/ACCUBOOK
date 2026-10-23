"use client";

import { useState } from "react";
import Link from "next/link";

import {
  METHOD_NOTE,
  STRATEGIES,
  STRATEGY_CATEGORIES,
  TOP_N,
  topByCategory,
  type Strategy,
  type StrategyCategory,
} from "@/lib/strategies-catalog";
import { adjacentFor } from "@/lib/strategy-adjacent";
import { CatalogueTabs } from "@/components/strategies/catalogue-tabs";
import { OutlookPill, RankBadge, RiskMeter, StrategyDrawer } from "@/components/strategies/strategy-ui";

function AdjacentMethods({ categoryId }: { categoryId: StrategyCategory["id"] }) {
  const methods = adjacentFor(categoryId);
  if (!methods.length) return null;
  return (
    <details className="border-t border-[var(--card-border)] px-4 py-2">
      <summary className="cursor-pointer text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]">
        {methods.length} more methods in this category the workbook does not list
      </summary>
      <ul className="mt-2 space-y-2.5">
        {methods.map((m) => (
          <li key={m.name}>
            <p className="text-[11px] font-medium">{m.name}</p>
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">{m.how}</p>
            <p className="text-[11px] leading-relaxed text-[var(--muted)] italic">{m.why}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-[var(--muted)]">
        Named for completeness, not assessed: the workbook carries no return or risk figure for
        these, so they are not ranked.
      </p>
    </details>
  );
}

export default function TopStrategiesPage() {
  const boards = topByCategory(TOP_N);
  const [selected, setSelected] = useState<Strategy | null>(null);

  return (
    <div className="max-w-[1400px] mx-auto">
      <CatalogueTabs active="top" />

      <header className="mt-5 mb-5">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
          Best of each category · Master_Investment_Strategies.xlsx
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Top {TOP_N} in every category</h1>
        <p className="text-sm text-[var(--muted)] mt-2 max-w-3xl leading-relaxed">
          The strongest {TOP_N} strategies from each of the {STRATEGY_CATEGORIES.length} categories, out of{" "}
          {STRATEGIES.length}. Where a category holds fewer than {TOP_N}, it shows what exists — nothing
          is padded.
        </p>
      </header>

      <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4 mb-5">
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Ranking rule</p>
        <p className="text-xs leading-relaxed text-[var(--muted)]">{METHOD_NOTE}</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {boards.map(({ category, total, rows }) => (
          <section
            key={category.id}
            className="rounded-xl border border-[var(--card-border)] bg-[var(--card)] overflow-hidden"
          >
            <header className="px-4 pt-4 pb-3 border-b border-[var(--card-border)]">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold">{category.label}</h2>
                <Link
                  href={`/strategies?cat=${category.id}`}
                  className="text-[11px] text-indigo-500 hover:underline shrink-0"
                >
                  all {total} →
                </Link>
              </div>
              <p className="text-[11px] text-[var(--muted)] mt-1 leading-relaxed">{category.blurb}</p>
            </header>

            <ol className="divide-y divide-[var(--card-border)]">
              {rows.map((s, i) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(s)}
                    className="w-full text-left px-4 py-3 hover:bg-[var(--card-hover)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                          i === 0
                            ? "bg-indigo-600 text-white"
                            : "bg-[var(--card-hover)] text-[var(--muted)]"
                        }`}
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="text-[13px] font-medium leading-snug truncate">{s.name}</h3>
                          <span className="text-[12px] font-semibold tabular-nums shrink-0">{s.retText || "—"}</span>
                        </div>
                        <div className="mt-1 flex items-center flex-wrap gap-x-3 gap-y-1">
                          <RiskMeter strategy={s} compact />
                          <RankBadge strategy={s} />
                          <OutlookPill outlook={s.outlook} />
                        </div>
                        {s.rationale && (
                          <p className="mt-1.5 text-[11px] text-[var(--muted)] leading-relaxed line-clamp-2">
                            {s.rationale}
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ol>

            <p className="px-4 py-2 text-[10px] text-[var(--muted)] border-t border-[var(--card-border)]">
              {rows.length} of {total} shown
              {total > TOP_N ? " · open the category for the rest" : " · this is the whole category"}
            </p>

            <AdjacentMethods categoryId={category.id} />
          </section>
        ))}
      </div>

      <section className="mt-8 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-5">
        <h2 className="text-sm font-semibold mb-2">Read this before acting on a row</h2>
        <ul className="space-y-1.5 text-[11px] text-[var(--muted)] leading-relaxed">
          <li>
            <strong className="text-[var(--foreground)]">RAR is arithmetic, not advice.</strong> It is the
            midpoint of the workbook&apos;s own return range divided by its own risk level. It does not know
            about taxes, fees, capacity or how much of the return you actually keep.
          </li>
          <li>
            <strong className="text-[var(--foreground)]">Most rows carry the workbook&apos;s default figures.</strong>{" "}
            151 of its 236 rows repeat the same 5%–12% APY and 0.6 risk, so within an arbitrage category the
            order is decided by the tie-breaks, not by measured performance.
          </li>
          <li>
            <strong className="text-[var(--foreground)]">A monthly figure is annualised for comparison only</strong>{" "}
            (×12) and labelled that way in the card — 10%–30% a month is not a 120%–360% yearly promise.
          </li>
          <li>
            <strong className="text-[var(--foreground)]">Three rows are not investable as written.</strong> The
            workbook itself flags them as category overlap, a platform-specific listing, or unviable — they keep
            their place and say so in the detail drawer.
          </li>
        </ul>
      </section>

      {selected && <StrategyDrawer strategy={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
