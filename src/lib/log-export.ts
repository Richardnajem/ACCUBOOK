/**
 * Export formats for the client error log (`src/lib/errorLogger.ts`).
 *
 * The log is the app's only running log, and until now it could only be read
 * in devtools. These formatters turn it into a file a person can open, send or
 * diff — CSV for spreadsheets, JSON for everything the UI does not show
 * (stack traces, full URLs, occurrence counts).
 *
 * Pure on purpose: no DOM, no storage, so it is unit-tested directly.
 */

import type { ErrorLogEntry } from "./errorLogger";
import { csvText } from "./export";

export const ERROR_LOG_HEADERS = [
  "Timestamp",
  "Level",
  "Source",
  "Message",
  "Occurrences",
  "URL",
  "Stack",
] as const;

/** One row per logged entry, in the order given (newest first from the UI). */
export function errorLogRows(entries: ErrorLogEntry[]): string[][] {
  return entries.map((entry) => [
    entry.timestamp,
    entry.level,
    entry.source,
    entry.message,
    String(entry.count),
    entry.url ?? "",
    entry.stack ?? "",
  ]);
}

export function errorLogsToCSV(entries: ErrorLogEntry[]): string {
  return csvText([...ERROR_LOG_HEADERS], errorLogRows(entries));
}

export function errorLogsToJSON(entries: ErrorLogEntry[], now: Date = new Date()): string {
  return JSON.stringify(
    {
      app: "Stockfolio",
      kind: "error-log",
      exportedAt: now.toISOString(),
      count: entries.length,
      entries,
    },
    null,
    2,
  );
}

/** `stockfolio-error-log-20260105-0907.csv` */
export function errorLogFileName(format: "csv" | "json", now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `stockfolio-error-log-${stamp}.${format}`;
}
