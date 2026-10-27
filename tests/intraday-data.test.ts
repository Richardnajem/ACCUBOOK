import { describe, it, expect } from "vitest";
import {
  aggregateBars,
  alpacaCredentials,
  mapAlpacaBars,
  fetchAlpacaBars,
  sessionOf,
  TIMEFRAME_MINUTES,
} from "../src/lib/intraday-data";
import type { Bar } from "../src/lib/market-data";

const bar = (ts: string, o: number, h: number, l: number, c: number, v = 100): Bar => ({
  date: ts,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe("mapAlpacaBars", () => {
  it("maps the wire shape to the app's Bar and keeps volume", () => {
    const [b] = mapAlpacaBars({ bars: [{ t: "2026-10-23T13:31:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 42 }] });
    expect(b).toEqual({ date: "2026-10-23T13:31:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 42 });
  });

  it("drops bars with a missing timestamp or a non-finite price", () => {
    const bars = mapAlpacaBars({
      bars: [
        { t: "2026-10-23T13:31:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 1 },
        { t: "2026-10-23T13:36:00Z", o: 1, h: 2, l: 0.5, c: Number.NaN, v: 1 },
        { o: 1, h: 2, l: 0.5, c: 1.5, v: 1 } as never,
      ],
    });
    expect(bars).toHaveLength(1);
  });

  it("tolerates a null body (empty page)", () => {
    expect(mapAlpacaBars({ bars: null })).toEqual([]);
    expect(mapAlpacaBars({})).toEqual([]);
  });
});

describe("aggregateBars", () => {
  const minutes = Array.from({ length: 10 }, (_, i) =>
    bar(`2026-10-23T13:3${i}:00Z`, 100 + i, 101 + i, 99 + i, 100.5 + i, 10)
  );

  it("rolls 1-minute bars into 5-minute bars with the right OHLCV", () => {
    const out = aggregateBars(minutes, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ open: 100, high: 105, low: 99, close: 104.5, volume: 50 });
    expect(out[1]).toMatchObject({ open: 105, close: 109.5, volume: 50 });
    // the bucket keeps the FIRST bar's timestamp, so the engine's date labels line up
    expect(out[0].date).toBe(minutes[0].date);
  });

  it("never merges across a session boundary", () => {
    const crossing = [
      bar("2026-10-23T19:56:00Z", 10, 10, 10, 10),
      bar("2026-10-23T19:58:00Z", 11, 11, 11, 11),
      bar("2026-10-26T13:30:00Z", 12, 12, 12, 12),
      bar("2026-10-26T13:32:00Z", 13, 13, 13, 13),
    ];
    const out = aggregateBars(crossing, 5);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(11);
    expect(out[1].open).toBe(12);
    expect(sessionOf(out[0].date)).toBe("2026-10-23");
    expect(sessionOf(out[1].date)).toBe("2026-10-26");
  });

  it("returns the input untouched when asked for 1-minute bars", () => {
    expect(aggregateBars(minutes, 1)).toBe(minutes);
  });
});

describe("Alpaca client", () => {
  const page = (bars: number, token: string | null) => ({
    ok: true,
    status: 200,
    json: async () => ({
      bars: Array.from({ length: bars }, (_, i) => ({
        t: `2026-10-23T13:${String(i).padStart(2, "0")}:00Z`,
        o: 1, h: 1, l: 1, c: 1, v: 1,
      })),
      next_page_token: token,
    }),
    text: async () => "",
  });

  it("follows page tokens and sends the key headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return calls.length === 1 ? page(2, "TOKEN2") : page(1, null);
    }) as never;

    const bars = await fetchAlpacaBars(
      "aapl",
      { start: "2026-10-01", timeframe: "5Min" },
      { fetchImpl, credentials: { keyId: "K", secret: "S", from: "ALPACA" } }
    );

    expect(bars).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/v2/stocks/AAPL/bars");
    expect(calls[0].url).toContain("timeframe=5Min");
    expect(calls[0].url).toContain("feed=iex");
    expect(calls[1].url).toContain("page_token=TOKEN2");
    expect(calls[0].headers["APCA-API-KEY-ID"]).toBe("K");
    expect(calls[0].headers["APCA-API-SECRET-KEY"]).toBe("S");
  });

  it("explains what to do when no key is configured", async () => {
    await expect(
      fetchAlpacaBars("AAPL", { start: "2026-10-01" }, { credentials: null })
    ).rejects.toThrow(/ALPACA_API_KEY_ID/);
  });

  it("surfaces the HTTP status instead of returning an empty series", async () => {
    const fetchImpl = (async () => ({
      ok: false, status: 403, json: async () => ({}), text: async () => "forbidden",
    })) as never;
    await expect(
      fetchAlpacaBars("AAPL", { start: "2026-10-01" }, { fetchImpl, credentials: { keyId: "K", secret: "S", from: "ALPACA" } })
    ).rejects.toThrow(/HTTP 403/);
  });

  it("reports an empty window as an error, not as zero bars", async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ bars: [] }), text: async () => "" })) as never;
    await expect(
      fetchAlpacaBars("ZZZZ", { start: "2026-10-01" }, { fetchImpl, credentials: { keyId: "K", secret: "S", from: "ALPACA" } })
    ).rejects.toThrow(/no 1Min bars/);
  });
});

describe("credentials", () => {
  it("accepts either the Alpaca or the APCA variable names, and needs both halves", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ALPACA_API_KEY_ID;
      delete process.env.ALPACA_API_SECRET_KEY;
      delete process.env.APCA_API_KEY_ID;
      delete process.env.APCA_API_SECRET_KEY;
      expect(alpacaCredentials()).toBeNull();

      process.env.APCA_API_KEY_ID = "id";
      expect(alpacaCredentials()).toBeNull(); // secret missing
      process.env.APCA_API_SECRET_KEY = "secret";
      expect(alpacaCredentials()).toMatchObject({ keyId: "id", secret: "secret", from: "APCA" });

      process.env.ALPACA_API_KEY_ID = "id2";
      process.env.ALPACA_API_SECRET_KEY = "secret2";
      expect(alpacaCredentials()).toMatchObject({ keyId: "id2", from: "ALPACA" });
    } finally {
      for (const k of ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("knows each timeframe's length in minutes", () => {
    expect(TIMEFRAME_MINUTES["1Min"]).toBe(1);
    expect(TIMEFRAME_MINUTES["5Min"]).toBe(5);
    expect(TIMEFRAME_MINUTES["1Hour"]).toBe(60);
  });
});
