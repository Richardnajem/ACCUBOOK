import { describe, expect, it } from "vitest";

import { STRATEGIES, STRATEGY_CATEGORIES } from "@/lib/strategies-db";
import {
  MECHANISMS,
  isThin,
  mechanismFor,
  ownFacts,
  templateFacts,
} from "@/lib/strategy-research";
import { ADJACENT_METHODS, adjacentCount, adjacentFor } from "@/lib/strategy-adjacent";
import { DEEP_DIVES, deepDiveCount, deepDiveFor } from "@/lib/strategy-deep-dives";

const FIELDS = [
  "what",
  "how",
  "venues",
  "liquidity",
  "capital",
  "costs",
  "regulatory",
  "shariah",
  "effort",
  "horizon",
] as const;

describe("mechanism research", () => {
  it("gives every strategy a mechanism", () => {
    for (const s of STRATEGIES) {
      const m = mechanismFor(s);
      expect(m, s.name).toBeTruthy();
      expect(MECHANISMS.some((f) => f.id === m.id), `${s.name} → ${m.id}`).toBe(true);
    }
  });

  it("never leaves a research field empty", () => {
    const shortOk = new Set(["effort", "horizon"]);
    for (const m of MECHANISMS) {
      for (const field of FIELDS) {
        const min = shortOk.has(field) ? 10 : 25;
        expect(String(m[field]).trim().length, `${m.id}.${field}`).toBeGreaterThan(min);
      }
      expect(m.risks.length, m.id).toBeGreaterThanOrEqual(2);
      expect(m.monitor.length, m.id).toBeGreaterThanOrEqual(2);
      for (const r of m.risks) expect(r.trim().length, `${m.id} risk`).toBeGreaterThan(15);
    }
  });

  it("labels every figure as a typical range, never as this row's data", () => {
    for (const m of MECHANISMS) {
      expect(m.costs.startsWith("Typical:"), `${m.id} costs`).toBe(true);
      for (const field of FIELDS) {
        const value = String(m[field]);
        if (/[%$]/.test(value)) {
          expect(value.includes("Typical"), `${m.id}.${field}: ${value}`).toBe(true);
        }
      }
    }
  });

  it("has no recommendation or forecast language", () => {
    const banned = /\b(guaranteed|risk-free return|will return|expected to earn|recommend(ed|ation)?)\b/i;
    for (const m of MECHANISMS) {
      for (const field of FIELDS) {
        expect(banned.test(String(m[field])), `${m.id}.${field}`).toBe(false);
      }
      for (const r of m.risks) expect(banned.test(r), `${m.id} risk`).toBe(false);
    }
  });

  it("keeps the workbook's template text apart from real research", () => {
    const thin = STRATEGIES.filter(isThin);
    expect(thin.length).toBeGreaterThan(100);
    for (const s of thin) {
      expect(ownFacts(s)).toHaveLength(0);
      expect(templateFacts(s).length).toBeGreaterThan(0);
      // every fact is either own or template, never both
      expect(ownFacts(s).length + templateFacts(s).length).toBe(s.facts.length);
    }
    // and the rows the workbook really researched keep their own facts
    const deep = STRATEGIES.filter((s) => !isThin(s));
    expect(deep.length).toBeGreaterThan(25);
  });

  it("does not attach a crypto template to a betting strategy", () => {
    const handicap = STRATEGIES.find((s) => s.name === "Asian Handicap Arbitrage")!;
    const templates = templateFacts(handicap).map((f) => `${f.label}: ${f.value}`).join(" ");
    expect(templates).toMatch(/protocol|smart contract/i);
    expect(ownFacts(handicap)).toHaveLength(0);
    expect(mechanismFor(handicap).id).toBe("sports-prop");
  });
});

describe("broader methods per category", () => {
  it("covers every category", () => {
    for (const c of STRATEGY_CATEGORIES) {
      expect(adjacentFor(c.id).length, c.id).toBeGreaterThanOrEqual(4);
    }
    expect(adjacentCount()).toBeGreaterThanOrEqual(48);
  });

  it("describes how and why, without inventing performance", () => {
    for (const [category, methods] of Object.entries(ADJACENT_METHODS)) {
      for (const m of methods) {
        expect(m.name.trim().length, category).toBeGreaterThan(3);
        expect(m.how.length, m.name).toBeGreaterThan(30);
        expect(m.why.length, m.name).toBeGreaterThan(30);
        // unassessed methods carry no figures at all
        expect(/\d+\s*%|\$\d/.test(`${m.how} ${m.why}`), m.name).toBe(false);
      }
      expect(new Set(methods.map((m) => m.name)).size).toBe(methods.length);
    }
  });
});

describe("sourced deep dives", () => {
  it("points only at strategies that exist", () => {
    expect(deepDiveCount()).toBe(DEEP_DIVES.length);
    for (const d of DEEP_DIVES) {
      const s = STRATEGIES.find((x) => x.id === d.id);
      expect(s, d.id).toBeTruthy();
      expect(deepDiveFor(d.id)).toBe(d);
    }
    expect(deepDiveFor("not-a-strategy")).toBeNull();
    expect(deepDiveFor(null)).toBeNull();
  });

  it("sources at least one row in every category", () => {
    for (const c of STRATEGY_CATEGORIES) {
      const inCategory = DEEP_DIVES.filter((d) =>
        STRATEGIES.some((s) => s.id === d.id && s.category === c.id),
      );
      expect(inCategory.length, `${c.id} has no sourced row`).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the four leader dives attached to the leaders", () => {
    for (const id of [
      "venture-capital-seed-stage-startups",
      "real-estate-rent-to-airbnb-arb",
      "vip-loyalty-program-arbitrage",
      "awards-market-arbitrage-oscars-grammys-etc",
    ]) {
      expect(deepDiveFor(id), id).toBeTruthy();
      expect(deepDiveFor(id)!.sources[0].url.startsWith("https://")).toBe(true);
    }
  });

  it("carries facts and a real source for each", () => {
    for (const d of DEEP_DIVES) {
      expect(d.summary.length, d.id).toBeGreaterThan(40);
      expect(d.facts.length, d.id).toBeGreaterThanOrEqual(2);
      for (const f of d.facts) {
        expect(f.label.trim().length).toBeGreaterThan(2);
        expect(f.value.length).toBeGreaterThan(40);
      }
      expect(d.sources.length, d.id).toBeGreaterThanOrEqual(1);
      for (const s of d.sources) {
        expect(s.url.startsWith("https://"), d.id).toBe(true);
        expect(s.title.length).toBeGreaterThan(10);
        expect(s.note.length).toBeGreaterThan(15);
      }
    }
  });

  it("flags any dive that rests on a partly-read page", () => {
    const blocked = DEEP_DIVES.filter((d) => d.caveat);
    for (const d of blocked) expect(d.caveat!.length).toBeGreaterThan(30);
    // rows without a dive are reported as unsourced, not padded
    expect(DEEP_DIVES.length).toBeLessThan(STRATEGIES.length);
  });
});
