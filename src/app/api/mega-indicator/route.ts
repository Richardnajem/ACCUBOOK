import { NextRequest, NextResponse } from "next/server";
import { getDailyBars } from "@/lib/market-data";
import { sma, ema, rsi, macd, bollinger, atr, rollingMax, stochastic, cci, stdev } from "@/lib/ta";
import { MA_PERIODS, computeMegaIndicator, WeightMap } from "@/lib/mega-indicator";
import { evaluateCustom, sanitizeCustomList, type CustomIndicatorDef } from "@/lib/custom-indicators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── Technical side (real daily OHLCV via the market-data cache) ──
interface TechnicalRaw {
  values: Record<string, number>;
  asOf: string | null;
  dataSource: "cache" | "yahoo" | "none";
  ticker: string | null;
  error: string | null;
  /** Spec objects for user-defined indicators that evaluated successfully. */
  customSpecs: ReturnType<typeof evaluateCustom>["specs"];
  /** Readable failures from built-in data loading or custom formulas. */
  warnings: string[];
}

async function technicalRaw(ticker: string | null, custom: CustomIndicatorDef[]): Promise<TechnicalRaw> {
  const empty: TechnicalRaw = {
    values: {}, asOf: null, dataSource: "none", ticker: null, error: null,
    customSpecs: [], warnings: [],
  };
  if (!ticker) return empty;
  try {
    const { bars, meta, source } = await getDailyBars(ticker.trim().toUpperCase(), 3);
    if (bars.length < 30) return { ...empty, ticker, error: `Not enough price history for ${ticker} (${bars.length} bars).` };

    const close = bars.map((b) => b.close);
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const volume = bars.map((b) => b.volume);
    const last = close.length - 1;
    const px = close[last];
    let residualPct = NaN;

    // 1. Trend: price relative to 50/200 SMAs (average of the two % distances)
    const sma50 = sma(close, 50);
    const sma200 = sma(close, 200);
    const trendParts: number[] = [];
    if (Number.isFinite(sma50[last])) trendParts.push((px / sma50[last] - 1) * 100);
    if (Number.isFinite(sma200[last])) trendParts.push((px / sma200[last] - 1) * 100);
    const trend = trendParts.length ? trendParts.reduce((s, v) => s + v, 0) / trendParts.length : NaN;

    // 2. RSI(14)
    const r = rsi(close, 14);
    const rsiVal = Number.isFinite(r[last]) ? r[last] : NaN;

    // 3. MACD histogram, normalized to % of price so the scale is comparable
    const m = macd(close, 12, 26, 9);
    const macdHist = Number.isFinite(m.histogram[last]) ? (m.histogram[last] / px) * 100 : NaN;

    // 4. Bollinger position: 0 = at lower band, 100 = at upper band
    const bb = bollinger(close, 20, 2);
    let bbPos = NaN;
    if (Number.isFinite(bb.upper[last]) && bb.upper[last] !== bb.lower[last]) {
      bbPos = ((px - bb.lower[last]) / (bb.upper[last] - bb.lower[last])) * 100;
    }

    // 5. ATR% (14)
    const a = atr(high, low, close, 14);
    const atrPct = Number.isFinite(a[last]) ? (a[last] / px) * 100 : NaN;

    // 5b. Stochastic (14, 3, 3) — slow %K and %D, both 0-100
    const st = stochastic(high, low, close, 14, 3, 3);
    const stochK = Number.isFinite(st.k[last]) ? st.k[last] : NaN;
    const stochD = Number.isFinite(st.d[last]) ? st.d[last] : NaN;

    // 5c. Commodity Channel Index (20)
    const cci20 = cci(high, low, close, 20);
    const cciVal = Number.isFinite(cci20[last]) ? cci20[last] : NaN;

    // 5d. 3-day volatility: sample stdev of closes as % of price
    const sd3 = stdev(close, 3);
    const vol3d = Number.isFinite(sd3[last]) && px !== 0 ? (sd3[last] / px) * 100 : NaN;

    // 6. 3-month (~63 trading days) momentum
    const lb = Math.min(63, close.length - 1);
    const mom = (px / close[last - lb] - 1) * 100;

    // 7. Volume vs 20-day average (last 5 days vs 20d avg)
    const volAvg = sma(volume, 20);
    const recentVol = volume.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, volume.length);
    const volRatio = Number.isFinite(volAvg[last]) && volAvg[last] > 0 ? recentVol / volAvg[last] : NaN;

    // 8. Distance below 52-week high (%)
    const hi52 = rollingMax(close, Math.min(252, close.length));
    const dist52 = Number.isFinite(hi52[last]) && hi52[last] > 0 ? ((px - hi52[last]) / hi52[last]) * 100 : NaN;

    // 9. Kaufman Efficiency Ratio (10): net move / sum of absolute moves
    let pathLen = 0;
    for (let i = close.length - 10; i < close.length; i++) pathLen += Math.abs(close[i] - close[i - 1]);
    const netMove = Math.abs(px - close[close.length - 10]);
    const er10 = pathLen > 0 ? netMove / pathLen : NaN;

    // 10/11. Nadaraya-Watson kernel regression (Gaussian, bandwidth 8) —
    // trend, slope (% of price per bar) and residual (choppiness).
    // Centered estimate where both sides exist; causal (trailing) estimate
    // for the most recent bars, since the LIVE bar has no future data.
    const bw = 8;
    const w = new Array(bw * 2 + 1).fill(0);
    for (let d = -bw; d <= bw; d++) w[d + bw] = Math.exp(-(d * d) / (2 * bw * bw));
    const n = close.length;
    const nwAt = (i: number): number => {
      if (i < bw) return NaN;
      if (i <= n - 1 - bw) {
        // centered: window [i-bw, i+bw]
        let ws = 0, vs = 0;
        for (let d = -bw; d <= bw; d++) { ws += w[d + bw]; vs += w[d + bw] * close[i + d]; }
        return vs / ws;
      }
      // causal: trailing window [i-2bw, i], gaussian centered at i-bw
      let ws = 0, vs = 0;
      for (let d = -2 * bw; d <= 0; d++) {
        const wt = Math.exp(-(d * d) / (2 * bw * bw));
        ws += wt; vs += wt * close[i + d];
      }
      return vs / ws;
    };
    let trendVal = NaN;
    let slope = NaN;
    if (n > bw * 2 + 2) {
      trendVal = nwAt(last);
      const prev = nwAt(last - 1);
      if (Number.isFinite(trendVal) && Number.isFinite(prev) && prev !== 0) {
        slope = ((trendVal - prev) / prev) * 100;
      }
      // Residual: stdev of (price - kernel) over the last 20 computable bars
      const diffs: number[] = [];
      for (let i = last; i >= Math.max(bw, last - 19); i--) {
        const est = nwAt(i);
        if (Number.isFinite(est)) diffs.push(close[i] - est);
      }
      if (diffs.length >= 5 && Number.isFinite(trendVal) && trendVal !== 0) {
        const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
        const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length;
        residualPct = (Math.sqrt(variance) / Math.abs(trendVal)) * 100;
      }
    }

    // 12. SMA/EMA family (10-200): price distance in % (above MA = bullish)
    const maValues: Record<string, number> = {};
    for (const p of MA_PERIODS) {
      const s = sma(close, p);
      const e = ema(close, p);
      maValues[`ta-sma-${p}`] = Number.isFinite(s[last]) ? ((px - s[last]) / s[last]) * 100 : NaN;
      maValues[`ta-ema-${p}`] = Number.isFinite(e[last]) ? ((px - e[last]) / e[last]) * 100 : NaN;
    }

    // User-defined indicators — evaluated once against the same bars.
    const customRes = custom.length
      ? evaluateCustom(custom, {
          open: bars.map((b) => b.open), high, low, close, volume,
        })
      : null;

    return {
      values: {
        "ta-trend-50-200": trend,
        "ta-rsi-14": rsiVal,
        "ta-macd-hist": macdHist,
        "ta-bb-pos": bbPos,
        "ta-atr-pct": atrPct,
        "ta-stoch-k": stochK,
        "ta-stoch-d": stochD,
        "ta-cci-20": cciVal,
        "ta-vol-3d": vol3d,
        "ta-mom-63": mom,
        "ta-vol-ratio": volRatio,
        "ta-dist-52w-high": dist52,
        "ta-er-10": er10,
        "ta-kernel-slope": slope,
        "ta-kernel-residual": residualPct,
        ...maValues,
        ...(customRes?.values ?? {}),
      },
      asOf: bars[last].date,
      dataSource: source,
      ticker: meta.symbol,
      error: null,
      customSpecs: customRes?.specs ?? [],
      warnings: customRes?.errors ?? [],
    };
  } catch (e) {
    return { ...empty, ticker, error: e instanceof Error ? e.message : "Failed to load market data." };
  }
}

