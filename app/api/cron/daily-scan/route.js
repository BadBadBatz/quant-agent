export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { checkSafetyGates, verifyCronSecret, isMarketHours } from '@/lib/safety';
import { getIndicators, getMarketBars, buildMarketContext } from '@/lib/indicators';
import { evaluateCandidate, ALL_CANDIDATES, SECTOR_MAP, calculatePositionSize } from '@/lib/signals';
import { claudeReason } from '@/lib/claude';
import { placeBracketOrder, getAccount, getPositions, waitForFill } from '@/lib/alpaca';
import { logTrade, logDecision, updateDecision, getConfig } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function getNewsSentiment(symbol) {
  if (!process.env.POLYGON_API_KEY) return 'neutral';
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=5&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const data = await res.json();
    if (!data.results?.length) return 'neutral';
    // Simple heuristic: count whole-word positive/negative hits in titles.
    // Word boundaries prevent false matches like "up" inside "startup"/"group".
    const titles = data.results.map(r => r.title.toLowerCase()).join(' ');
    const positiveWords = ['surge', 'surges', 'gain', 'gains', 'beat', 'beats', 'growth', 'rise', 'rises', 'up', 'profit', 'profits', 'strong', 'rally', 'jumps'];
    const negativeWords = ['fall', 'falls', 'drop', 'drops', 'miss', 'misses', 'loss', 'losses', 'down', 'decline', 'declines', 'weak', 'risk', 'risks', 'plunge', 'slump'];
    const countHits = (words) =>
      words.filter(w => new RegExp(`\\b${w}\\b`).test(titles)).length;
    const pos = countHits(positiveWords);
    const neg = countHits(negativeWords);
    if (pos > neg + 1) return 'positive';
    if (neg > pos + 1) return 'negative';
    return 'neutral';
  } catch {
    return 'neutral';
  }
}

