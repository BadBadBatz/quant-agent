'use client';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded p-3 text-xs font-mono">
      <p className="text-[#888] mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value > 0 ? '+' : ''}{p.value.toFixed(2)}%
        </p>
      ))}
    </div>
  );
}

export default function PortfolioChart({ data }) {
  if (!data?.length) {
    return (
      <div className="h-48 flex items-center justify-center text-[#444] text-sm font-mono">
        No history yet
      </div>
    );
  }

  // Normalize to % return from first data point
  const base = data[0]?.portfolio ?? 100000;
  const normalized = data.map(d => ({
    date: new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    Portfolio: parseFloat(((d.total_value - base) / base * 100).toFixed(2)),
    SPY: d.spy_daily_pct ?? 0,
    QQQ: d.qqq_daily_pct ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={normalized} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <XAxis
          dataKey="date"
          tick={{ fill: '#555', fontSize: 10, fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: '#555', fontSize: 10, fontFamily: 'JetBrains Mono' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={v => `${v}%`}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconType="plainline"
          iconSize={16}
          wrapperStyle={{ fontSize: '11px', fontFamily: 'JetBrains Mono', color: '#888' }}
        />
        <Line type="monotone" dataKey="Portfolio" stroke="#5b8ef7" dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="SPY" stroke="#444" dot={false} strokeWidth={1} strokeDasharray="4 2" />
        <Line type="monotone" dataKey="QQQ" stroke="#555" dot={false} strokeWidth={1} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}
