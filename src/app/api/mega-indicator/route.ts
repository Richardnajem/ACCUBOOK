import { NextRequest, NextResponse } from "next/server";
import { getDailyBars } from "@/lib/market-data";
import {
  sma, ema, rsi, macd, bollinger, atr, rollingMax, rollingMin, stochastic, cci, stdev, williamsR, stochRsi,
  adx, mfi, obv, keltnerPosition, aroon, superTrend, windowMean,
  donchianPosition, rangePosition, adl, chaikinMoneyFlow, chaikinOscillator,
  balanceOfPower, cmo, percentSlope,
  connorsRsi, coppock, pmo, dpo, emv, atrStop,
} from "@/lib/ta";
import { ALL_SPECS, MA_PERIODS, computeMegaIndicator, defaultWeights, WeightMap, type IndicatorOverrideMap } from "@/lib/mega-indicator";
import { suggestIndicators, median, type SuggestionContext } from "@/lib/indicator-suggestions";
import { evalFormulaLast, evaluateCustom, sanitizeCustomList, type CustomIndicatorDef } from "@/lib/custom-indicators";
import { sanitizeOverrides } from "@/lib/mega-overrides";

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
  /** Readable failures from built-in data loading, custom formulas or edits. */
  warnings: string[];
  /** The market state the indicator suggester reads (null when there is no data). */
  context: SuggestionContext | null;
}

