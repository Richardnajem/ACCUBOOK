import { describe, it, expect } from "vitest";
import {
  mergeFormula,
  scoreWithOverride,
  isFormulaChanged,
  sanitizeOverrides,
  setOverride,
  clearOverride,
  formulaLabel,
  type ScoringFormula,
} from "../src/lib/mega-overrides";

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
