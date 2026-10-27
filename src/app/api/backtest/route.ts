import { NextRequest, NextResponse } from 'next/server';
import { runStockBacktest, runStrategyComparison, runStrategyOptimization, runWalkForwardOptimization, BacktestConfig } from '@/lib/backtest-engine';
import { STRATEGIES, defaultParams } from '@/lib/strategies';
import { BAR_INTERVALS, type BarInterval } from '@/lib/bar-resample';
import { getDailyBars, listCachedSymbols } from '@/lib/market-data';
import { computeMegaScoreSeries, snapshotMegaScore } from '@/lib/mega-score';
import type { IndicatorOverrideMap, WeightMap } from '@/lib/mega-indicator';
import { sanitizeOverrides } from '@/lib/mega-overrides';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sanitize the client's Mega Indicator weights (id -> weight ≥ 0). Invalid or
// empty maps are dropped so the server falls back to its own defaults.
function parseMegaWeights(raw: unknown): WeightMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([k, v]) => [String(k).slice(0, 64), Math.max(0, Math.min(20, Number(v) || 0))] as const)
    .filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

// The user's per-indicator formula/field edits from the Mega Indicator page.
// Sanitized with the SAME function the client stores them with, so a formula
// that cannot compile is dropped here rather than scored by accident.
function parseMegaOverrides(raw: unknown): IndicatorOverrideMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const clean = sanitizeOverrides(raw);
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/**
 * The trading frequency the client asked for: daily (default), weekly or
 * monthly. Unknown values fall back to daily rather than erroring — a run at
 * the wrong frequency would be worse than an explicit default.
 */
function parseBarInterval(raw: unknown): BarInterval {
  const v = String(raw ?? 'daily').toLowerCase();
  return (BAR_INTERVALS as string[]).includes(v) ? (v as BarInterval) : 'daily';
}

