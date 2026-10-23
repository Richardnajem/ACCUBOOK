// Symbol search across the whole listed universe, keyless.
//
// The global palette and the watchlist's add form need to find a stock the user
// does not already hold — typing "nvid" has to offer NVDA with its company name
// and exchange, not only symbols already in the local database.
//
// Yahoo's public search endpoint is the same keyless provider the rest of the
// quote stack uses (lib/live-quotes.ts), so there is no new API key, no new
// account and no new failure mode to explain. Two hosts are tried in order for
// the same reason: they have independent rate-limit pools.
//
// Rules kept from the rest of the app:
//  - a failed lookup returns an error the caller can show, never an empty list
//    presented as "no such stock";
//  - results are the provider's own relevance order, with an exact symbol match
//    lifted to the top, and no invented fields — a name the provider omits is
//    left blank rather than guessed.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

/** Suggestions are cheap and change slowly; a keystroke burst must not fan out. */
const TTL_MS = 5 * 60_000;
const MAX_RESULTS = 10;

/** Quote types that are something a user can hold or track. */
const KEPT_TYPES = new Set([
  "EQUITY",
  "ETF",
  "MUTUALFUND",
  "INDEX",
  "CRYPTOCURRENCY",
  "CURRENCY",
  "FUTURE",
]);

const TYPE_LABELS: Record<string, string> = {
  EQUITY: "Stock",
  ETF: "ETF",
  MUTUALFUND: "Fund",
  INDEX: "Index",
  CRYPTOCURRENCY: "Crypto",
  CURRENCY: "FX",
  FUTURE: "Future",
};

export interface SymbolSuggestion {
  /** The provider's symbol, e.g. NVDA, BRK-B, 2222.SR, BTC-USD. */
  symbol: string;
  /** Company or instrument name, or "" when the provider did not send one. */
  name: string;
  /** Human-readable exchange ("NASDAQ"), or null. */
  exchange: string | null;
  /** "Stock", "ETF", … — for the row's right-hand label. */
  type: string;
  /** Raw quote type, for callers that want to filter. */
  typeCode: string;
}

interface YahooQuote {
  symbol?: unknown;
  shortname?: unknown;
  longname?: unknown;
  exchDisp?: unknown;
  exchange?: unknown;
  quoteType?: unknown;
  typeDisp?: unknown;
}

const cache = new Map<string, { at: number; items: SymbolSuggestion[] }>();

/** Test hook: drop cached queries so a fixture can be served again. */
export function clearSymbolSearchCache(): void {
  cache.clear();
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Turn a raw search payload into suggestions. Exported so the shape of the
 * provider's response is tested without touching the network.
 */
export function normaliseSuggestions(payload: unknown, limit = MAX_RESULTS): SymbolSuggestion[] {
  const raw = (payload as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: SymbolSuggestion[] = [];

  for (const entry of raw as YahooQuote[]) {
    const symbol = str(entry?.symbol).toUpperCase();
    const typeCode = str(entry?.quoteType).toUpperCase();
    if (!symbol || seen.has(symbol) || !KEPT_TYPES.has(typeCode)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      name: str(entry.longname) || str(entry.shortname),
      exchange: str(entry.exchDisp) || str(entry.exchange) || null,
      type: TYPE_LABELS[typeCode] || str(entry.typeDisp) || typeCode,
      typeCode,
    });
    if (out.length >= limit) break;
  }

  return out;
}

/** Lift an exact symbol match (and symbol prefixes) above the relevance order. */
function rank(items: SymbolSuggestion[], query: string): SymbolSuggestion[] {
  const q = query.trim().toUpperCase();
  const weight = (s: SymbolSuggestion) =>
    s.symbol === q ? 0 : s.symbol.startsWith(q) ? 1 : 2;
  return [...items].sort((a, b) => weight(a) - weight(b));
}

async function fetchSearch(query: string): Promise<unknown> {
  let lastError: unknown = null;
  for (const host of YAHOO_HOSTS) {
    const url =
      `${host}/v1/finance/search?q=${encodeURIComponent(query)}` +
      "&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=true";
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Symbol search returned HTTP ${res.status}.`);
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Symbol search is unreachable right now.");
}

/**
 * Search listed symbols by ticker or company name.
 *
 * Throws when every provider fails, so the UI can say the search is unavailable
 * instead of claiming the symbol does not exist.
 */
export async function searchSymbols(query: string): Promise<SymbolSuggestion[]> {
  const q = query.trim();
  if (!q) return [];

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;

  const items = rank(normaliseSuggestions(await fetchSearch(q)), q);
  cache.set(key, { at: Date.now(), items });
  return items;
}
