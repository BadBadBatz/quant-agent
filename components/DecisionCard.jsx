'use client';
import { useState } from 'react';
import SignalDots from './SignalDots';

const DECISION_COLORS = {
  buy: 'text-[#00d97e] border-[#00d97e33]',
  watchlist: 'text-[#f59e0b] border-[#f59e0b33]',
  pass: 'text-[#555] border-[#1e1e1e]',
  hold: 'text-[#5b8ef7] border-[#5b8ef733]',
  sell: 'text-[#ff4444] border-[#ff444433]',
};

export default function DecisionCard({ decision }) {
  const [expanded, setExpanded] = useState(false);
  const color = DECISION_COLORS[decision.decision] || DECISION_COLORS.pass;

  return (
    <div
      className="border border-[#1e1e1e] rounded bg-[#0d0d0d] hover:border-[#2a2a2a] transition-colors cursor-pointer"
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-center gap-4 p-3">
        <span className={`font-mono text-xs font-bold w-20 border rounded px-2 py-0.5 text-center ${color}`}>
          {decision.decision.toUpperCase()}
        </span>
        <span className="font-mono text-sm font-semibold text-white w-16">{decision.symbol}</span>
        <SignalDots signals={decision.signals} signalsMet={decision.signals_met} />
        <span className="font-mono text-xs text-[#555] ml-auto">
          {decision.confidence ? `${decision.confidence}/10` : '—'}
        </span>
        <span className="text-[#444] text-xs font-mono">
          {new Date(decision.created_at).toLocaleDateString()}
        </span>
        <span className="text-[#333] text-xs ml-2">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="border-t border-[#1e1e1e] px-4 py-3 space-y-2">
          <p className="text-sm text-[#ccc] leading-relaxed">{decision.reasoning}</p>
          <div className="grid grid-cols-3 gap-2 mt-2">
            {decision.rsi != null && (
              <div className="text-xs font-mono">
                <span className="text-[#555]">RSI</span>
                <span className="ml-2 text-[#888]">{decision.rsi}</span>
              </div>
            )}
            {decision.volume_ratio != null && (
              <div className="text-xs font-mono">
                <span className="text-[#555]">Vol</span>
                <span className="ml-2 text-[#888]">{decision.volume_ratio}x</span>
              </div>
            )}
            {decision.news_sentiment && (
              <div className="text-xs font-mono">
                <span className="text-[#555]">Sent</span>
                <span className="ml-2 text-[#888]">{decision.news_sentiment}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
