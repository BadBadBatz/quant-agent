import { NextResponse } from 'next/server';
import { getAccount, getPositions } from '@/lib/alpaca';
import { getSnapshotHistory } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const [account, positions, history] = await Promise.all([
      getAccount(),
      getPositions(),
      getSnapshotHistory(90),
    ]);

    return NextResponse.json({
      account: {
        portfolio_value: account.portfolio_value,
        cash: account.cash,
        buying_power: account.buying_power,
        equity: account.equity,
        status: account.status,
      },
      positions: positions.map(p => ({
        symbol: p.symbol,
        qty: p.qty,
        avg_entry_price: p.avg_entry_price,
        current_price: p.current_price,
        market_value: p.market_value,
        unrealized_pl: p.unrealized_pl,
        unrealized_plpc: p.unrealized_plpc,
        change_today: p.change_today,
      })),
      history,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
