export const dynamic = 'force-dynamic';

/**
 * EOD — End of Day
 * Combines Phase 7 (market close analysis) + Phase 3 (outcome writer)
 * Runs at 4:00 PM ET weekdays via Railway cron.
 */

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getPositions, getAccount, getBars } from '@/lib/alpaca';
import {
  getLatestMacroContext, logDailySummaryNew,
  supabase,
} from '@/lib/supabase';
import { claudeDailySummary } from '@/lib/claude';
import { resolvePendingOutcomes } from '@/lib/outcomes';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 180;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function parseJson(text) {
  const clean = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('No JSON'); }
}

// ── Phase 7: Per-position close assessment ────────────────────────────────────
async function assessPosition(pos, macro) {
  const returnPct = parseFloat(pos.unrealized_plpc) * 100;
  const spyIntraday = 0; // approximated

  const prompt = `Brief end-of-day assessment for this position. Be concise.

${pos.symbol}: entry $${parseFloat(pos.avg_entry_price).toFixed(2)}, current $${parseFloat(pos.current_price).toFixed(2)}, return ${returnPct.toFixed(2)}%
Market regime: ${macro.regime}  SPY RSI: ${macro.spy_rsi}

Return JSON only:
{"thesis_intact":true|false,"reason":"<one sentence>","concern_level":"low"|"medium"|"high"}`;

  try {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    return parseJson(r.content[0].text);
  } catch { return { thesis_intact: true, reason: 'Unable to assess.', concern_level: 'low' }; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().split('T')[0];
  const macro = await getLatestMacroContext();

  // ── Phase 7a: Per-position close assessment ───────────────────────────────
  const positions = await getPositions();
  const positionReviews = [];

  for (const pos of positions) {
    const assessment = macro
      ? await assessPosition(pos, macro)
      : { thesis_intact: true, reason: 'No macro context.', concern_level: 'low' };

    // Save to decisions as daily_review
    const { data: dec } = await supabase.from('decisions')
      .select('id').eq('ticker', pos.symbol).eq('outcome_resolved', false)
      .order('date', { ascending: false }).limit(1).single();

    if (dec) {
      await supabase.from('decisions')
        .update({ daily_review: { ...assessment, date: today } })
        .eq('id', dec.id);
    }

    positionReviews.push({ ticker: pos.symbol, ...assessment });
  }

  // ── Phase 3: Outcome resolution ───────────────────────────────────────────
  const resolvedOutcomes = await resolvePendingOutcomes({ holdTradingDays: 5 });

  // ── Phase 7b: Daily summary via Claude ───────────────────────────────────
  let summary = null;
  try {
    const account = await getAccount();
    const totalValue   = parseFloat(account.portfolio_value);
    const todayStart   = new Date(today + 'T00:00:00Z').toISOString();
    const { data: todayDecisions } = await supabase.from('decisions')
      .select('ticker, action').gte('date', todayStart).eq('action', 'buy');

    const spyBars = await getBars('SPY', '1Day', 2).catch(() => []);
    const spyDailyPct = spyBars.length >= 2
      ? ((spyBars[1].ClosePrice / spyBars[0].ClosePrice) - 1) * 100 : 0;

    // Use legacy claudeDailySummary format
    const { summary: summaryText, next_week_plan } = await claudeDailySummary(
      { total_value: totalValue, daily_pnl_pct: 0 },
      (todayDecisions || []).map(d => ({ side: 'buy', symbol: d.ticker, price: 0 })),
      { spy: spyDailyPct, qqq: 0 }
    );

    const highConcern = positionReviews.filter(p => p.concern_level === 'high');
    summary = await logDailySummaryNew({
      date:             today,
      summary:          summaryText,
      trades_today:     (todayDecisions || []).length,
      portfolio_value:  totalValue,
      day_pnl_pct:      0,
      vs_spy:           0,
      vs_qqq:           0,
      next_week_plan:   next_week_plan + (highConcern.length
        ? ` HIGH CONCERN positions: ${highConcern.map(p => p.ticker).join(', ')}.`
        : ''),
    });
  } catch (e) {
    console.error('[eod] daily summary error:', e.message);
  }

  return NextResponse.json({
    ok: true,
    position_reviews: positionReviews,
    resolved: {
      buys:    resolvedOutcomes.buys.length,
      passes:  resolvedOutcomes.passes.length,
      watches: resolvedOutcomes.watches.length,
      errors:  resolvedOutcomes.errors.length,
    },
    summary: summary?.id || null,
  });
}
