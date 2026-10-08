import { describe, it, expect } from "vitest";
import {
  parseFormula,
  evalFormula,
  evalFormulaLast,
  evaluateCustom,
  sanitizeCustomList,
  specForCustom,
  newCustomId,
  MAX_CUSTOM,
  MAX_PERIOD,
  type CustomIndicatorDef,
} from "../src/lib/custom-indicators";
import { normalizeScore } from "../src/lib/mega-indicator";
import { sma } from "../src/lib/ta";

function makeBars(n: number) {
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + Math.sin(i / 5) * 2 + 0.3;
    open.push(o);
    close.push(c);
    high.push(Math.max(o, c) + 0.5);
    low.push(Math.min(o, c) - 0.5);
    volume.push(1_000_000 + i * 1000);
    px = c;
  }
  return { open, high, low, close, volume };
}

const bars = makeBars(400);

const def = (over: Partial<CustomIndicatorDef> = {}): CustomIndicatorDef => ({
  id: "custom-x",
  name: "My indicator",
  formula: "close",
  direction: "higher",
  thresholds: [0, 1],
  unit: "",
  description: "",
  ...over,
});

// ─── Parsing and validation ─────────────────────────────────────

describe("formula parsing", () => {
  it("accepts valid formulas", () => {
    for (const f of [
      "close",
      "(close - sma(close, 20)) / sma(close, 20) * 100",
      "rsi(close, 14)",
      "100 * (close - rollingMin(close, 52)) / (rollingMax(close, 52) - rollingMin(close, 52))",
      "atr(14) / close * 100",
      "atr(high, low, close, 14)",
      "max(hlc3, prev(close, 1))",
      "-2 ^ 2 + abs(close)",
      "close > sma(close, 20)",
      "roc(close, 20) >= 5",
      "stdev(close, 3) / close * 100",
      "ema(close, 50) / sma(close, 200)",
    ]) {
      expect(parseFormula(f).ok, `${f} → ${JSON.stringify(parseFormula(f))}`).toBe(true);
    }
  });

  it("rejects unknown variables and functions", () => {
    const v = parseFormula("window.close");
    expect(v.ok).toBe(false);

    const f = parseFormula("fetch(close)");
    expect(f.ok).toBe(false);
    expect(!f.ok && f.error).toMatch(/Unknown function/);

    const g = parseFormula("process");
    expect(g.ok).toBe(false);
    expect(!g.ok && g.error).toMatch(/Unknown variable/);

    // String literals aren't tokens — quotes can never reach evaluation.
    expect(parseFormula("eval('1')").ok).toBe(false);
  });

  it("rejects wrong arity and dynamic periods", () => {
    expect(parseFormula("sma(close)").ok).toBe(false);
    expect(parseFormula("sma(close, 20, 3)").ok).toBe(false);
    expect(parseFormula("abs(close, 2)").ok).toBe(false);
    expect(parseFormula("atr(1, 2, 3)").ok).toBe(false); // atr accepts 1 or 4 args only

    const dyn = parseFormula("sma(close, 20 * 2)");
    expect(dyn.ok).toBe(false);
    expect(!dyn.ok && dyn.error).toMatch(/whole number/);
  });

  it("rejects out-of-range periods and oversized input", () => {
    const big = parseFormula(`sma(close, ${MAX_PERIOD + 1})`);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.error).toMatch(/whole number/);

    expect(parseFormula(`close + ${"1 + ".repeat(200)}1`).ok).toBe(false);
    expect(parseFormula("").ok).toBe(false);
    expect(parseFormula("close @ 2").ok).toBe(false);
    expect(parseFormula("((close").ok).toBe(false);
    expect(parseFormula("close close").ok).toBe(false);
  });

  it("caps nesting depth and node count", () => {
    let deep = "close";
    for (let i = 0; i < 40; i++) deep = `(${deep} + 1)`;
    const res = parseFormula(deep);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/deep|complex/);
  });
});

// ─── Evaluation ─────────────────────────────────────────────────

