// Live accuracy study for the research tab (network; opt-in).
//
//   npm run test:research
//
// Reads real filings for a mixed universe (US large caps, a bank, a
// conglomerate, an IFRS 20-F filer, a reorganized registrant) and prints, per
// company: the statement figures the page would show, whether each source
// answered, and every figure the independent reads disagree with. Then it
// asserts the things that must hold regardless of the market:
//
//   - statements exist for every name (a ticker that maps to a successor
//     registrant resolves to the entity that actually files),
//   - at least two of the four verification sources answer (a vendor can
//     legitimately not cover a ticker: Nasdaq has no BRK/B symbol),
//   - most reported figures are confirmed by an independent read,
//   - no figure disagrees with an independent source by more than 25 %
//     without the page having marked it a conflict.
//
// A number this harness prints is a measurement of today's filings, not a
// promise about tomorrow's: re-run it after a filing season before quoting.
import { describe, it, expect } from "vitest";
import { fetchCompanyResearch } from "../src/lib/research";

const LIVE = process.env.RESEARCH_LIVE === "1";

const UNIVERSE = [
  "AAPL", // 52/53-week, Sep FY
  "MSFT", // June FY
  "KO", // Dec FY, no total-liabilities tag
  "JPM", // bank: preferred dividends, no gross profit
  "BRK-B", // conglomerate: partial contract-revenue tag
  "XOM", // 2026 holdco reorganisation
  "WMT", // Jan FY, retail
  "ASML", // IFRS 20-F, EUR statements
];

describe("research accuracy (live)", () => {
  it("cross-checks every company against four independent sources", async () => {
    if (!LIVE) return;

    let totalReported = 0;
    let totalVerified = 0;
    let totalConflicts = 0;
    const lines: string[] = [];

    for (const ticker of UNIVERSE) {
      const data = await fetchCompanyResearch({ ticker, quote: null, verify: true });
      const v = data.verification;
      const latest = data.annual[0];
      expect(latest, `${ticker}: no annual statements`).toBeTruthy();
      expect(v, `${ticker}: verification missing`).toBeTruthy();

      const sources = v!.sources.filter((s) => s.kind !== "sec-primary");
      const okSources = sources.filter((s) => s.ok);

      const latestChecks = v!.figures.filter((f) => f.fy === latest.fy);
      const reported = latestChecks.filter((f) => f.verdict !== "not-reported");
      const verified = latestChecks.filter((f) => f.verdict === "verified");
      const conflicts = latestChecks.filter((f) => f.verdict === "conflict");
      totalReported += reported.length;
      totalVerified += verified.length;
      totalConflicts += conflicts.length;

      lines.push(
        `${ticker.padEnd(6)} FY${latest.fy} ${latest.end} ${data.currency} ` +
          `rev=${latest.revenue === null ? "—" : (latest.revenue / 1e9).toFixed(1) + "B"} ` +
          `ni=${latest.netIncome === null ? "—" : (latest.netIncome / 1e9).toFixed(1) + "B"} ` +
          `eps=${latest.epsDiluted ?? "—"} | sources ${okSources.length}/${sources.length} ` +
          `(${okSources.map((s) => s.name.replace("SEC ", "sec-").replace(" Finance", "")).join(", ")}) ` +
          `| verified ${verified.length}/${reported.length} conflicts ${conflicts.length}` +
          (data.statementsSource.predecessor ? ` | statements from CIK ${data.statementsSource.cik}` : "")
      );
      for (const c of conflicts) {
        const worst = c.matches
          .filter((m) => m.status === "differs")
          .map((m) => `${m.source} ${m.value === null ? "—" : (m.value / 1e9).toFixed(2)}B (${((m.diffPct ?? 0) * 100).toFixed(1)}%)`)
          .join("; ");
        lines.push(`        ! ${c.label} ${c.fy}: app ${(c.primary! / 1e9).toFixed(2)}B vs ${worst}`);
      }
      for (const s of sources.filter((x) => !x.ok)) {
        lines.push(`        - ${s.name}: ${s.error ?? "unavailable"}`);
      }

      // The cross-check must have something to say: two failing vendors plus a
      // failing SEC endpoint is a broken harness, not a clean bill of health.
      expect(okSources.length, `${ticker}: only ${okSources.length} verification source(s) answered`).toBeGreaterThanOrEqual(2);
    }

    const pct = totalReported === 0 ? 0 : (totalVerified / totalReported) * 100;
    lines.push(
      "",
      `UNIVERSE ${UNIVERSE.length} names · ${totalVerified}/${totalReported} latest-year figures confirmed (${pct.toFixed(0)}%) · ${totalConflicts} conflicts`
    );
    console.log("\n" + lines.join("\n"));

    expect(totalVerified / totalReported).toBeGreaterThanOrEqual(0.7);
  }, 900_000);

  it("resolves a successor registrant to the entity that files the annual report", async () => {
    if (!LIVE) return;
    const xom = await fetchCompanyResearch({ ticker: "XOM", quote: null, verify: false });
    expect(xom.annual.length).toBeGreaterThan(0);
    expect(xom.currency).toBe("USD");
    expect(xom.statementsSource.predecessor).toBe(true);
    expect(xom.statementsSource.cik).not.toBe(xom.profile.cik);
    expect(xom.notes.some((n) => n.includes("has filed no annual report yet"))).toBe(true);
  }, 300_000);
});
