"use client";

import StockBacktest from "./StockBacktest";

// Backtesting — real market data, famous strategies, parameter optimization.
// All heavy lifting lives in StockBacktest (single backtest / compare / optimize).
export default function BacktestPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Backtesting</h2>
        <p className="text-sm text-[var(--muted)]">
          Test famous strategies on real historical market data before risking a cent
        </p>
      </div>
      <StockBacktest />
    </div>
  );
}
