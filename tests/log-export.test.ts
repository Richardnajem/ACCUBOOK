import { describe, expect, it } from "vitest";
import { errorLogFileName, errorLogRows, errorLogsToCSV, errorLogsToJSON } from "../src/lib/log-export";
import type { ErrorLogEntry } from "../src/lib/errorLogger";

function entry(overrides: Partial<ErrorLogEntry> = {}): ErrorLogEntry {
  return {
    id: "abc123",
    timestamp: "2026-01-05T09:07:00.000Z",
    level: "error",
    source: "console.error",
    message: "Quote failed",
    count: 1,
    url: "http://localhost:3000/dashboard/holdings",
    stack: undefined,
    ...overrides,
  };
}

describe("log export", () => {
  it("maps each entry to a row with every exported field", () => {
    const [row] = errorLogRows([entry({ count: 4, stack: "Error: boom\n  at x" })]);
    expect(row).toEqual([
      "2026-01-05T09:07:00.000Z",
      "error",
      "console.error",
      "Quote failed",
      "4",
      "http://localhost:3000/dashboard/holdings",
      "Error: boom\n  at x",
    ]);
  });

  it("writes a blank stack rather than the string 'undefined'", () => {
    const [row] = errorLogRows([entry()]);
    expect(row[6]).toBe("");
  });

  it("quotes messages containing commas, quotes and newlines", () => {
    const csv = errorLogsToCSV([entry({ message: 'Quote failed for "AAPL", retrying' })]);
    const [, row] = csv.split("\n");
    expect(row).toContain('"Quote failed for ""AAPL"", retrying"');
  });

  it("keeps a header-only CSV for an empty log", () => {
    const csv = errorLogsToCSV([]);
    expect(csv).toBe("Timestamp,Level,Source,Message,Occurrences,URL,Stack");
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("exports JSON that round-trips with the count and full entries", () => {
    const payload = JSON.parse(errorLogsToJSON([entry({ count: 2, stack: "Error: boom" })]));
    expect(payload.count).toBe(1);
    expect(payload.kind).toBe("error-log");
    expect(payload.entries[0].message).toBe("Quote failed");
    expect(payload.entries[0].count).toBe(2);
    expect(payload.entries[0].stack).toBe("Error: boom");
    expect(typeof payload.exportedAt).toBe("string");
  });

  it("names files with the format and a sortable timestamp", () => {
    const now = new Date(2026, 0, 5, 9, 7);
    expect(errorLogFileName("csv", now)).toBe("stockfolio-error-log-20260105-0907.csv");
    expect(errorLogFileName("json", now)).toBe("stockfolio-error-log-20260105-0907.json");
  });
});
