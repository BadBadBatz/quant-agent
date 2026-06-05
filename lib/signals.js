// Stock universe
export const UNIVERSE = {
  tech: ['NVDA', 'MSFT', 'META', 'GOOGL', 'AAPL', 'AMZN', 'AMD', 'TSM'],
  diversifiers: ['BRK.B', 'LLY', 'JPM', 'COST', 'UNH', 'V'],
  defense: ['LMT', 'RTX', 'NOC', 'GD'],
  energy: ['XOM', 'CVX', 'COP', 'SLB'],
  etf_fallback: ['QQQ', 'SPY', 'XLK'],
};

export const ALL_CANDIDATES = [
  ...UNIVERSE.tech,
  ...UNIVERSE.diversifiers,
  ...UNIVERSE.defense,
  ...UNIVERSE.energy,
  ...UNIVERSE.etf_fallback,
];

export const SECTOR_MAP = {
  NVDA: 'tech', MSFT: 'tech', META: 'tech', GOOGL: 'tech',
  AAPL: 'tech', AMZN: 'tech', AMD: 'tech', TSM: 'tech',
  'BRK.B': 'finance', LLY: 'healthcare', JPM: 'finance',
  COST: 'consumer', UNH: 'healthcare', V: 'finance',
  LMT: 'defense', RTX: 'defense', NOC: 'defense', GD: 'defense',
  XOM: 'energy', CVX: 'energy', COP: 'energy', SLB: 'energy',
  QQQ: 'etf', SPY: 'etf', XLK: 'etf',
};

// Sector ETF map — used for Phase 4 market context enrichment
export const SECTOR_ETF_MAP = {
  tech:       'XLK',
  finance:    'XLF',
  healthcare: 'XLV',
  consumer:   'XLP',
  defense:    'ITA',
  energy:     'XLE',
  etf:        'SPY',
  unknown:    'SPY',
};

// FOMC meeting dates (hardcoded public calendar)
const FOMC_DATE_LIST = [
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-11-05','2025-12-17',
  '2026-01-28','2026-03-18','2026-05-06','2026-06-17',
  '2026-07-29','2026-09-16','2026-11-04','2026-12-16',
];

export function daysToNextFomc(from = new Date()) {
  const now = from.getTime();
  const upcoming = FOMC_DATE_LIST
    .map(d => new Date(d).getTime())
    .filter(t => t >= now)
    .sort((a, b) => a - b);
  if (!upcoming.length) return 999;
  return Math.ceil((upcoming[0] - now) / (1000 * 60 * 60 * 24));
}

// ── Phase 2 composite score ───────────────────────────────────────────────────
// Weighted signal quality score using Phase 2 XGBoost feature importances.
// Gives Claude a single 0–1 number representing market-context alignment.
const COMPOSITE_WEIGHTS = {
  spy_20d_trend: 9.67,
  spy_vs_ma50:   9.24,
  spy_rsi:       6.56,
  spy_5d_trend:  6.49,
  sector_5d:     6.21,
  sector_vs_spy: 5.08,
  pct_vs_ma200:  5.01,
  sector_rsi:    4.99,
  hl_range:      4.52,
  rsi:           2.58,
  pct_vs_ma50:   3.82,
  vol_ratio:     1.94,
};

function clampNorm(val, min, max, invert = false) {
  const n = (Math.max(min, Math.min(max, val)) - min) / (max - min);
  return invert ? 1 - n : n;
}

