// Price-basis guard: a cached series may only be EXTENDED by a fetch on the
// same basis. Yahoo is dividend-adjusted, Nasdaq/Stooq are raw — splicing them
// corrupts every indicator and every backtest that reads the cache.
//
// The subtle case this pins: a cache whose `price_meta.source` is NULL (written
// before the column existed) has an UNKNOWN basis. It must be replaced, not
// extended, because the two bases cannot be proven equal.

import { describe, it, expect } from "vitest";
import { basisMismatch } from "../src/lib/market-data";

describe("basisMismatch", () => {
  it("never replaces when there is nothing cached", () => {
    expect(basisMismatch(0, null, "yahoo")).toBe(false);
    expect(basisMismatch(0, "yahoo", "nasdaq")).toBe(false);
  });

  it("extends a cache that came from the same source", () => {
    expect(basisMismatch(5000, "yahoo", "yahoo")).toBe(false);
    expect(basisMismatch(5000, "import", "import")).toBe(false);
  });

  it("replaces when the provider changes (different price basis)", () => {
    expect(basisMismatch(5000, "yahoo", "nasdaq")).toBe(true);
    expect(basisMismatch(5000, "nasdaq", "yahoo")).toBe(true);
    expect(basisMismatch(5000, "stooq", "yahoo")).toBe(true);
  });

  it("treats an UNKNOWN cached basis as a mismatch, never as a match", () => {
    expect(basisMismatch(5000, null, "yahoo")).toBe(true);
    expect(basisMismatch(5000, undefined, "yahoo")).toBe(true);
  });

  it("ignores a nonsensical bar count", () => {
    expect(basisMismatch(Number.NaN, "yahoo", "nasdaq")).toBe(false);
    expect(basisMismatch(-1, "yahoo", "nasdaq")).toBe(false);
  });
});
