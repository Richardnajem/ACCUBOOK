import { NextRequest, NextResponse } from 'next/server';
import { runStockBacktest, runStrategyComparison, runStrategyOptimization, runWalkForwardOptimization, BacktestConfig } from '@/lib/backtest-engine';
import { STRATEGIES, defaultParams } from '@/lib/strategies';
import { listCachedSymbols } from '@/lib/market-data';
import type { WeightMap } from '@/lib/mega-indicator';

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
          benchmarkSymbol: data.benchmarkSymbol ? String(data.benchmarkSymbol).trim().toUpperCase() : undefined,
          megaWeights: parseMegaWeights(data.megaWeights),
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
          params: (data.params && typeof data.params === 'object') ? data.params : {},
        };
        if (!cfg.symbol || !cfg.strategyId) {
          return NextResponse.json({ error: 'Ticker and strategy are required.' }, { status: 400 });
        }
        const result = await runStrategyOptimization(cfg);
        return NextResponse.json(result);
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
