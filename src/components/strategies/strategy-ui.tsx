"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  HORIZON_META,
  basisLabel,
  categoryMeta,
  horizonOf,
  isResearched,
  riskPercent,
  type Strategy,
} from "@/lib/strategies-catalog";
import {
  isThin,
  mechanismFor,
  ownFacts,
  templateFacts,
  type MechanismResearch,
} from "@/lib/strategy-research";
import { deepDiveFor } from "@/lib/strategy-deep-dives";

/* --------------------------------------------------------------- primitives */

const BAND_STYLES: Record<string, { text: string; bg: string; bar: string }> = {
  "Very low": { text: "text-emerald-500", bg: "bg-emerald-500/10", bar: "bg-emerald-500" },
  Low: { text: "text-lime-500", bg: "bg-lime-500/10", bar: "bg-lime-500" },
  Moderate: { text: "text-amber-500", bg: "bg-amber-500/10", bar: "bg-amber-500" },
  Elevated: { text: "text-orange-500", bg: "bg-orange-500/10", bar: "bg-orange-500" },
  High: { text: "text-rose-500", bg: "bg-rose-500/10", bar: "bg-rose-500" },
  Extreme: { text: "text-red-500", bg: "bg-red-500/10", bar: "bg-red-500" },
  Unknown: { text: "text-[var(--muted)]", bg: "bg-[var(--card-hover)]", bar: "bg-zinc-500" },
};

const bandStyle = (band: string) => BAND_STYLES[band] ?? BAND_STYLES.Unknown;

export function RiskMeter({ strategy, compact = false }: { strategy: Strategy; compact?: boolean }) {
  const pct = riskPercent(strategy);
  const style = bandStyle(strategy.band);
  if (pct == null) {
    return <span className="text-xs text-[var(--muted)]">risk —</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <div className={`h-1.5 rounded-full bg-[var(--card-hover)] ${compact ? "w-16" : "w-24"} overflow-hidden`}>
        <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <span className={`text-[11px] font-medium ${style.text}`}>
        {strategy.band}
        <span className="text-[var(--muted)] font-normal"> · {pct}%</span>
      </span>
    </div>
  );
}

export function OutlookPill({ outlook }: { outlook: string }) {
  if (!outlook) return null;
  const t = outlook.toLowerCase();
  const tone = t.includes("bearish")
    ? "bg-rose-500/10 text-rose-500 border-rose-500/30"
    : t.includes("bullish") || t.includes("strong")
      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
      : "bg-[var(--card-hover)] text-[var(--muted)] border-[var(--card-border)]";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {outlook}
    </span>
  );
}

export function CategoryChip({ categoryId, className = "" }: { categoryId: Strategy["category"]; className?: string }) {
  return (
    <span className={`text-[10px] uppercase tracking-wider text-[var(--muted)] ${className}`}>
      {categoryMeta(categoryId).label}
    </span>
  );
}

