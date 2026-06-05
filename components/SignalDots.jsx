const SIGNAL_LABELS = [
  'RSI oversold',
  'Above MA50',
  'Volume spike',
  'Sentiment OK',
  'Sector clear',
];

export default function SignalDots({ signals, signalsMet }) {
  const keys = signals ? Object.keys(signals) : [];

  return (
    <div className="flex items-center gap-1.5" title={`${signalsMet ?? keys.filter(k => signals[k]).length}/5 signals`}>
      {SIGNAL_LABELS.map((label, i) => {
        const key = keys[i];
        const active = key ? signals[key] : false;
        return (
          <span
            key={label}
            title={label}
            className={`w-2.5 h-2.5 rounded-full inline-block transition-colors ${
              active ? 'bg-[#00d97e]' : 'bg-[#333]'
            }`}
          />
        );
      })}
    </div>
  );
}
