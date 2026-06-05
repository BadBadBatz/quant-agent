import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getAccount, getPositions, getBars } from '@/lib/alpaca';
import { logPortfolioSnapshot, getLatestSnapshot, getFirstSnapshot } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function getDailyPct(symbol) {
  try {
    const bars = await getBars(symbol, '1Day', 2);
    if (bars.length < 2) return 0;
    return ((bars[1].ClosePrice - bars[0].ClosePrice) / bars[0].ClosePrice) * 100;
  } catch {
    return 0;
  }
}

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [account, positions, spyPct, qqqPct, prevSnapshot, firstSnapshot] = await Promise.all([
    getAccount(),
    getPositions(),
    getDailyPct('SPY'),
    getDailyPct('QQQ'),
    getLatestSnapshot(),
    getFirstSnapshot(),
  ]);

  const totalValue = parseFloat(account.portfolio_value);
  const cash = parseFloat(account.cash);
  const equity = totalValue - cash;
  const dailyPnl = prevSnapshot ? totalValue - prevSnapshot.total_value : 0;
  const dailyPnlPct = prevSnapshot && prevSnapshot.total_value > 0
    ? (dailyPnl / prevSnapshot.total_value) * 100
    : 0;

  // Total P&L is anchored to the value when tracking began (first snapshot),
  // not a hardcoded number — so it stays correct if the account differs/resets.
  const baseline = firstSnapshot?.total_value ?? totalValue;
  const totalPnl = totalValue - baseline;
  const totalPnlPct = baseline > 0 ? (totalPnl / baseline) * 100 : 0;

  const snapshot = await logPortfolioSnapshot({
    total_value: totalValue,
    cash,
    equity,
    daily_pnl: dailyPnl,
    daily_pnl_pct: dailyPnlPct,
    total_pnl: totalPnl,
    total_pnl_pct: totalPnlPct,
    positions: positions.map(p => ({
      symbol: p.symbol,
      qty: p.qty,
      current_price: p.current_price,
      avg_entry_price: p.avg_entry_price,
      unrealized_pl: p.unrealized_pl,
      unrealized_plpc: p.unrealized_plpc,
    })),
    spy_daily_pct: spyPct,
    qqq_daily_pct: qqqPct,
  });

  return NextResponse.json(snapshot);
}
