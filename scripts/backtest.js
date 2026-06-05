/**
 * scripts/backtest.js
 * Autonomous backtest module — callable programmatically by rule-adjustment system.
 *
 * Usage:
 *   node scripts/backtest.js                    # full run, saves to Supabase
 *   node scripts/backtest.js --dry-run          # console only, no Supabase write
 *
 * Programmatic:
 *   const { runBacktest } = require('./backtest');
 *   const results = await runBacktest(rules, tickers, startDate, endDate);
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

const https = require('https');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ── Alpaca REST helper ────────────────────────────────────────────────────────
function alpacaGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'data.alpaca.markets',
      path,
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
      },
    };
    let data = '';
    const req = https.get(options, res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${path}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
  });
}

async function fetchBars(symbol, startDate, endDate) {
  const allBars = [];
  let pageToken = null;

  do {
    const start = startDate.toISOString().split('T')[0];
    const end   = endDate.toISOString().split('T')[0];
    let url = `/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&end=${end}&limit=1000&feed=iex`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;

    await new Promise(r => setTimeout(r, 80)); // gentle rate limit
    const data = await alpacaGet(url);
    if (data.bars) allBars.push(...data.bars);
    pageToken = data.next_page_token || null;
  } while (pageToken);

  return allBars.map(b => ({
    date:   b.t.split('T')[0],
    open:   b.o,
    high:   b.h,
    low:    b.l,
    close:  b.c,
    volume: b.v,
  }));
}

// ── Indicators (no lookahead — only use data up to index i) ──────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcAvgVol(volumes, period = 20) {
  if (volumes.length < period) return null;
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ── FOMC dates (hardcoded public calendar) ────────────────────────────────────
const FOMC_DATES = [
  '2024-01-31','2024-03-20','2024-05-01','2024-06-12',
  '2024-07-31','2024-09-18','2024-11-07','2024-12-18',
  '2025-01-29','2025-03-19','2025-05-07','2025-06-18',
  '2025-07-30','2025-09-17','2025-11-05','2025-12-17',
  '2026-01-28','2026-03-18','2026-05-06','2026-06-17',
  '2026-07-29','2026-09-16',
].map(d => new Date(d));

function isFomcWeek(date) {
  const d = new Date(date);
  const mon = new Date(d); mon.setDate(d.getDate() - d.getDay() + 1);
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  return FOMC_DATES.some(fd => fd >= mon && fd <= fri);
}

// ── Sector map ────────────────────────────────────────────────────────────────
const SECTOR_MAP = {
  NVDA:'tech', MSFT:'tech', META:'tech', GOOGL:'tech',
  AAPL:'tech', AMZN:'tech', AMD:'tech',  TSM:'tech',
  'BRK.B':'finance', JPM:'finance', V:'finance',
  LLY:'healthcare', UNH:'healthcare',
  COST:'consumer',
  LMT:'defense', RTX:'defense', NOC:'defense', GD:'defense',
  XOM:'energy', CVX:'energy', COP:'energy', SLB:'energy',
  QQQ:'etf', SPY:'etf', XLK:'etf',
};

// ── Core backtest engine ──────────────────────────────────────────────────────
/**
 * @param {object} rules         - signal thresholds to test
 * @param {string[]} tickers     - list of symbols
 * @param {Date} startDate
 * @param {Date} endDate
 * @param {object} [opts]
 * @returns {object} structured results
 */