export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const safety = await checkSafetyGates();
  if (safety.blocked) {
    return NextResponse.json({ skipped: true, reason: safety.reason });
  }

  const cfg = await getConfig();
  const [account, positions] = await Promise.all([getAccount(), getPositions()]);

  const accountValue = parseFloat(account.portfolio_value);
  // Use settled cash, not buying_power (which is 2x on a margin account and
  // would overstate deployable capital to the reasoning model).
  const availableCapital = parseFloat(account.cash);
  const weeklyBudget = parseFloat(cfg.weekly_budget);
  const maxPositions = parseInt(cfg.max_positions);
  const stopLossPct = parseFloat(cfg.stop_loss_pct);
  const takeProfitPct = parseFloat(cfg.take_profit_pct);

  if (positions.length >= maxPositions) {
    return NextResponse.json({ skipped: true, reason: `Max positions (${maxPositions}) already open` });
  }

  const currentPositions = positions.map(p => ({
    symbol: p.symbol,
    sector: SECTOR_MAP[p.symbol] || 'unknown',
  }));

  // Phase 4: fetch all ETF bars once before the scan loop
  const marketBars = await getMarketBars();

  const results = { scanned: 0, bought: [], watchlist: [], passed: [], skipped_unaffordable: [], errors: [], regime: null };

  for (const symbol of ALL_CANDIDATES) {
    if (positions.some(p => p.symbol === symbol)) continue; // already holding

    try {
      const indicators = await getIndicators(symbol);
      const sentiment = await getNewsSentiment(symbol);
      const sector = SECTOR_MAP[symbol] || 'unknown';

      // Phase 4: build market context (pure function, no extra fetches)
      const marketContext = buildMarketContext(marketBars, sector, indicators, indicators._bars);
      if (!results.regime) results.regime = marketContext.regime; // log once

      // Phase 3: use regime-aware RSI threshold
      const evaluation = evaluateCandidate(indicators, sentiment, currentPositions, marketContext.s1Upper);

      results.scanned++;

      // Signals 0–3: pure math says no — skip Claude, log as pass with regime context.
      if (evaluation.signalsMet < 4) {
        results.passed.push(symbol);
        await logDecision({
          symbol,
          decision: 'pass',
          confidence: null,
          reasoning: `Auto-passed: ${evaluation.signalsMet}/5 signals in ${marketContext.regime.toUpperCase()} regime (RSI threshold <${marketContext.s1Upper}). Composite score: ${marketContext.composite.score} — ${marketContext.composite.interpretation}.`,
          signals: {
            ...evaluation.signals,
            regime:          marketContext.regime,
            composite_score: marketContext.composite.score,
            spy_rsi:         marketContext.spyRsi,
            spy_20d_trend:   marketContext.spy20dTrend,
            days_to_fomc:    marketContext.daysToFomc,
          },
          rsi: indicators.rsi,
          price_vs_ma50: indicators.priceVsMa50,
          volume_ratio: indicators.volumeRatio,
          news_sentiment: sentiment,
          signals_met: evaluation.signalsMet,
        });
        continue;
      }

      // 4–5 signals: worth Claude's attention.
      const portfolioState = {
        totalValue: accountValue,
        availableCapital,
        weeklyBudgetRemaining: weeklyBudget,
        openPositions: currentPositions.length,
      };

      const systemRules = { maxPositions, stopLossPct, takeProfitPct };

      const claudeResult = await claudeReason(
        { ...indicators, ...evaluation },
        portfolioState,
        systemRules,
        marketContext           // Phase 4: full market context
      );

      // Log the decision — include regime + composite score in signals JSONB
      const decisionRecord = await logDecision({
        symbol,
        decision: claudeResult.decision,
        confidence: claudeResult.confidence,
        reasoning: claudeResult.reasoning,
        signals: {
          ...evaluation.signals,
          regime:          marketContext.regime,
          composite_score: marketContext.composite.score,
          spy_rsi:         marketContext.spyRsi,
          spy_20d_trend:   marketContext.spy20dTrend,
          days_to_fomc:    marketContext.daysToFomc,
        },
        rsi: indicators.rsi,
        price_vs_ma50: indicators.priceVsMa50,
        volume_ratio: indicators.volumeRatio,
        news_sentiment: sentiment,
        signals_met: evaluation.signalsMet,
      });

      if (claudeResult.decision === 'buy' && evaluation.signalsMet === 5 && currentPositions.length < maxPositions) {
        const positionSize = calculatePositionSize(accountValue, weeklyBudget, currentPositions);
        const notional = Math.min(positionSize, claudeResult.position_size || positionSize);

        // Whole-share bracket orders: skip cleanly if we can't afford 1 share.
        if (notional < indicators.price) {
          results.skipped_unaffordable.push({ symbol, price: indicators.price, notional: parseFloat(notional.toFixed(2)) });
          continue;
        }

        const order = await placeBracketOrder({
          symbol,
          notional,
          stopLossPct,
          takeProfitPct,
        });

        // Wait for the market order to fill so we log the real price/qty/status.
        const filled = await waitForFill(order.id);
        const fillPrice = parseFloat(filled.filled_avg_price || indicators.price);
        const fillQty = parseFloat(filled.filled_qty || filled.qty || order.qty);

        const trade = await logTrade({
          symbol,
          side: 'buy',
          qty: fillQty,
          price: fillPrice,
          total_value: fillQty * fillPrice,
          order_id: order.id,
          status: filled.status,
          stop_loss_price: claudeResult.stop_loss_price,
          take_profit_price: claudeResult.take_profit_price,
        });

        // Link decision to trade
        await updateDecision(decisionRecord.id, { trade_id: trade.id });

        currentPositions.push({ symbol, sector: SECTOR_MAP[symbol] || 'unknown' });
        results.bought.push({ symbol, size: positionSize });
      } else if (claudeResult.decision === 'watchlist') {
        results.watchlist.push(symbol);
      } else {
        results.passed.push(symbol);
      }
    } catch (err) {
      console.error(`[daily-scan] Error scanning ${symbol}:`, err.message);
      results.errors.push({ symbol, error: err.message });
    }
  }

  return NextResponse.json(results);
}
