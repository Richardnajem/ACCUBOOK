// Symbol search feeds the global palette and the watchlist's add form, so these
// tests pin the two things that matter: the provider's payload is filtered to
// things a user can actually hold, and a provider failure is reported as a
// failure — never as "no such stock".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  clearSymbolSearchCache,
  normaliseSuggestions,
  searchSymbols,
} from "@/lib/symbol-search";
import { GET } from "@/app/api/symbol-search/route";

const PAYLOAD = {
  quotes: [
    { symbol: "NVDL", shortname: "GraniteShares 2x Long NVDA", quoteType: "ETF", exchDisp: "NASDAQ" },
    { symbol: "NVDA", shortname: "NVIDIA Corporation", quoteType: "EQUITY", exchDisp: "NASDAQ" },
    { symbol: "NVDA240119C00050000", quoteType: "OPTION", exchDisp: "OPR" },
    { symbol: "nvda", shortname: "duplicate", quoteType: "EQUITY" },
    { symbol: "2222.SR", longname: "Saudi Arabian Oil Co.", quoteType: "EQUITY", exchDisp: "Saudi Stock Exchange" },
    { symbol: "BTC-USD", shortname: "Bitcoin USD", quoteType: "CRYPTOCURRENCY", exchDisp: "CCC" },
    { symbol: "", shortname: "no symbol", quoteType: "EQUITY" },
    { symbol: "ODD", quoteType: "WARRANT", exchDisp: "NYSE" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeRequest(url: string): Request {
  return new Request(`http://127.0.0.1${url}`);
}

beforeEach(() => clearSymbolSearchCache());
afterEach(() => vi.unstubAllGlobals());

describe("normaliseSuggestions", () => {
  it("keeps the types a user can hold and drops the rest", () => {
    const out = normaliseSuggestions(PAYLOAD);
    const symbols = out.map((s) => s.symbol);
    expect(symbols).toContain("NVDA");
    expect(symbols).toContain("NVDL");
    expect(symbols).toContain("2222.SR");
    expect(symbols).toContain("BTC-USD");
    // options, warrants and entries without a symbol are not suggestions
    expect(symbols).not.toContain("NVDA240119C00050000");
    expect(symbols).not.toContain("ODD");
    expect(symbols.some((s) => s === "")).toBe(false);
  });

  it("dedupes case-insensitively and keeps the first, complete record", () => {
    const out = normaliseSuggestions(PAYLOAD);
    expect(out.filter((s) => s.symbol === "NVDA")).toHaveLength(1);
    expect(out.find((s) => s.symbol === "NVDA")?.name).toBe("NVIDIA Corporation");
  });

  it("fills name, exchange and a readable type", () => {
    const out = normaliseSuggestions(PAYLOAD);
    const nvda = out.find((s) => s.symbol === "NVDA")!;
    expect(nvda.name).toBe("NVIDIA Corporation");
    expect(nvda.exchange).toBe("NASDAQ");
    expect(nvda.type).toBe("Stock");
    expect(nvda.typeCode).toBe("EQUITY");

    const aramco = out.find((s) => s.symbol === "2222.SR")!;
    expect(aramco.name).toBe("Saudi Arabian Oil Co."); // longname wins over shortname
    expect(out.find((s) => s.symbol === "BTC-USD")?.type).toBe("Crypto");
  });

  it("honours the result limit", () => {
    const many = { quotes: Array.from({ length: 40 }, (_, i) => ({ symbol: `T${i}`, quoteType: "EQUITY" })) };
    expect(normaliseSuggestions(many, 5)).toHaveLength(5);
  });

  it("returns nothing for a payload without quotes", () => {
    for (const bad of [null, undefined, {}, { quotes: "nope" }, { quotes: [] }]) {
      expect(normaliseSuggestions(bad)).toEqual([]);
    }
  });
});

describe("searchSymbols", () => {
  it("ranks an exact symbol match above the provider's own order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(PAYLOAD)));
    const out = await searchSymbols("NVDA");
    expect(out[0].symbol).toBe("NVDA");
    expect(out.map((s) => s.symbol)).toContain("NVDL");
  });

  it("ranks symbol prefixes next, then everything else", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(PAYLOAD)));
    const out = await searchSymbols("nv");
    const symbols = out.map((s) => s.symbol);
    expect(symbols.indexOf("NVDA")).toBeLessThan(symbols.indexOf("2222.SR"));
    expect(symbols.indexOf("NVDL")).toBeLessThan(symbols.indexOf("2222.SR"));
  });

  it("caches a query so a keystroke burst hits the provider once", async () => {
    const spy = vi.fn(async () => jsonResponse(PAYLOAD));
    vi.stubGlobal("fetch", spy);
    await searchSymbols("nvidia");
    await searchSymbols("NVIDIA");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fails over to the second host when the first errors", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(PAYLOAD));
    vi.stubGlobal("fetch", spy);
    const out = await searchSymbols("aramco");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(out.length).toBeGreaterThan(0);
  });

  it("throws when every provider fails, rather than returning an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(searchSymbols("tesla")).rejects.toThrow(/503/);
  });

  it("returns nothing for a blank query without calling the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await searchSymbols("   ")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /api/symbol-search", () => {
  it("treats an empty query as 'nothing typed yet'", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await GET(routeRequest("/api/symbol-search") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: "", suggestions: [], count: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns suggestions for a partial company name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(PAYLOAD)));
    const res = await GET(routeRequest("/api/symbol-search?q=nvid") as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: { symbol: string }[]; count: number };
    expect(body.count).toBe(body.suggestions.length);
    expect(body.suggestions.map((s) => s.symbol)).toContain("NVDA");
  });

  it("reports a provider failure as 502 with an error, not an empty success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 500 })));
    const res = await GET(routeRequest("/api/symbol-search?q=apple") as never);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; suggestions: unknown[] };
    expect(body.error).toBeTruthy();
    expect(body.suggestions).toEqual([]);
  });
});
