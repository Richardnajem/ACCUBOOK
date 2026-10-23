"use client";

import { useEffect, useState } from "react";
import type { SymbolSuggestion } from "@/lib/symbol-search";

export type { SymbolSuggestion };

/** Keystrokes are debounced; a query this short would return noise. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

/** Queries already answered in this tab — backspacing must not refetch. */
const memo = new Map<string, SymbolSuggestion[]>();

export interface SuggestionState {
  suggestions: SymbolSuggestion[];
  loading: boolean;
  /** Set when the search endpoint itself failed (not "no matches"). */
  error: string | null;
}

/**
 * Live suggestions for a partially typed ticker or company name.
 *
 * Pass "" to disable (e.g. while the palette is closed). The request is
 * aborted when the query changes, so a slow answer for "nv" can never overwrite
 * the results for "nvda".
 */
export function useSymbolSuggestions(query: string): SuggestionState {
  const trimmed = query.trim();
  // Answer for one specific query. Everything else is derived below, so the
  // effect only ever writes state from an async callback — no cascade.
  const [loaded, setLoaded] = useState<{ key: string; items: SymbolSuggestion[]; error: string | null } | null>(null);

  useEffect(() => {
    const key = trimmed.toLowerCase();
    if (key.length < MIN_QUERY || memo.has(key)) return;

    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(() => {
      fetch(`/api/symbol-search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as {
            suggestions?: SymbolSuggestion[];
            error?: string;
          };
          if (!res.ok) throw new Error(data.error || `Search failed (HTTP ${res.status})`);
          const list = Array.isArray(data.suggestions) ? data.suggestions : [];
          memo.set(key, list);
          if (!cancelled) setLoaded({ key, items: list, error: null });
        })
        .catch((e: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setLoaded({
            key,
            items: [],
            error: e instanceof Error ? e.message : "Symbol search failed.",
          });
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const key = trimmed.toLowerCase();
  if (key.length < MIN_QUERY) return { suggestions: [], loading: false, error: null };
  const cached = memo.get(key);
  if (cached) return { suggestions: cached, loading: false, error: null };
  if (loaded && loaded.key === key) {
    return { suggestions: loaded.items, loading: false, error: loaded.error };
  }
  return { suggestions: [], loading: true, error: null };
}

/**
 * The dropdown body, shared by the palette and the watchlist form so the two
 * behave identically. `activeIndex` is the keyboard highlight (-1 for none).
 */
export function SymbolSuggestionList({
  items,
  activeIndex = -1,
  onPick,
  onHover,
}: {
  items: SymbolSuggestion[];
  activeIndex?: number;
  onPick: (item: SymbolSuggestion) => void;
  onHover?: (index: number) => void;
}) {
  return (
    <>
      {items.map((item, i) => (
        <button
          key={item.symbol}
          type="button"
          onClick={() => onPick(item)}
          onMouseEnter={() => onHover?.(i)}
          className={`w-full flex items-baseline gap-3 px-3 py-2 text-left transition-colors ${
            i === activeIndex ? "bg-indigo-500/10" : "hover:bg-[var(--card-hover)]"
          }`}
        >
          <span className="font-bold text-sm w-20 shrink-0 text-[var(--foreground)]">
            {item.symbol}
          </span>
          <span className="text-xs text-[var(--muted)] truncate flex-1 min-w-0">
            {item.name || "—"}
          </span>
          <span className="text-[10px] text-[var(--muted)] shrink-0">
            {[item.exchange, item.type].filter(Boolean).join(" · ")}
          </span>
        </button>
      ))}
    </>
  );
}
