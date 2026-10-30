"use client";

// ─── Market Circle ──────────────────────────────────────────────────────────
// A circular allocation view grouped by asset class or by market (quote
// currency), with cash included. The asset-class labels are yours — the panel
// says "Unclassified" instead of guessing from a ticker, and lists every open
// position with a picker so the circle can be made exact in a few clicks.
//
// Rendered as a ChartPanel, so it drags/minimises/maximises like the others and
// picks up the PNG export button automatically.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartPanel } from "@/components/PanelBoard";
import {
  ASSET_CLASSES,
  UNCLASSIFIED,
  UNKNOWN_MARKET,
  allocationTotal,
  groupAllocation,
  loadAssetClasses,
  saveAssetClass,
  type AssetClassMap,
  type GroupMode,
} from "@/lib/asset-class";

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

export interface MarketCircleRow {
  symbol: string;
  marketValue: number;
  /** Quote currency from the live feed; null when it was unavailable. */
  currency: string | null;
}

const MODES: Array<{ value: GroupMode; label: string; title: string }> = [
  { value: "class", label: "Asset class", title: "Group by the class you assigned" },
  { value: "market", label: "Market", title: "Group by the live quote's currency" },
];

export function MarketCircle({
  rows,
  cashBalance,
  className = "",
}: {
  rows: MarketCircleRow[];
  cashBalance: number;
  className?: string;
}) {
  const [mode, setMode] = useState<GroupMode>("class");
  const [classes, setClasses] = useState<AssetClassMap>({});

  // localStorage is client-only; restore after mount so the server markup and
  // the first client render agree.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) setClasses(loadAssetClasses());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(
    () => groupAllocation(rows, { mode, classes, cash: cashBalance }),
    [rows, mode, classes, cashBalance],
  );
  const total = allocationTotal(groups);
  const unclassified = rows.filter(
    (row) => row.marketValue > 0 && !classes[row.symbol.trim().toUpperCase()],
  ).length;

  const assign = useCallback((symbol: string, value: string) => {
    setClasses(saveAssetClass(symbol, value || null));
  }, []);

  return (
    <ChartPanel
      id="market-circle"
      title="Market Circle"
      subtitle={
        mode === "class"
          ? "Where your equity sits, by the asset class you assign"
          : "Where your equity sits, by the market the quote comes from"
      }
      className={className}
      right={
        <div className="flex items-center bg-[var(--card)] border border-[var(--card-border)] rounded-lg p-0.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              title={m.title}
              aria-pressed={mode === m.value}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                mode === m.value
                  ? "bg-indigo-600 text-white"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-[var(--muted)] text-center py-10">
          Nothing allocated yet. Record a trade or a deposit and the circle fills in.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
            <div className="relative h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={groups} dataKey="value" nameKey="name" innerRadius={58} outerRadius={86} paddingAngle={2}>
                    {groups.map((group) => (
                      <Cell key={group.name} fill={group.color} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "var(--card)", border: "1px solid var(--card-border)", borderRadius: "8px", fontSize: 12 }}
                    formatter={(value) => fmt(Number(value))}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Total equity</span>
                <span className="text-lg font-bold tabular-nums">{fmt(total)}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {groups.map((group) => {
                const pct = total > 0 ? (group.value / total) * 100 : 0;
                return (
                  <div key={group.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: group.color }} />
                    <span className="font-medium truncate">{group.name}</span>
                    <span className="ml-auto text-[var(--muted)] tabular-nums">{pct.toFixed(1)}%</span>
                    <span className="w-20 text-right tabular-nums">{fmt(group.value)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {mode === "class" && rows.length > 0 && (
            <div className="mt-4 border-t border-[var(--card-border)] pt-3">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <p className="text-xs font-semibold">Assign a class</p>
                <p className="text-[10px] text-[var(--muted)]">
                  {unclassified > 0
                    ? `${unclassified} of ${rows.length} unclassified — nothing is inferred`
                    : "Every position is classified"}
                </p>
              </div>
              <ul className="mt-2 max-h-44 overflow-y-auto divide-y divide-[var(--card-border)]">
                {rows.map((row) => (
                  <li key={row.symbol} className="flex items-center gap-3 py-1.5 text-xs">
                    <span className="font-bold w-16">{row.symbol}</span>
                    <span className="text-[var(--muted)] tabular-nums">{fmt(row.marketValue)}</span>
                    <select
                      aria-label={`Asset class for ${row.symbol}`}
                      value={classes[row.symbol.trim().toUpperCase()] ?? ""}
                      onChange={(event) => assign(row.symbol, event.target.value)}
                      className="ml-auto px-2 py-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="">{UNCLASSIFIED} (default)</option>
                      {ASSET_CLASSES.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
            {mode === "class"
              ? "Classes are labels you keep on this device — the app never guesses one from a ticker, so an untouched symbol stays Unclassified rather than being misfiled."
              : `Markets are the live quote's currency (${UNKNOWN_MARKET} when the feed gives none). Cash is your ledger balance.`}
          </p>
        </>
      )}
    </ChartPanel>
  );
}
