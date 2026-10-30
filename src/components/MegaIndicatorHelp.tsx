"use client";

// ─── Mega Indicator help drawer ──────────────────────────────────────────
// The page has three controls that change the composite in ways that are not
// self-evident from the sliders alone: the weight map, the preset row and the
// two formula editors (right-click scoring rule, ＋ Add Indicator). The same
// material lives in README.md, but a page should not need a README to explain
// itself — so this drawer states the rules where the controls are, and shows
// the live state (preset, summed weight, indicator count) it is talking about.

import type { ReactNode } from "react";
import DetailDrawer from "./DetailDrawer";
import { MAX_CUSTOM } from "@/lib/custom-indicators";

function P({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-[var(--muted)]">{children}</p>;
}

function B({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-[var(--foreground)]">{children}</b>;
}

function K({ children }: { children: ReactNode }) {
  return (
    <code className="px-1 py-0.5 rounded bg-[var(--card-hover)] font-mono text-[10.5px] text-[var(--foreground)]">
      {children}
    </code>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="text-xs leading-relaxed text-[var(--muted)] space-y-1.5 list-disc pl-4">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--card-border)] p-3 space-y-1.5">
      <p className="text-xs font-semibold">{title}</p>
      {children}
    </div>
  );
}

export interface MegaIndicatorHelpProps {
  open: boolean;
  onClose: () => void;
  /** Label of the preset currently applied (or "✎ Custom"). */
  presetLabel: string;
  /** Summed weight of the enabled indicators. */
  totalWeight: number;
  /** Indicators with weight > 0. */
  inComposite: number;
  /** Every indicator on the page, in or out of the composite. */
  totalIndicators: number;
  /** User-defined formula indicators on this device. */
  customCount: number;
}

