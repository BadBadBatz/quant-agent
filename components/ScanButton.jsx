'use client';
import { useState } from 'react';

export default function ScanButton() {
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [results, setResults] = useState(null);

  async function runScan() {
    setState('running');
    setResults(null);
    try {
      const res = await fetch('/api/trigger/scan', { method: 'POST' });
      const data = await res.json();
      setResults(data);
      setState('done');
    } catch (err) {
      setResults({ error: err.message });
      setState('error');
    }
  }

  return (
    <div className="space-y-3">
      <button
        onClick={runScan}
        disabled={state === 'running'}
        className={`w-full py-2.5 rounded font-mono text-sm font-semibold transition-colors border ${
          state === 'running'
            ? 'border-[#333] text-[#555] cursor-not-allowed'
            : state === 'done'
            ? 'border-[#00d97e33] text-[#00d97e] hover:bg-[#00d97e11]'
            : state === 'error'
            ? 'border-[#ff444433] text-[#ff4444] hover:bg-[#ff444411]'
            : 'border-[#5b8ef733] text-[#5b8ef7] hover:bg-[#5b8ef711]'
        }`}
      >
        {state === 'running' ? 'SCANNING...' : state === 'done' ? 'SCAN COMPLETE — RUN AGAIN' : 'RUN SCAN NOW'}
      </button>

      {results && !results.error && (
        <div className="bg-[#0d0d0d] border border-[#1e1e1e] rounded p-3 space-y-2 text-xs font-mono">
          <div className="flex gap-4 text-[#888]">
            <span>Scanned <span className="text-white">{results.scanned}</span></span>
            <span>Bought <span className="text-[#00d97e]">{results.bought?.length ?? 0}</span></span>
            <span>Watchlist <span className="text-[#f59e0b]">{results.watchlist?.length ?? 0}</span></span>
            <span>Passed <span className="text-[#555]">{results.passed?.length ?? 0}</span></span>
          </div>

          {results.bought?.length > 0 && (
            <div className="pt-2 border-t border-[#1a1a1a]">
              {results.bought.map(b => (
                <p key={b.symbol} className="text-[#00d97e]">
                  ✓ BUY {b.symbol} — ${b.size?.toFixed(2)}
                </p>
              ))}
            </div>
          )}

          {results.skipped_unaffordable?.length > 0 && (
            <div className="pt-2 border-t border-[#1a1a1a]">
              {results.skipped_unaffordable.map(s => (
                <p key={s.symbol} className="text-[#f59e0b]">
                  ⚠ {s.symbol} skipped — ${s.price} &gt; ${s.notional} available
                </p>
              ))}
            </div>
          )}

          {results.errors?.length > 0 && (
            <div className="pt-2 border-t border-[#1a1a1a]">
              {results.errors.slice(0, 3).map(e => (
                <p key={e.symbol} className="text-[#ff4444]">✗ {e.symbol}: {e.error}</p>
              ))}
              {results.errors.length > 3 && (
                <p className="text-[#555]">+{results.errors.length - 3} more errors</p>
              )}
            </div>
          )}
        </div>
      )}

      {results?.error && (
        <p className="text-xs font-mono text-[#ff4444]">{results.error}</p>
      )}
    </div>
  );
}
