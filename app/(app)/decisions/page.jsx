'use client';
import { useEffect, useState } from 'react';
import DecisionCard from '@/components/DecisionCard';

const DECISION_FILTERS = ['all', 'buy', 'watchlist', 'pass'];

export default function DecisionsPage() {
  const [decisions, setDecisions] = useState([]);
  const [filter, setFilter] = useState('all');
  const [symbol, setSymbol] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '200' });
    if (filter !== 'all') params.set('decision', filter);
    if (symbol) params.set('symbol', symbol.toUpperCase());

    fetch(`/api/decisions?${params}`)
      .then(r => r.json())
      .then(d => setDecisions(d.decisions || []))
      .finally(() => setLoading(false));
  }, [filter, symbol]);

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-sm font-semibold text-white uppercase tracking-widest">Claude's Brain</h1>
        <span className="text-xs font-mono text-[#555]">{decisions.length} decisions</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {DECISION_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-mono rounded transition-colors ${
                filter === f
                  ? 'bg-[#5b8ef7] text-white'
                  : 'text-[#888] border border-[#1e1e1e] hover:text-white'
              }`}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by symbol..."
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          className="bg-[#111] border border-[#1e1e1e] rounded px-3 py-1 text-xs font-mono text-[#e8e8e8] placeholder-[#444] focus:outline-none focus:border-[#333] w-40"
        />
      </div>

      {/* Decision list */}
      {loading ? (
        <div className="text-center text-[#444] font-mono text-sm py-12">Loading...</div>
      ) : decisions.length === 0 ? (
        <div className="text-center text-[#444] font-mono text-sm py-12">No decisions yet</div>
      ) : (
        <div className="space-y-1">
          {decisions.map(d => <DecisionCard key={d.id} decision={d} />)}
        </div>
      )}
    </div>
  );
}