describe("formula evaluation", () => {
  const last = (f: string) => evalFormulaLast(f, bars);

  it("reads the latest bar", () => {
    expect(last("close")).toBe(bars.close[bars.close.length - 1]);
    expect(last("high")).toBe(bars.high[bars.high.length - 1]);
    expect(last("volume")).toBe(bars.volume[bars.volume.length - 1]);
    expect(last("hlc3")).toBeCloseTo(
      (bars.high.at(-1)! + bars.low.at(-1)! + bars.close.at(-1)!) / 3, 10);
  });

  it("evaluates arithmetic with correct precedence", () => {
    const c = bars.close.at(-1)!;
    expect(last("2 + 3 * 4")).toBe(14);
    expect(last("(2 + 3) * 4")).toBe(20);
    expect(last("close * 2 - 1")).toBeCloseTo(c * 2 - 1, 10);
    expect(last("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(last("-close")).toBeCloseTo(-c, 10);
    expect(last("10 % 3")).toBe(1);
  });

  it("maps division by zero to an unusable value rather than Infinity", () => {
    const series = evalFormula("close / (close - close)", bars);
    expect(series.at(-1)).toBeNaN();
  });

  it("produces a series aligned with the bars", () => {
    const s = evalFormula("close - sma(close, 20)", bars);
    expect(s).toHaveLength(bars.close.length);
    expect(Number.isNaN(s[0])).toBe(true);
    expect(s.at(-1)).toBeCloseTo(bars.close.at(-1)! - sma(bars.close, 20).at(-1)!, 8);
  });

  it("computes indicators that match the shared ta implementations", () => {
    expect(evalFormula("sma(close, 20)", bars)).toEqual(sma(bars.close, 20));
  });

  it("supports rate of change, lag and comparisons", () => {
    const c = bars.close;
    const n = c.length;
    expect(last("roc(close, 20)")).toBeCloseTo((c[n - 1] / c[n - 21] - 1) * 100, 10);
    expect(last("prev(close, 1)")).toBe(c[n - 2]);
    expect(last("change(close, 1)")).toBeCloseTo(c[n - 1] - c[n - 2], 10);
    expect(last("close > 0")).toBe(1);
    expect(last("close < 0")).toBe(0);
    expect(last("min(close, open, 1)")).toBe(1);
    expect(last("max(close, open)")).toBe(Math.max(c[n - 1], bars.open[n - 1]));
    expect(last("avg(close, open)")).toBeCloseTo((c[n - 1] + bars.open[n - 1]) / 2, 10);
  });

  it("throws a readable error when the formula yields nothing", () => {
    expect(() => evalFormulaLast("prev(close, 400)", bars)).toThrow(/no value/);
    expect(() => evalFormulaLast("log(-1)", bars)).toThrow();
  });

  it("has no access to globals — only the whitelisted variables", () => {
    for (const f of ["window", "globalThis", "process", "constructor", "require", "__proto__"]) {
      const r = parseFormula(f);
      expect(r.ok, `${f} should not be resolvable`).toBe(false);
    }
  });
});

// ─── Definition sanitisation ────────────────────────────────────

describe("sanitizeCustomList", () => {
  it("keeps well-formed definitions and repairs the rest", () => {
    const good = def();
    const out = sanitizeCustomList([
      good,
      def({ id: "custom-bad", formula: "window.close" }),   // unparseable
      def({ id: "", formula: "close" }),                     // no id
      def({ id: "custom-th", thresholds: [10, 0] }),         // descending
      { nonsense: true },
      "string",
      null,
    ]);
    expect(out.map((d) => d.id)).toEqual(["custom-x"]);

    // Equal thresholds are allowed — they make a step function.
    expect(sanitizeCustomList([def({ thresholds: [0, 0] })])).toHaveLength(1);
  });

  it("drops duplicate ids", () => {
    const out = sanitizeCustomList([def({ id: "custom-a" }), def({ id: "custom-a" })]);
    expect(out).toHaveLength(1);
  });

  it("caps the number of definitions", () => {
    const many = Array.from({ length: MAX_CUSTOM + 10 }, (_, i) =>
      def({ id: `custom-${i}` })
    );
    expect(sanitizeCustomList(many)).toHaveLength(MAX_CUSTOM);
  });

  it("returns an empty list for junk input", () => {
    expect(sanitizeCustomList(null)).toEqual([]);
    expect(sanitizeCustomList({})).toEqual([]);
    expect(sanitizeCustomList("nope")).toEqual([]);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, newCustomId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.startsWith("custom-")).toBe(true);
  });
});

// ─── Batch evaluation and specs ─────────────────────────────────

describe("evaluateCustom", () => {
  it("isolates failures so one bad definition cannot break the rest", () => {
    const res = evaluateCustom(
      [
        def({ id: "custom-ok", name: "OK", formula: "rsi(close, 14)" }),
        def({ id: "custom-throw", name: "Broken", formula: "prev(close, 9999)" }),
        def({ id: "custom-parse", name: "Invalid", formula: "sma(close)" }),
      ],
      bars
    );
    expect(Object.keys(res.values)).toEqual(["custom-ok"]);
    expect(res.specs.map((s) => s.id)).toEqual(["custom-ok"]);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]).toMatch(/^Broken/);
    expect(res.errors[1]).toMatch(/^Invalid/);
  });

  it("builds a spec that carries the user's own formula and scoring rule", () => {
    const spec = specForCustom(def({
      name: "My RSI",
      formula: "rsi(close, 14)",
      direction: "band",
      thresholds: [30, 70],
      unit: "",
      description: "mine",
    }));
    expect(spec.category).toBe("Custom");
    expect(spec.formula).toBe("rsi(close, 14)");
    expect(spec.thresholds).toEqual([30, 70]);
    // Scoring through it must stay in range.
    expect(normalizeScore(50, spec)).toBeGreaterThanOrEqual(0);
    expect(normalizeScore(50, spec)).toBeLessThanOrEqual(100);
    expect(normalizeScore(1000, spec)).toBeLessThanOrEqual(100);
    expect(normalizeScore(-1000, spec)).toBeGreaterThanOrEqual(0);
  });
});
