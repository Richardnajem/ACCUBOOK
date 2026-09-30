"use client";

import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface UndoEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

interface UndoRedoContextType {
  push: (entry: UndoEntry) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  history: string[];
}

const UndoRedoContext = createContext<UndoRedoContextType>({
  push: () => {},
  undo: () => {},
  redo: () => {},
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  history: [],
});

export function useUndoRedo() {
  return useContext(UndoRedoContext);
}

const MAX_HISTORY = 50;

export function UndoRedoProvider({ children }: { children: ReactNode }) {
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const [redoStack, setRedoStack] = useState<UndoEntry[]>([]);

  const push = useCallback((entry: UndoEntry) => {
    setUndoStack(prev => {
      const next = [...prev, entry];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    // Any new action clears the redo stack
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    entry.undo();
    setUndoStack(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, entry]);
  }, [undoStack]);

  const redo = useCallback(() => {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    entry.redo();
    setRedoStack(prev => prev.slice(0, -1));
    setUndoStack(prev => [...prev, entry]);
  }, [redoStack]);

  return (
    <UndoRedoContext.Provider
      value={{
        push,
        undo,
        redo,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : null,
        redoLabel: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : null,
        history: [...undoStack.map(e => e.label)],
      }}
    >
      {children}
    </UndoRedoContext.Provider>
  );
}
