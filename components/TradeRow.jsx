const EXIT_LABELS = {
  stop_loss: { label: 'SL', labelFull: 'Stop Loss', color: 'text-[#ff4444]' },
  take_profit: { label: 'TP', labelFull: 'Take Profit', color: 'text-[#00d97e]' },
  manual: { label: 'Man', labelFull: 'Manual', color: 'text-[#f59e0b]' },
  signal: { label: 'Sig', labelFull: 'Signal', color: 'text-[#5b8ef7]' },
};

export default function TradeRow({ trade }) {
  const isBuy = trade.side === 'buy';
  const exitMeta = EXIT_LABELS[trade.exit_reason];

  return (
    <tr className="border-b border-[#111] text-xs font-mono">
      <td className="py-3 px-4">
        <span className={`font-semibold ${isBuy ? 'text-[#00d97e]' : 'text-[#ff4444]'}`}>
          {trade.side.toUpperCase()}
        </span>
      </td>
      <td className="py-3 pr-4 font-semibold text-white">{trade.symbol}</td>
      <td className="py-3 pr-4 text-[#888] hidden sm:table-cell">{trade.qty}</td>
      <td className="py-3 pr-4 text-[#888]">${parseFloat(trade.price).toFixed(2)}</td>
      <td className="py-3 pr-4 text-[#888] hidden sm:table-cell">${parseFloat(trade.total_value).toFixed(2)}</td>
      <td className="py-3 pr-4">
        {trade.pnl_pct != null ? (
          <span className={trade.pnl_pct >= 0 ? 'text-[#00d97e]' : 'text-[#ff4444]'}>
            {trade.pnl_pct >= 0 ? '+' : ''}{parseFloat(trade.pnl_pct).toFixed(2)}%
          </span>
        ) : <span className="text-[#444]">—</span>}
      </td>
      <td className="py-3 pr-4">
        {exitMeta ? (
          <>
            <span className={`${exitMeta.color} sm:hidden`}>{exitMeta.label}</span>
            <span className={`${exitMeta.color} hidden sm:inline`}>{exitMeta.labelFull}</span>
          </>
        ) : <span className="text-[#444]">—</span>}
      </td>
      <td className="py-3 pr-4 text-[#444] hidden sm:table-cell">
        {new Date(trade.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}
