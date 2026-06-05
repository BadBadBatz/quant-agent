import { NextResponse } from 'next/server';
import { checkSafetyGates, verifyCronSecret, isMarketHours } from '@/lib/safety';
import { getPositions, getLatestQuote, sellPosition } from '@/lib/alpaca';
import { logTrade, getTrades, updateTrade, getConfig } from '@/lib/supabase';
import { EXIT_RULES } from '@/lib/signals';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isMarketHours()) {
    return NextResponse.json({ skipped: true, reason: 'Outside market hours' });
  }

  const safety = await checkSafetyGates();
  if (safety.blocked) {
    return NextResponse.json({ skipped: true, reason: safety.reason });
  }

  const cfg = await getConfig();
  const stopLossPct = parseFloat(cfg.stop_loss_pct);
  const takeProfitPct = parseFloat(cfg.take_profit_pct);

  const positions = await getPositions();
  const exits = [];

  for (const pos of positions) {
    const entryPrice = parseFloat(pos.avg_entry_price);
    const currentPrice = parseFloat(pos.current_price);
    const pnlPct = (currentPrice - entryPrice) / entryPrice;
    const qty = parseFloat(pos.qty);

    let exitReason = null;
    let sellQty = qty;

    if (pnlPct <= -stopLossPct) {
      exitReason = 'stop_loss';
    } else if (pnlPct >= EXIT_RULES.take_profit_2) {
      exitReason = 'take_profit';
    } else if (pnlPct >= EXIT_RULES.take_profit_1) {
      exitReason = 'take_profit';
      sellQty = Math.floor(qty * 0.5); // sell half at TP1
    }

    // Check max hold days using trade log
    if (!exitReason) {
      const trades = await getTrades({ limit: 200 });
      const entry = trades.find(t => t.symbol === pos.symbol && t.side === 'buy' && t.status === 'filled');
      if (entry) {
        const dayHeld = (Date.now() - new Date(entry.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (dayHeld > EXIT_RULES.max_hold_days) exitReason = 'signal';
      }
    }

    if (exitReason && sellQty >= 1) {
      try {
        const order = await sellPosition(pos.symbol, sellQty);
        const pnl = (currentPrice - entryPrice) * sellQty;

        await logTrade({
          symbol: pos.symbol,
          side: 'sell',
          qty: sellQty,
          price: currentPrice,
          total_value: currentPrice * sellQty,
          order_id: order.id,
          status: order.status,
          exit_reason: exitReason,
          pnl,
          pnl_pct: pnlPct * 100,
        });

        exits.push({ symbol: pos.symbol, reason: exitReason, pnl_pct: (pnlPct * 100).toFixed(2) });
      } catch (err) {
        console.error(`[stop-loss-monitor] Failed to sell ${pos.symbol}:`, err.message);
      }
    }
  }

  return NextResponse.json({ checked: positions.length, exits });
}
