export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getAccount, getPositions, getBars } from '@/lib/alpaca';
import { logPortfolioSnapshot, getLatestSnapshot, getFirstSnapshot, getTrades, logDailySummary } from '@/lib/supabase';
import { claudeDailySummary } from '@/lib/claude';

export const runtime = 'nodejs';
export const maxDuration = 120;

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

  // Also run daily summary immediately after snapshot (saves a separate cron service)
  let summaryRecord = null;
  try {
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today + 'T00:00:00Z').toISOString();
    const allTrades = await getTrades({ limit: 100 });
    const tradesToday = allTrades.filter(t => t.created_at >= todayStart);

    const dailyPnlPct = parseFloat(Number(snapshot.daily_pnl_pct).toFixed(2));
    const vsSpyQqq = {
      spy: parseFloat((dailyPnlPct - spyPct).toFixed(2)),
      qqq: parseFloat((dailyPnlPct - qqqPct).toFixed(2)),
    };

    const { summary, next_week_plan } = await claudeDailySummary(
      { total_value: totalValue, daily_pnl_pct: dailyPnlPct },
      tradesToday,
      vsSpyQqq
    );

    summaryRecord = await logDailySummary({
      date: today, summary, trades_today: tradesToday.length,
      portfolio_value: totalValue, day_pnl_pct: dailyPnlPct,
      vs_spy: vsSpyQqq.spy, vs_qqq: vsSpyQqq.qqq, next_week_plan,
    });
  } catch (err) {
    console.error('[portfolio-snapshot] daily-summary error:', err.message);
  }

  return NextResponse.json({ snapshot, summary: summaryRecord });
}
