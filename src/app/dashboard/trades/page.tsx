"use client";

import { useCallback, useEffect, useState } from "react";
import { SortableTable, Column } from "@/components/SortableTable";
import ImportDialog from "@/components/ImportDialog";
import { useUndoRedo } from "@/lib/undo-redo";
import { downloadCSV } from "@/lib/export";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

interface Trade {
  id: number;
  date: string;
  type: string;
  symbol: string | null;
  shares: number | null;
  price: number | null;
  fees: number;
  notes: string | null;
  created_at: string;
}

const TYPE_STYLES: Record<string, string> = {
  buy: "bg-green-500/10 text-[var(--success)]",
  sell: "bg-red-500/10 text-[var(--danger)]",
  dividend: "bg-blue-500/10 text-blue-500 dark:text-blue-400",
  deposit: "bg-indigo-500/10 text-indigo-500 dark:text-indigo-400",
  withdrawal: "bg-amber-500/10 text-[var(--warning)]",
  fee: "bg-zinc-500/10 text-[var(--muted)]",
};

const TYPE_OPTIONS = [
  { value: "buy", label: "Buy", needsSymbol: true, needsShares: true, priceLabel: "Price / Share" },
  { value: "sell", label: "Sell", needsSymbol: true, needsShares: true, priceLabel: "Price / Share" },
  { value: "dividend", label: "Dividend", needsSymbol: true, needsShares: false, priceLabel: "Amount" },
  { value: "deposit", label: "Deposit", needsSymbol: false, needsShares: false, priceLabel: "Amount" },
  { value: "withdrawal", label: "Withdrawal", needsSymbol: false, needsShares: false, priceLabel: "Amount" },
  { value: "fee", label: "Fee", needsSymbol: false, needsShares: false, priceLabel: "Amount" },
];

const EMPTY_FORM = {
  date: new Date().toISOString().split("T")[0],
  type: "buy",
  symbol: "",
  shares: "",
  price: "",
  fees: "",
  notes: "",
};