/** Short-term / medium-term / long-term, from the row's horizon data. */
export function HorizonChip({ strategy }: { strategy: Strategy }) {
  const horizon = horizonOf(strategy);
  if (!horizon) return null;
  const meta = HORIZON_META[horizon];
  const tone =
    horizon === "short"
      ? "border-emerald-500/30 text-emerald-500"
      : horizon === "medium"
        ? "border-amber-500/30 text-amber-500"
        : "border-indigo-500/30 text-indigo-500 dark:text-indigo-400";
  return (
    <span
      title={`Typical holding period: ${meta.hint}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {meta.label}
    </span>
  );
}

/** The workbook's own rank, or the computed RAR when it has none. */
export function RankBadge({ strategy }: { strategy: Strategy }) {
  if (strategy.coreRank != null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-indigo-600/15 px-2 py-0.5 text-[11px] font-semibold text-indigo-500 dark:text-indigo-400">
        Core #{strategy.coreRank}
      </span>
    );
  }
  if (strategy.score == null) {
    return (
      <span className="inline-flex items-center rounded-md border border-[var(--card-border)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
        no comparable figure
      </span>
    );
  }
  return (
    <span
      title="RAR: annualised midpoint of the sheet's return range ÷ the sheet's risk level"
      className="inline-flex items-center gap-1 rounded-md bg-[var(--card-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--foreground)]"
    >
      RAR {strategy.score.toFixed(1)}
    </span>
  );
}

export function ReturnFigure({ strategy, size = "md" }: { strategy: Strategy; size?: "md" | "lg" }) {
  const big = size === "lg" ? "text-2xl" : "text-xl";
  return (
    <div className="min-w-0">
      <p className={`${big} font-semibold tracking-tight leading-tight`}>{strategy.retText || "—"}</p>
      <p className="text-[11px] text-[var(--muted)] mt-0.5">{basisLabel(strategy)}</p>
    </div>
  );
}

/* -------------------------------------------------------------------- card -- */

export function StrategyCard({ strategy, onOpen }: { strategy: Strategy; onOpen: (s: Strategy) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(strategy)}
      className="group text-left w-full rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4 hover:bg-[var(--card-hover)] hover:border-indigo-500/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <CategoryChip categoryId={strategy.category} />
          <HorizonChip strategy={strategy} />
        </span>
        <RankBadge strategy={strategy} />
      </div>

      <h3 className="text-sm font-semibold leading-snug mb-3 line-clamp-2 group-hover:text-indigo-500">
        {strategy.name}
      </h3>

      <ReturnFigure strategy={strategy} />

      <div className="mt-3 pt-3 border-t border-[var(--card-border)] flex items-center justify-between gap-2">
        <RiskMeter strategy={strategy} />
        {strategy.outlook ? (
          <OutlookPill outlook={strategy.outlook} />
        ) : (
          <span className="text-[10px] text-[var(--muted)]">
            {isThin(strategy)
              ? "mechanism-level research"
              : `${ownFacts(strategy).length} research fields`}
          </span>
        )}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ drawer -- */

function Prose({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">{label}</p>
      <p className="text-sm leading-relaxed text-[var(--foreground)]">{children}</p>
    </div>
  );
}

export function StrategyDrawer({ strategy, onClose }: { strategy: Strategy; onClose: () => void }) {
  const meta = categoryMeta(strategy.category);
  const mechanism = mechanismFor(strategy);
  const own = ownFacts(strategy);
  const template = templateFacts(strategy);
  const dive = deepDiveFor(strategy.id);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={strategy.name}
        className="relative h-full w-full max-w-xl overflow-y-auto border-l border-[var(--card-border)] shadow-2xl"
        style={{ background: "var(--card)" }}
      >
        <header className="sticky top-0 z-10 border-b border-[var(--card-border)] px-5 py-4" style={{ background: "var(--card)" }}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CategoryChip categoryId={strategy.category} />
              <h2 className="text-lg font-semibold leading-snug mt-1">{strategy.name}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-lg px-2 py-1 text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center flex-wrap gap-x-4 gap-y-2 mt-3">
            <ReturnFigure strategy={strategy} size="lg" />
            <RiskMeter strategy={strategy} />
            <RankBadge strategy={strategy} />
            <OutlookPill outlook={strategy.outlook} />
          </div>
        </header>

        <div className="px-5 py-4">
          {strategy.description && (
            <Prose label={isResearched(strategy) ? "What the research says" : "What the workbook says"}>
              {strategy.description}
            </Prose>
          )}

          {isResearched(strategy) && <ResearchedBlock strategy={strategy} />}

          {dive && <DeepDive dive={dive} />}

          {strategy.rationale && <Prose label="Why it works">{strategy.rationale}</Prose>}
          {strategy.keyRisk && <Prose label="Key risk">{strategy.keyRisk}</Prose>}

          {own.length > 0 ? (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-2">
                Research filed against this strategy ({own.length} fields)
              </p>
              <FactList facts={own} />
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                <span className="font-medium text-amber-500">No research was filed against this row.</span>{" "}
                The workbook repeated one template across {template.length ? `${template.length} of its ` : ""}columns
                here — including cells that make no sense for this strategy — so nothing below is
                presented as data about it. The mechanism research underneath is about the trade
                itself, not about this specific listing.
              </p>
            </div>
          )}

          <MechanismBlock mechanism={mechanism} />

          {template.length > 0 && (
            <details className="mt-4 rounded-lg border border-[var(--card-border)] px-3 py-2">
              <summary className="cursor-pointer text-[11px] text-[var(--muted)]">
                {template.length} workbook cells reused from the sheet&apos;s template — not this strategy&apos;s research
              </summary>
              <div className="mt-2 opacity-70">
                <FactList facts={template} />
              </div>
            </details>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 text-[11px]">
            <Meta label="Category" value={meta.label} />
            <Meta label="Workbook category" value={strategy.sheetCategory} />
            <Meta label="Source" value={strategy.source || "—"} />
            <Meta label="Data freshness" value={strategy.freshness || "—"} />
            <Meta label="Confidence" value={strategy.confidence || "—"} />
            <Meta label="Risk level (sheet)" value={strategy.riskText || "—"} />
            <Meta label="Workbook tier" value={strategy.tier || "—"} />
            <Meta label="Limitations" value={strategy.limitations || "—"} />
          </div>

          {strategy.aliases.length > 0 && (
            <p className="mt-4 text-[11px] text-[var(--muted)]">
              The workbook also lists this strategy as {strategy.aliases.map((a) => `“${a}”`).join(", ")}.
            </p>
          )}

          <p className="mt-5 text-[11px] text-[var(--muted)]">
            <Link href={`/strategies?cat=${strategy.category}`} className="text-indigo-500 hover:underline">
              Everything in {meta.label} →
            </Link>
          </p>
        </div>
      </aside>
    </div>
  );
}

/** Sourced-additions block: viability, horizon and the pages the row rests on. */
function ResearchedBlock({ strategy }: { strategy: import("@/lib/strategies-catalog").ResearchedStrategy }) {
  const horizon = HORIZON_META[strategy.horizon];
  const tone =
    strategy.viability === "Speculative"
      ? "text-rose-500"
      : strategy.viability === "Mostly institutional"
        ? "text-orange-500"
        : strategy.viability === "Viable"
          ? "text-emerald-500"
          : "text-amber-500";
  return (
    <section className="mb-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-emerald-500">
        Researched addition — sourced outside the workbook
      </h3>
      <dl className="mt-2 space-y-1.5">
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-[11px] text-[var(--muted)]">Viability</dt>
          <dd className="col-span-2 text-[12px] leading-relaxed">
            <span className={`font-medium ${tone}`}>{strategy.viability}</span> — {strategy.viabilityNote}
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <dt className="text-[11px] text-[var(--muted)]">Horizon</dt>
          <dd className="col-span-2 text-[12px] leading-relaxed">
            {horizon.label} ({horizon.hint}) — {strategy.horizonText}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[10px] uppercase tracking-wider text-[var(--muted)]">Sources (pages opened in research)</p>
      <ul className="mt-1 space-y-1">
        {strategy.sources.map((s) => (
          <li key={s.url} className="text-[11px] leading-relaxed">
            <a href={s.url} target="_blank" rel="noreferrer" className="text-emerald-500 hover:underline">
              {s.title}
            </a>
            <span className="text-[var(--muted)]"> — {s.note}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">
        Figures here are typical industry ranges, historical averages or published current yields measured in
        October2026 — not forecasts, and not the workbook&apos;s cells.
      </p>
    </section>
  );
}

function FactList({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="divide-y divide-[var(--card-border)] rounded-lg border border-[var(--card-border)]">
      {facts.map((f) => (
        <div key={f.label} className="grid grid-cols-3 gap-3 px-3 py-2">
          <dt className="text-[11px] text-[var(--muted)]">{f.label}</dt>
          <dd className="col-span-2 text-[12px] leading-relaxed">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MechanismBlock({ mechanism }: { mechanism: MechanismResearch }) {
  const rows: [string, string][] = [
    ["How it is put on", mechanism.how],
    ["Where it trades", mechanism.venues],
    ["Liquidity & exit", mechanism.liquidity],
    ["Capital & operations", mechanism.capital],
    ["Costs", mechanism.costs],
    ["Regulatory", mechanism.regulatory],
    ["Shariah", mechanism.shariah],
  ];
  return (
    <section className="mt-4 rounded-xl border border-[var(--card-border)] bg-[var(--card-hover)]/40 px-3 py-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider">How this mechanism works</h3>
        <span className="text-[10px] text-[var(--muted)]">{mechanism.label}</span>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed">{mechanism.what}</p>
      <dl className="mt-2 space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-3 gap-3">
            <dt className="text-[10px] uppercase tracking-wider text-[var(--muted)] pt-0.5">{label}</dt>
            <dd className="col-span-2 text-[12px] leading-relaxed">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-[10px] uppercase tracking-wider text-[var(--muted)]">What breaks it</p>
      <ul className="mt-1 space-y-1">
        {mechanism.risks.map((r) => (
          <li key={r} className="text-[12px] leading-relaxed pl-3 relative before:content-['–'] before:absolute before:left-0 before:text-[var(--muted)]">
            {r}
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Effort</p>
          <p className="mt-0.5 leading-relaxed">{mechanism.effort}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Horizon</p>
          <p className="mt-0.5 leading-relaxed">{mechanism.horizon}</p>
        </div>
      </div>

      <p className="mt-3 text-[10px] uppercase tracking-wider text-[var(--muted)]">Watch per position</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--foreground)]">{mechanism.monitor.join(" · ")}</p>

      <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
        Mechanism-level research: how this family of trades works. Ranges marked “Typical:” are
        industry ranges, not from the workbook and not specific to this strategy.
      </p>
    </section>
  );
}

function DeepDive({ dive }: { dive: import("@/lib/strategy-deep-dives").DeepDive }) {
  return (
    <section className="mb-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 px-3 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-indigo-500">
        Sourced deep dive
      </h3>
      <p className="mt-1 text-[11px] text-[var(--muted)] leading-relaxed">{dive.summary}</p>
      <dl className="mt-2 divide-y divide-[var(--card-border)]">
        {dive.facts.map((f) => (
          <div key={f.label} className="grid grid-cols-3 gap-3 py-1.5">
            <dt className="text-[11px] text-[var(--muted)]">{f.label}</dt>
            <dd className="col-span-2 text-[12px] leading-relaxed">{f.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[10px] uppercase tracking-wider text-[var(--muted)]">Sources</p>
      <ul className="mt-1 space-y-1">
        {dive.sources.map((s) => (
          <li key={s.url} className="text-[11px] leading-relaxed">
            <a href={s.url} target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline">
              {s.title}
            </a>
            <span className="text-[var(--muted)]"> — {s.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--card-border)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</p>
      <p className="mt-0.5 leading-relaxed break-words">{value}</p>
    </div>
  );
}
