import { getDailySummaries, getSnapshotHistory } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  let summaries = [];
  let history = [];

  try {
    [summaries, history] = await Promise.all([
      getDailySummaries({ limit: 30 }),
      getSnapshotHistory(30),
    ]);
  } catch {
    // Supabase not configured yet
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="font-mono text-sm font-semibold text-white uppercase tracking-widest">Reports</h1>

      {/* Weekly performance table */}
      {history.length > 0 && (
        <div className="bg-[#111] border border-[#1e1e1e] rounded p-4">
          <p className="text-xs text-[#555] uppercase tracking-wider mb-4 font-sans">Benchmark Comparison</p>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-[#555] border-b border-[#1e1e1e]">
                {['Date', 'Portfolio', 'SPY', 'QQQ', 'vs SPY', 'vs QQQ'].map(h => (
                  <th key={h} className="text-left py-2 pr-4 font-normal uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.slice(-14).reverse().map(s => {
                const vsSpy = (s.daily_pnl_pct ?? 0) - (s.spy_daily_pct ?? 0);
                const vsQqq = (s.daily_pnl_pct ?? 0) - (s.qqq_daily_pct ?? 0);
                return (
                  <tr key={s.id} className="border-b border-[#111]">
                    <td className="py-2 pr-4 text-[#555]">
                      {new Date(s.date || s.created_at).toLocaleDateString()}
                    </td>
                    <td className={`py-2 pr-4 ${(s.daily_pnl_pct ?? 0) >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
                      {(s.daily_pnl_pct ?? 0) >= 0 ? '+' : ''}{(s.daily_pnl_pct ?? 0).toFixed(2)}%
                    </td>
                    <td className="py-2 pr-4 text-[#888]">
                      {(s.spy_daily_pct ?? 0) >= 0 ? '+' : ''}{(s.spy_daily_pct ?? 0).toFixed(2)}%
                    </td>
                    <td className="py-2 pr-4 text-[#888]">
                      {(s.qqq_daily_pct ?? 0) >= 0 ? '+' : ''}{(s.qqq_daily_pct ?? 0).toFixed(2)}%
                    </td>
                    <td className={`py-2 pr-4 ${vsSpy >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
                      {vsSpy >= 0 ? '+' : ''}{vsSpy.toFixed(2)}%
                    </td>
                    <td className={`py-2 pr-4 ${vsQqq >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
                      {vsQqq >= 0 ? '+' : ''}{vsQqq.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Daily summaries */}
      <div className="space-y-3">
        <p className="text-xs text-[#555] uppercase tracking-wider font-sans">Daily Summaries</p>
        {summaries.length === 0 ? (
          <p className="text-[#444] font-mono text-sm text-center py-8">No summaries yet — runs daily at 4:05pm ET</p>
        ) : (
          summaries.map(s => (
            <div key={s.id} className="bg-[#111] border border-[#1e1e1e] rounded p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-[#555]">{s.date}</span>
                <div className="flex gap-4 font-mono text-xs">
                  <span className={s.day_pnl_pct >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}>
                    {s.day_pnl_pct >= 0 ? '+' : ''}{s.day_pnl_pct?.toFixed(2)}%
                  </span>
                  <span className="text-[#555]">{s.trades_today} trades</span>
                </div>
              </div>
              <p className="text-sm text-[#ccc] leading-relaxed">{s.summary}</p>
              {s.next_week_plan && (
                <p className="text-xs text-[#666] italic border-t border-[#1a1a1a] pt-2">
                  Next: {s.next_week_plan}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
