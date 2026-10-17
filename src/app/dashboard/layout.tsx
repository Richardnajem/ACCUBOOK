"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useTheme } from "@/components/ThemeProvider";
import ImportDialog from "@/components/ImportDialog";
import { useUndoRedo } from "@/lib/undo-redo";
import { dispatchSearch } from "@/lib/search-bus";
import { useState, useRef, useEffect } from "react";

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg> },
  { label: "Holdings", href: "/dashboard/holdings", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v18h18M7 16v-5m4 5V8m4 8v-3m4 3V5" /></svg> },
  { label: "Trade Log", href: "/dashboard/trades", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" /></svg> },
  { label: "Watchlist", href: "/dashboard/watchlist", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg> },
  { label: "Mega Indicator", href: "/dashboard/mega-indicator", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v3m0 12v3m9-9h-3M6 12H3m15.364 6.364l-2.122-2.122M7.758 7.758L5.636 5.636m12.728 0l-2.122 2.122M7.758 16.242l-2.122 2.122" /></svg> },
  { label: "Backtesting", href: "/dashboard/backtest", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg> },
  { label: "Settings", href: "/dashboard/settings", icon: <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
];

interface SymbolHit {
  symbol: string;
  holdings: boolean;
  watchlist: boolean;
  trades: boolean;
}

// A symbol the user holds is most useful on Holdings; otherwise prefer the
// Watchlist, then the Trade Log. The pick is handed to the page's search box
// through lib/search-bus rather than a URL query.
const symbolHref = (h: SymbolHit): string => {
  if (h.holdings) return "/dashboard/holdings";
  if (h.watchlist) return "/dashboard/watchlist";
  return "/dashboard/trades";
};

const symbolSources = (h: SymbolHit): string =>
  [h.holdings && "held", h.watchlist && "watched", h.trades && "traded"].filter(Boolean).join(" · ");

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme, setTheme, themes } = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false); // drawer below lg
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [symbols, setSymbols] = useState<SymbolHit[]>([]);
  const themeRef = useRef<HTMLDivElement>(null);
  const cmdInputRef = useRef<HTMLInputElement>(null);

  // Close the drawer whenever the route changes
  useEffect(() => {
    (async () => {
      setNavOpen(false);
    })();
  }, [pathname]);

  const { undo, redo, canUndo, canRedo, undoLabel, redoLabel } = useUndoRedo();

  // Cmd+K keyboard shortcut + Ctrl+Z / Ctrl+Shift+Z undo/redo
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen(prev => !prev);
        setCmdQuery("");
      }
      if (e.key === "Escape") setCmdOpen(false);
      // Undo: Ctrl+Z (not in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          undo();
        }
      }
      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((e.metaKey || e.ctrlKey) && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          redo();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  useEffect(() => {
    if (cmdOpen) setTimeout(() => cmdInputRef.current?.focus(), 50);
  }, [cmdOpen]);

  // Load every symbol the user touches (held / traded / watched) when the
  // search palette opens, so one query covers the whole portfolio.
  useEffect(() => {
    if (!cmdOpen) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/portfolio", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/trades", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      fetch("/api/watchlist", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    ]).then(([pf, tr, wl]) => {
      if (cancelled) return;
      const map = new Map<string, SymbolHit>();
      const get = (s: string) => {
        const k = s.toUpperCase();
        if (!map.has(k)) map.set(k, { symbol: k, holdings: false, watchlist: false, trades: false });
        return map.get(k)!;
      };
      for (const p of (pf?.quoted ?? []) as { symbol: string }[]) get(p.symbol).holdings = true;
      for (const t of (tr?.trades ?? []) as { symbol: string | null }[]) if (t.symbol) get(t.symbol).trades = true;
      for (const w of (wl?.items ?? []) as { symbol: string }[]) if (w.symbol) get(w.symbol).watchlist = true;
      setSymbols([...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)));
    });
    return () => { cancelled = true; };
  }, [cmdOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const currentTheme = themes.find((t) => t.value === theme);

  const sidebarInner = (
    <>
      <div className="h-16 flex items-center gap-3 px-5 border-b border-[var(--card-border)]">
        <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <div>
          <span className="text-lg font-bold tracking-tight">Stockfolio</span>
          <p className="text-[10px] text-[var(--muted)]">Local Only</p>
        </div>
      </div>

      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-indigo-600/15 text-indigo-600 dark:text-indigo-400"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
              }`}>
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-[var(--card-border)]">
        <div className="flex items-center justify-between text-xs text-[var(--muted)]">
          <span>by Richard Najem</span>
          <span>Local</span>
        </div>
      </div>
    </>
  );

  const normalizedQuery = cmdQuery.trim().toLowerCase();
  const filteredNav = navItems.filter(
    (item) =>
      !normalizedQuery ||
      item.label.toLowerCase().includes(normalizedQuery) ||
      item.href.toLowerCase().includes(normalizedQuery),
  );
  const filteredSymbols = normalizedQuery
    ? symbols.filter((s) => s.symbol.toLowerCase().includes(normalizedQuery))
    : symbols;

  return (
    <div className="min-h-screen flex">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 h-screen shrink-0 w-64 border-r border-[var(--card-border)] hidden lg:flex flex-col"
        style={{ background: "var(--sidebar-bg)" }}>
        {sidebarInner}
      </aside>

      {/* Sidebar drawer (below lg) */}
      {navOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setNavOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-[var(--card-border)] flex flex-col shadow-2xl"
            style={{ background: "var(--sidebar-bg)" }}>
            {sidebarInner}
          </aside>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 min-w-0 min-h-screen">
        <header className="h-16 flex items-center gap-4 px-6 border-b border-[var(--card-border)] sticky top-0 z-20"
          style={{ background: "var(--header-bg)", backdropFilter: "blur(12px)" }}>
          {/* Hamburger (below lg) */}
          <button onClick={() => setNavOpen(true)} aria-label="Open navigation"
            className="lg:hidden p-2 -ml-2 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] transition-colors">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">
              {navItems.find((i) => i.href === pathname)?.label || "Stockfolio"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {/* Theme Picker */}
            <div className="relative" ref={themeRef}>
              <button onClick={() => setThemeOpen(!themeOpen)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] transition-colors">
                <span>{currentTheme?.icon}</span>
                <span className="hidden sm:inline">{currentTheme?.label}</span>
                <svg className={`w-4 h-4 transition-transform ${themeOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {themeOpen && (
                <div className="absolute right-0 top-full mt-1 w-48 py-1 rounded-xl border border-[var(--card-border)] shadow-xl z-50"
                  style={{ background: "var(--card)" }}>
                  {themes.map((t) => (
                    <button key={t.value} onClick={() => { setTheme(t.value); setThemeOpen(false); }}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        theme === t.value
                          ? "text-[var(--primary)] bg-[var(--primary)]/10"
                          : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
                      }`}>
                      <span className="text-lg">{t.icon}</span>
                      <span>{t.label}</span>
                      {theme === t.value && (
                        <svg className="w-4 h-4 ml-auto text-[var(--primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Undo/Redo buttons */}
            <div className="flex items-center gap-1">
              <button onClick={undo} disabled={!canUndo}
                title={canUndo ? `Undo: ${undoLabel}` : "Nothing to undo"}
                className="p-1.5 text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg hover:bg-[var(--card-hover)] transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" /></svg>
              </button>
              <button onClick={redo} disabled={!canRedo}
                title={canRedo ? `Redo: ${redoLabel}` : "Nothing to redo"}
                className="p-1.5 text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg hover:bg-[var(--card-hover)] transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2m15-7l-4-4m4 4l-4 4" /></svg>
              </button>
            </div>

            {/* Global search (symbols + pages) */}
            <button onClick={() => { setCmdOpen(true); setCmdQuery(""); }}
              title="Search symbols and pages (⌘K)"
              className="flex items-center gap-2 pl-2.5 pr-2 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)] transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <span className="hidden md:inline">Search symbols…</span>
              <kbd className="hidden md:inline text-[10px] text-[var(--muted)] bg-[var(--input-bg)] px-1.5 py-0.5 rounded border border-[var(--input-border)]">⌘K</kbd>
            </button>

            {/* Global import — available on every tab */}
            <button onClick={() => setImportOpen(true)}
              title="Import trades, positions, a watchlist, or price history"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-indigo-500/50 text-indigo-500 dark:text-indigo-400 hover:bg-indigo-500/10 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" /></svg>
              <span className="hidden sm:inline">Import</span>
            </button>

            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" title="System Active" />
          </div>
        </header>
        <div className="p-6">{children}</div>
      </main>

      {/* Command Palette (Cmd+K) */}
      {cmdOpen && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
          <div className="absolute inset-0 bg-black/60" onClick={() => setCmdOpen(false)} />
          <div className="relative w-full max-w-lg rounded-2xl border border-[var(--card-border)] shadow-2xl overflow-hidden" style={{ background: "var(--card)" }}>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--card-border)]">
              <svg className="w-5 h-5 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              <input
                ref={cmdInputRef}
                type="text" value={cmdQuery} onChange={(e) => setCmdQuery(e.target.value)}
                placeholder="Navigate to…"
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder-[var(--muted)]"
              />
              <kbd className="text-[10px] text-[var(--muted)] bg-[var(--input-bg)] px-1.5 py-0.5 rounded border border-[var(--input-border)]">ESC</kbd>
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {filteredNav
                .map(item => {
                  const isActive = pathname === item.href;
                  return (
                    <Link key={item.href} href={item.href}
                      onClick={() => setCmdOpen(false)}
                      className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                        isActive
                          ? "bg-indigo-600/15 text-indigo-600 dark:text-indigo-400"
                          : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
                      }`}>
                      {item.icon}
                      <span>{item.label}</span>
                      {isActive && <span className="ml-auto text-[10px] text-[var(--muted)]">current</span>}
                    </Link>
                  );
                })}
              {filteredSymbols.length > 0 && (
                <>
                  <p className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">Symbols</p>
                  {filteredSymbols.slice(0, 30).map((h) => (
                    <Link key={h.symbol} href={symbolHref(h)}
                      onClick={() => { dispatchSearch(h.symbol); setCmdOpen(false); }}
                      className="flex items-center gap-3 px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] transition-colors">
                      <span className="font-bold text-[var(--foreground)] w-16">{h.symbol}</span>
                      <span className="text-[11px] text-[var(--muted)]">{symbolSources(h)}</span>
                      <span className="ml-auto text-[10px] text-[var(--muted)]">open →</span>
                    </Link>
                  ))}
                </>
              )}
              {filteredNav.length === 0 && filteredSymbols.length === 0 && (
                <p className="text-sm text-[var(--muted)] text-center py-8">No matching symbols or pages</p>
              )}
            </div>
          </div>
        </div>
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { if (typeof window !== "undefined") window.dispatchEvent(new Event("stockfolio:data-changed")); }}
      />
    </div>
  );
}
