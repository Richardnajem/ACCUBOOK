"use client";

// A tiny client-side hand-off for the global search palette.
//
// The palette lives in the dashboard layout, so it can't push state into a
// page's own search box directly. When a symbol is picked it records the term
// here and fires an event; the target tab picks the term up either from the
// event (already mounted) or on mount (freshly navigated). Using this instead
// of a `?q=` URL param keeps `useSearchParams` (which needs a Suspense boundary
// for prerendered routes) out of the dashboard pages.

const STORAGE_KEY = "stockfolio:pending-search";
export const SEARCH_EVENT = "stockfolio:search";

/** Record a pending search term and notify any mounted page. */
export function dispatchSearch(term: string): void {
  if (!term) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, term);
  } catch {
    // sessionStorage unavailable — the event below still covers a mounted page
  }
  window.dispatchEvent(new CustomEvent(SEARCH_EVENT, { detail: term }));
}

/** Read and clear a term left for a page that is about to mount. */
function takePendingSearch(): string {
  try {
    const term = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    if (term) window.sessionStorage.removeItem(STORAGE_KEY);
    return term;
  } catch {
    return "";
  }
}

/**
 * Subscribe a page's search state to the palette. Returns a cleanup function.
 * `apply` is called with the term when a pick arrives, and once on mount if a
 * term was left for this page.
 */
export function onSearchRequested(apply: (term: string) => void): () => void {
  const pending = takePendingSearch();
  if (pending) apply(pending);

  const handler = (e: Event) => {
    const term = (e as CustomEvent<string>).detail;
    if (term) apply(term);
  };
  window.addEventListener(SEARCH_EVENT, handler);
  return () => window.removeEventListener(SEARCH_EVENT, handler);
}
