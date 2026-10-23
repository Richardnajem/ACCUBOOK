"use client";

import Link from "next/link";

const TABS = [
  { key: "all", label: "All strategies", href: "/strategies" },
  { key: "top", label: "Top 5 per category", href: "/strategies/top" },
] as const;

export function CatalogueTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="inline-flex rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-1 gap-1">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            active === tab.key
              ? "bg-indigo-600/15 text-indigo-500 dark:text-indigo-400"
              : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)]"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