// ─── GET ────────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'catalog';

    switch (type) {
      case 'catalog':
        // Available stock strategies + their parameters (for the GUI)
        return NextResponse.json(
          STRATEGIES.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            params: s.params,
            minBars: s.minBars,
            defaults: defaultParams(s),
          }))
        );

      case 'cache':
        return NextResponse.json(listCachedSymbols());

      default:
        return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error in backtest GET:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ─── POST ───────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, ...data } = body;

    switch (action) {
      case 'runStockBacktest': {
        const cfg: BacktestConfig = {
          symbol: String(data.symbol || '').trim(),
          strategyId: String(data.strategyId || ''),
          initialCapital: Number(data.initialCapital) || 100000,
          years: Number(data.years) || 10,
          commissionBps: Number(data.commissionBps ?? 0),
          slippageBps: Number(data.slippageBps ?? 0),
          positionPct: Number(data.positionPct ?? 100),
          params: (data.params && typeof data.params === 'object') ? data.params : {},
          stopLossPct: data.stopLossPct != null && Number(data.stopLossPct) > 0 ? Number(data.stopLossPct) : undefined,
          takeProfitPct: data.takeProfitPct != null && Number(data.takeProfitPct) > 0 ? Number(data.takeProfitPct) : undefined,
          maxTrades: data.maxTrades != null && Number(data.maxTrades) > 0 ? Math.floor(Number(data.maxTrades)) : undefined,
          flatAtSessionEnd: Boolean(data.flatAtSessionEnd),
          barInterval: parseBarInterval(data.barInterval),
          minTrades: data.minTrades != null && Number(data.minTrades) > 0 ? Math.floor(Number(data.minTrades)) : undefined,
          benchmarkSymbol: data.benchmarkSymbol ? String(data.benchmarkSymbol).trim().toUpperCase() : undefined,
          megaWeights: parseMegaWeights(data.megaWeights),
          megaOverrides: parseMegaOverrides(data.megaOverrides),
        };
        if (!cfg.symbol) {
          return NextResponse.json({ error: 'Ticker symbol is required (e.g. AAPL).' }, { status: 400 });
        }
        if (!cfg.strategyId) {
          return NextResponse.json({ error: 'Strategy is required.' }, { status: 400 });
        }
        const result = await runStockBacktest(cfg);
        return NextResponse.json(result);
      }

      case 'compareStrategies': {
        const cfg: BacktestConfig = {
          symbol: String(data.symbol || '').trim(),
          strategyId: 'buy_hold', // unused by the comparison itself
          initialCapital: Number(data.initialCapital) || 100000,
          years: Number(data.years) || 10,
          commissionBps: Number(data.commissionBps ?? 0),
          slippageBps: Number(data.slippageBps ?? 0),
          positionPct: Number(data.positionPct ?? 100),
          megaWeights: parseMegaWeights(data.megaWeights),
          megaOverrides: parseMegaOverrides(data.megaOverrides),
          barInterval: parseBarInterval(data.barInterval),
          params: {},
        };
        if (!cfg.symbol) {
          return NextResponse.json({ error: 'Ticker symbol is required (e.g. AAPL).' }, { status: 400 });
        }
        const result = await runStrategyComparison(cfg);
        return NextResponse.json(result);
      }

      case 'optimizeStrategy': {
        const cfg: BacktestConfig = {
          symbol: String(data.symbol || '').trim(),
          strategyId: String(data.strategyId || ''),
          initialCapital: Number(data.initialCapital) || 100000,
          years: Number(data.years) || 10,
          commissionBps: Number(data.commissionBps ?? 0),
          slippageBps: Number(data.slippageBps ?? 0),
          positionPct: Number(data.positionPct ?? 100),
          megaWeights: parseMegaWeights(data.megaWeights),
          megaOverrides: parseMegaOverrides(data.megaOverrides),
          barInterval: parseBarInterval(data.barInterval),
          minTrades: data.minTrades != null && Number(data.minTrades) > 0 ? Math.floor(Number(data.minTrades)) : undefined,
          params: (data.params && typeof data.params === 'object') ? data.params : {},
        };
        if (!cfg.symbol || !cfg.strategyId) {
          return NextResponse.json({ error: 'Ticker and strategy are required.' }, { status: 400 });
        }
        const result = await runStrategyOptimization(cfg);
        return NextResponse.json(result);
      }

      // Per-indicator breakdown for specific bars (the trade log's "every
      // indicator" view). Recomputed on demand so a normal backtest response
      // never has to carry ~150 series × every bar to the browser.
      case 'indicatorSnapshot': {
        const symbol = String(data.symbol || '').trim().toUpperCase();
        const years = Number(data.years) || 10;
        const dates: string[] = Array.isArray(data.dates)
          ? Array.from(new Set((data.dates as unknown[]).map((d) => String(d)).filter(Boolean))).slice(0, 8)
          : [];
        if (!symbol || dates.length === 0) {
          return NextResponse.json({ error: 'Ticker and at least one date are required.' }, { status: 400 });
        }
        const weights = parseMegaWeights(data.megaWeights);
        const overrides = parseMegaOverrides(data.megaOverrides);
        const { bars } = await getDailyBars(symbol, years);
        if (bars.length === 0) throw new Error(`No price history available for ${symbol}.`);
        const series = computeMegaScoreSeries(
          {
            high: bars.map((b) => b.high),
            low: bars.map((b) => b.low),
            close: bars.map((b) => b.close),
            volume: bars.map((b) => b.volume),
            open: bars.map((b) => b.open),
          },
          weights,
          undefined,
          overrides
        );
        const indexByDate = new Map(bars.map((b, i) => [b.date, i]));
        const snapshots = dates.map((date) => {
          const index = indexByDate.get(date);
          if (index === undefined) return null;
          return snapshotMegaScore(series, index, date, weights);
        });
        return NextResponse.json({
          symbol,
          bars: bars.length,
          snapshots: snapshots.filter(Boolean),
          missingDates: dates.filter((d) => !indexByDate.has(d)),
        });
      }

      case 'walkForward': {
        const cfg: BacktestConfig = {
          symbol: String(data.symbol || '').trim(),
          strategyId: String(data.strategyId || ''),
          initialCapital: Number(data.initialCapital) || 100000,
          years: Number(data.years) || 10,
          commissionBps: Number(data.commissionBps ?? 0),
          slippageBps: Number(data.slippageBps ?? 0),
          positionPct: Number(data.positionPct ?? 100),
          megaWeights: parseMegaWeights(data.megaWeights),
          megaOverrides: parseMegaOverrides(data.megaOverrides),
          minTrades: data.minTrades != null && Number(data.minTrades) > 0 ? Math.floor(Number(data.minTrades)) : undefined,
          params: {},
        };
        if (!cfg.symbol || !cfg.strategyId) {
          return NextResponse.json({ error: 'Ticker and strategy are required.' }, { status: 400 });
        }
        const result = await runWalkForwardOptimization(cfg, {
          trainYears: Number(data.trainYears) || 3,
          testYears: Number(data.testYears) || 1,
        });
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error in backtest POST:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
