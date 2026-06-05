export default function StatCard({ label, value, sub, color }) {
  const colorClass =
    color === 'green' ? 'text-[#00d97e]' :
    color === 'red'   ? 'text-[#ff4444]' :
    color === 'amber' ? 'text-[#f59e0b]' :
    'text-white';

  return (
    <div className="bg-[#111] border border-[#1e1e1e] rounded p-3 sm:p-4">
      <p className="text-[#888] text-[10px] sm:text-xs font-sans uppercase tracking-wider mb-1 truncate">{label}</p>
      <p className={`font-mono text-lg sm:text-2xl font-semibold ${colorClass} truncate`}>{value}</p>
      {sub && <p className="text-[#555] text-[10px] font-mono mt-1 truncate">{sub}</p>}
    </div>
  );
}
