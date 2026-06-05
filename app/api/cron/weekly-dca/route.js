import { NextResponse } from 'next/server';
import { checkSafetyGates, verifyCronSecret } from '@/lib/safety';
import { getIndicators } from '@/lib/indicators';
import { evaluateCandidate, UNIVERSE, SECTOR_MAP } from '@/lib/signals';
import { placeBracketOrder, getAccount, getPositions, waitForFill } from '@/lib/alpaca';
import { logTrade, logDca, getConfig, getCurrentWeekDca } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const safety = await checkSafetyGates();
  if (safety.blocked) {
    return NextResponse.json({ skipped: true, reason: safety.reason });
  }

  // Idempotency: don't deploy twice in the same week (e.g. on a cron retry).
  const existingDca = await getCurrentWeekDca();
  if (existingDca) {
    return NextResponse.json({ skipped: true, reason: 'Already deployed this week' });
  }

  const cfg = await getConfig();
  const weeklyBudget = parseFloat(cfg.weekly_budget);
  const deployable = weeklyBudget * 0.75; // $37.50 of $50
  const stopLossPct = parseFloat(cfg.stop_loss_pct);
  const takeProfitPct = parseFloat(cfg.take_profit_pct);

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const currentPositions = positions.map(p => ({
    symbol: p.symbol,
    sector: SECTOR_MAP[p.symbol] || 'unknown',
  }));

  // Find highest-conviction candidate from tech universe
  let bestSymbol = null;
  let bestScore = -1;

  for (const symbol of UNIVERSE.tech) {
    if (positions.some(p => p.symbol === symbol)) continue;
    try {
      const indicators = await getIndicators(symbol);
      const evaluation = evaluateCandidate(indicators, 'neutral', currentPositions);
      if (evaluation.signalsMet > bestScore) {
        bestScore = evaluation.signalsMet;
        bestSymbol = symbol;
      }
    } catch {
      // skip on error
    }
  }

  // Fallback to QQQ if no good signal
  const target = bestScore >= 3 ? bestSymbol : 'QQQ';

  // Avoid stacking a bracket order onto a position we already hold (Alpaca
  // rejects overlapping brackets / can trip wash-trade protection).
  if (positions.some(p => p.symbol === target)) {
    return NextResponse.json({ skipped: true, reason: `Already holding ${target}` });
  }

  let order = null;
  let trade = null;
  try {
    order = await placeBracketOrder({
      symbol: target,
      notional: deployable,
      stopLossPct,
      takeProfitPct,
    });

    const filled = await waitForFill(order.id);
    const fillPrice = parseFloat(filled.filled_avg_price || 0);
    const fillQty = parseFloat(filled.filled_qty || filled.qty || order.qty);

    trade = await logTrade({
      symbol: target,
      side: 'buy',
      qty: fillQty,
      price: fillPrice,
      total_value: fillPrice > 0 ? fillQty * fillPrice : deployable,
      order_id: order.id,
      status: filled.status,
    });
  } catch (err) {
    // Whole-share constraint: if $deployable can't buy 1 share, skip cleanly
    // (no order placed) rather than failing the whole run.
    if (/Insufficient capital|1 share/i.test(err.message)) {
      return NextResponse.json({
        skipped: true,
        reason: `Deployable $${deployable.toFixed(2)} insufficient for 1 share of ${target}`,
      });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);

  await logDca({
    week_start: weekStart.toISOString().split('T')[0],
    amount: weeklyBudget,
    deployed: deployable,
    held_back: weeklyBudget - deployable,
    targets: [{ symbol: target, amount: deployable, signal_score: bestScore }],
  });

  return NextResponse.json({ deployed: deployable, symbol: target, signal_score: bestScore, order_id: order?.id });
}