export default function TradesPage() {
  const [rows, setRows] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Trade | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Trade | null>(null);
  const { push } = useUndoRedo();

  const load = useCallback(() => {
    fetch("/api/trades", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setRows(d.trades || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const typeDef = TYPE_OPTIONS.find((t) => t.value === form.type) ?? TYPE_OPTIONS[0];
  const needsSymbol = typeDef.needsSymbol;
  const needsShares = typeDef.needsShares;

  const openAdd = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setError("");
    setShowForm(true);
  };

  const openEdit = (t: Trade) => {
    setEditing(t);
    setForm({
      date: t.date,
      type: t.type,
      symbol: t.symbol ?? "",
      shares: t.shares?.toString() ?? "",
      price: t.price?.toString() ?? "",
      fees: t.fees?.toString() ?? "",
      notes: t.notes ?? "",
    });
    setError("");
    setShowForm(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const payload: Record<string, unknown> = {
      date: form.date,
      type: form.type,
      symbol: needsSymbol ? form.symbol.trim().toUpperCase() : null,
      shares: needsShares ? Number(form.shares) : null,
      price: Number(form.price),
      fees: Number(form.fees || 0),
      notes: form.notes || null,
    };

    try {
      const res = await fetch(editing ? `/api/trades/${editing.id}` : "/api/trades", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      const newTradeId: number | undefined = data.tradeId;

      // Undo/redo: restore previous state on undo
      push({
        label: editing ? `Edit ${form.type} ${form.symbol || ""}`.trim() : `Add ${form.type} ${form.symbol || ""}`.trim(),
        undo: async () => {
          if (editing) {
            await fetch(`/api/trades/${editing.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                date: editing.date,
                type: editing.type,
                symbol: editing.symbol,
                shares: editing.shares,
                price: editing.price,
                fees: editing.fees,
                notes: editing.notes,
              }),
            });
          } else if (newTradeId) {
            await fetch(`/api/trades/${newTradeId}`, { method: "DELETE" }).catch(() => {});
          }
          load();
        },
        redo: async () => {
          if (editing) {
            await fetch(`/api/trades/${editing.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          } else {
            await fetch("/api/trades", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          }
          load();
        },
      });

      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trade");
    } finally {
      setSubmitting(false);
    }
  };

  const doDelete = async (t: Trade) => {
    await fetch(`/api/trades/${t.id}`, { method: "DELETE" });
    push({
      label: `Delete ${t.type} ${t.symbol || ""}`.trim(),
      undo: async () => {
        await fetch("/api/trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: t.date, type: t.type, symbol: t.symbol,
            shares: t.shares, price: t.price, fees: t.fees, notes: t.notes,
          }),
        });
        load();
      },
      redo: async () => {
        await fetch(`/api/trades/${t.id}`, { method: "DELETE" });
        load();
      },
    });
    setConfirmDelete(null);
    load();
  };

  const columns: Column<Trade>[] = [
    { key: "date", header: "Date", render: (r) => r.date },
    {
      key: "type", header: "Type", filterable: true, filterOptions: Object.keys(TYPE_STYLES),
      render: (r) => (
        <span className={`px-2 py-1 rounded text-xs font-medium capitalize ${TYPE_STYLES[r.type] ?? ""}`}>{r.type}</span>
      ),
    },
    { key: "symbol", header: "Symbol", render: (r) => (r.symbol ? <span className="font-bold">{r.symbol}</span> : <span className="text-[var(--muted)]">—</span>) },
    { key: "shares", header: "Shares", align: "right", render: (r) => (r.shares != null ? r.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—") },
    { key: "price", header: "Price / Amount", align: "right", render: (r) => (r.price != null ? fmt(r.price) : "—") },
    { key: "fees", header: "Fees", align: "right", render: (r) => (r.fees ? fmt(r.fees) : "—") },
    {
      key: "value", header: "Value", align: "right",
      render: (r) => (r.shares != null && r.price != null ? fmt(r.shares * r.price) : fmt(r.price ?? 0)),
    },
    { key: "notes", header: "Notes", render: (r) => <span className="text-[var(--muted)] max-w-xs truncate block">{r.notes || "—"}</span> },
    {
      key: "actions", header: "", sortable: false, align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button onClick={(e) => { e.stopPropagation(); openEdit(r); }} className="p-1.5 text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] rounded" title="Edit">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </button>
          <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(r); }} className="p-1.5 text-[var(--muted)] hover:text-red-500 hover:bg-red-500/10 rounded" title="Delete">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      ),
    },
  ];

  const exportCSV = () => {
    const headers = ["Date", "Type", "Symbol", "Shares", "Price", "Fees", "Value", "Notes"];
    const csvRows = rows.map((t) => [
      t.date, t.type, t.symbol ?? "", t.shares ?? "", t.price ?? "", t.fees,
      t.shares != null && t.price != null ? t.shares * t.price : t.price ?? 0, t.notes ?? "",
    ]);
    downloadCSV("trades.csv", headers, csvRows);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Trade Log</h2>
          <p className="text-sm text-[var(--muted)]">Every buy, sell, dividend, and cash movement</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} className="px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)] border border-[var(--card-border)]">
            Export CSV
          </button>
          <button onClick={() => setImportOpen(true)} className="px-4 py-2 text-sm font-medium rounded-lg border border-indigo-500/50 text-indigo-500 dark:text-indigo-400 hover:bg-indigo-500/10">
            Import
          </button>
          <button onClick={openAdd} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg">
            + Record Trade
          </button>
        </div>
      </div>

      <div className="glass rounded-xl p-5">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <SortableTable
            columns={columns}
            data={rows}
            searchKey="symbol"
            searchPlaceholder="Search symbol, notes…"
            emptyMessage="No trades recorded yet — add one or import from your broker."
          />
        )}
      </div>

      {/* Add/Edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowForm(false)} />
          <form onSubmit={submit} className="relative glass rounded-2xl w-full max-w-lg p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">{editing ? "Edit Trade" : "Record Trade"}</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                >
                  {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Date</label>
                <input
                  type="date" required value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
              {needsSymbol && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Symbol</label>
                  <input
                    required value={form.symbol}
                    onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
                    placeholder="AAPL"
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm uppercase focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              )}
              {needsShares && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Shares</label>
                  <input
                    required type="number" step="any" min="0" value={form.shares}
                    onChange={(e) => setForm({ ...form, shares: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              )}
              <div className={needsShares ? "" : "col-span-2"}>
                <label className="block text-xs text-[var(--muted)] mb-1">{typeDef.priceLabel}</label>
                <input
                  required type="number" step="any" min="0" value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
              {needsShares && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Fees</label>
                  <input
                    type="number" step="any" min="0" value={form.fees}
                    onChange={(e) => setForm({ ...form, fees: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                  />
                </div>
              )}
              <div className="col-span-2">
                <label className="block text-xs text-[var(--muted)] mb-1">Notes</label>
                <input
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Optional"
                  className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}

            <div className="flex items-center justify-end gap-2 mt-6">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg">
                {submitting ? "Saving…" : editing ? "Save Changes" : "Record Trade"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmDelete(null)} />
          <div className="relative glass rounded-2xl w-full max-w-sm p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-2">Delete trade?</h3>
            <p className="text-sm text-[var(--muted)] mb-1">
              {confirmDelete.date} — {confirmDelete.type} {confirmDelete.symbol ?? ""} {confirmDelete.shares ?? ""} @ {confirmDelete.price != null ? fmt(confirmDelete.price) : ""}
            </p>
            <p className="text-xs text-[var(--muted)] mb-5">You can undo this with Ctrl+Z.</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--card-hover)]">
                Cancel
              </button>
              <button onClick={() => doDelete(confirmDelete)} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={load} />
    </div>
  );
}
