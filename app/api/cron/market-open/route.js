export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { checkSafetyGates, verifyCronSecret } from '@/lib/safety';
import { getAccount, getPositions, placeBracketOrder, getBars, sellPosition, waitForFill } from '@/lib/alpaca';
import { getIndicators, getMarketBars, buildMarketContext } from '@/lib/indicators';
import { evaluateCandidate, ALL_CANDIDATES, SECTOR_MAP, calculatePositionSize } from '@/lib/signals';
import { claudeReason } from '@/lib/claude';
import {
  getAgentConfig, getLatestMacroContext, saveMacroContext,
  logDecisionNew, markDecisionResolved, logOutcome,
  getDecisionHistory, getSimilarSetups, getLatestXgboostScore,
  supabase,
} from '@/lib/supabase';
import { calculateRSI } from '@/lib/indicators';
import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const maxDuration = 300;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getTickerNews(ticker) {
  if (!process.env.POLYGON_API_KEY) return [];
  try {
    const r = await fetch(
      `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=3&apiKey=${process.env.POLYGON_API_KEY}`
    );
    const d = await r.json();
    return (d.results || []).map(n => n.title);
  } catch { return []; }
}

function parseJson(text) {
  const clean = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('No JSON'); }
}

function isStale(ctx) {
  if (!ctx) return true;
  return (Date.now() - new Date(ctx.fetched_at).getTime()) > 3 * 60 * 60 * 1000; // 3 hours
}

async function refreshMacroContext() {
  // Inline re-fetch (mirrors pre-market-fetch logic)
  const FOMC_DATES = [
    '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30',
    '2025-09-17','2025-11-05','2025-12-17','2026-01-28','2026-03-18',
    '2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16',
  ];
  const now = Date.now();
  const upcoming = FOMC_DATES.map(d => new Date(d).getTime()).filter(t => t >= now).sort();
  const daysToFomc = upcoming.length ? Math.ceil((upcoming[0] - now) / 86400000) : 999;
  const mon = new Date(); mon.setDate(mon.getDate() - mon.getDay() + 1); mon.setHours(0,0,0,0);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const isFomcWeek = FOMC_DATES.some(d => { const fd = new Date(d); return fd >= mon && fd <= fri; });

  const spyBars = await getBars('SPY', '1Day', 60);
  const spyCloses = spyBars.map(b => b.ClosePrice);
  const spyRsi = parseFloat(calculateRSI(spyCloses).toFixed(1));
  const spy5dayRet = parseFloat(((spyBars[spyBars.length-1].ClosePrice / spyBars[spyBars.length-6].ClosePrice - 1) * 100).toFixed(2));
  const regime = spyRsi > 60 ? 'bull' : spyRsi < 40 ? 'bear' : 'neutral';

  return saveMacroContext({
    spy_5day_return: spy5dayRet, spy_rsi: spyRsi, regime,
    sector_perf: {}, top_headlines: [], days_to_fomc: daysToFomc, is_fomc_week: isFomcWeek,
  });
}

// ── Claude: judge existing position (HOLD or SELL) ────────────────────────────
async function judgePosition(pos, macro, news) {
  const entryPrice  = parseFloat(pos.avg_entry_price);
  const currentPrice = parseFloat(pos.current_price);
  const returnPct   = ((currentPrice / entryPrice) - 1) * 100;
  const daysHeld    = pos.created_at
    ? Math.floor((Date.now() - new Date(pos.created_at).getTime()) / 86400000)
    : 0;

  const prompt = `You manage a quant trading portfolio. Review this open position and decide HOLD or SELL.

POSITION:
  Ticker: ${pos.symbol}
  Entry: $${entryPrice.toFixed(2)}  Current: $${currentPrice.toFixed(2)}  Return: ${returnPct.toFixed(2)}%
  Days held: ${daysHeld}

MACRO CONTEXT:
  Regime: ${macro.regime}  SPY RSI: ${macro.spy_rsi}  SPY 5d: ${macro.spy_5day_return > 0 ? '+' : ''}${macro.spy_5day_return}%
  Days to FOMC: ${macro.days_to_fomc}  FOMC week: ${macro.is_fomc_week}

RECENT NEWS on ${pos.symbol}:
${news.length ? news.map(h => `  - ${h}`).join('\n') : '  No recent news.'}

SELL only if a SPECIFIC condition is met:
  1. Negative breaking news directly about this stock
  2. RSI now > 65 (momentum fully exhausted)
  3. Regime shifted to BEAR since entry AND return < +3%
  4. Position slots full AND this position is below +3% AND better opportunity exists

Default is HOLD. Return JSON only:
{"action":"hold","reasoning":"<one sentence>"}
OR
{"action":"sell","reasoning":"<one sentence>","condition_met":"<which condition>"}`;

  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJson(r.content[0].text);
}