// ─── GET ────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get("ticker");
    let weights: WeightMap | undefined;
    let excluded: string[] | undefined;

    const weightsParam = searchParams.get("weights");
    if (weightsParam) {
      try {
        const parsed = JSON.parse(weightsParam);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          weights = Object.fromEntries(
            Object.entries(parsed).map(([k, v]) => [k, Math.max(0, Number(v) || 0)])
          );
        }
      } catch { /* ignore malformed weights */ }
    }

    const excludedParam = searchParams.get("excluded");
    if (excludedParam) {
      try {
        const parsed = JSON.parse(excludedParam);
        if (Array.isArray(parsed)) excluded = parsed.map(String);
      } catch { /* ignore malformed excluded */ }
    }

    // User-defined indicators (from the "Add Indicator" editor).
    let custom: CustomIndicatorDef[] = [];
    let customParseError: string | null = null;
    const customParam = searchParams.get("custom");
    if (customParam) {
      try {
        const rawCustom: unknown = JSON.parse(customParam);
        if (Array.isArray(rawCustom)) {
          custom = sanitizeCustomList(rawCustom);
          // Definitions the sanitizer dropped would otherwise vanish silently —
          // tell the user which of their saved indicators did not load.
          const skipped = rawCustom.length - custom.length;
          if (skipped > 0) {
            customParseError =
              `${skipped} of your saved indicators could not be loaded — ` +
              `the formula is no longer valid, or its id is broken.`;
          }
        }
      } catch {
        customParseError = "Your saved indicator list was malformed and was ignored.";
      }
    }

    const technical = await technicalRaw(ticker, custom);

    const result = computeMegaIndicator({
      technical: technical.values,
      custom: technical.customSpecs,
      weights,
      excluded,
      meta: {
        asOf: technical.asOf,
        ticker: technical.ticker,
        dataSource: technical.dataSource,
      },
    });

    return NextResponse.json({
      ...result,
      technicalError: technical.error,
      warnings: customParseError ? [customParseError, ...technical.warnings] : technical.warnings,
      customCount: technical.customSpecs.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute mega indicator." },
      { status: 500 }
    );
  }
}
