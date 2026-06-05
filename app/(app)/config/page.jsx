'use client';
import { useEffect, useState } from 'react';
import KillSwitch from '@/components/KillSwitch';
import ScanButton from '@/components/ScanButton';

const DESCRIPTIONS = {
  weekly_budget: 'Weekly capital to deploy ($)',
  dry_powder_pct: 'Hold back percentage (0.25 = 25%)',
  max_positions: 'Max open positions at once',
  stop_loss_pct: 'Hard stop loss (0.06 = 6%)',
  take_profit_pct: 'Take profit level (0.12 = 12%)',
  max_position_pct: 'Max single position size (0.40 = 40% of portfolio)',
  require_confirm_above: 'Require manual confirmation above this USD amount',
  blackout_fomc: 'Pause new entries during FOMC weeks (true/false)',
};

export default function ConfigPage() {
  const [config, setConfig] = useState([]);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState({});
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/kill-switch').then(r => r.json()),
    ]).then(([cfg, ks]) => {
      setConfig(cfg.config || []);
      setPaused(ks.system_paused || false);
    }).finally(() => setLoading(false));
  }, []);

  async function saveKey(key) {
    if (edits[key] === undefined) return;
    setSaving(s => ({ ...s, [key]: true }));
    try {
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: edits[key] }),
      });
      setConfig(c => c.map(r => r.key === key ? { ...r, value: edits[key] } : r));
      setEdits(e => { const n = { ...e }; delete n[key]; return n; });
    } finally {
      setSaving(s => ({ ...s, [key]: false }));
    }
  }

  const editableKeys = config.filter(r => r.key !== 'system_paused' && r.key !== 'mode');

  if (loading) return <div className="text-[#444] font-mono text-sm text-center py-12">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="font-mono text-sm font-semibold text-white uppercase tracking-widest">System Config</h1>

      <div className="bg-[#111] border border-[#1e1e1e] rounded p-4">
        <p className="text-xs text-[#555] uppercase tracking-wider mb-3 font-sans">Manual Scan</p>
        <ScanButton />
      </div>

      <KillSwitch paused={paused} onToggle={setPaused} />

      <div className="bg-[#111] border border-[#1e1e1e] rounded divide-y divide-[#1a1a1a]">
        {editableKeys.map(row => {
          const val = edits[row.key] !== undefined ? edits[row.key] : row.value;
          const dirty = edits[row.key] !== undefined;
          return (
            <div key={row.key} className="flex items-center gap-4 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-white">{row.key}</p>
                <p className="text-[#555] text-xs mt-0.5">{DESCRIPTIONS[row.key] || row.description}</p>
              </div>
              <input
                value={val}
                onChange={e => setEdits(eds => ({ ...eds, [row.key]: e.target.value }))}
                className="bg-[#0d0d0d] border border-[#1e1e1e] rounded px-2 py-1 text-xs font-mono text-[#e8e8e8] w-24 text-right focus:outline-none focus:border-[#333]"
              />
              {dirty && (
                <button
                  onClick={() => saveKey(row.key)}
                  disabled={saving[row.key]}
                  className="text-xs font-mono text-[#5b8ef7] hover:text-white transition-colors"
                >
                  {saving[row.key] ? '...' : 'Save'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="bg-[#111] border border-[#f59e0b33] rounded p-4">
        <p className="text-xs text-[#f59e0b] font-mono uppercase tracking-wider mb-2">Mode</p>
        <p className="text-sm text-[#888]">
          Currently in <span className="text-white font-mono">PAPER</span> mode.
          To switch to live trading, update <code className="text-[#5b8ef7]">mode</code> in Supabase
          and set real Alpaca credentials.
        </p>
      </div>
    </div>
  );
}