// ── Claude: judge new candidate (BUY / WATCH / PASS) ─────────────────────────
async function judgeCandidate(stockData, portfolioState, cfg, macro, history, xgbScore) {
  const similarSetups = history.filter(d => d.outcomes?.length);
  const wins = similarSetups.filter(d => d.outcomes[0]?.win).length;
  const historyText = similarSetups.length
    ? `${similarSetups.length} similar setups: ${wins} wins, ${similarSetups.length - wins} losses (${Math.round(wins/similarSetups.length*100)}% win rate)`
    : 'No similar historical setups on record.';

  const prompt = `You are a quant trading agent. Judge whether to BUY, WATCH, or PASS on this candidate.

MARKET REGIME: ${macro.regime.toUpperCase()} (SPY RSI ${macro.spy_rsi}, 5d ${macro.spy_5day_return > 0 ? '+' : ''}${macro.spy_5day_return}%)
FOMC: ${macro.days_to_fomc} days away${macro.is_fomc_week ? ' — THIS IS FOMC WEEK (elevated risk)' : ''}

CANDIDATE: ${stockData.symbol}
  Price: $${stockData.price}  RSI: ${stockData.rsi}  vs MA50: ${stockData.priceVsMa50}%
  Volume ratio: ${stockData.volumeRatio}x  Sentiment: ${stockData.sentiment}
  Sector: ${stockData.sector}  vs MA200: ${stockData.pctVsMa200 ?? 'n/a'}%

SIGNALS FIRED: ${stockData.signalsMet}/5
${stockData.signalDetails}

COMPOSITE SCORE: ${stockData.composite?.score ?? 'n/a'} — ${stockData.composite?.interpretation ?? ''}

HISTORICAL PATTERN (this ticker, similar RSI/volume setup, same regime):
  ${historyText}

XGBOOST PROBABILITY: ${xgbScore ? `${(xgbScore.probability * 100).toFixed(1)}% (${xgbScore.model_version || 'latest'})` : 'Not yet computed (model not trained yet)'}

RECENT NEWS:
${stockData.news?.length ? stockData.news.map(h => `  - ${h}`).join('\n') : '  No recent news.'}

PORTFOLIO: ${portfolioState.openPositions} positions open, ${portfolioState.slotsRemaining} slots free
  Budget remaining this week: $${portfolioState.weeklyBudgetRemaining.toFixed(0)}
  Stop loss: ${cfg.stop_loss_pct * 100}%  Take profit: ${cfg.take_profit_pct * 100}%

Return JSON only (no markdown):
{
  "action": "buy" | "watch" | "pass",
  "confidence": 1-10,
  "position_size": <dollars or null>,
  "reasoning": "<2-3 sentences referencing regime, signals, and history>",
  "risk_flags": ["<concerns>"]
}`;

  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJson(r.content[0].text);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function GET(request) {
  if (!await verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const safety = await checkSafetyGates();
  if (safety.blocked) return NextResponse.json({ skipped: true, reason: safety.reason });

  // ── Step 1: Macro context ──────────────────────────────────────────────────
  let macro = await getLatestMacroContext();
  if (isStale(macro)) {
    console.log('[market-open] macro context stale, re-fetching...');
    macro = await refreshMacroContext();
  }

  if (macro.is_fomc_week) {
    return NextResponse.json({ skipped: true, reason: 'FOMC week blackout — no new entries' });
  }

  // ── Step 2: Load live config (thresholds come from Supabase, not hardcoded) ─
  const cfg = await getAgentConfig();
  const stopLoss      = parseFloat(cfg.stop_loss_pct);
  const takeProfit    = parseFloat(cfg.take_profit_pct);
  const maxPositions  = parseInt(cfg.max_positions);
  const weeklyBudget  = parseFloat(cfg.weekly_budget);
  const sigRequired   = parseInt(cfg.signals_required);
  const rsiLower      = parseFloat(cfg.rsi_lower);
  const rsiUpper      = parseFloat(cfg.rsi_upper);

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const accountValue   = parseFloat(account.portfolio_value);
  const availableCash  = parseFloat(account.cash);

  // ── Step 3: Review existing positions ────────────────────────────────────
  const sells = [];
  const holds = [];

  for (const pos of positions) {
    const ticker = pos.symbol;
    // Only do full review on flagged or once-per-day basis
    const news = await getTickerNews(ticker);
    const entryPrice  = parseFloat(pos.avg_entry_price);
    const currentPrice = parseFloat(pos.current_price);
    const returnPct   = ((currentPrice / entryPrice) - 1) * 100;

    // Check needs_review flag
    const { data: decRows } = await supabase.from('decisions')
      .select('id, needs_review, regime')
      .eq('ticker', ticker).eq('outcome_resolved', false)
      .order('date', { ascending: false }).limit(1);
    const dec = decRows?.[0];

    const needsReview = dec?.needs_review || false;
    const regimeShift = dec?.regime && dec.regime !== macro.regime && macro.regime === 'bear';

    if (needsReview || regimeShift || (news.length && returnPct < 3)) {
      const judgment = await judgePosition(pos, macro, news);
      if (judgment.action === 'sell') {
        try {
          await sellPosition(ticker, pos.qty);
          if (dec) {
            await logOutcome({
              decision_id: dec.id,
              exit_price:  currentPrice,
              return_pct:  returnPct,
              exit_reason: 'sold_early',
              days_held:   null,
              win:         returnPct > 0,
            });
            await markDecisionResolved(dec.id);
          }
          sells.push({ ticker, returnPct: parseFloat(returnPct.toFixed(2)), reason: judgment.condition_met });
        } catch (e) {
          console.error(`[market-open] sell error ${ticker}:`, e.message);
        }
      } else {
        if (dec) await supabase.from('decisions').update({ needs_review: false }).eq('id', dec.id);
        holds.push({ ticker, reasoning: judgment.reasoning });
      }
    }
  }

  // Refresh positions after any sells
  const currentPositions = (await getPositions()).map(p => ({
    symbol: p.symbol, sector: SECTOR_MAP[p.symbol] || 'unknown',
  }));

  // ── Step 4: Free slot check ───────────────────────────────────────────────
  if (currentPositions.length >= maxPositions) {
    return NextResponse.json({ skipped: false, sells, holds, reason: 'max positions reached', buys: [], watched: [], passed: [] });
  }

  // Check weekly budget
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(0, 0, 0, 0);
  const { data: weekTrades } = await supabase.from('decisions')
    .select('position_size').eq('action', 'buy')
    .gte('date', weekStart.toISOString());
  const deployedThisWeek = (weekTrades || []).reduce((s, t) => s + (t.position_size || 0), 0);
  const weeklyBudgetRemaining = Math.max(0, weeklyBudget * 0.75 - deployedThisWeek);

  if (weeklyBudgetRemaining < 100) {
    return NextResponse.json({ skipped: false, sells, holds, reason: 'weekly budget exhausted', buys: [], watched: [], passed: [] });
  }

  // ── Step 5: Scan universe ─────────────────────────────────────────────────
  const marketBars = await getMarketBars();
  const buys = [], watched = [], passed = [];

  // Regime-aware RSI upper bound (Phase 3 backtest result)
  const rsiUpperBound = macro.regime === 'bull' ? Math.min(rsiUpper + 20, 60) : rsiUpper;

  for (const symbol of ALL_CANDIDATES) {
    if (currentPositions.some(p => p.symbol === symbol)) continue;
    if (currentPositions.length >= maxPositions) break;

    try {
      const indicators = await getIndicators(symbol);
      const sector = SECTOR_MAP[symbol] || 'unknown';
      const sentiment = 'neutral'; // Sentiment always neutral without Polygon key

      const marketContext = buildMarketContext(marketBars, sector, indicators, indicators._bars);
      const evaluation = evaluateCandidate(indicators, sentiment, currentPositions, {
        rsi_lower: rsiLower,
        rsi_upper: rsiUpperBound,
        volume_multiplier: parseFloat(cfg.volume_multiplier ?? 1.4),
      });

      // Log every decision including passes
      const baseDecision = {
        ticker: symbol,
        date: new Date().toISOString(),
        rsi: indicators.rsi,
        volume_ratio: indicators.volumeRatio,
        ma50_distance: indicators.priceVsMa50,
        signals_fired: evaluation.signalsMet,
        regime: macro.regime,
        macro_context: {
          spy_rsi: macro.spy_rsi,
          spy_5day: macro.spy_5day_return,
          fomc_days: macro.days_to_fomc,
          sector_perf: macro.sector_perf?.[sector],
          composite: marketContext.composite,
        },
      };

      if (evaluation.signalsMet < sigRequired) {
        passed.push(symbol);
        await logDecisionNew({
          ...baseDecision,
          action: 'pass',
          claude_reasoning: `Auto-pass: ${evaluation.signalsMet}/${sigRequired} signals (${macro.regime} regime, RSI threshold <${rsiUpperBound}).`,
        });
        continue;
      }

      // Passes signal threshold — ask Claude
      const [news, history, xgbScore] = await Promise.all([
        getTickerNews(symbol),
        getDecisionHistory(symbol, { limit: 10 }),
        getLatestXgboostScore(symbol),
      ]);

      const portfolioState = {
        openPositions:  currentPositions.length,
        slotsRemaining: maxPositions - currentPositions.length,
        weeklyBudgetRemaining,
        availableCapital: availableCash,
      };

      const stockData = {
        ...indicators, ...evaluation, sentiment,
        sector, news,
        pctVsMa200: marketContext.pctVsMa200,
        composite: marketContext.composite,
      };

      const judgment = await judgeCandidate(stockData, portfolioState, cfg, macro, history, xgbScore);

      const decisionRecord = await logDecisionNew({
        ...baseDecision,
        action: judgment.action === 'buy' ? 'buy' : judgment.action === 'watch' ? 'watch' : 'pass',
        claude_reasoning: judgment.reasoning,
        entry_price: judgment.action === 'buy' ? indicators.price : null,
        position_size: judgment.action === 'buy' ? judgment.position_size : null,
      });

      if (judgment.action === 'buy' && currentPositions.length < maxPositions) {
        const positionSize = calculatePositionSize(accountValue, weeklyBudget, currentPositions);
        const notional = Math.min(positionSize, judgment.position_size || positionSize, weeklyBudgetRemaining);

        if (notional < indicators.price) {
          passed.push({ symbol, reason: 'insufficient capital for 1 share' });
          continue;
        }

        const order = await placeBracketOrder({ symbol, notional, stopLossPct: stopLoss, takeProfitPct: takeProfit });
        const filled = await waitForFill(order.id);
        currentPositions.push({ symbol, sector });
        buys.push({ symbol, notional, orderId: order.id, status: filled.status });

        // Update decision with confirmed entry price
        await supabase.from('decisions')
          .update({ entry_price: parseFloat(filled.filled_avg_price || indicators.price) })
          .eq('id', decisionRecord.id);
      } else if (judgment.action === 'watch') {
        watched.push(symbol);
      } else {
        passed.push(symbol);
      }
    } catch (err) {
      console.error(`[market-open] ${symbol}:`, err.message);
    }
  }

  return NextResponse.json({ ok: true, regime: macro.regime, sells, holds, buys, watched, passed: passed.length });
}
