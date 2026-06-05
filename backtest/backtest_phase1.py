#!/usr/bin/env python3
"""
Phase 1 Backtest — Quant Agent Signal Analysis
2 years of daily OHLCV via Alpaca, replay 5 current signal rules.
No production files are modified.
"""

import os, sys, time, math, json, warnings
from datetime import date, timedelta, datetime
from collections import defaultdict

import warnings; warnings.filterwarnings("ignore")
import requests
import pandas as pd
import numpy as np

# ── Credentials ─────────────────────────────────────────────────────────────
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
env = {}
with open(ENV_PATH) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, _, v = line.partition('=')
            env[k.strip()] = v.strip()

ALPACA_KEY    = env['ALPACA_API_KEY']
ALPACA_SECRET = env['ALPACA_SECRET_KEY']
DATA_BASE     = 'https://data.alpaca.markets/v2'
HEADERS       = {'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET}

# ── Universe & sector map (mirrors lib/signals.js) ───────────────────────────
SYMBOLS = ['NVDA','MSFT','META','GOOGL','AAPL','AMZN','AMD','TSM',
           'BRK.B','LLY','JPM','COST','UNH','V',
           'LMT','RTX','NOC','GD',
           'XOM','CVX','COP','SLB',
           'QQQ','SPY','XLK']

SECTOR_MAP = {
    'NVDA':'tech','MSFT':'tech','META':'tech','GOOGL':'tech',
    'AAPL':'tech','AMZN':'tech','AMD':'tech','TSM':'tech',
    'BRK.B':'finance','LLY':'healthcare','JPM':'finance',
    'COST':'consumer','UNH':'healthcare','V':'finance',
    'LMT':'defense','RTX':'defense','NOC':'defense','GD':'defense',
    'XOM':'energy','CVX':'energy','COP':'energy','SLB':'energy',
    'QQQ':'etf','SPY':'etf','XLK':'etf',
}

# ── Risk config (mirrors system_config) ─────────────────────────────────────
STOP_LOSS_PCT    = 0.06
TAKE_PROFIT_PCT  = 0.12
MAX_POSITIONS    = 4
MAX_HOLD_DAYS    = 30
WEEKLY_BUDGET    = 6250
DRY_POWDER_PCT   = 0.25
DEPLOYABLE_PCT   = 1 - DRY_POWDER_PCT   # 75%

# ── FOMC meeting dates 2024-2026 (public calendar) ───────────────────────────
FOMC_DATES = {
    date(2024,1,31), date(2024,3,20), date(2024,5,1),  date(2024,6,12),
    date(2024,7,31), date(2024,9,18), date(2024,11,7), date(2024,12,18),
    date(2025,1,29), date(2025,3,19), date(2025,5,7),  date(2025,6,18),
    date(2025,7,30), date(2025,9,17), date(2025,11,5), date(2025,12,17),
    date(2026,1,28), date(2026,3,18), date(2026,5,6),  date(2026,6,17),
}

def is_fomc_week(d: date) -> bool:
    """True if d falls in any calendar week containing an FOMC meeting."""
    week_start = d - timedelta(days=d.weekday())
    week_end   = week_start + timedelta(days=4)
    return any(week_start <= fd <= week_end for fd in FOMC_DATES)

# ── Data fetching ─────────────────────────────────────────────────────────────
def fetch_bars(symbol: str, start: str, end: str) -> pd.DataFrame:
    """Fetch daily OHLCV from Alpaca and return as DataFrame indexed by date."""
    url = f"{DATA_BASE}/stocks/{symbol}/bars"
    bars, token = [], None
    while True:
        params = {'timeframe':'1Day','start':start,'end':end,'limit':1000}
        if token:
            params['page_token'] = token
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(2); continue
        r.raise_for_status()
        data = r.json()
        bars.extend(data.get('bars') or [])
        token = data.get('next_page_token')
        if not token:
            break
    if not bars:
        return pd.DataFrame()
    df = pd.DataFrame(bars)
    df['date'] = pd.to_datetime(df['t']).dt.date
    df = df.rename(columns={'o':'open','h':'high','l':'low','c':'close','v':'volume'})
    df = df[['date','open','high','low','close','volume']].set_index('date').sort_index()
    return df

# ── Indicators (mirrors lib/indicators.js) ────────────────────────────────────
def calc_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    delta = closes.diff()
    gain  = delta.clip(lower=0)
    loss  = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['rsi']        = calc_rsi(df['close'])
    df['ma50']       = df['close'].rolling(50).mean()
    df['avg_vol_20'] = df['volume'].rolling(20).mean()
    df['vol_ratio']  = df['volume'] / df['avg_vol_20']
    df['pct_vs_ma50']= (df['close'] / df['ma50'] - 1) * 100
    return df

# ── Signal evaluation ─────────────────────────────────────────────────────────
def eval_signals(row, open_sector_set: set) -> dict:
    """
    Returns dict of signal booleans.
    Signal 4 (sentiment) = always True in backtest — no historical sentiment data.
    """
    sector = SECTOR_MAP.get(row.name[1] if hasattr(row.name,'__len__') else '', 'unknown')
    return {
        's1_rsi':       bool(25 < row['rsi'] < 40),
        's2_ma50':      bool(row['close'] > row['ma50'] * 0.97),
        's3_volume':    bool(row['vol_ratio'] > 1.4),
        's4_sentiment': True,   # always pass — no historical data
        's5_sector':    sector not in open_sector_set,
    }

# ── Main backtest ─────────────────────────────────────────────────────────────
def run_backtest(threshold: int, data: dict) -> dict:
    """
    Simulate the strategy at a given signal threshold (3, 4, or 5).
    Returns dict with trade list and equity curve.
    """
    # Collect all trading days
    all_dates = sorted(set(d for df in data.values() for d in df.index))

    cash             = 100_000.0
    equity_curve     = []
    open_positions   = {}   # symbol → {entry_date, entry_price, shares, sector, stop, take}
    closed_trades    = []
    weekly_deployed  = defaultdict(float)

    def week_key(d): return (d.year, d.isocalendar()[1])

    for i, today in enumerate(all_dates):
        if i < 50:   # need enough history for MA50
            equity_curve.append({'date': today, 'equity': cash})
            continue

        # ── Close positions that hit stop/take/max-hold ──────────────────
        positions_to_close = []
        for sym, pos in open_positions.items():
            if sym not in data or today not in data[sym].index:
                continue
            row  = data[sym].loc[today]
            days = (today - pos['entry_date']).days
            pnl_pct = (row['close'] / pos['entry_price']) - 1

            exit_reason = None
            exit_price  = row['close']

            if row['low'] <= pos['stop']:
                exit_reason, exit_price = 'stop_loss', pos['stop']
            elif row['high'] >= pos['take']:
                exit_reason, exit_price = 'take_profit', pos['take']
            elif days >= MAX_HOLD_DAYS:
                exit_reason, exit_price = 'max_hold', row['close']

            if exit_reason:
                pnl_pct = (exit_price / pos['entry_price']) - 1
                pnl     = pos['shares'] * pos['entry_price'] * pnl_pct
                cash   += pos['shares'] * exit_price
                closed_trades.append({
                    'symbol':       sym,
                    'entry_date':   pos['entry_date'],
                    'exit_date':    today,
                    'entry_price':  pos['entry_price'],
                    'exit_price':   exit_price,
                    'pnl_pct':      pnl_pct,
                    'pnl':          pnl,
                    'exit_reason':  exit_reason,
                    'hold_days':    days,
                })
                positions_to_close.append(sym)

        for sym in positions_to_close:
            del open_positions[sym]

        open_sector_set = {p['sector'] for p in open_positions.values()}

        # ── Scan for entries ─────────────────────────────────────────────
        if not is_fomc_week(today) and len(open_positions) < MAX_POSITIONS:
            wk  = week_key(today)
            budget_left = WEEKLY_BUDGET * DEPLOYABLE_PCT - weekly_deployed[wk]

            candidates = []
            for sym in SYMBOLS:
                if sym in open_positions:
                    continue
                if sym not in data or today not in data[sym].index:
                    continue
                row = data[sym].loc[today]
                if pd.isna(row['rsi']) or pd.isna(row['ma50']):
                    continue
                sigs = eval_signals(row, open_sector_set)
                n_met = sum(sigs.values())
                if n_met >= threshold:
                    candidates.append((sym, row, sigs, n_met))

            # Sort by most signals first, then RSI (lower = more oversold)
            candidates.sort(key=lambda x: (-x[3], x[1]['rsi']))

            for sym, row, sigs, n_met in candidates:
                if len(open_positions) >= MAX_POSITIONS:
                    break
                sector = SECTOR_MAP.get(sym, 'unknown')
                if sector in {p['sector'] for p in open_positions.values()}:
                    continue
                if budget_left < 100:
                    continue

                # Entry at tomorrow's open (if available)
                future_dates = [d for d in all_dates if d > today]
                if not future_dates:
                    continue
                next_day = future_dates[0]
                if sym not in data or next_day not in data[sym].index:
                    continue

                entry_price = data[sym].loc[next_day]['open']
                if pd.isna(entry_price) or entry_price <= 0:
                    continue

                notional = min(
                    budget_left,
                    cash * 0.40,       # max 40% of portfolio
                    WEEKLY_BUDGET * DEPLOYABLE_PCT / max(1, MAX_POSITIONS - len(open_positions))
                )
                shares = math.floor(notional / entry_price)
                if shares < 1:
                    continue

                cost = shares * entry_price
                cash -= cost
                weekly_deployed[week_key(next_day)] += cost
                open_sector_set.add(sector)

                open_positions[sym] = {
                    'entry_date':  next_day,
                    'entry_price': entry_price,
                    'shares':      shares,
                    'sector':      sector,
                    'stop':        entry_price * (1 - STOP_LOSS_PCT),
                    'take':        entry_price * (1 + TAKE_PROFIT_PCT),
                    'signals_met': n_met,
                }

        # ── Mark-to-market equity ────────────────────────────────────────
        mkt_value = sum(
            pos['shares'] * data[sym].loc[today]['close']
            for sym, pos in open_positions.items()
            if sym in data and today in data[sym].index
        )
        equity_curve.append({'date': today, 'equity': cash + mkt_value})

    # Close any remaining open positions at last close
    for sym, pos in open_positions.items():
        last_day = [d for d in all_dates if sym in data and d in data[sym].index]
        if not last_day:
            continue
        last_day = last_day[-1]
        exit_price = data[sym].loc[last_day]['close']
        pnl_pct = (exit_price / pos['entry_price']) - 1
        pnl     = pos['shares'] * pos['entry_price'] * pnl_pct
        cash   += pos['shares'] * exit_price
        closed_trades.append({
            'symbol':      sym,
            'entry_date':  pos['entry_date'],
            'exit_date':   last_day,
            'entry_price': pos['entry_price'],
            'exit_price':  exit_price,
            'pnl_pct':     pnl_pct,
            'pnl':         pnl,
            'exit_reason': 'end_of_period',
            'hold_days':   (last_day - pos['entry_date']).days,
        })

    return {
        'trades':       closed_trades,
        'equity_curve': equity_curve,
    }

# ── Metrics ───────────────────────────────────────────────────────────────────
def calc_metrics(result: dict, label: str) -> dict:
    trades = result['trades']
    curve  = pd.DataFrame(result['equity_curve']).set_index('date')['equity']

    n = len(trades)
    if n == 0:
        return {'label': label, 'n_trades': 0}

    wins   = [t for t in trades if t['pnl_pct'] > 0]
    losses = [t for t in trades if t['pnl_pct'] <= 0]

    win_rate  = len(wins)  / n
    avg_win   = np.mean([t['pnl_pct'] for t in wins])   if wins   else 0
    avg_loss  = np.mean([t['pnl_pct'] for t in losses]) if losses else 0
    ev        = win_rate * avg_win + (1 - win_rate) * avg_loss

    # Sharpe (annualised daily returns)
    daily_ret = curve.pct_change().dropna()
    sharpe    = (daily_ret.mean() / daily_ret.std() * math.sqrt(252)) if daily_ret.std() > 0 else 0

    # Max drawdown
    roll_max  = curve.cummax()
    drawdown  = (curve - roll_max) / roll_max
    max_dd    = drawdown.min()

    total_ret = (curve.iloc[-1] / curve.iloc[0] - 1) if len(curve) > 1 else 0

    # Exit reason breakdown
    exits = defaultdict(int)
    for t in trades:
        exits[t['exit_reason']] += 1

    return {
        'label':      label,
        'n_trades':   n,
        'win_rate':   win_rate,
        'avg_win':    avg_win,
        'avg_loss':   avg_loss,
        'ev_per_trade': ev,
        'total_return': total_ret,
        'sharpe':     sharpe,
        'max_drawdown': max_dd,
        'exit_reasons': dict(exits),
        'final_equity': curve.iloc[-1] if len(curve) else 100_000,
        'trades_detail': trades,
    }

# ── Per-signal fire rate analysis ─────────────────────────────────────────────
def signal_fire_analysis(data: dict):
    """
    For each symbol × day, evaluate signals 1–4 independently.
    Signal 5 (sector) is portfolio-state-dependent so reported separately.
    """
    all_dates = sorted(set(d for df in data.values() for d in df.index))

    counts = {'s1_rsi': 0, 's2_ma50': 0, 's3_volume': 0, 's4_sentiment': 0}
    total  = 0
    s1_only_misses = 0   # days where all OTHER signals pass but s1 blocks
    combos_45 = defaultdict(int)

    for today in all_dates:
        for sym in SYMBOLS:
            if sym not in data or today not in data[sym].index:
                continue
            row = data[sym].loc[today]
            if pd.isna(row['rsi']) or pd.isna(row['ma50']):
                continue
            total += 1

            s1 = bool(25 < row['rsi'] < 40)
            s2 = bool(row['close'] > row['ma50'] * 0.97)
            s3 = bool(row['vol_ratio'] > 1.4)
            s4 = True

            if s1: counts['s1_rsi']     += 1
            if s2: counts['s2_ma50']    += 1
            if s3: counts['s3_volume']  += 1
            if s4: counts['s4_sentiment'] += 1  # always

            n_met = s1 + s2 + s3 + s4   # ignoring sector signal for this analysis
            if n_met >= 4:
                combos_45[n_met] += 1

            # "S1 is the bottleneck" check: days where s2+s3+s4 all pass but s1 doesn't
            if s2 and s3 and s4 and not s1:
                s1_only_misses += 1

    return {
        'total_symbol_days': total,
        'fire_rates': {k: (v / total, v) for k, v in counts.items()},
        's1_bottleneck_days': s1_only_misses,
        's1_bottleneck_pct': s1_only_misses / total,
        '4_of_4_signal_days': combos_45.get(4, 0),   # 4/4 non-sector signals
        '3_of_4_signal_days': combos_45.get(3, 0),
    }

# ── SPY benchmark ─────────────────────────────────────────────────────────────
def spy_benchmark(spy_df: pd.DataFrame, start_equity=100_000) -> dict:
    spy_df = spy_df.iloc[50:]   # align with backtest start
    total_ret = (spy_df['close'].iloc[-1] / spy_df['close'].iloc[0] - 1)
    daily_ret = spy_df['close'].pct_change().dropna()
    sharpe    = daily_ret.mean() / daily_ret.std() * math.sqrt(252)
    roll_max  = spy_df['close'].cummax()
    max_dd    = ((spy_df['close'] - roll_max) / roll_max).min()
    return {'total_return': total_ret, 'sharpe': sharpe, 'max_drawdown': max_dd}

# ── Entry ─────────────────────────────────────────────────────────────────────
def main():
    end_date   = date.today().isoformat()
    start_date = (date.today() - timedelta(days=730)).isoformat()

    print(f"\n{'='*60}")
    print(f"  QUANT AGENT — PHASE 1 BACKTEST")
    print(f"  Period : {start_date} → {end_date}")
    print(f"  Universe: {len(SYMBOLS)} symbols")
    print(f"{'='*60}\n")

    # ── Fetch data ────────────────────────────────────────────────────────
    print("Fetching 2 years of daily bars from Alpaca...")
    data = {}
    for sym in SYMBOLS:
        try:
            df = fetch_bars(sym, start_date, end_date)
            if len(df) < 60:
                print(f"  SKIP {sym}: only {len(df)} bars")
                continue
            data[sym] = add_indicators(df)
            print(f"  {sym:8s} {len(df)} bars  RSI_today={data[sym]['rsi'].iloc[-1]:.1f}  vs_MA50={data[sym]['pct_vs_ma50'].iloc[-1]:.1f}%")
        except Exception as e:
            print(f"  ERROR {sym}: {e}")
        time.sleep(0.1)   # gentle rate limit

    print(f"\nLoaded {len(data)} symbols.\n")

    # ── Signal fire rate analysis ─────────────────────────────────────────
    print("─"*60)
    print("PER-SIGNAL FIRE RATE  (signal 4/sentiment always passes in backtest)")
    print("─"*60)
    sfa = signal_fire_analysis(data)
    print(f"Total symbol-days evaluated : {sfa['total_symbol_days']:,}")
    print()
    print(f"{'Signal':<30} {'Fire Rate':>10} {'Days Fired':>12}")
    print(f"{'─'*30} {'─'*10} {'─'*12}")
    labels = {
        's1_rsi':        'S1: RSI 25–40 (oversold)',
        's2_ma50':       'S2: Price > MA50×0.97',
        's3_volume':     'S3: Volume > 1.4× avg',
        's4_sentiment':  'S4: Sentiment ≠ negative',
    }
    for k, lbl in labels.items():
        rate, cnt = sfa['fire_rates'][k]
        bar = '█' * int(rate * 40)
        print(f"{lbl:<30} {rate*100:>9.1f}%  {cnt:>10,}  {bar}")
    print()
    print(f"S1 is the sole bottleneck: {sfa['s1_bottleneck_days']:,} symbol-days "
          f"({sfa['s1_bottleneck_pct']*100:.1f}%) where S2+S3+S4 pass but S1 blocks.")
    print(f"4-of-4 non-sector signals (pre-sector gate): {sfa['4_of_4_signal_days']:,} days")

    # ── Threshold backtest ────────────────────────────────────────────────
    print("\n" + "─"*60)
    print("THRESHOLD COMPARISON  (3/5 vs 4/5 vs 5/5)")
    print("─"*60)

    results = {}
    for thresh in [3, 4, 5]:
        label = f"{thresh}/5"
        print(f"\nRunning backtest at threshold {label}...")
        r = run_backtest(thresh, data)
        m = calc_metrics(r, label)
        results[thresh] = m
        print(f"  → {m['n_trades']} trades")

    # Summary table
    print()
    print(f"{'Threshold':<12} {'Trades':>8} {'Win%':>8} {'Avg Win':>9} {'Avg Loss':>9} {'EV/Trade':>10} {'Total Ret':>10} {'Sharpe':>8} {'Max DD':>8}")
    print(f"{'─'*12} {'─'*8} {'─'*8} {'─'*9} {'─'*9} {'─'*10} {'─'*10} {'─'*8} {'─'*8}")
    for thresh in [3, 4, 5]:
        m = results[thresh]
        if m['n_trades'] == 0:
            print(f"{m['label']:<12} {'0':>8}")
            continue
        print(f"{m['label']:<12}"
              f"  {m['n_trades']:>6}"
              f"  {m['win_rate']*100:>6.1f}%"
              f"  {m['avg_win']*100:>7.2f}%"
              f"  {m['avg_loss']*100:>7.2f}%"
              f"  {m['ev_per_trade']*100:>8.2f}%"
              f"  {m['total_return']*100:>8.1f}%"
              f"  {m['sharpe']:>7.2f}"
              f"  {m['max_drawdown']*100:>6.1f}%")

    # ── Full detail for 5/5 (current production) ─────────────────────────
    print("\n" + "─"*60)
    print("CURRENT SYSTEM (5/5) — DETAILED")
    print("─"*60)
    m5 = results[5]
    if m5['n_trades'] > 0:
        print(f"  Trades         : {m5['n_trades']}")
        print(f"  Win rate       : {m5['win_rate']*100:.1f}%")
        print(f"  Avg win        : +{m5['avg_win']*100:.2f}%")
        print(f"  Avg loss       : {m5['avg_loss']*100:.2f}%")
        print(f"  EV per trade   : {m5['ev_per_trade']*100:.2f}%")
        print(f"  Total return   : {m5['total_return']*100:.1f}%")
        print(f"  Final equity   : ${m5['final_equity']:,.0f}  (started $100,000)")
        print(f"  Sharpe ratio   : {m5['sharpe']:.2f}")
        print(f"  Max drawdown   : {m5['max_drawdown']*100:.1f}%")
        print(f"\n  Exit reasons:")
        for reason, count in sorted(m5['exit_reasons'].items(), key=lambda x: -x[1]):
            pct = count / m5['n_trades'] * 100
            print(f"    {reason:<20} {count:>4}  ({pct:.0f}%)")

        print(f"\n  Individual trades:")
        print(f"  {'Symbol':<8} {'Entry':>10} {'Exit':>10} {'Hold':>5} {'P&L%':>8} {'Reason':<16}")
        print(f"  {'─'*8} {'─'*10} {'─'*10} {'─'*5} {'─'*8} {'─'*16}")
        for t in sorted(m5['trades_detail'], key=lambda x: x['entry_date']):
            print(f"  {t['symbol']:<8} {str(t['entry_date']):>10} {str(t['exit_date']):>10} "
                  f"{t['hold_days']:>5}d {t['pnl_pct']*100:>+7.2f}% {t['exit_reason']:<16}")
    else:
        print("  No trades triggered at 5/5 threshold in the 2-year period.")
        print("  This confirms the RSI 25-40 gate is too restrictive for this universe.")

    # ── Signal 1 spotlight ────────────────────────────────────────────────
    print("\n" + "─"*60)
    print("SIGNAL 1 SPOTLIGHT — RSI 25-40")
    print("─"*60)
    rate1, cnt1 = sfa['fire_rates']['s1_rsi']
    total_sd = sfa['total_symbol_days']
    print(f"  S1 fires on {cnt1:,} of {total_sd:,} symbol-days ({rate1*100:.1f}%)")
    print(f"  That's roughly {cnt1 // len(SYMBOLS)} trading days per year per symbol.")

    # Show RSI distribution
    rsi_vals = []
    for df in data.values():
        rsi_vals.extend(df['rsi'].dropna().tolist())
    rsi_arr = np.array(rsi_vals)
    print(f"\n  RSI distribution across all symbol-days:")
    for lo, hi in [(0,25),(25,40),(40,50),(50,60),(60,70),(70,100)]:
        n = int(((rsi_arr >= lo) & (rsi_arr < hi)).sum())
        pct = n / len(rsi_arr) * 100
        bar = '█' * int(pct / 2)
        label = f"  {lo:>3}–{hi:<3}"
        marker = " ← S1 target" if lo == 25 else (" ← free-fall zone" if lo == 0 else "")
        print(f"  {lo:>3}–{hi:<3}  {pct:>5.1f}%  {bar}{marker}")

    print(f"\n  If S1 were widened to RSI 25–55 (captures mean-reversion AND mild dips):")
    s1_wide = int(((rsi_arr >= 25) & (rsi_arr < 55)).sum())
    print(f"    {s1_wide:,} symbol-days would pass ({s1_wide/len(rsi_arr)*100:.1f}%) "
          f"vs {cnt1:,} currently ({rate1*100:.1f}%)")
    print(f"    That's a {s1_wide/max(cnt1,1):.1f}× increase in S1-qualifying days.")

    # ── SPY benchmark ─────────────────────────────────────────────────────
    if 'SPY' in data:
        spy = spy_benchmark(data['SPY'])
        print(f"\n{'─'*60}")
        print(f"SPY BUY-AND-HOLD BENCHMARK (same 2-year period)")
        print(f"{'─'*60}")
        print(f"  Total return : {spy['total_return']*100:.1f}%")
        print(f"  Sharpe ratio : {spy['sharpe']:.2f}")
        print(f"  Max drawdown : {spy['max_drawdown']*100:.1f}%")

    print(f"\n{'='*60}")
    print(f"  PHASE 1 COMPLETE — awaiting your review before Phase 2")
    print(f"{'='*60}\n")

if __name__ == '__main__':
    main()
