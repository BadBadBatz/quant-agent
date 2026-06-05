export const dynamic = 'force-dynamic';

import StatCard from '@/components/StatCard';
import PositionsTable from '@/components/PositionsTable';
import PortfolioChart from '@/components/PortfolioChart';
import BenchmarkBar from '@/components/BenchmarkBar';
import DecisionCard from '@/components/DecisionCard';
import { getAccount, getPositions } from '@/lib/alpaca';
import { getSnapshotHistory, getDecisions, getConfig, getTrades } from '@/lib/supabase';

function weekStartISO() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day; // back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function getData() {
  try {
    const [account, positions, history, decisionsData, cfg, trades] = await Promise.all([
      getAccount(),
      getPositions(),
      getSnapshotHistory(90),
      getDecisions({ limit: 5 }),
      getConfig(),
      getTrades({ limit: 200 }),
    ]);

    const ws = weekStartISO();
    const weeklyBudget = parseFloat(cfg.weekly_budget) || 0;
    const deployedThisWeek = trades
      .filter(t => t.side === 'buy' && t.created_at >= ws)
      .reduce((sum, t) => sum + (parseFloat(t.total_value) || 0), 0);

    return {
      portfolio: {
        account: {
          portfolio_value: account.portfolio_value,
          cash: account.cash,
          buying_power: account.buying_power,
          equity: account.equity,
          status: account.status,
        },
        positions: positions.map(p => ({
          symbol: p.symbol,
          qty: p.qty,
          avg_entry_price: p.avg_entry_price,
          current_price: p.current_price,
          market_value: p.market_value,
          unrealized_pl: p.unrealized_pl,
          unrealized_plpc: p.unrealized_plpc,
          change_today: p.change_today,
        })),
        history,
      },
      decisions: { decisions: decisionsData },
      weekly: { budget: weeklyBudget, deployed: deployedThisWeek },
    };
  } catch (err) {
    console.error('[dashboard] getData error:', err.message);
    return { portfolio: null, decisions: null, weekly: null };
  }
}

export default async function Dashboard() {
  const { portfolio, decisions, weekly } = await getData();

  const account = portfolio?.account;
  const positions = portfolio?.positions || [];
  const history = portfolio?.history || [];
  const recentDecisions = decisions?.decisions || [];

  const weeklyBudget = weekly?.budget ?? 0;
  const deployedThisWeek = weekly?.deployed ?? 0;
  const deployedPct = weeklyBudget > 0 ? Math.min((deployedThisWeek / weeklyBudget) * 100, 100) : 0;

  const totalValue = account ? parseFloat(account.portfolio_value) : null;
  const latestSnapshot = history[history.length - 1];
  const prevSnapshot = history[history.length - 2];
  const dailyPnlPct = latestSnapshot?.daily_pnl_pct ?? 0;
  const vsSpyToday = latestSnapshot ? dailyPnlPct - (latestSnapshot.spy_daily_pct ?? 0) : 0;
  const vsQqqToday = latestSnapshot ? dailyPnlPct - (latestSnapshot.qqq_daily_pct ?? 0) : 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Portfolio Value"
          value={totalValue ? `$${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
          sub={account ? `$${parseFloat(account.cash).toFixed(2)} cash` : null}
        />
        <StatCard
          label="Today's P&L"
          value={`${dailyPnlPct >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}%`}
          color={dailyPnlPct >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="vs SPY Today"
          value={`${vsSpyToday >= 0 ? '+' : ''}${vsSpyToday.toFixed(2)}%`}
          color={vsSpyToday >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="vs QQQ Today"
          value={`${vsQqqToday >= 0 ? '+' : ''}${vsQqqToday.toFixed(2)}%`}
          color={vsQqqToday >= 0 ? 'green' : 'red'}
        />
      </div>

      {/* Chart */}
      <div className="bg-[#111] border border-[#1e1e1e] rounded p-4">
        <p className="text-xs text-[#555] uppercase tracking-wider mb-4 font-sans">Portfolio vs Benchmarks</p>
        <PortfolioChart data={history} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Positions */}
        <div className="lg:col-span-2 bg-[#111] border border-[#1e1e1e] rounded p-4">
          <p className="text-xs text-[#555] uppercase tracking-wider mb-4 font-sans">
            Open Positions ({positions.length})
          </p>
          <PositionsTable positions={positions} />
        </div>

        {/* Benchmark comparison */}
        <div className="bg-[#111] border border-[#1e1e1e] rounded p-4">
          <p className="text-xs text-[#555] uppercase tracking-wider mb-4 font-sans">Performance vs Benchmarks</p>
          <div className="space-y-3">
            <BenchmarkBar label="SPY" value={dailyPnlPct} baseline={latestSnapshot?.spy_daily_pct ?? 0} />
            <BenchmarkBar label="QQQ" value={dailyPnlPct} baseline={latestSnapshot?.qqq_daily_pct ?? 0} />
          </div>
          <div className="mt-6 pt-4 border-t border-[#1e1e1e]">
            <p className="text-xs text-[#555] uppercase tracking-wider mb-2 font-sans">Weekly Budget</p>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-[#888]">Deployed</span>
              <span className="text-white">
                ${deployedThisWeek.toFixed(2)} / ${weeklyBudget.toFixed(0)}
              </span>
            </div>
            <div className="h-1.5 bg-[#1e1e1e] rounded-full mt-2">
              <div className="h-full bg-[#5b8ef7] rounded-full" style={{ width: `${deployedPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Recent decisions */}
      {recentDecisions.length > 0 && (
        <div className="bg-[#111] border border-[#1e1e1e] rounded p-4">
          <p className="text-xs text-[#555] uppercase tracking-wider mb-4 font-sans">Today's Activity</p>
          <div className="space-y-1">
            {recentDecisions.map(d => (
              <DecisionCard key={d.id} decision={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