export default function MegaIndicatorHelp({
  open,
  onClose,
  presetLabel,
  totalWeight,
  inComposite,
  totalIndicators,
  customCount,
}: MegaIndicatorHelpProps) {
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title="How the Mega Score is built"
      subtitle={`Now: ${presetLabel} · total weight ${totalWeight.toFixed(1)} across ${inComposite} of ${totalIndicators} indicators`}
      badges={
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card-hover)] text-[var(--muted)]">
          WEIGHTS · PRESETS · FORMULA
        </span>
      }
      sections={[
        {
          heading: "Weights — how much say an indicator has",
          body: (
            <div className="space-y-3">
              <div className="rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-3">
                <p className="font-mono text-[11px] leading-relaxed">
                  composite = Σ (score × weight) ÷ Σ weight
                </p>
                <p className="text-[10.5px] text-[var(--muted)] mt-1">
                  summed over the indicators whose weight is above 0
                </p>
              </div>
              <Bullets
                items={[
                  <>
                    A weight is a <B>share</B>, not a percentage. 20 on RSI and 10 on the MACD
                    histogram means RSI has twice the say — nothing has to add up to 100. The
                    Balanced map sums to 88.5, and the composite divides by 88.5 (the weight it
                    actually summed).
                  </>,
                  <>
                    The slider runs 0–10 in half steps; the number box beside it accepts up to 20
                    when one reading should dominate. The <B>%</B> on the right is that
                    indicator&apos;s share of the summed weight (RSI at 20 of 88.5 = 22.6 %).
                  </>,
                  <>
                    Weight <B>0</B> takes the indicator out of the composite: its row dims, it stops
                    moving the score, and it still shows its own reading. Catalogue indicators start
                    at 0 until you add them.
                  </>,
                  <>
                    <B>Σw</B> on a category header is that group&apos;s summed weight, not a score —
                    open the group to see which members carry it.
                  </>,
                  <>
                    Every panel recomputes instantly from the map: the composite, the category bars
                    and the contribution chart. The score-history chart stays on even weights, so
                    moving a slider is a change of <B>view</B> — it never redraws the past.
                  </>,
                  <>
                    Touching any slider sets the preset to <B>✎ Custom</B> (no preset matches the map
                    any more). ↺ Reset restores the Balanced defaults. Weights are saved in this
                    browser and survive reloads.
                  </>,
                ]}
              />
              <P>
                <B>Balanced is measured, not picked.</B> On 24 tickers × 15 years at identical
                70/25 bands, a flat average of every indicator ended 0.23 excess Sharpe{" "}
                <i>behind</i> buy &amp; hold and this map 0.02 behind — the closest to the benchmark
                of anything tested, because sixteen correlated SMA/EMA readings were capped at 0.5
                each. Hand-tuning is a reasonable view change; a real retrain belongs in Backtest →
                🎓 Train Weights, and it must win on the <i>held-out</i> tail. A single retrain on a
                narrow universe has not (it lost 0.09–0.12 excess Sharpe out of sample).
              </P>
            </div>
          ),
        },
        {
          heading: "Presets — a whole weight map in one click",
          body: (
            <div className="space-y-2">
              <P>
                A preset writes every weight at once; it does not adjust the map you already have.
                The hints on the buttons are the same text as these cards.
              </P>
              <Card title="⚖️ Balanced — the calibrated default">
                <P>
                  RSI 20 · Bollinger position 20 · MACD histogram 10 · 2–4 each for 3-month
                  momentum, stochastic, Williams %R, ATR, volatility, volume ratio, 52-week distance,
                  efficiency ratio and the kernel pair · 0.5 each for the 16 SMA/EMA readings.
                </P>
                <P>
                  <B>Start here.</B> It is the map with the best held-out result, and the only one
                  where redundant moving averages cannot outvote the oscillators.
                </P>
              </Card>
              <Card title="⚖️ Everything — flat 1s">
                <P>
                  <B>Use it</B> to see one indicator&apos;s raw say or to test a hunch.{" "}
                  <B>Not a trading map:</B> the moving averages then take about half the total
                  weight, and that blend measured 0.23 excess Sharpe behind Balanced at the same
                  bands.
                </P>
              </Card>
              <Card title="🧭 Trend — follow the slow structure">
                <P>
                  Trend 50/200 and kernel slope at 4, all moving averages at 2, 3-month momentum at
                  2. <B>Use it</B> when you want the score to track the prevailing trend. Trend weight
                  is deliberately cheap in Balanced because slow uptrends mostly reward staying long
                  — a trend-heavy map re-ranks correlated averages more than it adds information.
                </P>
              </Card>
              <Card title="🚀 Momentum — thrust over position">
                <P>
                  RSI, MACD histogram and 3-month momentum at 4, volume ratio at 2.{" "}
                  <B>Use it</B> when you want the score to react to a move starting, not to where
                  price already sits.
                </P>
              </Card>
              <Card title="🔄 Mean Reversion — band readings weigh more">
                <P>
                  Bollinger position, RSI, StochRSI %K, Williams %R and 52-week distance at 4, ATR at
                  2. <B>Use it</B> on ranging names, where a reading far outside its healthy band
                  (RSI outside 30–70, price at a Bollinger extreme, far below the 52-week high)
                  should cost more than a mild trend reading.
                </P>
              </Card>
              <Card title="🌊 Smooth Trends — clean paths only">
                <P>
                  Efficiency ratio and kernel residual at 4, ATR at 2. <B>Use it</B> on noisy names,
                  where a trend that keeps doubling back should score badly even if it ends in the
                  same place.
                </P>
              </Card>
              <P>
                <B>✎ Custom</B> is not a preset — it is the badge you get once a slider, an added
                indicator or a formula change makes the map yours. Custom maps persist across
                reloads; ↺ Reset is the way back to Balanced.
              </P>
            </div>
          ),
        },
        {
          heading: "Formula editor — two editors, two jobs",
          body: (
            <div className="space-y-3">
              <Card title="Right-click a row → its rule, its formula, its fields">
                <P>
                  <B>What scores better</B> plus the two thresholds turn the raw reading into the
                  0–100 score. The same panel also edits the indicator itself: write a formula of
                  your own and it <B>replaces</B> the built-in calculation, and the name, unit and
                  description become yours too. Leave a field blank to keep the built-in&apos;s — the
                  box shows it as the placeholder.
                </P>
                <Bullets
                  items={[
                    <>
                      <B>Higher is better</B> — at or below <K>Bad (→0)</K> the score is 0, at or
                      above <K>Good (→100)</K> it is 100, straight line in between.
                    </>,
                    <>
                      <B>Lower is better</B> — the mirror image: <K>Good (→100)</K> is the low
                      figure, <K>Bad (→0)</K> the high one.
                    </>,
                    <>
                      <B>Healthy band</B> — inside <K>Band low</K>…<K>Band high</K> the score runs
                      60–100 with 100 at the middle of the band; outside it falls to 0 at 75 % of a
                      band width past the edge.
                    </>,
                    <>
                      A reversed pair (low above high) is rejected and scores 50 rather than
                      guessing. A collapsed pair such as <K>0 / 0</K> is a clean step: bullish 100,
                      bearish 0.
                    </>,
                  ]}
                />
                <P>
                  The formula box saves when it loses focus, and something that does not compile is
                  refused with the parser&apos;s own message rather than stored. An edited row is tagged{" "}
                  <B>your formula</B> — or <B>edited</B> when only a field changed — and its rule is
                  printed under the name. <B>Reset to built-in</B> drops the whole edit;{" "}
                  <B>Exclude</B> sets the weight to 0. Edits are saved in this browser and apply
                  wherever the indicator is scored: the composite, the score history and any
                  backtest you run afterwards. An expression that produces no value for the ticker
                  keeps the built-in reading and says so by name instead of scoring a blank.
                </P>
              </Card>

              <Card title="＋ Add Indicator → a formula of your own">
                <P>
                  This one writes the <B>raw</B> indicator: name, unit, formula, what scores better,
                  thresholds, description. The formula is evaluated bar by bar on the same daily
                  OHLCV series as the built-ins — variables <K>open</K> <K>high</K> <K>low</K>{" "}
                  <K>close</K> <K>volume</K>, lookbacks via <K>prev</K> <K>change</K>{" "}
                  <K>roc</K>, rolling maths via <K>sma</K> <K>ema</K> <K>stdev</K> <K>rsi</K>{" "}
                  <K>atr</K>, plus arithmetic and comparisons (which return 1/0). Lookback periods
                  must be whole numbers.
                </P>
                <P>
                  While you type, the draft is compiled and run against the{" "}
                  <B>current ticker</B>: the preview shows value → score before you save, and a
                  formula that produces nothing for that symbol reports a warning instead of a
                  silent 0.
                </P>
                <P>
                  Saving stores it on this device and adds it to the composite at weight 1 — move it
                  like any other row. Up to <B>{MAX_CUSTOM}</B> custom indicators
                  {customCount > 0 ? ` (${customCount} defined)` : ""}; edit or remove it from its
                  row. Its row carries an <i>Edit formula</i> button, and the right-click panel now
                  writes the same fields — the difference is only which one you reach first.
                </P>
              </Card>

              <P>
                Every built-in&apos;s own calculation stays readable: the ⓘ on a row and the
                right-click panel print it under <B>How it&apos;s calculated</B>. When you replace it with a
                formula of your own, that original is listed above your box — so an edit is always
                readable against what it replaced, and one click away from being undone.
              </P>
            </div>
          ),
        },
      ]}
    />
  );
}
