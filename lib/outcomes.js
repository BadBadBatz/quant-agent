import { getBarsBetween } from './alpaca.js';
import {
  getUnresolvedDecisions,
  logOutcome,
  markDecisionResolved,
} from './supabase.js';

function getDecisionTicker(decision) {
  return decision.ticker || decision.symbol;
}

function getDecisionAction(decision) {
  if (decision.action) return decision.action;
  if (decision.decision === 'watchlist') return 'watch';
  return decision.decision;
}

function toIsoDate(value) {
  return new Date(value).toISOString().split('T')[0];
}

function tradingDaysBetween(bars, startDate, endDate) {
  return bars.filter(bar => {
    const date = new Date(bar.Timestamp || bar.t);
    return date >= startDate && date <= endDate;
  }).length;
}

function barClose(bar) {
  return bar.ClosePrice ?? bar.c;
}

function barHigh(bar) {
  return bar.HighPrice ?? bar.h;
}

function barLow(bar) {
  return bar.LowPrice ?? bar.l;
}

export async function resolveDecisionOutcome(decision, { holdTradingDays = 5 } = {}) {
  const ticker = getDecisionTicker(decision);
  const action = getDecisionAction(decision);
  if (!ticker || !action) return null;

  const decisionDate = new Date(decision.date || decision.created_at);
  const endDate = new Date();
  const bars = await getBarsBetween(ticker, {
    timeframe: '1Day',
    start: toIsoDate(decisionDate),
    end: toIsoDate(endDate),
    limit: 1000,
  });

  if (!bars || bars.length < holdTradingDays + 1) return null;

  const entryBar = bars[0];
  const exitBar = bars[Math.min(holdTradingDays, bars.length - 1)];
  const entryPrice = Number(decision.entry_price || barClose(entryBar));
  const exitPrice = Number(barClose(exitBar));
  if (!entryPrice || !exitPrice) return null;

  const returnPct = ((exitPrice / entryPrice) - 1) * 100;
  const daysHeld = tradingDaysBetween(bars, decisionDate, new Date(exitBar.Timestamp || exitBar.t));

  let payload;
  if (action === 'buy') {
    const stopPrice = entryPrice * (1 - 0.06);
    const targetPrice = entryPrice * (1 + 0.12);
    let exitReason = 'time_exit';
    let resolvedExitPrice = exitPrice;

    for (const bar of bars.slice(1, holdTradingDays + 1)) {
      if (barLow(bar) <= stopPrice) {
        exitReason = 'stop_loss';
        resolvedExitPrice = stopPrice;
        break;
      }
      if (barHigh(bar) >= targetPrice) {
        exitReason = 'take_profit';
        resolvedExitPrice = targetPrice;
        break;
      }
    }

    const resolvedReturnPct = ((resolvedExitPrice / entryPrice) - 1) * 100;
    payload = {
      decision_id: decision.id,
      exit_price: resolvedExitPrice,
      return_pct: resolvedReturnPct,
      exit_reason: exitReason,
      days_held: daysHeld,
      win: resolvedReturnPct > 0,
    };
  } else {
    payload = {
      decision_id: decision.id,
      exit_price: exitPrice,
      return_pct: returnPct,
      exit_reason: 'time_exit',
      days_held: daysHeld,
      win: null,
      missed_win: returnPct > 3,
      correct_pass: returnPct < -2,
    };
  }

  const outcome = await logOutcome(payload);
  await markDecisionResolved(decision.id);
  return outcome;
}

export async function resolvePendingOutcomes({ holdTradingDays = 5 } = {}) {
  const [buys, passes, watches] = await Promise.all([
    getUnresolvedDecisions({ action: 'buy', minAgeTradingDays: holdTradingDays }),
    getUnresolvedDecisions({ action: 'pass', minAgeTradingDays: holdTradingDays }),
    getUnresolvedDecisions({ action: 'watch', minAgeTradingDays: holdTradingDays }),
  ]);

  const groups = { buys, passes, watches };
  const resolved = { buys: [], passes: [], watches: [], errors: [] };

  for (const [group, decisions] of Object.entries(groups)) {
    for (const decision of decisions) {
      try {
        const outcome = await resolveDecisionOutcome(decision, { holdTradingDays });
        if (outcome) resolved[group].push(outcome);
      } catch (err) {
        resolved.errors.push({
          decision_id: decision.id,
          ticker: getDecisionTicker(decision),
          error: err.message,
        });
      }
    }
  }

  return resolved;
}
