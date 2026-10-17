"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import {
  A_STRATEGIES,
  C_STRATEGIES,
  ALL_STRATEGIES,
  TAXONOMY,
  CATEGORY_DISPLAY_NAMES,
} from "@/lib/strategies-data";

const PAGE_SIZE = 21;

export default function StrategiesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background p-4">Loading strategies...</div>}>
      <StrategiesContent />
    </Suspense>
  );
}

function StrategiesContent() {
  const searchParams = useSearchParams();

  const [categoryFilter, setCategoryFilter] = useState<string | null>(
    searchParams.get("cat")
  );
  const [shariahFilter, setShariahFilter] = useState<string | null>(
    searchParams.get("sh")
  );
  const [taxRegFilter, setTaxRegFilter] = useState<{
    tax?: string;
    reg?: string;
  } | null>(
    searchParams.get("tax") || searchParams.get("reg")
      ? {
          tax: searchParams.get("tax") ?? undefined,
          reg: searchParams.get("reg") ?? undefined,
        }
      : null
  );
  const [page, setPage] = useState(1);

  const strategies = useMemo(
    () =>
      ALL_STRATEGIES.filter((s) => {
        if (categoryFilter && s.cat !== categoryFilter) return false;
        if (shariahFilter && s.sh !== shariahFilter) return false;
        if (taxRegFilter?.tax && s.tax !== taxRegFilter.tax) return false;
        if (taxRegFilter?.reg && s.reg !== taxRegFilter.reg) return false;
        return true;
      }),
    [categoryFilter, shariahFilter, taxRegFilter]
  );

  const categories = useMemo(
    () => [...new Set(ALL_STRATEGIES.map((s) => s.cat))].sort(),
    []
  );
  const taxOptions = useMemo(
    () => [...new Set(ALL_STRATEGIES.map((s) => s.tax).filter(Boolean))].sort(),
    []
  );

  const totalPages = Math.ceil(strategies.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  const pageStrategies = strategies.slice(start, start + PAGE_SIZE);

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Investment Strategies</h1>
          <p className="text-muted-foreground text-lg">
            {ALL_STRATEGIES.length} strategies across{" "}
            {Object.keys(TAXONOMY).length} categories
          </p>
        </header>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium mb-1">Category</label>
            <select
              value={categoryFilter ?? ""}
              onChange={(e) => {
                setCategoryFilter(e.target.value || null);
                setPage(1);
              }}
              className="w-full rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {CATEGORY_DISPLAY_NAMES[
                    cat as keyof typeof CATEGORY_DISPLAY_NAMES
                  ] || cat}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Shariah Compliance
            </label>
            <select
              value={shariahFilter ?? ""}
              onChange={(e) => {
                setShariahFilter(e.target.value || null);
                setPage(1);
              }}
              className="w-full rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">All</option>
              {["Compliant", "Case-by-case", "Non-compliant", "Avoid"].map(
                (compliance) => (
                  <option key={compliance} value={compliance}>
                    {compliance}
                  </option>
                )
              )}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Tax Treatment
            </label>
            <select
              value={taxRegFilter?.tax ?? ""}
              onChange={(e) => {
                setTaxRegFilter((prev) => ({
                  ...prev,
                  tax: e.target.value || undefined,
                }));
                setPage(1);
              }}
              className="w-full rounded border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">All Tax Treatments</option>
              {taxOptions.map((tax) => (
                <option key={tax} value={tax}>
                  {tax}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Strategies Table */}
        <div className="overflow-x-auto rounded-lg border bg-card border-shadow">
          <table className="min-w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  ID
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Category
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Tax
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Regulatory
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Shariah
                </th>
              </tr>
            </thead>
            <tbody>
              {pageStrategies.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border hover:bg-accent/20"
                >
                  <td className="p-3 font-mono text-sm">{s.id}</td>
                  <td className="p-3">
                    <Link
                      href={`/strategy/${s.id}`}
                      className="text-primary hover:underline"
                    >
                      {s.n}
                    </Link>
                  </td>
                  <td className="p-3 text-sm">{s.cat}</td>
                  <td className="p-3 text-xs">{s.tax || "—"}</td>
                  <td className="p-3 text-xs">{s.reg || "—"}</td>
                  <td className="p-3 text-xs">{s.sh || "—"}</td>
                </tr>
              ))}
              {pageStrategies.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="p-6 text-center text-sm text-muted-foreground"
                  >
                    No strategies match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-6 flex justify-center gap-2">
            {[...Array(totalPages).keys()].map((i) => (
              <button
                key={i}
                onClick={() => setPage(i + 1)}
                className={`px-4 py-2 rounded ${
                  page === i + 1 ? "bg-primary text-primary-foreground" : ""
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}

        {/* Summary stats at bottom */}
        <div className="mt-6 p-4 bg-card border-border">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Total</div>
              <div className="text-lg font-bold">
                {ALL_STRATEGIES.length}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Cash &amp; Credit</div>
              <div className="text-lg font-bold">{A_STRATEGIES.length}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Crypto / Digital</div>
              <div className="text-lg font-bold">{C_STRATEGIES.length}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Categories</div>
              <div className="text-lg font-bold">
                {Object.keys(TAXONOMY).length}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
