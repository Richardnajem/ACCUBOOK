import { describe, expect, it } from "vitest";
import { chartFileName, chartSlug } from "../src/lib/chart-export";

describe("chart export filenames", () => {
  it("slugifies a chart title", () => {
    expect(chartSlug("Total Equity")).toBe("total-equity");
    expect(chartSlug("Allocation (market value)")).toBe("allocation-market-value");
    // A donut chart's title lands the same way as any other chart.
    expect(chartSlug("Allocation")).toBe("allocation");
  });

  it("never leaves path or shell-hostile characters in a filename", () => {
    const slug = chartSlug('../../etc/passwd "x" | <y>');
    expect(slug).toBe("etc-passwd-x-y");
    expect(chartSlug("***")).toBe("chart");
  });

  it("falls back to 'chart' and caps the slug length", () => {
    expect(chartSlug("")).toBe("chart");
    expect(chartSlug("   ")).toBe("chart");
    expect(chartSlug("a".repeat(200))).toHaveLength(64);
  });

  it("stamps the file so two exports never collide", () => {
    const early = chartFileName("Allocation", new Date(2026, 0, 5, 9, 7));
    const later = chartFileName("Allocation", new Date(2026, 0, 5, 9, 8));
    expect(early).toBe("stockfolio-allocation-20260105-0907.png");
    expect(later).toBe("stockfolio-allocation-20260105-0908.png");
    expect(early).toMatch(/^stockfolio-[a-z0-9-]+-\d{8}-\d{4}\.png$/);
  });
});
