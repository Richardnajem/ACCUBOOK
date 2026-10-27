import { describe, it, expect } from "vitest";
import {
  mergeFormula,
  scoreWithOverride,
  isFormulaChanged,
  isOverrideChanged,
  hashOverrides,
  sanitizeOverrides,
  setOverride,
  clearOverride,
  formulaLabel,
  type ScoringFormula,
} from "../src/lib/mega-overrides";
import { applyIndicatorOverride, getSpec, MAX_OVERRIDE_DESC } from "../src/lib/mega-indicator";

const base: ScoringFormula = { direction: "higher", thresholds: [0, 5] };

describe("mergeFormula", () => {
  it("returns the base formula when there is no override", () => {
    expect(mergeFormula(base)).toEqual({ direction: "higher", thresholds: [0, 5] });
  });

  it("applies a direction override", () => {
    expect(mergeFormula(base, { direction: "lower" }).direction).toBe("lower");
  });

  it("applies a thresholds override", () => {
    expect(mergeFormula(base, { thresholds: [1, 9] }).thresholds).toEqual([1, 9]);
  });

  it("ignores malformed thresholds and keeps the base", () => {
    expect(mergeFormula(base, { thresholds: [1] as unknown as [number, number] }).thresholds).toEqual([0, 5]);
    expect(mergeFormula(base, { thresholds: ["x", 2] as unknown as [number, number] }).thresholds).toEqual([0, 5]);
  });

  it("does not mutate the base thresholds", () => {
    const merged = mergeFormula(base, { thresholds: [3, 4] });
    expect(merged.thresholds).not.toBe(base.thresholds);
    expect(base.thresholds).toEqual([0, 5]);
  });
});

describe("scoreWithOverride", () => {
  it("matches the default normalization with no override", () => {
    // higher: [0,5] -> 2.5 sits exactly halfway
    expect(scoreWithOverride(2.5, base)).toBeCloseTo(50, 5);
    expect(scoreWithOverride(-1, base)).toBe(0);
    expect(scoreWithOverride(10, base)).toBe(100);
  });

  it("re-normalizes when thresholds change", () => {
    // widen the good threshold: 2.5 is now only halfway to a bad 0..10 window
    expect(scoreWithOverride(2.5, base, { thresholds: [2, 3] })).toBeCloseTo(50, 5);
    expect(scoreWithOverride(2.5, base, { thresholds: [0, 10] })).toBeCloseTo(25, 5);
  });

  it("flips meaning when direction flips to lower", () => {
    // lower: good at a, bad at b. value 0 (best) -> 100
    expect(scoreWithOverride(0, base, { direction: "lower" })).toBe(100);
    expect(scoreWithOverride(5, base, { direction: "lower" })).toBe(0);
  });

  it("scores a band", () => {
    const band: ScoringFormula = { direction: "band", thresholds: [30, 70] };
    expect(scoreWithOverride(50, band)).toBeCloseTo(100, 5); // dead centre
    expect(scoreWithOverride(30, band)).toBeCloseTo(60, 5); // band edge
    expect(scoreWithOverride(85, band)).toBeLessThan(60); // outside the band
  });

  it("returns 50 for non-finite input", () => {
    expect(scoreWithOverride(NaN, base)).toBe(50);
    expect(scoreWithOverride(Infinity, base)).toBe(50);
  });
});

describe("isFormulaChanged", () => {
  it("is false with no override or an identical one", () => {
    expect(isFormulaChanged(base)).toBe(false);
    expect(isFormulaChanged(base, { direction: "higher", thresholds: [0, 5] })).toBe(false);
  });

  it("detects a real change", () => {
    expect(isFormulaChanged(base, { thresholds: [1, 5] })).toBe(true);
    expect(isFormulaChanged(base, { direction: "lower" })).toBe(true);
  });
});

describe("sanitizeOverrides", () => {
  it("drops non-objects, arrays and empty entries", () => {
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([])).toEqual({});
    expect(sanitizeOverrides("nope")).toEqual({});
    expect(sanitizeOverrides({ a: 1, b: {}, c: { direction: "band" } })).toEqual({ c: { direction: "band" } });
  });

  it("keeps valid entries", () => {
    const out = sanitizeOverrides({ x: { direction: "lower", thresholds: [1, 2] } });
    expect(out).toEqual({ x: { direction: "lower", thresholds: [1, 2] } });
  });
});

describe("setOverride / clearOverride", () => {
  it("adds, merges and removes entries without mutating the input", () => {
    const m0 = {};
    const m1 = setOverride(m0, "a", { thresholds: [1, 2] });
    const m2 = setOverride(m1, "a", { direction: "lower" });
    expect(m1).toEqual({ a: { thresholds: [1, 2] } });
    expect(m2).toEqual({ a: { thresholds: [1, 2], direction: "lower" } });
    expect(m0).toEqual({});
    expect(clearOverride(m2, "a")).toEqual({});
    expect(clearOverride({}, "missing")).toEqual({});
  });

  it("removes an entry when the patch clears it back to empty", () => {
    const m = setOverride({ a: { direction: "band" } }, "a", { direction: undefined });
    expect(m).toEqual({});
  });
});

describe("formulaLabel", () => {
  it("renders each direction", () => {
    expect(formulaLabel({ direction: "higher", thresholds: [0, 5] })).toBe("higher: 0 → 5");
    expect(formulaLabel({ direction: "band", thresholds: [35, 65] })).toBe("band: 35 – 65");
  });
});

// ─── Editing an indicator's own fields ─────────────────────────
// The right-click editor patches any field of a built-in spec, and can REPLACE
// its calculation with a user expression. These pin the patch semantics: a
// missing field keeps the built-in value, and an invalid one never produces an
// invalid spec (a reversed threshold pair would score above 100).

