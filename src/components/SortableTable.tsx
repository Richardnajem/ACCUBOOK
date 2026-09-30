"use client";

import { useState, useMemo, ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  filterable?: boolean;
  filterOptions?: string[];
  render?: (row: T, index: number) => ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
}

interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

interface FilterConfig {
  [key: string]: string;
}

interface SortableTableProps<T> {
  columns: Column<T>[];
  data: T[];
  searchPlaceholder?: string;
  searchKey?: string;
  emptyMessage?: string;
  footer?: ReactNode;
  className?: string;
  onRowClick?: (row: T) => void;
  rowKey?: (row: T, index: number) => string | number;
}

export function SortableTable<T extends object>({
  columns,
  data,
  searchPlaceholder,
  searchKey,
  emptyMessage = "No data found",
  footer,
  className = "",
  onRowClick,
  rowKey,
}: SortableTableProps<T>) {
  const [sort, setSort] = useState<SortConfig | null>(null);
  const [filters, setFilters] = useState<FilterConfig>({});
  const [search, setSearch] = useState("");

  const handleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return prev.direction === "asc" ? { key, direction: "desc" } : null;
      }
      return { key, direction: "asc" };
    });
  };

  const setFilter = (key: string, value: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === "" || value === "all") {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const processedData = useMemo(() => {
    let result = [...data];

    // Search
    if (search && searchKey) {
      const q = search.toLowerCase();
      result = result.filter((row) => {
        const val = (row as Record<string, unknown>)[searchKey];
        return val != null && String(val).toLowerCase().includes(q);
      });
    }

    // Column filters
    for (const [key, value] of Object.entries(filters)) {
      if (value) {
        result = result.filter((row) => {
          const val = (row as Record<string, unknown>)[key];
          return val != null && String(val).toLowerCase() === value.toLowerCase();
        });
      }
    }

    // Sort
    if (sort) {
      result.sort((a, b) => {
        const aVal = (a as Record<string, unknown>)[sort.key];
        const bVal = (b as Record<string, unknown>)[sort.key];
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        if (typeof aVal === "number" && typeof bVal === "number") {
          return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
        }
        const cmp = String(aVal).localeCompare(String(bVal));
        return sort.direction === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [data, sort, filters, search, searchKey]);

  const activeFilterCount = Object.keys(filters).length + (search ? 1 : 0);

  const alignClass = (align?: string) => {
    if (align === "right") return "text-right";
    if (align === "center") return "text-center";
    return "text-left";
  };

  // Inner content of <th> is a flex row, so mirror the column alignment there
  const headerJustify = (align?: string) => {
    if (align === "right") return "justify-end";
    if (align === "center") return "justify-center";
    return "";
  };

  const sortIcon = (key: string) => {
    if (sort?.key !== key) return <span className="text-[var(--muted)] opacity-30">↕</span>;
    return <span className="text-[var(--primary)]">{sort.direction === "asc" ? "↑" : "↓"}</span>;
  };

  return (
    <div className={className}>
      {/* Toolbar: search + active filters */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {searchKey && (
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder || "Search..."}
              className="w-full pl-9 pr-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm placeholder-zinc-500 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
          </div>
        )}
        {activeFilterCount > 0 && (
          <button
            onClick={() => { setFilters({}); setSearch(""); }}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[var(--danger)] hover:bg-red-500/10 rounded-lg transition-colors"
          >
            ✕ Clear {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
          </button>
        )}
        <span className="text-xs text-[var(--muted)] ml-auto">{processedData.length} rows</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[var(--muted)] border-b border-[var(--card-border)]">
              {columns.map((col) => (
                <th key={col.key} className={`${alignClass(col.align)} py-2 font-medium`}>
                  <div className={`flex items-center gap-1 flex-wrap ${headerJustify(col.align)}`}>
                    {col.sortable !== false ? (
                      <button
                        onClick={() => handleSort(col.key)}
                        className="sort-btn flex items-center gap-1 font-medium"
                      >
                        {col.header}
                        {sortIcon(col.key)}
                      </button>
                    ) : (
                      col.header
                    )}
                  </div>
                  {col.filterable && col.filterOptions && (
                    <div className="mt-1">
                      <select
                        value={filters[col.key] || ""}
                        onChange={(e) => setFilter(col.key, e.target.value)}
                        className="w-full px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                      >
                        <option value="">All</option>
                        {col.filterOptions.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {processedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-12 text-center text-[var(--muted)]">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              processedData.map((row, idx) => (
                <tr
                  key={rowKey ? rowKey(row, idx) : idx}
                  onClick={() => onRowClick?.(row)}
                  className={`border-b border-[var(--card-border)] hover:bg-[var(--table-row-hover)] transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={`py-2.5 ${alignClass(col.align)} ${col.className || ""}`}>
                      {col.render ? col.render(row, idx) : String((row as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}
