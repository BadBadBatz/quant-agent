export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/safety';
import { getPositions, sellPosition, getLatestQuote } from '@/lib/alpaca';
import { getAgentConfig, logDecisionNew, logOutcome, getDecisionHistory } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 120;

async function getTickerNews(ticker) {
  if (!process.env.POLYGON_API_KEY) return [];
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // last 30 min
    const r = await fetch(
      `https://api.polygon.io/v2/reference/news?ticker=${ticker}&published_utc.gte=${since}&limit=3&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const d = await r.json();
    return (d.results || []).map(n => n.title);
  } catch { return []; }
}

function isNegativeNews(headlines) {
  const negative = ['downgrade','cut','miss','loss','decline','plunge','risk','investigation','lawsuit','recall','fraud'];
  const text = headlines.join(' ').toLowerCase();
  return negative.some(w => text.includes(w));
}

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cfg = await getAgentConfig();
  const stopLoss   = parseFloat(cfg.stop_loss_pct);
  const takeProfit = parseFloat(cfg.take_profit_pct);

  const positions = await getPositions();
  if (!positions.length) return NextResponse.json({ ok: true, checked: 0 });

  const results = { stops: [], profits: [], flagged: [], ok: [] };

  for (const pos of positions) {
    const ticker      = pos.symbol;
    const entryPrice  = parseFloat(pos.avg_entry_price);
    const quote = await getLatestQuote(ticker).catch(() => null);
    const quotePrice = Number(quote?.AskPrice || quote?.ap || quote?.BidPrice || quote?.bp);
    const currentPrice = quotePrice > 0 ? quotePrice : parseFloat(pos.current_price);
    const returnPct   = (currentPrice / entryPrice) - 1;

    // Hard exits — no Claude, immediate action
    if (returnPct <= -stopLoss) {
      try {
        await sellPosition(ticker, pos.qty);
        const history = await getDecisionHistory(ticker, { limit: 1 });
        const decisionId = history[0]?.id || null;

        if (decisionId) {
          await logOutcome({
            decision_id: decisionId,
            exit_price:  currentPrice,
            return_pct:  returnPct * 100,
            exit_reason: 'stop_loss',
            days_held:   Math.floor((Date.now() - new Date(history[0].date)) / 86400000),
            win:         false,
          });
          const { supabase } = await import('@/lib/supabase');
          await supabase.from('decisions').update({ outcome_resolved: true }).eq('id', decisionId);
        }

        results.stops.push({ ticker, returnPct: parseFloat((returnPct * 100).toFixed(2)) });
      } catch (e) {
        console.error(`[position-monitor] stop loss error ${ticker}:`, e.message);
      }
      continue;
    }

    if (returnPct >= takeProfit) {
      try {
        await sellPosition(ticker, pos.qty);
        const history = await getDecisionHistory(ticker, { limit: 1 });
        const decisionId = history[0]?.id || null;

        if (decisionId) {
          await logOutcome({
            decision_id: decisionId,
            exit_price:  currentPrice,
            return_pct:  returnPct * 100,
            exit_reason: 'take_profit',
            days_held:   Math.floor((Date.now() - new Date(history[0].date)) / 86400000),
            win:         true,
          });
          const { supabase } = await import('@/lib/supabase');
          await supabase.from('decisions').update({ outcome_resolved: true }).eq('id', decisionId);
        }

        results.profits.push({ ticker, returnPct: parseFloat((returnPct * 100).toFixed(2)) });
      } catch (e) {
        console.error(`[position-monitor] take profit error ${ticker}:`, e.message);
      }
      continue;
    }

    // No price trigger — check for breaking news
    const headlines = await getTickerNews(ticker);
    if (headlines.length && isNegativeNews(headlines)) {
      // Flag for market-open to review — don't sell here
      const { supabase } = await import('@/lib/supabase');
      const history = await getDecisionHistory(ticker, { limit: 1 });
      if (history[0]) {
        await supabase.from('decisions')
          .update({ needs_review: true })
          .eq('id', history[0].id);
      }
      results.flagged.push({ ticker, headlines });
    } else {
      results.ok.push(ticker);
    }
  }

  return NextResponse.json(results);
}