export function computeCompositeScore(f) {
  const norm = {
    spy_20d_trend: clampNorm(f.spy20dTrend,  -10, 15),
    spy_vs_ma50:   clampNorm(f.spyVsMa50,    -10, 15),
    spy_rsi:       clampNorm(f.spyRsi,         30, 80),
    spy_5d_trend:  clampNorm(f.spy5dTrend,    -5,   8),
    sector_5d:     clampNorm(f.sector5d,       -5,   8),
    sector_vs_spy: clampNorm(f.sectorVsSpy,   -5,   5),
    pct_vs_ma200:  clampNorm(f.pctVsMa200,   -20,  10),
    sector_rsi:    clampNorm(f.sectorRsi,      30,  75),
    hl_range:      clampNorm(f.hlRange,         0,   4),
    rsi:           clampNorm(f.rsi,            20,  50, true), // lower RSI = better entry
    pct_vs_ma50:   clampNorm(f.pctVsMa50,     -15,   5),
    vol_ratio:     clampNorm(f.volRatio,         0,   3),
  };

  let weighted = 0, total = 0;
  for (const [k, w] of Object.entries(COMPOSITE_WEIGHTS)) {
    if (norm[k] !== undefined) { weighted += norm[k] * w; total += w; }
  }
  const score = total > 0 ? weighted / total : 0.5;

  const interpretation =
    score >= 0.70 ? 'strong — multiple tailwinds aligned' :
    score >= 0.55 ? 'above average — market context supportive' :
    score >= 0.45 ? 'neutral — mixed signals' :
    score >= 0.30 ? 'below average — headwinds present' :
                    'weak — significant headwinds';

  const topDrivers = Object.entries(norm)
    .map(([k, v]) => ({ k, c: v * (COMPOSITE_WEIGHTS[k] || 0) }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 3)
    .map(d => d.k);

  return { score: parseFloat(score.toFixed(2)), interpretation, topDrivers };
}

// Individual signal evaluators — each returns true/false
export const SIGNALS = {
  rsi_oversold: (rsi) => rsi < 40 && rsi > 25,
  above_ma50: (price, ma50) => price > ma50 * 0.97,
  volume_spike: (vol, avgVol) => vol > avgVol * 1.4,
  sentiment_ok: (sentiment) => sentiment !== 'negative',
  sector_clear: (sector, currentPositions) =>
    !currentPositions.some(p => p.sector === sector),
};

export const EXIT_RULES = {
  stop_loss: -0.06,
  take_profit_1: 0.12,
  take_profit_2: 0.20,
  max_hold_days: 30,
};

export const BLACKOUT_RULES = {
  high_vix: 30,
  monthly_drawdown: -0.10,
};

/**
 * Evaluates all 5 signals for a candidate and returns a structured result.
 * @param {object} indicators - output of getIndicators()
 * @param {string} sentiment - 'positive' | 'neutral' | 'negative'
 * @param {Array} currentPositions - array of open positions with .sector
 * @returns {{ signalsMet: number, signals: object, signalDetails: string, decision: string }}
 */
/**
 * @param {object} indicators
 * @param {string} sentiment
 * @param {Array}  currentPositions
 * @param {number} rsiUpperBound - Phase 3 regime-aware: 40 (bear) or 60 (bull)
 */
export function evaluateCandidate(indicators, sentiment, currentPositions = [], rsiUpperBound = 40) {
  const { price, rsi, ma50, volume, avgVolume } = indicators;
  const sector = SECTOR_MAP[indicators.symbol] || 'unknown';

  const results = {
    rsi_oversold: rsi > 25 && rsi < rsiUpperBound,
    above_ma50: SIGNALS.above_ma50(price, ma50),
    volume_spike: SIGNALS.volume_spike(volume, avgVolume),
    sentiment_ok: SIGNALS.sentiment_ok(sentiment),
    sector_clear: SIGNALS.sector_clear(sector, currentPositions),
  };

  const signalsMet = Object.values(results).filter(Boolean).length;

  const signalDetails = [
    `Signal 1 (RSI oversold 25-${rsiUpperBound}): ${results.rsi_oversold ? '✓' : '✗'} RSI=${rsi}`,
    `Signal 2 (Price > MA50×0.97): ${results.above_ma50 ? '✓' : '✗'} Price=$${price}, MA50=$${ma50}`,
    `Signal 3 (Volume spike >1.4×): ${results.volume_spike ? '✓' : '✗'} Ratio=${indicators.volumeRatio}x`,
    `Signal 4 (Sentiment not negative): ${results.sentiment_ok ? '✓' : '✗'} ${sentiment}`,
    `Signal 5 (Sector diversification): ${results.sector_clear ? '✓' : '✗'} sector=${sector}`,
  ].join('\n');

  let decision;
  if (signalsMet === 5) decision = 'buy';
  else if (signalsMet >= 3) decision = 'watchlist';
  else decision = 'pass';

  return {
    signalsMet,
    signals: results,
    signalDetails,
    sector,
    sentiment,
    decision,
  };
}

export function calculatePositionSize(accountValue, weeklyBudget, openPositions) {
  const deployable = weeklyBudget * 0.75;
  const maxByPortfolio = accountValue * 0.40;
  return Math.min(
    deployable / Math.max(1, openPositions.length + 1),
    maxByPortfolio
  );
}