async function runBacktest(rules, tickers, startDate, endDate, opts = {}) {
  const {
    rsi_lower          = 25,
    rsi_upper          = 40,
    bull_rsi_upper     = null,
    volume_multiplier  = 1.4,
    signals_required   = 5,
    stop_loss_pct      = 0.06,
    take_profit_pct    = 0.12,
    max_positions      = 4,
    max_hold_days      = 20,
  } = rules;

  const label = opts.label || `bt_${Date.now()}`;
  const includeRsiCeilingAnalysis = opts.includeRsiCeilingAnalysis !== false;
  const prefetchedData = opts.prefetchedData || null;

  // Fetch all data upfront
  let allData = prefetchedData?.allData;
  let spyData = prefetchedData?.spyData;
  const fetchStart = prefetchedData?.fetchStart || new Date(startDate);

  if (!prefetchedData) {
    process.stdout.write(`  Fetching data for ${tickers.length} symbols`);
    allData = {};
    fetchStart.setDate(fetchStart.getDate() - 120); // extra history for indicators

    for (const ticker of tickers) {
      try {
        allData[ticker] = await fetchBars(ticker, fetchStart, endDate);
        process.stdout.write('.');
      } catch (e) {
        process.stdout.write('x');
      }
    }
    console.log(` done (${Object.keys(allData).length}/${tickers.length})`);
  }

  // Fetch SPY for regime classification
  spyData = spyData || allData['SPY'] || [];
  if (!spyData.length && !tickers.includes('SPY')) {
    try { spyData = await fetchBars('SPY', fetchStart, endDate); } catch {}
  }

  // Build SPY RSI index by date
  const spyRsiByDate = {};
  for (let i = 14; i < spyData.length; i++) {
    const closes = spyData.slice(0, i + 1).map(b => b.close);
    spyRsiByDate[spyData[i].date] = calcRSI(closes);
  }

  // All trading dates in range
  const allDates = [...new Set(
    Object.values(allData).flatMap(bars => bars.map(b => b.date))
  )].filter(d => d >= startDate.toISOString().split('T')[0])
    .sort();

  // Simulation state
  let cash = 100_000;
  const openPositions = {};   // ticker → { entryDate, entryPrice, shares, sector, stop, take }
  const closedTrades = [];
  const weeklyDeployed = {};

  function weekKey(dateStr) {
    const d = new Date(dateStr);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week}`;
  }

  // Per-signal fire counters (ignore sector signal for fire-rate analysis)
  const signalFired = { s1_rsi: 0, s2_ma50: 0, s3_volume: 0, total_evaluated: 0 };
  const signalBottleneck = { only_s1_blocking: 0 };

  // Regime breakdown
  const regimeStats = {
    bull:    { trades: 0, wins: 0, pnls: [] },
    neutral: { trades: 0, wins: 0, pnls: [] },
    bear:    { trades: 0, wins: 0, pnls: [] },
  };

  const WEEKLY_DEPLOYABLE = 6250 * 0.75;

  for (let di = 0; di < allDates.length; di++) {
    const today = allDates[di];
    const todayDate = new Date(today);

    // Check exits
    for (const [ticker, pos] of Object.entries({ ...openPositions })) {
      if (!allData[ticker]) continue;
      const bar = allData[ticker].find(b => b.date === today);
      if (!bar) continue;
      const daysHeld = allDates.slice(0, di + 1).filter(d => d >= pos.entryDate).length;
      let exitReason = null;
      let exitPrice  = bar.close;

      if (bar.low <= pos.stop)            { exitReason = 'stop_loss';   exitPrice = pos.stop; }
      else if (bar.high >= pos.take)       { exitReason = 'take_profit'; exitPrice = pos.take; }
      else if (daysHeld >= max_hold_days)  { exitReason = 'time_exit';  exitPrice = bar.close; }

      if (exitReason) {
        const pnlPct = (exitPrice / pos.entryPrice) - 1;
        const pnl    = pos.shares * pos.entryPrice * pnlPct;
        cash += pos.shares * exitPrice;
        closedTrades.push({
          ticker, entryDate: pos.entryDate, exitDate: today,
          entryPrice: pos.entryPrice, exitPrice,
          pnlPct, pnl, exitReason, daysHeld, regime: pos.regime,
        });
        delete openPositions[ticker];

        // Regime tracking
        if (regimeStats[pos.regime]) {
          regimeStats[pos.regime].trades++;
          regimeStats[pos.regime].pnls.push(pnlPct);
          if (pnlPct > 0) regimeStats[pos.regime].wins++;
        }
      }
    }

    if (isFomcWeek(todayDate)) continue;
    if (Object.keys(openPositions).length >= max_positions) continue;

    const wk = weekKey(today);
    if ((weeklyDeployed[wk] || 0) >= WEEKLY_DEPLOYABLE) continue;

    const spyRsi = spyRsiByDate[today] || 50;
    const regime = spyRsi > 60 ? 'bull' : spyRsi < 40 ? 'bear' : 'neutral';
    const openSectors = new Set(Object.values(openPositions).map(p => p.sector));

    for (const ticker of tickers) {
      if (openPositions[ticker]) continue;
      if (!allData[ticker]) continue;

      const barIdx = allData[ticker].findIndex(b => b.date === today);
      if (barIdx < 50) continue;

      const barsUpToToday = allData[ticker].slice(0, barIdx + 1);
      const closes  = barsUpToToday.map(b => b.close);
      const volumes = barsUpToToday.map(b => b.volume);

      const rsi      = calcRSI(closes);
      const ma50     = calcMA(closes, 50);
      const avgVol   = calcAvgVol(volumes, 20);
      const todayBar = barsUpToToday[barsUpToToday.length - 1];

      if (rsi === null || ma50 === null || avgVol === null) continue;

      signalFired.total_evaluated++;
      const activeRsiUpper = regime === 'bull' && bull_rsi_upper != null
        ? bull_rsi_upper
        : rsi_upper;
      const s1 = rsi > rsi_lower && rsi < activeRsiUpper;
      const s2 = todayBar.close > ma50 * 0.97;
      const s3 = todayBar.volume > avgVol * volume_multiplier;
      const s4 = true; // sentiment always passes in backtest
      const s5 = !openSectors.has(SECTOR_MAP[ticker] || 'unknown');

      if (s1) signalFired.s1_rsi++;
      if (s2) signalFired.s2_ma50++;
      if (s3) signalFired.s3_volume++;

      // Bottleneck analysis
      if (s2 && s3 && s4 && !s1) signalBottleneck.only_s1_blocking++;

      const nMet = [s1, s2, s3, s4, s5].filter(Boolean).length;
      if (nMet < signals_required) continue;

      // Find next trading day for entry
      const nextDayIdx = allDates.indexOf(today) + 1;
      if (nextDayIdx >= allDates.length) continue;
      const nextDay = allDates[nextDayIdx];
      const nextBar = allData[ticker]?.find(b => b.date === nextDay);
      if (!nextBar) continue;

      const entryPrice = nextBar.open;
      const sector     = SECTOR_MAP[ticker] || 'unknown';
      if (openSectors.has(sector)) continue;
      if (Object.keys(openPositions).length >= max_positions) break;

      const budgetLeft = WEEKLY_DEPLOYABLE - (weeklyDeployed[wk] || 0);
      const notional   = Math.min(
        budgetLeft,
        cash * max_positions > 0 ? cash / max_positions : cash,
      );
      const shares = Math.floor(notional / entryPrice);
      if (shares < 1) continue;

      const cost = shares * entryPrice;
      cash -= cost;
      weeklyDeployed[wk] = (weeklyDeployed[wk] || 0) + cost;
      openSectors.add(sector);

      openPositions[ticker] = {
        entryDate: nextDay, entryPrice, shares, sector,
        stop:  entryPrice * (1 - stop_loss_pct),
        take:  entryPrice * (1 + take_profit_pct),
        regime,
      };
    }
  }

  // Close any remaining positions at last price
  for (const [ticker, pos] of Object.entries(openPositions)) {
    const lastBar = allData[ticker]?.[allData[ticker].length - 1];
    if (!lastBar) continue;
    const pnlPct = (lastBar.close / pos.entryPrice) - 1;
    closedTrades.push({
      ticker, entryDate: pos.entryDate, exitDate: lastBar.date,
      entryPrice: pos.entryPrice, exitPrice: lastBar.close,
      pnlPct, pnl: pos.shares * pos.entryPrice * pnlPct,
      exitReason: 'time_exit', daysHeld: max_hold_days, regime: pos.regime,
    });
    if (regimeStats[pos.regime]) {
      regimeStats[pos.regime].trades++;
      regimeStats[pos.regime].pnls.push(pnlPct);
      if (pnlPct > 0) regimeStats[pos.regime].wins++;
    }
  }

  // ── Compute metrics ───────────────────────────────────────────────────────
  const n      = closedTrades.length;
  const wins   = closedTrades.filter(t => t.pnlPct > 0);
  const losses = closedTrades.filter(t => t.pnlPct <= 0);
  const winRate  = n > 0 ? wins.length / n : 0;
  const avgWin   = wins.length   ? wins.reduce((s, t) => s + t.pnlPct, 0)   / wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const ev       = winRate * avgWin + (1 - winRate) * avgLoss;
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);

  // Equity curve & drawdown
  let equity = 100_000;
  let peak   = equity;
  let maxDD   = 0;
  const equityCurve = [{ date: allDates[0], equity }];
  for (const t of closedTrades.sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    equityCurve.push({ date: t.exitDate, equity });
  }
  const totalReturn = (equity - 100_000) / 100_000;

  // Sharpe
  const rets   = closedTrades.map(t => t.pnlPct);
  const mean   = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const stddev = rets.length > 1
    ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1))
    : 0;
  const sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252 / Math.max(1, max_hold_days)) : 0;

  const rsiCeilingResults = {};
  if (includeRsiCeilingAnalysis) {
    for (const ceil of [40, 43, 45, 47, 50, 55]) {
      const ceilingRun = await runBacktest(
        { ...rules, rsi_upper: 40, bull_rsi_upper: ceil },
        tickers,
        startDate,
        endDate,
        {
          label: `${label}_rsi_ceiling_${ceil}`,
          includeRsiCeilingAnalysis: false,
          prefetchedData: { allData, spyData, fetchStart },
        }
      );
      const bullTrades = ceilingRun.tradeLog.filter(t => t.regime === 'bull');
      const winsForCeiling = bullTrades.filter(t => t.pnlPct > 0);
      rsiCeilingResults[ceil] = {
        trades: bullTrades.length,
        wins: winsForCeiling.length,
        winRate: bullTrades.length > 0 ? winsForCeiling.length / bullTrades.length : 0,
        ev: bullTrades.length > 0
          ? bullTrades.reduce((sum, t) => sum + t.pnlPct, 0) / bullTrades.length
          : 0,
      };
    }
  }

  // Regime stats
  const regimeBreakdown = {};
  for (const [r, s] of Object.entries(regimeStats)) {
    regimeBreakdown[r] = {
      trades:  s.trades,
      winRate: s.trades > 0 ? s.wins / s.trades : 0,
      avgReturn: s.pnls.length > 0 ? s.pnls.reduce((a, b) => a + b, 0) / s.pnls.length : 0,
    };
  }

  // Signal breakdown
  const total = signalFired.total_evaluated;
  const signalBreakdown = {
    s1_rsi:          { fireRate: total > 0 ? signalFired.s1_rsi / total : 0,   count: signalFired.s1_rsi },
    s2_ma50:         { fireRate: total > 0 ? signalFired.s2_ma50 / total : 0,  count: signalFired.s2_ma50 },
    s3_volume:       { fireRate: total > 0 ? signalFired.s3_volume / total : 0, count: signalFired.s3_volume },
    s4_sentiment:    { fireRate: 1.0, count: total },
    bottleneck_days: signalBottleneck.only_s1_blocking,
    bottleneck_pct:  total > 0 ? signalBottleneck.only_s1_blocking / total : 0,
  };

  const results = {
    label, rules,
    startDate: startDate.toISOString().split('T')[0],
    endDate:   endDate.toISOString().split('T')[0],
    nTrades:      n,
    winRate:      parseFloat(winRate.toFixed(4)),
    avgWin:       parseFloat(avgWin.toFixed(4)),
    avgLoss:      parseFloat(avgLoss.toFixed(4)),
    expectedValue: parseFloat(ev.toFixed(4)),
    maxDrawdown:  parseFloat(maxDD.toFixed(4)),
    sharpe:       parseFloat(sharpe.toFixed(3)),
    totalReturn:  parseFloat(totalReturn.toFixed(4)),
    equityCurve,
    tradeLog:     closedTrades,
    signalBreakdown,
    regimeBreakdown,
    rsiCeilingAnalysis: rsiCeilingResults,
  };

  return results;
}

// ── Report printer ────────────────────────────────────────────────────────────
function printReport(r, title) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
  if (r.nTrades === 0) {
    console.log('  No trades triggered.');
    return;
  }
  console.log(`  Trades       : ${r.nTrades}`);
  console.log(`  Win rate     : ${(r.winRate * 100).toFixed(1)}%`);
  console.log(`  Avg win      : +${(r.avgWin * 100).toFixed(2)}%`);
  console.log(`  Avg loss     : ${(r.avgLoss * 100).toFixed(2)}%`);
  console.log(`  EV per trade : ${(r.expectedValue * 100).toFixed(2)}%`);
  console.log(`  Total return : ${(r.totalReturn * 100).toFixed(1)}%  ($${(r.totalReturn * 100000).toFixed(0)})`);
  console.log(`  Sharpe       : ${r.sharpe.toFixed(2)}`);
  console.log(`  Max drawdown : ${(r.maxDrawdown * 100).toFixed(1)}%`);

  console.log(`\n  Exit reasons:`);
  const exits = {};
  r.tradeLog.forEach(t => exits[t.exitReason] = (exits[t.exitReason] || 0) + 1);
  Object.entries(exits).sort((a,b) => b[1]-a[1]).forEach(([k, v]) =>
    console.log(`    ${k.padEnd(14)} ${v}  (${(v/r.nTrades*100).toFixed(0)}%)`)
  );

  console.log(`\n  Signal breakdown (symbol-days evaluated: ${r.signalBreakdown.s1_rsi.count + r.signalBreakdown.bottleneck_days}):`);
  console.log(`    S1 RSI ${r.rules.rsi_lower}-${r.rules.rsi_upper}  fires ${(r.signalBreakdown.s1_rsi.fireRate*100).toFixed(1)}%  (${r.signalBreakdown.s1_rsi.count} days)`);
  console.log(`    S2 MA50        fires ${(r.signalBreakdown.s2_ma50.fireRate*100).toFixed(1)}%  (${r.signalBreakdown.s2_ma50.count} days)`);
  console.log(`    S3 Volume      fires ${(r.signalBreakdown.s3_volume.fireRate*100).toFixed(1)}%  (${r.signalBreakdown.s3_volume.count} days)`);
  console.log(`    S1 sole blocker: ${r.signalBreakdown.bottleneck_days} days (${(r.signalBreakdown.bottleneck_pct*100).toFixed(1)}%) where S2+S3 pass but S1 blocks`);

  console.log(`\n  Regime breakdown:`);
  for (const [regime, s] of Object.entries(r.regimeBreakdown)) {
    if (s.trades > 0)
      console.log(`    ${regime.padEnd(8)} ${s.trades} trades  win=${(s.winRate*100).toFixed(1)}%  avgReturn=${(s.avgReturn*100).toFixed(2)}%`);
  }

  if (r.rsiCeilingAnalysis) {
    console.log(`\n  RSI ceiling analysis (bull regime trades):`);
    console.log(`    Ceiling  Trades  WinRate  EV`);
    for (const [ceil, s] of Object.entries(r.rsiCeilingAnalysis)) {
      if (ceil === r.rules.rsi_upper.toString()) process.stdout.write('  → ');
      else process.stdout.write('    ');
      console.log(`RSI<${ceil.toString().padEnd(3)} ${String(s.trades).padStart(6)}  ${(s.winRate*100).toFixed(1)}%    ${(s.ev*100).toFixed(2)}%`);
    }
  }

  console.log(`\n  Trades:`);
  console.log(`  ${'Symbol'.padEnd(8)} ${'Entry'.padStart(10)} ${'Exit'.padStart(10)} ${'Hold'.padStart(5)} ${'P&L%'.padStart(8)} ${'Reason'.padEnd(14)} Regime`);
  r.tradeLog.sort((a,b) => a.entryDate.localeCompare(b.entryDate)).forEach(t =>
    console.log(`  ${t.ticker.padEnd(8)} ${t.entryDate.padStart(10)} ${t.exitDate.padStart(10)} ${String(t.daysHeld).padStart(4)}d ${(t.pnlPct*100).toFixed(2).padStart(7)}% ${t.exitReason.padEnd(14)} ${t.regime}`)
  );
}

// ── Save to Supabase ──────────────────────────────────────────────────────────
async function saveToSupabase(r) {
  const { error } = await supabase.from('backtest_results').insert({
    label:            r.label,
    rules:            r.rules,
    start_date:       r.startDate,
    end_date:         r.endDate,
    n_trades:         r.nTrades,
    win_rate:         r.winRate,
    avg_win:          r.avgWin,
    avg_loss:         r.avgLoss,
    expected_value:   r.expectedValue,
    max_drawdown:     r.maxDrawdown,
    sharpe:           r.sharpe,
    total_return:     r.totalReturn,
    equity_curve:     r.equityCurve,
    trade_log:        r.tradeLog,
    signal_breakdown: r.signalBreakdown,
    regime_breakdown: r.regimeBreakdown,
    rsi_ceiling_analysis: r.rsiCeilingAnalysis,
  });
  if (error) console.error('  Supabase save error:', error.message);
  else console.log('  ✓ Saved to backtest_results');
}

// ── CLI entry point ───────────────────────────────────────────────────────────
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const endDate   = new Date();
  const startDate = new Date(endDate);
  startDate.setFullYear(startDate.getFullYear() - 2);

  const TICKERS = [
    'NVDA','MSFT','META','GOOGL','AAPL','AMZN','AMD','TSM',
    'BRK.B','LLY','JPM','COST','UNH','V',
    'LMT','RTX','NOC','GD',
    'XOM','CVX','COP','SLB',
    'QQQ','SPY','XLK',
  ];

  const BASE_RULES = {
    stop_loss_pct: 0.06, take_profit_pct: 0.12,
    max_positions: 4, max_hold_days: 20,
    volume_multiplier: 1.4,
  };

  console.log('\n' + '═'.repeat(60));
  console.log('  QUANT AGENT — PHASE 2 BACKTEST');
  console.log(`  Period : ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log('═'.repeat(60));

  // Run 1: 5/5 threshold (current production)
  console.log('\n[1/3] Running 5/5 threshold (current system)...');
  const r55 = await runBacktest(
    { ...BASE_RULES, rsi_lower: 25, rsi_upper: 40, signals_required: 5 },
    TICKERS, startDate, endDate, { label: '5/5_rsi25-40' }
  );
  printReport(r55, '5/5 THRESHOLD — RSI 25-40 (CURRENT SYSTEM)');
  if (!isDryRun) await saveToSupabase(r55);

  // Run 2: 4/5 threshold
  console.log('\n[2/3] Running 4/5 threshold...');
  const r45 = await runBacktest(
    { ...BASE_RULES, rsi_lower: 25, rsi_upper: 40, signals_required: 4 },
    TICKERS, startDate, endDate, { label: '4/5_rsi25-40' }
  );
  printReport(r45, '4/5 THRESHOLD — RSI 25-40');
  if (!isDryRun) await saveToSupabase(r45);

  // Run 3: 4/5 + widened RSI ceiling (regime-aware) — Phase 3 winner from prior backtest
  console.log('\n[3/3] Running 4/5 + bull-regime RSI<60 (Phase 3 best combo)...');
  const r45regime = await runBacktest(
    { ...BASE_RULES, rsi_lower: 25, rsi_upper: 40, bull_rsi_upper: 60, signals_required: 4 },
    TICKERS, startDate, endDate, { label: '4/5_bull-regime-rsi60' }
  );
  printReport(r45regime, '4/5 + REGIME-AWARE RSI<60');
  if (!isDryRun) await saveToSupabase(r45regime);

  // ── Side-by-side comparison ─────────────────────────────────────────────
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log('  SIDE-BY-SIDE COMPARISON');
  console.log(line);
  console.log(`  ${'Label'.padEnd(30)} ${'Trades'.padStart(7)} ${'WinRate'.padStart(8)} ${'EV%'.padStart(7)} ${'Sharpe'.padStart(7)} ${'MaxDD'.padStart(7)}`);
  console.log(`  ${'─'.repeat(30)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)}`);
  for (const [label, r] of [['5/5  RSI 25-40 (current)', r55], ['4/5  RSI 25-40', r45], ['4/5  Bull RSI<60 (regime)', r45regime]]) {
    console.log(
      `  ${label.padEnd(30)} ${String(r.nTrades).padStart(7)} ` +
      `${(r.winRate*100).toFixed(1).padStart(7)}% ` +
      `${(r.expectedValue*100).toFixed(2).padStart(7)}% ` +
      `${r.sharpe.toFixed(2).padStart(7)} ` +
      `${(r.maxDrawdown*100).toFixed(1).padStart(6)}%`
    );
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  PHASE 2 COMPLETE');
  console.log(`${'═'.repeat(60)}\n`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runBacktest };
