import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getDailyBars } from "@/lib/market-data";
import { computeMegaScoreSeries } from "@/lib/mega-score";
import { buildPriceWorkbook, priceFileName } from "@/lib/price-export";
import type { IndicatorOverrideMap, WeightMap } from "@/lib/mega-indicator";
import { sanitizeOverrides } from "@/lib/mega-overrides";
import { sanitizeCustomList, type CustomIndicatorDef } from "@/lib/custom-indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How far back an "all days" request asks for by default (data sources cap it). */
const DEFAULT_EXPORT_YEARS = 30;
const MAX_EXPORT_YEARS = 60;

function parseWeights(raw: string | null): WeightMap | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).map(
      ([k, v]) => [String(k).slice(0, 64), Math.max(0, Math.min(20, Number(v) || 0))] as const,
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

// GET /api/export/prices?symbol=AAPL&years=30
//    &weights={"ta-rsi-14":2}&overrides={...}&custom=[...]
//
// The whole daily history for one ticker as one .xlsx: every bar (OHLCV, both
// change readings, dollar volume, 52-week distances, Mega Score) plus one column
// per indicator in its 0-100 score and in its own units, the catalogue and each
// indicator's coverage. Same bars, weights and edits as the Mega Indicator page,
// so the file describes the series the app is showing.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = (searchParams.get("symbol") || searchParams.get("ticker") || "").trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ error: "symbol query param is required (e.g. AAPL)." }, { status: 400 });
    }

    const requested = Number(searchParams.get("years"));
    const years = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_EXPORT_YEARS, requested)
      : DEFAULT_EXPORT_YEARS;

    const weights = parseWeights(searchParams.get("weights"));

    let custom: CustomIndicatorDef[] = [];
    const customParam = searchParams.get("custom");
    if (customParam) {
      try {
        const rawCustom: unknown = JSON.parse(customParam);
        if (Array.isArray(rawCustom)) custom = sanitizeCustomList(rawCustom);
      } catch { /* ignore malformed custom defs */ }
    }

    let overrides: IndicatorOverrideMap = {};
    const overridesParam = searchParams.get("overrides");
    if (overridesParam) {
      try {
        overrides = sanitizeOverrides(JSON.parse(overridesParam));
      } catch { /* ignore malformed overrides */ }
    }

    const { bars, meta } = await getDailyBars(symbol, years);
    if (bars.length === 0) {
      return NextResponse.json({ error: `No price history available for ${symbol}.` }, { status: 404 });
    }

    const series = computeMegaScoreSeries(
      {
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close: bars.map((b) => b.close),
        volume: bars.map((b) => b.volume),
        open: bars.map((b) => b.open),
      },
      weights,
      custom,
      overrides,
    );

    const workbook = buildPriceWorkbook({
      symbol,
      meta,
      bars,
      series,
      weights,
      yearsRequested: years,
      overrideCount: Object.keys(overrides).length,
      customCount: custom.length,
    });
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    const filename = priceFileName(symbol);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error exporting price history:", error);
    const message = error instanceof Error ? error.message : "Could not build the workbook.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
