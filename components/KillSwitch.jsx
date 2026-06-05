'use client';
import { useState } from 'react';

export default function KillSwitch({ paused, onToggle }) {
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      const res = await fetch('/api/kill-switch', { method: 'POST' });
      const data = await res.json();
      onToggle(data.system_paused);
    } finally {
      setLoading(false);
      setConfirm(false);
    }
  }

  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded p-6">
      <p className="text-xs text-[#888] uppercase tracking-wider mb-4">Kill Switch</p>

      {!confirm ? (
        <button
          onClick={() => setConfirm(true)}
          className={`w-full py-3 rounded font-mono text-sm font-semibold transition-colors ${
            paused
              ? 'bg-[#00d97e20] border border-[#00d97e] text-[#00d97e] hover:bg-[#00d97e30]'
              : 'bg-[#ff444420] border border-[#ff4444] text-[#ff4444] hover:bg-[#ff444430]'
          }`}
        >
          {paused ? 'RESUME TRADING' : 'HALT ALL TRADING'}
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-[#e8e8e8]">
            {paused ? 'Resume autonomous trading?' : 'Halt all trading immediately?'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={loading}
              className={`flex-1 py-2 rounded font-mono text-sm font-semibold ${
                paused
                  ? 'bg-[#00d97e] text-black hover:bg-[#00c070]'
                  : 'bg-[#ff4444] text-white hover:bg-[#e03030]'
              }`}
            >
              {loading ? '...' : 'CONFIRM'}
            </button>
            <button
              onClick={() => setConfirm(false)}
              className="flex-1 py-2 rounded font-mono text-sm border border-[#333] text-[#888] hover:text-white"
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