async function technicalRaw(
  ticker: string | null,
  custom: CustomIndicatorDef[],
  overrides: IndicatorOverrideMap,
): Promise<TechnicalRaw> {
  const empty: TechnicalRaw = {
    values: {}, asOf: null, dataSource: "none", ticker: null, error: null,
    customSpecs: [], warnings: [], context: null,
  };
  if (!ticker) return empty;
  try {
    const { bars, meta, source } = await getDailyBars(ticker.trim().toUpperCase(), 3);
    if (bars.length < 30) return { ...empty, ticker, error: `Not enough price history for ${ticker} (${bars.length} bars).` };

    const close = bars.map((b) => b.close);
    const open = bars.map((b) => b.open);
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

    // 5e. Williams %R (14) — 0 at the 14-day high, −100 at the 14-day low
    const wr14 = williamsR(high, low, close, 14);
    const williamsRVal = Number.isFinite(wr14[last]) ? wr14[last] : NaN;

    // 5f. Stochastic RSI (14,14,3) — fast %K and %D, both 0-100
    const sr = stochRsi(close, 14, 14, 3, 3);
    const stochRsiK = Number.isFinite(sr.k[last]) ? sr.k[last] : NaN;
    const stochRsiD = Number.isFinite(sr.d[last]) ? sr.d[last] : NaN;

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

    // ─── Catalogue: computed for every ticker, added only on request ──
    const adx14 = adx(high, low, close, 14);
    const mfi14 = mfi(high, low, close, volume, 14);
    const obvSeries = obv(close, volume);
    const obvAvg = sma(obvSeries, 20);
    const kcPos = keltnerPosition(high, low, close, 20, 10, 2);
    const aroon25 = aroon(high, low, 25);
    const stTrend = superTrend(high, low, close, 10, 3);
    const stLine = stTrend.line[last];
    const obvDiv =
      Number.isFinite(obvAvg[last]) && Number.isFinite(volAvg[last]) && volAvg[last] > 0
        ? (obvSeries[last] - obvAvg[last]) / volAvg[last]
        : NaN;
    const stLinePct = Number.isFinite(stLine) && stLine !== 0 ? ((px - stLine) / stLine) * 100 : NaN;

    // ─── Workbook 181026 additions ──────────────────────────────
    // Donchian channel position (0 = window low, 100 = window high).
    const donchian20 = donchianPosition(high, low, close, 20);
    // Fibonacci range position over the same 52-week window the app already
    // uses for "distance from the 52-week high".
    const fibWindow = Math.min(252, close.length);
    const fibPos = rangePosition(high, low, close, fibWindow);
    // A/D line against its own 20-bar average — days of average volume.
    const adlSeries = adl(high, low, close, volume);
    const adlAvg = sma(adlSeries, 20);
    const adlDays =
      Number.isFinite(adlAvg[last]) && Number.isFinite(volAvg[last]) && volAvg[last] > 0
        ? (adlSeries[last] - adlAvg[last]) / volAvg[last]
        : NaN;
    // +DI − −DI: ADX's direction.
    const diSpread =
      Number.isFinite(adx14.plusDi[last]) && Number.isFinite(adx14.minusDi[last])
        ? adx14.plusDi[last] - adx14.minusDi[last]
        : NaN;
    // Smoothed Balance of Power (14), and the Chaikin money-flow pair.
    const bop14 = windowMean(balanceOfPower(open, high, low, close), 14);
    const cmf20 = chaikinMoneyFlow(high, low, close, volume, 20);
    const chaikinOsc = chaikinOscillator(high, low, close, volume, 3, 10);
    const chaikinOscDays =
      Number.isFinite(chaikinOsc[last]) && Number.isFinite(volAvg[last]) && volAvg[last] > 0
        ? chaikinOsc[last] / volAvg[last]
        : NaN;
    // Chande momentum and the two workbook EMA slopes.
    const cmo14 = cmo(close, 14);
    const ema20 = ema(close, 20);
    const ema200 = ema(close, 200);
    const ema20Slope = percentSlope(ema20, close);
    const ema200Slope = percentSlope(ema200, close);
    // CTM: the workbook's mean of RSI, CMO, EMA-20, EMA-200 and ADX. The
    // workbook averages the EMA *price levels* in raw, which makes CTM drift
    // with the share price (always >60 for an expensive stock). Convert the two
    // EMA legs to the same 0-100 price-vs-EMA readings used by ta-ema-* first,
    // so CTM is a comparable 0-100 signal.
    const pctToEmaScore = (pct: number): number =>
      Number.isFinite(pct) ? Math.max(0, Math.min(100, ((pct + 1) / 2) * 100)) : NaN;
    const ema20Dist = Number.isFinite(ema20[last]) && ema20[last] !== 0 ? ((px - ema20[last]) / ema20[last]) * 100 : NaN;
    const ema200Dist = Number.isFinite(ema200[last]) && ema200[last] !== 0 ? ((px - ema200[last]) / ema200[last]) * 100 : NaN;
    const ctmParts = [rsiVal, cmo14[last], pctToEmaScore(ema20Dist), pctToEmaScore(ema200Dist), adx14.adx[last]];
    const ctm = ctmParts.every(Number.isFinite)
      ? ctmParts.reduce((s, v) => s + v, 0) / ctmParts.length
      : NaN;

    // ─── technicals richard additions ──────────────────────────
    const connors = connorsRsi(close, 3, 2, 100);
    const coppockCurve = coppock(close, 10, 14, 11);
    const pmoRes = pmo(close, 35, 20, 10);
    const dpo20 = dpo(close, 20);
    const dpoPct = Number.isFinite(dpo20[last]) && px !== 0 ? (dpo20[last] / px) * 100 : NaN;
    const emv14 = emv(high, low, volume, 14);
    const atrTrail = atrStop(high, low, close, 14, 3, 200);
    const low52 = rollingMin(close, Math.min(252, close.length));
    const atrStopPct =
      Number.isFinite(atrTrail.line[last]) && px !== 0
        ? ((px - atrTrail.line[last]) / px) * 100
        : NaN;
    const dist52Low =
      Number.isFinite(low52[last]) && low52[last] > 0
        ? ((px - low52[last]) / low52[last]) * 100
        : NaN;

    // Volatility regime: today's ATR% against its own median over the last year.
    const atrPctHistory: number[] = [];
    for (let i = Math.max(0, last - 249); i <= last; i++) {
      if (Number.isFinite(a[i]) && close[i] > 0) atrPctHistory.push((a[i] / close[i]) * 100);
    }

    const context: SuggestionContext = {
      adx: adx14.adx[last],
      efficiency: er10,
      atrPct,
      atrPctMedian: median(atrPctHistory),
      momentum: mom,
      volumeRatio: volRatio,
      fromHigh: dist52,
    };

    // User-defined indicators — evaluated once against the same bars.
    const customRes = custom.length
      ? evaluateCustom(custom, {
          open: bars.map((b) => b.open), high, low, close, volume,
        })
      : null;

    const values: Record<string, number> = {
        "ta-trend-50-200": trend,
        "ta-rsi-14": rsiVal,
        "ta-macd-hist": macdHist,
        "ta-bb-pos": bbPos,
        "ta-atr-pct": atrPct,
        "ta-stoch-k": stochK,
        "ta-stoch-d": stochD,
        "ta-cci-20": cciVal,
        "ta-williams-r": williamsRVal,
        "ta-stochrsi-k": stochRsiK,
        "ta-stochrsi-d": stochRsiD,
        "ta-adx-14": adx14.adx[last],
        "ta-supertrend": stLinePct,
        "ta-aroon-osc": aroon25.osc[last],
        "ta-mfi-14": mfi14[last],
        "ta-obv-20": obvDiv,
        "ta-kc-pos": kcPos[last],
        "ta-donchian-pos": donchian20[last],
        "ta-fib-pos": fibPos[last],
        "ta-adl-20": adlDays,
        "ta-di-spread": diSpread,
        "ta-bop-14": bop14[last],
        "ta-cmf-20": cmf20[last],
        "ta-chaikin-osc": chaikinOscDays,
        "ta-cmo-14": cmo14[last],
        "ta-ema20-slope": ema20Slope[last],
        "ta-ema200-slope": ema200Slope[last],
        "ta-ctm": ctm,
        "ta-vol-3d": vol3d,
        "ta-mom-63": mom,
        "ta-vol-ratio": volRatio,
        "ta-dist-52w-high": dist52,
        "ta-er-10": er10,
        "ta-kernel-slope": slope,
        "ta-kernel-residual": residualPct,
        "ta-connors-rsi": connors.value[last],
        "ta-coppock": coppockCurve[last],
        "ta-pmo": pmoRes.pmo[last],
        "ta-dpo-pct": dpoPct,
        "ta-emv-14": emv14[last],
        "ta-atr-stop": atrStopPct,
        "ta-dist-52w-low": dist52Low,
        ...maValues,
        ...(customRes?.values ?? {}),
    };

    // ─── User-edited calculations ─────────────────────────────────
    // An indicator whose formula the user replaced is evaluated from that
    // expression over the same bars (the same sandbox as a custom indicator),
    // and its value replaces the built-in one. A formula that fails to produce
    // a value keeps the built-in reading and is reported rather than silently
    // scoring something else.
    const warnings: string[] = [...(customRes?.errors ?? [])];
    for (const [id, ov] of Object.entries(overrides)) {
      const formula = ov?.formula?.trim();
      if (!formula) continue;
      if (!ALL_SPECS.some((s) => s.id === id)) continue;
      try {
        const edited = evalFormulaLast(formula, {
          open: bars.map((b) => b.open), high, low, close, volume,
        });
        if (Number.isFinite(edited)) values[id] = edited;
        else warnings.push(`Your formula for ${id} produced no value — the built-in calculation is still in use.`);
      } catch (e) {
        warnings.push(
          `Your formula for ${id} could not be evaluated (${e instanceof Error ? e.message : "invalid"}) — the built-in calculation is still in use.`
        );
      }
    }

    return {
      values,
      asOf: bars[last].date,
      dataSource: source,
      ticker: meta.symbol,
      error: null,
      customSpecs: customRes?.specs ?? [],
      warnings,
      context,
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

    // Per-indicator edits (a replacement formula and/or the other fields) from
    // the right-click editor. A malformed map is ignored rather than failing the
    // request, so the page falls back to the built-in readings.
    let overrides: IndicatorOverrideMap = {};
    const overridesParam = searchParams.get("overrides");
    if (overridesParam) {
      try {
        overrides = sanitizeOverrides(JSON.parse(overridesParam));
      } catch { /* ignore malformed overrides */ }
    }

    const technical = await technicalRaw(ticker, custom, overrides);

    // Catalogue indicators start outside the composite, so the default weight map
    // turns every optional spec off until the user adds it.
    const effectiveWeights = weights ?? defaultWeights(ALL_SPECS);
    const suggestions = technical.context
      ? suggestIndicators({
          context: technical.context,
          values: technical.values,
          weights: effectiveWeights,
          specs: ALL_SPECS,
        })
      : [];

    const result = computeMegaIndicator({
      technical: technical.values,
      custom: technical.customSpecs,
      weights: effectiveWeights,
      excluded,
      overrides,
      meta: {
        asOf: technical.asOf,
        ticker: technical.ticker,
        dataSource: technical.dataSource,
      },
    });

    return NextResponse.json({
      ...result,
      suggestions,
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
