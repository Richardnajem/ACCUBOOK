import { NextRequest, NextResponse } from "next/server";
import { clearCompanyResearch, fetchCompanyResearch } from "@/lib/research";
import { fetchMultiSourceQuote } from "@/lib/quote-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/research?ticker=AAPL
//
// Company research from SEC EDGAR: profile, up to five annual statements,
// ratios and valuation against the live quote, plus recent filings.
//
// Every statement figure is a filed XBRL fact; missing items are null and the
// response carries a `notes` list explaining what could not be computed.
// The price leg uses the same five-source aggregate as the quote cards, and a
// quote failure does NOT fail the request — the research half still loads and
// `quoteError` says why the multiples are blank.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json(
      { error: "ticker query param is required." },
      { status: 400 }
    );
  }

  // The page's Refresh button bypasses the 15-minute in-process cache so a
  // newly filed 10-K shows up without restarting the server.
  if (searchParams.get("refresh") === "1") clearCompanyResearch(ticker);

  let quote = null;
  let quoteError: string | null = null;
  try {
    const multi = await fetchMultiSourceQuote(ticker);
    if (multi.price !== null) {
      quote = {
        price: multi.price,
        previousClose: multi.previousClose,
        changePercent: multi.changePercent,
        dayHigh: multi.dayHigh,
        dayLow: multi.dayLow,
        marketState: multi.marketState,
        tradeTime: multi.tradeTime,
        // The headline price came from the source with the newest trade
        // stamp; name that source rather than guessing from equal prices.
        source: multi.sources.find((s) => s.ok && s.tradeTime === multi.tradeTime)?.source ?? null,
      };
    } else {
      quoteError = "No quote source returned a price.";
    }
  } catch (e) {
    quoteError = e instanceof Error ? e.message : "Live quote failed.";
  }

  try {
    const data = await fetchCompanyResearch({ ticker, quote, quoteError });
    return NextResponse.json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load company research.";
    const notFound = /No SEC registrant/i.test(message);
    return NextResponse.json({ error: message }, { status: notFound ? 404 : 502 });
  }
}
