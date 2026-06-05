import { getBars } from './alpaca.js';
import { SECTOR_ETF_MAP, daysToNextFomc, computeCompositeScore } from './signals.js';

export function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50; // neutral fallback

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateMA(closes, period = 50) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

export function calculateAvgVolume(volumes, period = 20) {
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ── Market context (Phase 4) ──────────────────────────────────────────────────

/**
 * Fetch all bars needed for market context once per scan.
 * Returns a map: { SPY: bars[], XLK: bars[], ... }
 * Call this ONCE before the scan loop, not per-symbol.
 */
export async function getMarketBars() {
  const etfs = ['SPY', 'XLK', 'XLF', 'XLV', 'XLP', 'ITA', 'XLE'];
  const results = {};
  await Promise.all(
    etfs.map(async (etf) => {
      try {
        results[etf] = await getBars(etf, '1Day', 250); // 250 for MA200 + 20d trend
      } catch {
        results[etf] = [];
      }
    })
  );
  return results;
}

/**
 * Build full market context from pre-fetched bars + current indicators.
 * Pure function — no I/O. Call once per symbol inside the scan loop.
 *
 * @param {object} marketBars   - output of getMarketBars()
 * @param {string} sector       - sector string from SECTOR_MAP
 * @param {object} indicators   - output of getIndicators()
 * @param {object} symbolBars   - raw bars for the stock (for MA200 + HL)
 * @returns {object} marketContext
 */
export function buildMarketContext(marketBars, sector, indicators, symbolBars) {
  const spyBars    = marketBars['SPY'] || [];
  const sectorEtf  = SECTOR_ETF_MAP[sector] || 'SPY';
  const sectorBars = marketBars[sectorEtf] || spyBars;

  // SPY indicators
  const spyCloses  = spyBars.map(b => b.ClosePrice);
  const spyLatest  = spyBars[spyBars.length - 1];
  const spyPrev5   = spyBars.length >= 6  ? spyBars[spyBars.length - 6]  : spyLatest;
  const spyPrev20  = spyBars.length >= 21 ? spyBars[spyBars.length - 21] : spyLatest;

  const spyRsi      = spyCloses.length >= 15 ? calculateRSI(spyCloses) : 50;
  const spyMa50     = spyCloses.length >= 50 ? calculateMA(spyCloses, 50) : spyLatest?.ClosePrice || 0;
  const spy5dTrend  = spyLatest && spyPrev5  ? ((spyLatest.ClosePrice / spyPrev5.ClosePrice)  - 1) * 100 : 0;
  const spy20dTrend = spyLatest && spyPrev20 ? ((spyLatest.ClosePrice / spyPrev20.ClosePrice) - 1) * 100 : 0;
  const spyVsMa50   = spyLatest && spyMa50   ? ((spyLatest.ClosePrice / spyMa50) - 1) * 100 : 0;

  // Sector indicators
  const secCloses  = sectorBars.map(b => b.ClosePrice);
  const secLatest  = sectorBars[sectorBars.length - 1];
  const secPrev5   = sectorBars.length >= 6 ? sectorBars[sectorBars.length - 6] : secLatest;

  const sectorRsi  = secCloses.length >= 15 ? calculateRSI(secCloses) : 50;
  const sector5d   = secLatest && secPrev5 ? ((secLatest.ClosePrice / secPrev5.ClosePrice) - 1) * 100 : 0;
  // Relative performance: sector 5d vs SPY 5d
  const sectorVsSpy = parseFloat((sector5d - spy5dTrend).toFixed(2));

  // Stock vs MA200
  const stockCloses = symbolBars ? symbolBars.map(b => b.ClosePrice) : [];
  const ma200 = stockCloses.length >= 200 ? calculateMA(stockCloses, 200) : null;
  const pctVsMa200 = ma200 && indicators.price
    ? parseFloat(((indicators.price / ma200 - 1) * 100).toFixed(2))
    : null;

  // HL range (intraday volatility proxy for today)
  const latestBar = symbolBars ? symbolBars[symbolBars.length - 1] : null;
  const hlRange = latestBar
    ? parseFloat(((latestBar.HighPrice - latestBar.LowPrice) / latestBar.ClosePrice * 100).toFixed(2))
    : null;

  // Phase 3 regime classification (best backtest combo: SPY RSI > 60 AND 20d trend > 4%)
  const isBull   = spyRsi > 60 && spy20dTrend > 4.0;
  const regime   = isBull ? 'bull' : 'bear';
  const s1Upper  = isBull ? 60 : 40;   // regime-aware S1 RSI upper bound

  // Phase 2 composite score
  const composite = computeCompositeScore({
    spy20dTrend, spyVsMa50, spyRsi, spy5dTrend,
    sector5d, sectorVsSpy, pctVsMa200: pctVsMa200 ?? 0,
    sectorRsi: parseFloat(sectorRsi.toFixed(1)),
    hlRange: hlRange ?? 1,
    rsi: indicators.rsi,
    pctVsMa50: indicators.priceVsMa50,
    volRatio: indicators.volumeRatio,
  });

  return {
    regime,
    s1Upper,
    spyRsi:       parseFloat(spyRsi.toFixed(1)),
    spy5dTrend:   parseFloat(spy5dTrend.toFixed(2)),
    spy20dTrend:  parseFloat(spy20dTrend.toFixed(2)),
    spyVsMa50:    parseFloat(spyVsMa50.toFixed(2)),
    sectorEtf,
    sectorRsi:    parseFloat(sectorRsi.toFixed(1)),
    sector5d:     parseFloat(sector5d.toFixed(2)),
    sectorVsSpy,
    pctVsMa200,
    hlRange,
    daysToFomc:   daysToNextFomc(),
    composite,
  };
}

export async function getIndicators(symbol) {
  // Fetch 250 bars — enough for MA200 (Phase 4) + MA50 + RSI
  const bars = await getBars(symbol, '1Day', 250);

  if (!bars || bars.length < 20) {
    throw new Error(`Insufficient bar data for ${symbol}: got ${bars?.length ?? 0} bars`);
  }

  const closes = bars.map(b => b.ClosePrice);
  const volumes = bars.map(b => b.Volume);
  const latest = bars[bars.length - 1];

  const rsi = calculateRSI(closes);
  const ma50 = calculateMA(closes, Math.min(50, closes.length));
  const avgVolume = calculateAvgVolume(volumes, 20);

  return {
    symbol,
    price: latest.ClosePrice,
    rsi: parseFloat(rsi.toFixed(2)),
    ma50: parseFloat(ma50.toFixed(2)),
    priceVsMa50: parseFloat(((latest.ClosePrice / ma50 - 1) * 100).toFixed(2)),
    volume: latest.Volume,
    avgVolume: parseFloat(avgVolume.toFixed(0)),
    volumeRatio: parseFloat((latest.Volume / avgVolume).toFixed(2)),
    _bars: bars, // raw bars for buildMarketContext (MA200, HL)
  };
}
