"use client";

// ─── PanelBoard + ChartPanel ─────────────────────────────────────────────
// A draggable board for dashboard cards and charts:
//   • drag the grip to reorder (dnd-kit, pointer + keyboard)
//   • minimize (−) collapses a panel to its header
//   • maximize (⤢) opens it fullscreen with bigger charts
// Order + collapsed state persist per board in localStorage, so the layout
// the user builds survives reloads.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface PanelLayoutState {
  order: string[];
  collapsed: Record<string, boolean>;
}

const STORAGE_PREFIX = "panel-layout:";

function loadLayout(key: string): PanelLayoutState | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PanelLayoutState;
    if (Array.isArray(parsed?.order)) {
      return { order: parsed.order, collapsed: parsed.collapsed ?? {} };
    }
  } catch { /* corrupted — fall back to defaults */ }
  return null;
}

function saveLayout(key: string, state: PanelLayoutState) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state)); } catch { /* full/hidden */ }
  // Also persist to SQLite via the layouts API so the layout syncs across
  // devices pointed at the same portfolio.db. Fire-and-forget: localStorage
  // keeps the UI instant, the server call settles in the background.
  fetch("/api/layouts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boardKey: key, order: state.order, collapsed: state.collapsed }),
  }).catch(() => { /* offline / local-only — localStorage still has it */ });
}

interface BoardCtx {
  collapsed: Record<string, boolean>;
  toggleCollapse: (id: string) => void;
  orderIndex: (id: string) => number;
}

const BoardContext = createContext<BoardCtx | null>(null);

/**
 * Board wrapper: keeps DOM order stable but renders panels in the saved
 * order via CSS `order`, so drag-reorder never fights React's child order.
 */
export function PanelBoard({ boardKey, ids, className = "grid grid-cols-1 xl:grid-cols-2 gap-6", children }: {
  boardKey: string;
  ids: string[];
  className?: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<PanelLayoutState>({ order: ids, collapsed: {} });

  // Restore saved layout after mount (localStorage is client-only, and
  // restoring during render would desync SSR hydration). Both restores run
  // inside async callbacks: setting state synchronously in an effect body
  // forces an extra cascading render on every mount — which is exactly what
  // react-hooks/set-state-in-effect flags.
  useEffect(() => {
    const known = new Set(ids);
    let cancelled = false;
    const orderOf = (saved: PanelLayoutState): PanelLayoutState => ({
      order: [...saved.order.filter((id) => known.has(id)), ...ids.filter((id) => !saved.order.includes(id))],
      collapsed: saved.collapsed,
    });
    // 1. Device layout: applied when the server answer settles (or rejects),
    //    so the effect body itself never writes state.
    const applyLocal = () => {
      if (cancelled) return;
      const local = loadLayout(boardKey);
      if (local) setState(orderOf(local));
    };
    // 2. Authoritative: SQLite via /api/layouts — the same DB is shared by
    // every device pointing at this portfolio.db, so the server layout wins
    // when one exists (e.g. rearranged on another machine).
    fetch("/api/layouts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        applyLocal();
        if (cancelled || !d) return;
        const server = d?.layouts?.[boardKey];
        if (!server || !Array.isArray(server.order)) return;
        setState((prev) => ({
          order: [
            ...server.order.filter((id: string) => known.has(id)),
            ...ids.filter((id: string) => !server.order.includes(id)),
          ],
          // keep local collapse state if the server entry has none
          collapsed: server.collapsed ?? prev.collapsed,
        }));
      })
      .catch(() => applyLocal()); // offline: the device layout is all there is
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey]);

  const sensors = useSensors(
    // distance: 6 so clicking the header buttons never starts a drag
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setState((prev) => {
      const oldIndex = prev.order.indexOf(String(active.id));
      const newIndex = prev.order.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = { ...prev, order: arrayMove(prev.order, oldIndex, newIndex) };
      saveLayout(boardKey, next);
      return next;
    });
  }, [boardKey]);

  const toggleCollapse = useCallback((id: string) => {
    setState((prev) => {
      const next = { ...prev, collapsed: { ...prev.collapsed, [id]: !prev.collapsed[id] } };
      saveLayout(boardKey, next);
      return next;
    });
  }, [boardKey]);

  const ctx = useMemo<BoardCtx>(() => ({
    collapsed: state.collapsed,
    toggleCollapse,
    orderIndex: (id: string) => {
      const i = state.order.indexOf(id);
      return i < 0 ? ids.indexOf(id) : i;
    },
  }), [state, toggleCollapse, ids]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={state.order} strategy={rectSortingStrategy}>
        <BoardContext.Provider value={ctx}>
          <div className={className}>{children}</div>
        </BoardContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

// ─── Inline icons (no icon lib in this project) ──────────────────
const GripIcon = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden>
    <circle cx="3" cy="3" r="1.4" /><circle cx="9" cy="3" r="1.4" />
    <circle cx="3" cy="8" r="1.4" /><circle cx="9" cy="8" r="1.4" />
    <circle cx="3" cy="13" r="1.4" /><circle cx="9" cy="13" r="1.4" />
  </svg>
);
const MinusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M5 12h14" />
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

