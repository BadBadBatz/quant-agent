export default function BenchmarkBar({ label, value, baseline = 0 }) {
  const diff = value - baseline;
  const isPositive = diff >= 0;

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[#888] font-sans w-8">{label}</span>
      <div className="flex-1 h-1.5 bg-[#1e1e1e] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isPositive ? 'bg-[#00d97e]' : 'bg-[#ff4444]'}`}
          style={{ width: `${Math.min(Math.abs(diff) * 5, 100)}%` }}
        />
      </div>
      <span className={`font-mono text-xs w-16 text-right ${isPositive ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
        {isPositive ? '+' : ''}{diff.toFixed(2)}%
      </span>
    </div>
  );
}
