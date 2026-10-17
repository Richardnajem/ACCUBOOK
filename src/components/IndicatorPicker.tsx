"use client";

// A searchable picker for adding indicators to the Mega Indicator composite.
//
// Replaces the old always-on "Suggested for this ticker" panel: suggestions are
// still computed (lib/indicator-suggestions) and still ranked, but they now sit
// at the top of this list, flagged with the reason, rather than dominating the
// page. Everything the catalogue offers is searchable here.

import { useEffect, useMemo, useRef, useState } from "react";
import { effectiveWeight, scoreColor, type WeightMap } from "@/lib/mega-indicator";
import type { Suggestion } from "@/lib/indicator-suggestions";

export interface PickerIndicator {
  id: string;
  name: string;
  category: string;
  unit: string;
  value: number;
  score: number;
  description: string;
  optional?: boolean;
}

const valueLabel = (ind: PickerIndicator) => {
  const v = ind.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return ind.unit === "$" ? `$${v}` : ind.unit ? `${v} ${ind.unit}` : v;
};

export default function IndicatorPicker({
  open,
  onClose,
  indicators,
  weights,
  suggestions,
  ticker,
  onAdd,
  onCreateCustom,
}: {
  open: boolean;
  onClose: () => void;
  indicators: PickerIndicator[];
  weights: WeightMap;
  suggestions: Suggestion[];
  ticker?: string | null;
  onAdd: (id: string, weight: number) => void;
  onCreateCustom: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Clear the box each time the picker opens (render-time state adjustment).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setQuery("");
  }

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const suggestionById = useMemo(
    () => new Map(suggestions.map((s) => [s.id, s])),
    [suggestions],
  );

  // Anything not already carrying weight is available to add.
  const available = useMemo(
    () => indicators.filter((i) => effectiveWeight(i, weights) <= 0),
    [indicators, weights],
  );

  const inComposite = indicators.length - available.length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q),
    );
  }, [available, query]);

  const suggested = filtered.filter((i) => suggestionById.has(i.id));
  const rest = filtered.filter((i) => !suggestionById.has(i.id));

  if (!open) return null;

  const row = (ind: PickerIndicator) => {
    const s = suggestionById.get(ind.id);
    return (
      <div
        key={ind.id}
        className="flex flex-wrap items-start gap-3 px-3 py-2.5 border-b border-[var(--card-border)] last:border-0"
      >
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{ind.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card-hover)] text-[var(--muted)]">{ind.category}</span>
            <span className="text-[10px] tabular-nums" style={{ color: scoreColor(ind.score) }}>score {ind.score.toFixed(0)}</span>
            <span className="text-[10px] text-[var(--muted)] tabular-nums">{valueLabel(ind)}</span>
          </div>
          <p className="text-[11px] text-[var(--muted)] mt-0.5 line-clamp-2">{ind.description}</p>
          {s && (
            <p className="text-[11px] mt-1 flex items-start gap-1.5 text-emerald-600 dark:text-emerald-400">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 font-medium shrink-0">
                {s.kind === "add" ? "SUGGESTED" : "BOOST"}
              </span>
              <span className="text-[var(--muted)]">{s.reason}</span>
            </p>
          )}
        </div>
        <button
          onClick={() => onAdd(ind.id, s ? s.weight : 1)}
          title={`Add ${ind.name} to the composite at weight ${s ? s.weight : 1}`}
          className="text-xs px-2.5 py-1.5 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 font-medium shrink-0"
        >
          {s && s.kind === "reweight" ? `Set weight ${s.weight}` : "Add"}
        </button>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-[var(--card-border)] bg-[var(--card)] shadow-2xl flex flex-col max-h-[85vh] my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 pb-3 border-b border-[var(--card-border)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">Add Indicator</h3>
              <p className="text-xs text-[var(--muted)]">
                {ticker ? `Available for ${ticker} — ` : ""}search the catalogue and add what you need.
                {" "}<b className="text-[var(--foreground)]">{inComposite}</b> of {indicators.length} in the composite.
              </p>
            </div>
            <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--foreground)]" aria-label="Close">✕</button>
          </div>
          <div className="relative mt-3">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search indicators — name, category, or description…"
              className="w-full pl-9 pr-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-[var(--muted)] text-center py-12">
              {query ? `No available indicator matches “${query}”.` : "Every indicator is already in the composite."}
            </p>
          ) : (
            <>
              {suggested.length > 0 && (
                <div>
                  <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
                    Suggested for this market state
                  </p>
                  {suggested.map(row)}
                </div>
              )}
              {rest.length > 0 && (
                <div>
                  <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
                    {suggested.length > 0 ? "Everything else available" : "Available to add"}
                  </p>
                  {rest.map(row)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--card-border)] flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--muted)]">{filtered.length} available</span>
          <button
            onClick={onCreateCustom}
            className="text-xs px-3 py-1.5 rounded border border-indigo-500/40 text-indigo-500 dark:text-indigo-400 hover:bg-indigo-500/10 font-medium"
          >
            ＋ Create a custom indicator
          </button>
        </div>
      </div>
    </div>
  );
}
