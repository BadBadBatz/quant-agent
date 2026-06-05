create extension if not exists pgcrypto;

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  ticker text,
  symbol text,
  date timestamptz default now(),
  action text check (action is null or action in ('buy', 'watch', 'pass')),
  decision text check (decision is null or decision in ('buy', 'watchlist', 'pass')),
  rsi numeric,
  volume_ratio numeric,
  price_vs_ma50 numeric,
  ma50_distance numeric,
  signals_fired integer,
  signals_met integer,
  regime text check (regime is null or regime in ('bull', 'neutral', 'bear')),
  confidence integer,
  signals jsonb,
  news_sentiment text,
  claude_reasoning text,
  reasoning text,
  entry_price numeric,
  position_size numeric,
  macro_context jsonb,
  daily_review jsonb,
  trade_id uuid,
  needs_review boolean default false,
  outcome_resolved boolean default false,
  created_at timestamptz default now()
);

create index if not exists decisions_ticker_date_idx on public.decisions (ticker, date desc);
create index if not exists decisions_symbol_created_idx on public.decisions (symbol, created_at desc);
create index if not exists decisions_outcome_resolved_idx on public.decisions (outcome_resolved);

create table if not exists public.outcomes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid references public.decisions(id) on delete cascade,
  exit_price numeric,
  return_pct numeric,
  exit_reason text check (exit_reason is null or exit_reason in ('stop_loss', 'take_profit', 'time_exit', 'sold_early')),
  days_held integer,
  win boolean,
  missed_win boolean,
  correct_pass boolean,
  resolved_at timestamptz default now()
);

create index if not exists outcomes_decision_id_idx on public.outcomes (decision_id);
create index if not exists outcomes_resolved_at_idx on public.outcomes (resolved_at desc);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text check (side in ('buy', 'sell')),
  qty numeric,
  price numeric,
  total_value numeric,
  order_id text,
  status text,
  stop_loss_price numeric,
  take_profit_price numeric,
  exit_reason text,
  pnl numeric,
  pnl_pct numeric,
  created_at timestamptz default now()
);

create index if not exists trades_symbol_created_idx on public.trades (symbol, created_at desc);

create table if not exists public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  total_value numeric,
  cash numeric,
  equity numeric,
  daily_pnl numeric,
  daily_pnl_pct numeric,
  total_pnl numeric,
  total_pnl_pct numeric,
  positions jsonb,
  spy_daily_pct numeric,
  qqq_daily_pct numeric,
  created_at timestamptz default now()
);

create index if not exists portfolio_snapshots_created_idx on public.portfolio_snapshots (created_at desc);

create table if not exists public.dca_log (
  id uuid primary key default gen_random_uuid(),
  week_start date,
  amount numeric,
  deployed numeric,
  held_back numeric,
  targets jsonb,
  created_at timestamptz default now()
);

create unique index if not exists dca_log_week_start_idx on public.dca_log (week_start);

create table if not exists public.daily_summaries (
  id uuid primary key default gen_random_uuid(),
  date date,
  summary text,
  trades_today integer,
  portfolio_value numeric,
  day_pnl_pct numeric,
  vs_spy numeric,
  vs_qqq numeric,
  next_week_plan text,
  created_at timestamptz default now()
);

create index if not exists daily_summaries_date_idx on public.daily_summaries (date desc);

create table if not exists public.rule_history (
  id uuid primary key default gen_random_uuid(),
  changed_at timestamptz default now(),
  rule_name text,
  old_value numeric,
  new_value numeric,
  reason text,
  backtest_ev numeric,
  reverted boolean default false
);

create table if not exists public.agent_config (
  key text primary key,
  value text not null,
  description text,
  locked boolean default false,
  updated_at timestamptz default now()
);

insert into public.agent_config (key, value, description, locked) values
  ('rsi_lower', '25', 'Lower RSI bound for entry signal', false),
  ('rsi_upper', '40', 'Upper RSI bound for entry signal', false),
  ('volume_multiplier', '1.4', 'Volume multiple over 20-day average', false),
  ('signals_required', '5', 'Signals required before Claude review', false),
  ('stop_loss_pct', '0.06', 'Hard stop loss percentage', true),
  ('take_profit_pct', '0.12', 'Take profit percentage', true),
  ('max_positions', '4', 'Maximum open positions', true),
  ('max_position_pct', '0.40', 'Maximum single-position portfolio percentage', true),
  ('weekly_budget', '6250', 'Weekly capital budget', true),
  ('dry_powder_pct', '0.25', 'Capital held back each week', true),
  ('blackout_fomc', 'true', 'Disable entries during FOMC weeks', true),
  ('adjustment_frozen', '0', 'Autonomous rule adjustment freeze flag', false),
  ('consecutive_bad_weeks', '0', 'Circuit-breaker counter', false)
on conflict (key) do nothing;

create table if not exists public.system_config (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz default now()
);

insert into public.system_config (key, value, description) values
  ('system_paused', 'false', 'Global kill switch'),
  ('mode', 'paper', 'Trading mode'),
  ('weekly_budget', '6250', 'Weekly capital budget'),
  ('dry_powder_pct', '0.25', 'Capital held back each week'),
  ('max_positions', '4', 'Maximum open positions'),
  ('stop_loss_pct', '0.06', 'Hard stop loss percentage'),
  ('take_profit_pct', '0.12', 'Take profit percentage'),
  ('max_position_pct', '0.40', 'Maximum single-position portfolio percentage'),
  ('require_confirm_above', '10000', 'Manual confirmation threshold'),
  ('blackout_fomc', 'true', 'Disable entries during FOMC weeks')
on conflict (key) do nothing;

create table if not exists public.macro_context (
  id uuid primary key default gen_random_uuid(),
  fetched_at timestamptz default now(),
  spy_5day_return numeric,
  spy_rsi numeric,
  regime text check (regime is null or regime in ('bull', 'neutral', 'bear')),
  sector_perf jsonb,
  top_headlines jsonb,
  days_to_fomc integer,
  is_fomc_week boolean
);

create index if not exists macro_context_fetched_at_idx on public.macro_context (fetched_at desc);

create table if not exists public.xgboost_scores (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  probability numeric,
  feature_values jsonb,
  model_version text,
  scored_at timestamptz default now()
);

create index if not exists xgboost_scores_ticker_scored_idx on public.xgboost_scores (ticker, scored_at desc);

create table if not exists public.model_history (
  id uuid primary key default gen_random_uuid(),
  model_version text,
  trained_at timestamptz default now(),
  metrics jsonb,
  feature_importance jsonb,
  artifact_path text
);

create table if not exists public.backtest_results (
  id uuid primary key default gen_random_uuid(),
  label text,
  rules jsonb,
  start_date date,
  end_date date,
  n_trades integer,
  win_rate numeric,
  avg_win numeric,
  avg_loss numeric,
  expected_value numeric,
  max_drawdown numeric,
  sharpe numeric,
  total_return numeric,
  equity_curve jsonb,
  trade_log jsonb,
  signal_breakdown jsonb,
  regime_breakdown jsonb,
  rsi_ceiling_analysis jsonb,
  created_at timestamptz default now()
);
