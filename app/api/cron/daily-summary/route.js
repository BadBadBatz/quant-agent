export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getAccount } from '@/lib/alpaca';
import { claudeDailySummary } from '@/lib/claude';
import { logDailySummary, getTrades, getLatestSnapshot } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
  const today = new Date().toISOString().split('T')[0];
  const todayStart = new Date(today + 'T00:00:00Z').toISOString();

  // Read the P&L straight from today's 4:00pm snapshot (written 5 min earlier),
  // which already computed daily_pnl_pct vs the prior day — recomputing here
  // against that same snapshot would always yield ~0%.
  const [account, allTrades, snapshot] = await Promise.all([
    getAccount(),
    getTrades({ limit: 100 }),
    getLatestSnapshot(),
  ]);

  const tradesToday = allTrades.filter(t => t.created_at >= todayStart);
  const totalValue = parseFloat(account.portfolio_value);
  const dailyPnlPct = snapshot?.daily_pnl_pct != null
    ? parseFloat(Number(snapshot.daily_pnl_pct).toFixed(2))
    : 0;
  const spyPct = snapshot?.spy_daily_pct ?? 0;
  const qqqPct = snapshot?.qqq_daily_pct ?? 0;

  const portfolioSnapshot = { total_value: totalValue, daily_pnl_pct: dailyPnlPct };
  const vsSpyQqq = {
    spy: parseFloat((dailyPnlPct - spyPct).toFixed(2)),
    qqq: parseFloat((dailyPnlPct - qqqPct).toFixed(2)),
  };

  const { summary, next_week_plan } = await claudeDailySummary(
    portfolioSnapshot,
    tradesToday,
    vsSpyQqq
  );

  const record = await logDailySummary({
    date: today,
    summary,
    trades_today: tradesToday.length,
    portfolio_value: totalValue,
    day_pnl_pct: dailyPnlPct,
    vs_spy: vsSpyQqq.spy,
    vs_qqq: vsSpyQqq.qqq,
    next_week_plan,
  });

  return NextResponse.json(record);
  } catch (err) {
    console.error('[daily-summary] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
