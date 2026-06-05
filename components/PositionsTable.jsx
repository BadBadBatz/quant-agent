export default function PositionsTable({ positions }) {
  if (!positions?.length) {
    return (
      <p className="text-[#444] text-sm font-mono py-8 text-center">No open positions</p>
    );
  }

  return (
    <div className="overflow-x-auto -mx-3 sm:mx-0 px-3 sm:px-0">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-[#555] border-b border-[#1e1e1e]">
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider">Symbol</th>
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider hidden sm:table-cell">Qty</th>
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider">Entry</th>
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider">Price</th>
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider">P&L%</th>
            <th className="text-left py-2 pr-4 font-normal uppercase tracking-wider hidden sm:table-cell">Value</th>
          </tr>
        </thead>
        <tbody>
          {positions.map(p => {
            const plPct = parseFloat(p.unrealized_plpc) * 100;
            const isPos = plPct >= 0;
            return (
              <tr key={p.symbol} className="border-b border-[#111]">
                <td className="py-3 pr-4 font-semibold text-white">{p.symbol}</td>
                <td className="py-3 pr-4 text-[#888] hidden sm:table-cell">{p.qty}</td>
                <td className="py-3 pr-4 text-[#888]">${parseFloat(p.avg_entry_price).toFixed(2)}</td>
                <td className="py-3 pr-4 text-[#e8e8e8]">${parseFloat(p.current_price).toFixed(2)}</td>
                <td className={`py-3 pr-4 font-semibold ${isPos ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
                  {isPos ? '+' : ''}{plPct.toFixed(2)}%
                </td>
                <td className="py-3 pr-4 text-[#888] hidden sm:table-cell">
                  ${parseFloat(p.market_value).toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