/**
 * A dashboard card: draggable header grip, minimize, maximize (fullscreen).
 * Must live inside a PanelBoard to participate in drag-reorder; outside a
 * board it still minimizes/maximizes.
 */
export function ChartPanel({ id, title, subtitle, right, className = "", bodyClassName = "", children }: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  /** extra classes for the panel itself (grid spans, glow, …) */
  className?: string;
  /** extra classes for the body wrapper */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const ctx = useContext(BoardContext);
  const collapsed = ctx?.collapsed[id] ?? false;
  const order = ctx?.orderIndex(id) ?? 0;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const [maximized, setMaximized] = useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    order,
    zIndex: isDragging ? 40 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  const controls = (extra?: ReactNode) => (
    <>
      {right}
      {extra}
      <button
        onClick={() => ctx?.toggleCollapse(id)}
        title={collapsed ? "Expand panel" : "Minimize panel"}
        className="p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] transition-colors"
      >
        {collapsed ? <PlusIcon /> : <MinusIcon />}
      </button>
      {!maximized && (
        <button
          onClick={() => setMaximized(true)}
          title="Maximize panel"
          className="p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] transition-colors"
        >
          <ExpandIcon />
        </button>
      )}
    </>
  );

  const panel = (
    <div
      ref={setNodeRef}
      style={style}
      className={`glass rounded-2xl p-5 ${className}`}
    >
      <div className="flex items-center gap-2 mb-4">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-[var(--muted)] hover:text-[var(--foreground)] touch-none shrink-0"
          title="Drag to move panel"
          aria-label={`Drag ${typeof title === "string" ? title : "panel"}`}
        >
          <GripIcon />
        </button>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{title}</h3>
          {subtitle && <p className="text-[11px] text-[var(--muted)] truncate">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {controls()}
        </div>
      </div>
      {collapsed ? (
        <p className="text-xs text-[var(--muted)]">Minimized — click + to expand.</p>
      ) : (
        <div className={bodyClassName}>{children}</div>
      )}
    </div>
  );

  return (
    <>
      {panel}
      {maximized && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm p-3 sm:p-6"
          onClick={() => setMaximized(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="glass rounded-2xl p-5 h-full max-w-[1500px] mx-auto overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold truncate">{title}</h3>
                {subtitle && <p className="text-xs text-[var(--muted)] truncate">{subtitle}</p>}
              </div>
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {right}
                <button
                  onClick={() => setMaximized(false)}
                  title="Close fullscreen"
                  className="p-1.5 rounded-md text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--card-hover)] transition-colors"
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            {/* maximized-body lets CSS grow charts to fill the screen */}
            <div className="maximized-body">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
