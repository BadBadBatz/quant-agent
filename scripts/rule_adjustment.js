/**
 * scripts/rule_adjustment.js
 * Phase 8 — Autonomous Rule Adjustment
 * Runs via GitHub Actions every Sunday 8 PM ET.
 * Analyzes last week's outcomes, proposes ONE rule change,
 * validates against backtest, applies if confirmed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

const { createClient } = require('@supabase/supabase-js');
const { runBacktest }  = require('./backtest');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Hard bounds — adjustment system can never cross these
const BOUNDS = {
  rsi_lower:          { min: 20,  max: 30,  initial: 25  },
  rsi_upper:          { min: 35,  max: 55,  initial: 40  },
  volume_multiplier:  { min: 1.1, max: 2.0, initial: 1.4 },
  signals_required:   { min: 3,   max: 5,   initial: 5   },
};

const LOCKED = new Set([
  'stop_loss_pct','take_profit_pct','max_position_pct',
  'max_positions','weekly_budget','dry_powder_pct','blackout_fomc',
]);

const MIN_SAMPLE = 5;
const MIN_OCCURRENCES = 15;
const MAX_CHANGE_PCT = 0.10;

async function getAgentConfig() {
  const { data } = await supabase.from('agent_config').select('key, value');
  return Object.fromEntries((data || []).map(r => [r.key, parseFloat(r.value)]));
}

async function getWeeklyOutcomes() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { data } = await supabase
    .from('outcomes').select('*, decisions(*)')
    .gte('resolved_at', weekAgo.toISOString());
  return data || [];
}

async function checkCircuitBreaker(cfg, outcomes) {
  const wins    = outcomes.filter(o => o.win === true).length;
  const n       = outcomes.filter(o => o.win !== null).length;
  const winRate = n > 0 ? wins / n : 1;

  if (winRate < 0.45 && n >= MIN_SAMPLE) {
    const { data: prev } = await supabase.from('agent_config')
      .select('value').eq('key', 'consecutive_bad_weeks').single();
    const weeks = parseFloat(prev?.value || 0) + 1;

    await supabase.from('agent_config')
      .update({ value: weeks }).eq('key', 'consecutive_bad_weeks');

    if (weeks >= 2) {
      console.log(`⚠️  Circuit breaker triggered: ${weeks} consecutive weeks below 45% win rate`);
      await supabase.from('agent_config')
        .update({ value: 1 }).eq('key', 'adjustment_frozen');

      // Revert last rule change
      const { data: lastChange } = await supabase.from('rule_history')
        .select('*').eq('reverted', false)
        .order('changed_at', { ascending: false }).limit(1).single();

      if (lastChange) {
        await supabase.from('agent_config')
          .update({ value: lastChange.old_value }).eq('key', lastChange.rule_name);
        await supabase.from('rule_history')
          .update({ reverted: true }).eq('id', lastChange.id);
        console.log(`  Reverted ${lastChange.rule_name}: ${lastChange.new_value} → ${lastChange.old_value}`);
      }
      return true; // frozen
    }
  } else {
    // Reset consecutive bad weeks counter on a good week
    if (n >= MIN_SAMPLE) {
      await supabase.from('agent_config')
        .update({ value: 0 }).eq('key', 'consecutive_bad_weeks');
    }
  }
  return false;
}

function analyzeBottleneck(outcomes, cfg) {
  if (!outcomes.length) return null;

  // Missed wins — passes where stock gained >3%
  const missedWins = outcomes.filter(o => o.missed_win === true);
  // Bad entries — loss trades
  const lossOutcomes = outcomes.filter(o => o.win === false && o.decisions?.action === 'buy');

  const proposals = [];

  // Pattern: too many missed wins with RSI just above the ceiling
  if (missedWins.length >= MIN_OCCURRENCES * 0.6) {
    // Check if RSI was just above rsi_upper at time of miss
    const nearCeiling = missedWins.filter(o => {
      const rsi = o.decisions?.rsi;
      return rsi && rsi > cfg.rsi_upper && rsi < cfg.rsi_upper + 10;
    });
    if (nearCeiling.length >= MIN_OCCURRENCES * 0.4) {
      const proposedUpper = Math.min(
        cfg.rsi_upper * (1 + MAX_CHANGE_PCT),
        BOUNDS.rsi_upper.max
      );
      if (proposedUpper > cfg.rsi_upper) {
        proposals.push({
          rule_name: 'rsi_upper',
          old_value: cfg.rsi_upper,
          new_value: parseFloat(proposedUpper.toFixed(1)),
          reason: `${nearCeiling.length} missed wins had RSI just above ceiling (${cfg.rsi_upper}). Proposing ceiling raise to ${proposedUpper.toFixed(1)}.`,
          evidence_count: nearCeiling.length,
        });
      }
    }
  }

  // Pattern: bad entries often have low volume
  if (lossOutcomes.length >= MIN_OCCURRENCES * 0.5) {
    const lowVol = lossOutcomes.filter(o => {
      const vr = o.decisions?.volume_ratio;
      return vr && vr < cfg.volume_multiplier + 0.3;
    });
    if (lowVol.length >= MIN_OCCURRENCES * 0.4) {
      const proposedVol = Math.min(
        cfg.volume_multiplier * (1 + MAX_CHANGE_PCT),
        BOUNDS.volume_multiplier.max
      );
      proposals.push({
        rule_name: 'volume_multiplier',
        old_value: cfg.volume_multiplier,
        new_value: parseFloat(proposedVol.toFixed(2)),
        reason: `${lowVol.length} losses had volume near threshold. Tightening to ${proposedVol.toFixed(2)}x.`,
        evidence_count: lowVol.length,
      });
    }
  }

  // Return highest-evidence proposal only (one change per week max)
  return proposals.sort((a, b) => b.evidence_count - a.evidence_count)[0] || null;
}

async function validateWithBacktest(proposal, cfg) {
  console.log(`  Running backtest with ${proposal.rule_name} = ${proposal.new_value}...`);

  const TICKERS = [
    'NVDA','MSFT','META','GOOGL','AAPL','AMZN','AMD','TSM',
    'BRK.B','LLY','JPM','COST','UNH','V',
    'LMT','RTX','NOC','GD',
    'XOM','CVX','COP','SLB',
    'QQQ','SPY','XLK',
  ];

  const endDate   = new Date();
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - 1); // 1-year validation window

  const newRules = {
    rsi_lower:         cfg.rsi_lower,
    rsi_upper:         cfg.rsi_upper,
    volume_multiplier: cfg.volume_multiplier,
    signals_required:  cfg.signals_required,
    stop_loss_pct:     0.06,
    take_profit_pct:   0.12,
    max_positions:     4,
    [proposal.rule_name]: proposal.new_value,
  };

  const currentRules = { ...newRules, [proposal.rule_name]: proposal.old_value };

  const [newResults, currentResults] = await Promise.all([
    runBacktest(newRules, TICKERS, startDate, endDate, { label: 'validation_new' }),
    runBacktest(currentRules, TICKERS, startDate, endDate, { label: 'validation_current' }),
  ]);

  const improves = (
    newResults.expectedValue  >= currentResults.expectedValue &&
    newResults.maxDrawdown    >= currentResults.maxDrawdown - 0.02 &&
    newResults.nTrades         >= currentResults.nTrades
  );

  console.log(`  Current:  EV=${(currentResults.expectedValue*100).toFixed(2)}%  DD=${(currentResults.maxDrawdown*100).toFixed(1)}%  trades=${currentResults.nTrades}`);
  console.log(`  Proposed: EV=${(newResults.expectedValue*100).toFixed(2)}%  DD=${(newResults.maxDrawdown*100).toFixed(1)}%  trades=${newResults.nTrades}`);
  console.log(`  Backtest ${improves ? '✓ CONFIRMS improvement' : '✗ CONTRADICTS — discarding'}`);

  return { improves, backtestEv: newResults.expectedValue };
}

async function applyChange(proposal, backtestEv) {
  await supabase.from('agent_config')
    .update({ value: proposal.new_value, updated_at: new Date().toISOString() })
    .eq('key', proposal.rule_name);

  await supabase.from('rule_history').insert({
    rule_name:   proposal.rule_name,
    old_value:   proposal.old_value,
    new_value:   proposal.new_value,
    reason:      proposal.reason,
    backtest_ev: backtestEv,
  });

  console.log(`  ✓ Applied: ${proposal.rule_name} ${proposal.old_value} → ${proposal.new_value}`);
}

async function checkDrift(cfg) {
  for (const [key, bounds] of Object.entries(BOUNDS)) {
    const current = cfg[key];
    if (!current) continue;
    const driftPct = Math.abs(current - bounds.initial) / bounds.initial;
    if (driftPct > 0.30) {
      console.log(`⚠️  ${key} drifted ${(driftPct*100).toFixed(0)}% from initial — reverting to ${bounds.initial}`);
      await supabase.from('agent_config')
        .update({ value: bounds.initial }).eq('key', key);
      await supabase.from('rule_history').insert({
        rule_name: key,
        old_value: current,
        new_value: bounds.initial,
        reason:    `Auto-revert: drifted ${(driftPct*100).toFixed(0)}% from initial backtest-optimal value`,
        backtest_ev: null,
      });
    }
  }
}

async function main() {
  console.log('\n' + '═'.repeat(55));
  console.log('  PHASE 8 — AUTONOMOUS RULE ADJUSTMENT');
  console.log('  ' + new Date().toISOString());
  console.log('═'.repeat(55));

  const [cfg, outcomes] = await Promise.all([getAgentConfig(), getWeeklyOutcomes()]);

  const buyOutcomes = outcomes.filter(o => o.decisions?.action === 'buy');
  console.log(`\nThis week: ${buyOutcomes.length} resolved buy outcomes`);

  // 1. Drift check (before anything else)
  await checkDrift(cfg);

  // 2. Circuit breaker check
  const frozen = parseFloat(cfg.adjustment_frozen) === 1;
  if (frozen) {
    console.log('⛔ Adjustments frozen by circuit breaker. Skipping.');
    return;
  }
  const tripped = await checkCircuitBreaker(cfg, outcomes);
  if (tripped) {
    console.log('Circuit breaker just tripped. Halting.');
    return;
  }

  // 3. Minimum sample check
  if (buyOutcomes.length < MIN_SAMPLE) {
    console.log(`Insufficient sample (${buyOutcomes.length}/${MIN_SAMPLE}). Skipping adjustment.`);
    await supabase.from('rule_history').insert({
      rule_name: 'weekly_check', old_value: null, new_value: null,
      reason: `Skipped: only ${buyOutcomes.length} resolved outcomes (min ${MIN_SAMPLE})`,
      backtest_ev: null,
    });
    return;
  }

  const wins = buyOutcomes.filter(o => o.win).length;
  const winRate = wins / buyOutcomes.length;
  console.log(`Win rate: ${(winRate * 100).toFixed(1)}%  (${wins}/${buyOutcomes.length})`);

  // 4. Analyze and propose
  const proposal = analyzeBottleneck(outcomes, cfg);
  if (!proposal) {
    console.log('No pattern found with sufficient occurrences. No change proposed.');
    return;
  }

  // 5. Hard bounds check
  const bounds = BOUNDS[proposal.rule_name];
  if (!bounds) {
    console.log(`${proposal.rule_name} has no bounds defined. Skipping.`);
    return;
  }
  if (proposal.new_value < bounds.min || proposal.new_value > bounds.max) {
    console.log(`Proposed value ${proposal.new_value} out of bounds [${bounds.min}, ${bounds.max}]. Clamping.`);
    proposal.new_value = Math.max(bounds.min, Math.min(bounds.max, proposal.new_value));
  }

  console.log(`\nProposed: ${proposal.rule_name} ${proposal.old_value} → ${proposal.new_value}`);
  console.log(`Reason: ${proposal.reason}`);

  // 6. Backtest validation
  const { improves, backtestEv } = await validateWithBacktest(proposal, cfg);
  if (!improves) {
    await supabase.from('rule_history').insert({
      rule_name:   proposal.rule_name,
      old_value:   proposal.old_value,
      new_value:   proposal.new_value,
      reason:      `Rejected: backtest did not confirm improvement. ${proposal.reason}`,
      backtest_ev: backtestEv,
    });
    console.log('Change discarded — logged as live_anomaly.');
    return;
  }

  // 7. Apply
  await applyChange(proposal, backtestEv);

  console.log('\n' + '═'.repeat(55));
  console.log('  RULE ADJUSTMENT COMPLETE');
  console.log('═'.repeat(55) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
