import { describe, expect, it } from "vitest";
import {
  CASH_GROUP,
  GROUP_COLORS,
  UNCLASSIFIED,
  UNKNOWN_MARKET,
  allocationTotal,
  groupAllocation,
  type AllocationRow,
} from "../src/lib/asset-class";

const rows: AllocationRow[] = [
  { symbol: "AAPL", marketValue: 6000, currency: "USD" },
  { symbol: "MSFT", marketValue: 3000, currency: "USD" },
  { symbol: "VWRL.L", marketValue: 1000, currency: "GBp" },
];

describe("groupAllocation — asset class", () => {
  it("groups by the assigned class and merges symbols that share one", () => {
    const groups = groupAllocation(rows, {
      mode: "class",
      classes: { AAPL: "Stocks", MSFT: "Stocks", "VWRL.L": "ETFs" },
    });
    expect(groups.map((g) => [g.name, g.value])).toEqual([
      ["Stocks", 9000],
      ["ETFs", 1000],
    ]);
  });

  it("keeps untouched symbols Unclassified instead of guessing", () => {
    const groups = groupAllocation(rows, { mode: "class", classes: { AAPL: "Stocks" } });
    expect(groups.find((g) => g.name === UNCLASSIFIED)?.value).toBe(4000);
    expect(groups.find((g) => g.name === "Stocks")?.value).toBe(6000);
  });

  it("matches classes case-insensitively on the symbol", () => {
    const groups = groupAllocation([{ symbol: " aapl ", marketValue: 100 }], {
      mode: "class",
      classes: { AAPL: "Stocks" },
    });
    expect(groups).toEqual([{ name: "Stocks", value: 100, color: GROUP_COLORS[0] }]);
  });

  it("adds cash as its own group", () => {
    const groups = groupAllocation(rows, { mode: "class", classes: {}, cash: 2000 });
    expect(groups.find((g) => g.name === CASH_GROUP)?.value).toBe(2000);
    expect(allocationTotal(groups)).toBe(12000);
  });

  it("ignores closed positions and zero/negative cash", () => {
    const groups = groupAllocation(
      [...rows, { symbol: "OLD", marketValue: 0, currency: "USD" }],
      { mode: "class", classes: { OLD: "Stocks" }, cash: 0 },
    );
    expect(groups.some((g) => g.name === "Old" || g.name === "OLD")).toBe(false);
    expect(allocationTotal(groups)).toBe(10000);
  });
});

describe("groupAllocation — market", () => {
  it("groups by quote currency, upper-cased", () => {
    const groups = groupAllocation(rows, { mode: "market" });
    expect(groups.map((g) => [g.name, g.value])).toEqual([
      ["USD", 9000],
      ["GBP", 1000], // GBp is the minor unit; the market is still GBP
    ]);
  });

  it("names a missing currency instead of inventing one", () => {
    const groups = groupAllocation([{ symbol: "X", marketValue: 50, currency: null }], { mode: "market" });
    expect(groups[0].name).toBe(UNKNOWN_MARKET);
  });
});

describe("groupAllocation — ordering and colours", () => {
  it("sorts largest first and assigns the palette in that order", () => {
    const groups = groupAllocation(rows, { mode: "market", cash: 5000 });
    expect(groups.map((g) => g.name)).toEqual(["USD", "Cash", "GBP"]);
    expect(groups.map((g) => g.color)).toEqual([
      GROUP_COLORS[0],
      GROUP_COLORS[1],
      GROUP_COLORS[2],
    ]);
  });

  it("cycles the palette rather than running out of colours", () => {
    const many = Array.from({ length: GROUP_COLORS.length + 1 }, (_, i) => ({
      symbol: `S${i}`,
      marketValue: 1000 - i,
      currency: `C${i}`,
    }));
    const groups = groupAllocation(many, { mode: "market" });
    expect(groups).toHaveLength(GROUP_COLORS.length + 1);
    expect(groups[GROUP_COLORS.length].color).toBe(GROUP_COLORS[0]);
  });

  it("returns an empty list for an empty portfolio", () => {
    expect(groupAllocation([], { mode: "class" })).toEqual([]);
    expect(allocationTotal([])).toBe(0);
  });
});
