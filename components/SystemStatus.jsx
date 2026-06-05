'use client';
import { useEffect, useState } from 'react';

export default function SystemStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetch('/api/kill-switch')
      .then(r => r.json())
      .then(d => setStatus(d))
      .catch(() => {});

    const interval = setInterval(() => {
      fetch('/api/kill-switch')
        .then(r => r.json())
        .then(d => setStatus(d))
        .catch(() => {});
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  if (!status) {
    return <span className="h-2 w-2 rounded-full bg-[#444] animate-pulse" />;
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 rounded-full ${status.system_paused ? 'bg-[#ff4444]' : 'bg-[#00d97e] animate-pulse'}`}
      />
      <span className={`font-mono text-xs ${status.system_paused ? 'text-[#ff4444]' : 'text-[#00d97e]'}`}>
        {status.system_paused ? 'PAUSED' : 'ACTIVE'} · PAPER
      </span>
    </div>
  );
}
