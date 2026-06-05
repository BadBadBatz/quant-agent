import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Server-side client with full access (for API routes / crons)
export const supabase = createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey);

// --- Trades ---

export async function logTrade(trade) {
  const { data, error } = await supabase.from('trades').insert(trade).select().single();
  if (error) throw error;
  return data;
}

export async function getTrades({ limit = 50, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

export async function updateTrade(id, updates) {
  const { data, error } = await supabase
    .from('trades')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// --- Decisions ---

export async function logDecision(decision) {
  const { data, error } = await supabase.from('decisions').insert(decision).select().single();
  if (error) throw error;
  return data;
}

export async function updateDecision(id, updates) {
  const { data, error } = await supabase
    .from('decisions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getDecisions({ limit = 100, offset = 0, symbol, decision: dec } = {}) {
  let query = supabase
    .from('decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (symbol) query = query.eq('symbol', symbol);
  if (dec) query = query.eq('decision', dec);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// --- Portfolio snapshots ---

export async function logPortfolioSnapshot(snapshot) {
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .insert(snapshot)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getLatestSnapshot() {
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getFirstSnapshot() {
  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getMonthStartSnapshot() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('*')
    .gte('created_at', monthStart.toISOString())
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function getSnapshotHistory(days = 90) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from('portfolio_snapshots')
    .select('*')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// --- DCA log ---

export async function logDca(entry) {
  const { data, error } = await supabase.from('dca_log').insert(entry).select().single();
  if (error) throw error;
  return data;
}

export async function getCurrentWeekDca() {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  weekStart.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('dca_log')
    .select('*')
    .gte('week_start', weekStart.toISOString().split('T')[0])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// --- Daily summaries ---

export async function logDailySummary(summary) {
  const { data, error } = await supabase
    .from('daily_summaries')
    .insert(summary)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getDailySummaries({ limit = 30 } = {}) {
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('*')
    .order('date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// --- System config ---

export async function getConfig() {
  const { data, error } = await supabase.from('system_config').select('key, value, description');
  if (error) throw error;
  return Object.fromEntries(data.map(c => [c.key, c.value]));
}

export async function getConfigRows() {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value, description, updated_at')
    .order('key');
  if (error) throw error;
  return data;
}

export async function updateConfig(key, value) {
  const { data, error } = await supabase
    .from('system_config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function pauseSystem(reason = 'Manually paused') {
  console.log(`[safety] System paused: ${reason}`);
  return updateConfig('system_paused', 'true');
}

export async function resumeSystem() {
  return updateConfig('system_paused', 'false');
}

// ── Agent config (live rule thresholds) ───────────────────────────────────────

export async function getAgentConfig() {
  const { data, error } = await supabase
    .from('agent_config')
    .select('key, value, locked');
  if (error) throw error;
  return Object.fromEntries(data.map(r => [r.key, r.value]));
}

export async function updateAgentConfig(key, value) {
  const { data: row } = await supabase
    .from('agent_config').select('locked').eq('key', key).single();
  if (row?.locked) throw new Error(`agent_config.${key} is locked — cannot modify`);
  const { data, error } = await supabase
    .from('agent_config')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key).select().single();
  if (error) throw error;
  return data;
}

// ── Macro context ─────────────────────────────────────────────────────────────

export async function saveMacroContext(ctx) {
  const { data, error } = await supabase
    .from('macro_context').insert(ctx).select().single();
  if (error) throw error;
  return data;
}

export async function getLatestMacroContext() {
  const { data, error } = await supabase
    .from('macro_context')
    .select('*').order('fetched_at', { ascending: false }).limit(1).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// ── New decisions table ───────────────────────────────────────────────────────

export async function logDecisionNew(decision) {
  const { data, error } = await supabase
    .from('decisions').insert(decision).select().single();
  if (error) throw error;
  return data;
}

export async function markDecisionResolved(id) {
  const { error } = await supabase
    .from('decisions').update({ outcome_resolved: true }).eq('id', id);
  if (error) throw error;
}

export async function getUnresolvedDecisions({ action, minAgeTradingDays = 5 } = {}) {
  // minAgeTradingDays converted to calendar days (approx 1.4× trading days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.ceil(minAgeTradingDays * 1.4));
  let q = supabase.from('decisions').select('*')
    .eq('outcome_resolved', false)
    .lt('date', cutoff.toISOString());
  if (action) q = q.eq('action', action);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getDecisionHistory(ticker, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('decisions').select('*, outcomes(*)')
    .eq('ticker', ticker)
    .order('date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getSimilarSetups({ ticker, rsi, volumeRatio, regime, rsiWindow = 5, volWindow = 0.2 }) {
  const { data, error } = await supabase
    .from('decisions')
    .select('*, outcomes(*)')
    .eq('ticker', ticker)
    .eq('regime', regime)
    .gte('rsi', rsi - rsiWindow)
    .lte('rsi', rsi + rsiWindow)
    .gte('volume_ratio', volumeRatio - volWindow)
    .lte('volume_ratio', volumeRatio + volWindow)
    .eq('outcome_resolved', true);
  if (error) throw error;
  return data || [];
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

export async function logOutcome(outcome) {
  const { data, error } = await supabase
    .from('outcomes').insert(outcome).select().single();
  if (error) throw error;
  return data;
}

export async function getWeeklyOutcomes() {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { data, error } = await supabase
    .from('outcomes')
    .select('*, decisions(*)')
    .gte('resolved_at', weekAgo.toISOString());
  if (error) throw error;
  return data || [];
}

// ── Rule history ──────────────────────────────────────────────────────────────

export async function logRuleChange(change) {
  const { data, error } = await supabase
    .from('rule_history').insert(change).select().single();
  if (error) throw error;
  return data;
}

export async function getRecentRuleChanges({ limit = 10 } = {}) {
  const { data, error } = await supabase
    .from('rule_history').select('*')
    .order('changed_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// ── XGBoost scores ────────────────────────────────────────────────────────────

export async function getLatestXgboostScore(ticker) {
  const { data, error } = await supabase
    .from('xgboost_scores')
    .select('*').eq('ticker', ticker)
    .order('scored_at', { ascending: false }).limit(1).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

export async function saveXgboostScores(scores) {
  // scores = [{ ticker, probability, feature_values, model_version }]
  const { error } = await supabase.from('xgboost_scores').insert(scores);
  if (error) throw error;
}

// ── Daily summaries (new) ─────────────────────────────────────────────────────

export async function logDailySummaryNew(summary) {
  const { data, error } = await supabase
    .from('daily_summaries').insert(summary).select().single();
  if (error) throw error;
  return data;
}
