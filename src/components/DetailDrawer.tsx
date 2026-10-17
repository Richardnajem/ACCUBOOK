"use client";

// A reusable right-hand slide-over for "click a thing, see its details".
//
// Pages build `sections` from data they already hold, so nothing here invents
// values — a row that has no real reading simply isn't rendered. `value` rows
// take a ReactNode, so callers can pass formatted numbers, badges, or links.

import { ReactNode, useEffect } from "react";

export interface DetailRow {
  label: string;
  value: ReactNode;
  /** Colour hint: pos = green, neg = red, muted = dim. */
  tone?: "pos" | "neg" | "muted";
}

export interface DetailSection {
  heading?: string;
  rows?: DetailRow[];
  /** Arbitrary content (tables, charts, lists) rendered under the rows. */
  body?: ReactNode;
}

/** Green when ≥ 0, red otherwise — the usual sign colouring for a detail row. */
export const toneOf = (n: number): DetailRow["tone"] => (n >= 0 ? "pos" : "neg");

export interface DetailAction {
  label: string;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "ghost";
}

export default function DetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  badges,
  sections,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  sections?: DetailSection[];
  actions?: DetailAction[];
  /** Extra content rendered after all sections (charts, raw tables, …). */
  children?: ReactNode;
}) {
  // Escape closes the drawer (matching the other modals).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toneClass = (tone?: DetailRow["tone"]) =>
    tone === "pos" ? "text-[var(--success)]"
    : tone === "neg" ? "text-[var(--danger)]"
    : tone === "muted" ? "text-[var(--muted)]"
    : "";

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside
        role="dialog"
        aria-label={typeof title === "string" ? title : "Details"}
        className="absolute inset-y-0 right-0 w-full sm:max-w-lg bg-[var(--card)] border-l border-[var(--card-border)] shadow-2xl flex flex-col"
      >
        {/* Header */}
        <div className="p-5 border-b border-[var(--card-border)] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold truncate">{title}</h3>
            {subtitle && <p className="text-xs text-[var(--muted)] mt-0.5">{subtitle}</p>}
            {badges && <div className="flex items-center gap-1.5 flex-wrap mt-2">{badges}</div>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close details"
            className="shrink-0 p-1.5 -mr-1.5 text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {(sections ?? []).map((section, i) => (
            <div key={i}>
              {section.heading && (
                <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-2">{section.heading}</p>
              )}
              {section.rows && section.rows.length > 0 && (
                <div className="rounded-xl border border-[var(--card-border)] divide-y divide-[var(--card-border)]">
                  {section.rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                      <span className="text-[var(--muted)]">{row.label}</span>
                      <span className={`font-medium tabular-nums text-right ${toneClass(row.tone)}`}>{row.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {section.body && <div className={section.rows && section.rows.length > 0 ? "mt-2" : ""}>{section.body}</div>}
            </div>
          ))}
          {children}
        </div>

        {/* Actions */}
        {actions && actions.length > 0 && (
          <div className="p-4 border-t border-[var(--card-border)] flex items-center justify-end gap-2">
            {actions.map((a) =>
              a.href ? (
                <a
                  key={a.label}
                  href={a.href}
                  target="_blank"
                  rel="noreferrer"
                  className={actionClass(a.variant)}
                >
                  {a.label}
                </a>
              ) : (
                <button key={a.label} onClick={a.onClick} className={actionClass(a.variant)}>
                  {a.label}
                </button>
              ),
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function actionClass(variant?: DetailAction["variant"]) {
  return variant === "primary"
    ? "px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg"
    : "px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)]";
}