const rsiSpec = getSpec("ta-rsi-14")!;

describe("applyIndicatorOverride", () => {
  it("returns the same spec when there is no override", () => {
    expect(applyIndicatorOverride(rsiSpec)).toBe(rsiSpec);
  });

  it("keeps every built-in field the override does not mention", () => {
    const patched = applyIndicatorOverride(rsiSpec, { formula: "rsi(close, 9)" });
    expect(patched.formula).toBe("rsi(close, 9)");
    expect(patched.name).toBe(rsiSpec.name);
    expect(patched.unit).toBe(rsiSpec.unit);
    expect(patched.description).toBe(rsiSpec.description);
    expect(patched.direction).toBe(rsiSpec.direction);
    expect(patched.thresholds).toEqual(rsiSpec.thresholds);
    expect(patched.id).toBe(rsiSpec.id);
    expect(patched.category).toBe(rsiSpec.category);
  });

  it("patches the text fields", () => {
    const patched = applyIndicatorOverride(rsiSpec, {
      name: "  My RSI  ", unit: "pts", description: "Mine", formula: " rsi(close, 9) ",
    });
    expect(patched.name).toBe("My RSI");
    expect(patched.unit).toBe("pts");
    expect(patched.description).toBe("Mine");
    expect(patched.formula).toBe("rsi(close, 9)");
  });

  it("treats blank text as \"keep the built-in\"", () => {
    const patched = applyIndicatorOverride(rsiSpec, { name: "   ", unit: "", formula: "" });
    expect(patched.name).toBe(rsiSpec.name);
    expect(patched.unit).toBe(rsiSpec.unit);
    expect(patched.formula).toBe(rsiSpec.formula);
  });

  it("clamps the text fields like the custom editor does", () => {
    const patched = applyIndicatorOverride(rsiSpec, {
      name: "n".repeat(100),
      description: "d".repeat(400),
    });
    expect(patched.name.length).toBeLessThanOrEqual(40);
    expect(patched.description.length).toBe(MAX_OVERRIDE_DESC);
  });

  it("ignores a reversed or malformed threshold pair", () => {
    expect(applyIndicatorOverride(rsiSpec, { thresholds: [80, 20] }).thresholds).toEqual(rsiSpec.thresholds);
    expect(applyIndicatorOverride(rsiSpec, { thresholds: [1] as unknown as [number, number] }).thresholds).toEqual(rsiSpec.thresholds);
    expect(applyIndicatorOverride(rsiSpec, { thresholds: ["a", 2] as unknown as [number, number] }).thresholds).toEqual(rsiSpec.thresholds);
  });

  it("keeps an equal pair, which is a step function", () => {
    expect(applyIndicatorOverride(rsiSpec, { thresholds: [50, 50] }).thresholds).toEqual([50, 50]);
  });
});

describe("isOverrideChanged", () => {
  it("is false with no override or an identical one", () => {
    expect(isOverrideChanged(rsiSpec)).toBe(false);
    expect(isOverrideChanged(rsiSpec, { name: rsiSpec.name, formula: rsiSpec.formula })).toBe(false);
  });

  it("counts a formula-only, field-only or scoring edit", () => {
    expect(isOverrideChanged(rsiSpec, { formula: "rsi(close, 9)" })).toBe(true);
    expect(isOverrideChanged(rsiSpec, { name: "My RSI" })).toBe(true);
    expect(isOverrideChanged(rsiSpec, { unit: "pts" })).toBe(true);
    expect(isOverrideChanged(rsiSpec, { description: "Mine" })).toBe(true);
    expect(isOverrideChanged(rsiSpec, { thresholds: [10, 90] })).toBe(true);
  });
});

describe("sanitizeOverrides — the new fields", () => {
  it("keeps a formula that compiles", () => {
    const out = sanitizeOverrides({ "ta-rsi-14": { formula: "rsi(close, 9)" } });
    expect(out).toEqual({ "ta-rsi-14": { formula: "rsi(close, 9)" } });
  });

  it("drops a formula that does not compile, keeping the rest of the edit", () => {
    const out = sanitizeOverrides({
      "ta-rsi-14": { formula: "nope(close, 9)", name: "My RSI" },
    });
    expect(out).toEqual({ "ta-rsi-14": { name: "My RSI" } });
  });

  it("keeps text fields, trimmed and capped", () => {
    const out = sanitizeOverrides({
      "ta-rsi-14": { name: "  Mine  ", unit: " pts ", description: "d".repeat(400) },
    });
    expect(out["ta-rsi-14"].name).toBe("Mine");
    expect(out["ta-rsi-14"].unit).toBe("pts");
    expect(out["ta-rsi-14"].description!.length).toBe(MAX_OVERRIDE_DESC);
  });

  it("ignores blank text so it cannot blank out a built-in", () => {
    expect(sanitizeOverrides({ "ta-rsi-14": { name: "  ", unit: "" } })).toEqual({});
  });
});

describe("hashOverrides", () => {
  it("is stable for the same content and different for a changed edit", () => {
    expect(hashOverrides(undefined)).toBe("0");
    expect(hashOverrides({})).toBe("0");
    const a = hashOverrides({ "ta-rsi-14": { formula: "rsi(close, 9)" } });
    expect(hashOverrides({ "ta-rsi-14": { formula: "rsi(close, 9)" } })).toBe(a);
    expect(hashOverrides({ "ta-rsi-14": { formula: "rsi(close, 21)" } })).not.toBe(a);
    expect(hashOverrides({ "ta-rsi-14": { formula: "rsi(close, 9)", name: "Mine" } })).not.toBe(a);
    expect(hashOverrides({ "ta-rsi-14": { thresholds: [1, 2] } })).not.toBe("0");
  });
});
