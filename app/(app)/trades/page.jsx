'use client';
import { useEffect, useState } from 'react';
import TradeRow from '@/components/TradeRow';

export default function TradesPage() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  useEffect(() => {
    setLoading(true);
    fetch(`/api/trades?limit=${LIMIT}&offset=${offset}`)
      .then(r => r.json())
      .then(d => setTrades(d.trades || []))
      .finally(() => setLoading(false));
  }, [offset]);

  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-sm font-semibold text-white uppercase tracking-widest">Trade History</h1>
        {trades.length > 0 && (
          <span className={`font-mono text-sm font-semibold ${totalPnl >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
            Total P&L: {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-center text-[#444] font-mono text-sm py-12">Loading...</div>
      ) : trades.length === 0 ? (
        <div className="text-center text-[#444] font-mono text-sm py-12">No trades yet</div>
      ) : (
        <div className="bg-[#111] border border-[#1e1e1e] rounded overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[#555] border-b border-[#1e1e1e] text-xs font-mono">
                <th className="text-left py-2.5 px-4 font-normal uppercase tracking-wider">Side</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider">Symbol</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider hidden sm:table-cell">Qty</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider">Price</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider hidden sm:table-cell">Value</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider">P&L%</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider">Exit</th>
                <th className="text-left py-2.5 pr-4 font-normal uppercase tracking-wider hidden sm:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => <TradeRow key={t.id} trade={t} />)}
            </tbody>
          </table>
        </div>
      )}

      {trades.length === LIMIT && (
        <button
          onClick={() => setOffset(o => o + LIMIT)}
          className="w-full py-2 text-xs font-mono text-[#555] border border-[#1e1e1e] rounded hover:text-white transition-colors"
        >
          Load more
        </button>
      )}
    </div>
  );
}
