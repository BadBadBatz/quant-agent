#!/usr/bin/env python3
"""
Phase 3 — Regime-Aware Threshold Grid Search
Test whether widening Signal 1's RSI window in bullish regimes
increases trade count without hurting EV or Sharpe.
96 parameter combinations, no production files touched.
"""

import os, sys, time, math, warnings, itertools
from datetime import date, timedelta
from collections import defaultdict

warnings.filterwarnings("ignore")

import requests
import pandas as pd
import numpy as np

# ── Credentials ───────────────────────────────────────────────────────────────
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

# ── Universe ──────────────────────────────────────────────────────────────────
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

# ── Risk config ───────────────────────────────────────────────────────────────
STOP_LOSS_PCT   = 0.06
TAKE_PROFIT_PCT = 0.12
MAX_POSITIONS   = 4
MAX_HOLD_DAYS   = 30
WEEKLY_BUDGET   = 6250
DEPLOYABLE_PCT  = 0.75

FOMC_DATES = {
    date(2024,1,31), date(2024,3,20), date(2024,5,1),  date(2024,6,12),
    date(2024,7,31), date(2024,9,18), date(2024,11,7), date(2024,12,18),
    date(2025,1,29), date(2025,3,19), date(2025,5,7),  date(2025,6,18),
    date(2025,7,30), date(2025,9,17), date(2025,11,5), date(2025,12,17),
    date(2026,1,28), date(2026,3,18), date(2026,5,6),  date(2026,6,17),
}

def is_fomc_week(d):
    ws = d - timedelta(days=d.weekday())
    we = ws + timedelta(days=4)
    return any(ws <= fd <= we for fd in FOMC_DATES)

# ── Data fetch ────────────────────────────────────────────────────────────────
def fetch_bars(symbol, start, end):
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
        d = r.json()
        bars.extend(d.get('bars') or [])
        token = d.get('next_page_token')
        if not token:
            break
    if not bars:
        return pd.DataFrame()
    df = pd.DataFrame(bars)
    df['date'] = pd.to_datetime(df['t']).dt.date
    df = df.rename(columns={'o':'open','h':'high','l':'low','c':'close','v':'volume'})
    return df[['date','open','high','low','close','volume']].set_index('date').sort_index()

def calc_rsi(closes, period=14):
    delta    = closes.diff()
    gain     = delta.clip(lower=0)
    loss     = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def add_indicators(df):
    df = df.copy()
    df['rsi']        = calc_rsi(df['close'])
    df['ma50']       = df['close'].rolling(50).mean()
    df['avg_vol_20'] = df['volume'].rolling(20).mean()
    df['vol_ratio']  = df['volume'] / df['avg_vol_20']
    return df

def add_spy_features(spy_df):
    spy_df = spy_df.copy()
    spy_df['spy_rsi']      = calc_rsi(spy_df['close'])
    spy_df['spy_20d_ret']  = spy_df['close'].pct_change(20) * 100
    spy_df['spy_ma50']     = spy_df['close'].rolling(50).mean()
    spy_df['spy_vs_ma50']  = (spy_df['close'] / spy_df['spy_ma50'] - 1) * 100
    return spy_df

# ── Regime classification ─────────────────────────────────────────────────────
def classify_regime(spy_row, spy_rsi_thresh, spy_trend_thresh):
    """Bull if BOTH SPY RSI and 20d trend exceed thresholds."""
    if pd.isna(spy_row['spy_rsi']) or pd.isna(spy_row['spy_20d_ret']):
        return 'neutral'
    if spy_row['spy_rsi'] > spy_rsi_thresh and spy_row['spy_20d_ret'] > spy_trend_thresh:
        return 'bull'
    return 'bear'

# ── Core backtest ─────────────────────────────────────────────────────────────
def run_backtest(data, spy_data, params):
    """
    params = {
      spy_rsi_thresh, spy_trend_thresh,
      s1_upper_bull, s1_upper_bear,
      s1_lower (always 25)
    }
    """
    s1_lower       = 25
    s1_upper_bull  = params['s1_upper_bull']
    s1_upper_bear  = params['s1_upper_bear']
    spy_rsi_thresh = params['spy_rsi_thresh']
    spy_trend      = params['spy_trend_thresh']

    all_dates = sorted(set(d for df in data.values() for d in df.index))

    cash             = 100_000.0
    open_positions   = {}
    closed_trades    = []
    weekly_deployed  = defaultdict(float)
    regime_log       = {}   # date → regime

    def week_key(d): return (d.year, d.isocalendar()[1])

    for i, today in enumerate(all_dates):
        if i < 50:
            continue

        # ── Determine regime ─────────────────────────────────────────────
        if today in spy_data.index and not pd.isna(spy_data.loc[today, 'spy_rsi']):
            regime = classify_regime(spy_data.loc[today], spy_rsi_thresh, spy_trend)
        else:
            regime = 'neutral'
        regime_log[today] = regime

        s1_upper = s1_upper_bull if regime == 'bull' else s1_upper_bear

        # ── Check exits ──────────────────────────────────────────────────
        to_close = []
        for sym, pos in open_positions.items():
            if sym not in data or today not in data[sym].index:
                continue
            row  = data[sym].loc[today]
            days = (today - pos['entry_date']).days

            exit_reason = None
            exit_price  = row['close']
            if row['low'] <= pos['stop']:
                exit_reason, exit_price = 'stop_loss',   pos['stop']
            elif row['high'] >= pos['take']:
                exit_reason, exit_price = 'take_profit', pos['take']
            elif days >= MAX_HOLD_DAYS:
                exit_reason, exit_price = 'max_hold',    row['close']

            if exit_reason:
                pnl_pct = (exit_price / pos['entry_price']) - 1
                cash   += pos['shares'] * exit_price
                closed_trades.append({
                    'symbol':      sym,
                    'entry_date':  pos['entry_date'],
                    'exit_date':   today,
                    'entry_price': pos['entry_price'],
                    'exit_price':  exit_price,
                    'pnl_pct':     pnl_pct,
                    'pnl':         pos['shares'] * pos['entry_price'] * pnl_pct,
                    'exit_reason': exit_reason,
                    'hold_days':   days,
                    'regime':      pos['regime'],
                })
                to_close.append(sym)
        for sym in to_close:
            del open_positions[sym]

        open_sector_set = {p['sector'] for p in open_positions.values()}

        # ── Scan entries ─────────────────────────────────────────────────
        if not is_fomc_week(today) and len(open_positions) < MAX_POSITIONS:
            wk = week_key(today)
            budget_left = WEEKLY_BUDGET * DEPLOYABLE_PCT - weekly_deployed[wk]
            candidates  = []

            for sym in SYMBOLS:
                if sym in open_positions:
                    continue
                if sym not in data or today not in data[sym].index:
                    continue
                row = data[sym].loc[today]
                if pd.isna(row['rsi']) or pd.isna(row['ma50']):
                    continue

                s1 = s1_lower < row['rsi'] < s1_upper
                s2 = row['close'] > row['ma50'] * 0.97
                s3 = row['vol_ratio'] > 1.4
                s4 = True   # sentiment always passes in backtest
                s5 = SECTOR_MAP.get(sym,'') not in open_sector_set

                if s1 and s2 and s3 and s4 and s5:
                    candidates.append((sym, row))

            candidates.sort(key=lambda x: x[1]['rsi'])

            for sym, row in candidates:
                if len(open_positions) >= MAX_POSITIONS:
                    break
                sector = SECTOR_MAP.get(sym, 'unknown')
                if sector in {p['sector'] for p in open_positions.values()}:
                    continue
                if budget_left < 100:
                    continue

                future = [d for d in all_dates if d > today]
                if not future:
                    continue
                next_day = future[0]
                if sym not in data or next_day not in data[sym].index:
                    continue

                entry_price = data[sym].loc[next_day]['open']
                if pd.isna(entry_price) or entry_price <= 0:
                    continue

                notional = min(
                    budget_left,
                    cash * 0.40,
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
                    'regime':      regime,
                }

    # Close remaining
    for sym, pos in open_positions.items():
        last_days = [d for d in all_dates if sym in data and d in data[sym].index]
        if not last_days:
            continue
        ld = last_days[-1]
        ep = data[sym].loc[ld]['close']
        pnl_pct = (ep / pos['entry_price']) - 1
        closed_trades.append({
            'symbol': sym, 'entry_date': pos['entry_date'], 'exit_date': ld,
            'entry_price': pos['entry_price'], 'exit_price': ep,
            'pnl_pct': pnl_pct, 'pnl': pos['shares']*pos['entry_price']*pnl_pct,
            'exit_reason': 'end_of_period', 'hold_days': (ld-pos['entry_date']).days,
            'regime': pos['regime'],
        })

    return closed_trades, regime_log

def metrics(trades, label=''):
    n = len(trades)
    if n == 0:
        return {'label':label,'n':0,'win_rate':0,'avg_win':0,'avg_loss':0,
                'ev':0,'total_pnl':0,'sharpe':0,'max_dd':0,'n_bull':0,'n_bear':0}
    wins   = [t for t in trades if t['pnl_pct'] > 0]
    losses = [t for t in trades if t['pnl_pct'] <= 0]
    wr   = len(wins)  / n
    aw   = np.mean([t['pnl_pct'] for t in wins])   if wins   else 0
    al   = np.mean([t['pnl_pct'] for t in losses]) if losses else 0
    ev   = wr * aw + (1 - wr) * al
    total_pnl = sum(t['pnl'] for t in trades)
    # rough Sharpe from trade returns
    rets = [t['pnl_pct'] for t in trades]
    sharpe = (np.mean(rets)/np.std(rets)*np.sqrt(252/MAX_HOLD_DAYS)) if len(rets)>1 and np.std(rets)>0 else 0
    # drawdown (cumulative pnl)
    cum = np.cumsum([t['pnl'] for t in trades])
    running_max = np.maximum.accumulate(cum + 100_000)
    dd = ((cum + 100_000 - running_max) / running_max)
    max_dd = dd.min() if len(dd) else 0
    n_bull = sum(1 for t in trades if t.get('regime') == 'bull')
    n_bear = sum(1 for t in trades if t.get('regime') in ('bear','neutral'))
    return {'label':label,'n':n,'win_rate':wr,'avg_win':aw,'avg_loss':al,
            'ev':ev,'total_pnl':total_pnl,'sharpe':sharpe,'max_dd':max_dd,
            'n_bull':n_bull,'n_bear':n_bear}

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    end_date   = date.today().isoformat()
    start_date = (date.today() - timedelta(days=730)).isoformat()

    print(f"\n{'='*65}")
    print(f"  QUANT AGENT — PHASE 3: REGIME-AWARE THRESHOLD GRID SEARCH")
    print(f"  Period : {start_date} → {end_date}  |  96 parameter combos")
    print(f"{'='*65}\n")

    # ── Fetch data ────────────────────────────────────────────────────────
    print("Fetching data...")
    data = {}
    for sym in SYMBOLS:
        try:
            df = fetch_bars(sym, start_date, end_date)
            if len(df) >= 60:
                data[sym] = add_indicators(df)
                print(f"  {sym:8s} {len(df)} bars")
        except Exception as e:
            print(f"  ERROR {sym}: {e}")
        time.sleep(0.05)

    spy_raw = fetch_bars('SPY', start_date, end_date)
    spy_data = add_spy_features(spy_raw)
    print(f"\nLoaded {len(data)} symbols + SPY regime data.\n")

    # ── Regime calendar ───────────────────────────────────────────────────
    print("─"*65)
    print("REGIME CALENDAR  (across all parameter combinations — SPY RSI 60, trend 2%)")
    print("─"*65)
    sample_regime = {}
    for d in spy_data.index:
        if not pd.isna(spy_data.loc[d,'spy_rsi']):
            sample_regime[d] = classify_regime(spy_data.loc[d], 60, 2.0)

    bull_days = sum(1 for v in sample_regime.values() if v == 'bull')
    bear_days = sum(1 for v in sample_regime.values() if v != 'bull')
    total_days = len(sample_regime)
    print(f"  Bull regime days : {bull_days:>4}  ({bull_days/total_days*100:.1f}%)")
    print(f"  Bear/neutral days: {bear_days:>4}  ({bear_days/total_days*100:.1f}%)")

    # Show regime by year-quarter
    spy_data['regime_sample'] = [
        classify_regime(spy_data.loc[d], 60, 2.0)
        if not pd.isna(spy_data.loc[d,'spy_rsi']) else 'neutral'
        for d in spy_data.index
    ]
    spy_data['yrq'] = [f"{d.year}-Q{(d.month-1)//3+1}" for d in spy_data.index]
    yrq_stats = spy_data.groupby('yrq')['regime_sample'].apply(
        lambda x: f"{(x=='bull').sum()}/{len(x)} bull days"
    )
    print()
    for yrq, stat in yrq_stats.items():
        print(f"  {yrq}  {stat}")

    # ── Baseline: current 5/5 fixed threshold ────────────────────────────
    print("\n" + "─"*65)
    print("BASELINE (current system: 5/5, RSI 25-40, no regime awareness)")
    print("─"*65)
    baseline_params = {'spy_rsi_thresh':999,'spy_trend_thresh':999,
                       's1_upper_bull':40,'s1_upper_bear':40}
    baseline_trades, _ = run_backtest(data, spy_data, baseline_params)
    bm = metrics(baseline_trades, 'BASELINE')
    print(f"  Trades: {bm['n']}  |  Win: {bm['win_rate']*100:.1f}%  |  "
          f"EV: {bm['ev']*100:.2f}%  |  Sharpe: {bm['sharpe']:.2f}  |  "
          f"Max DD: {bm['max_dd']*100:.1f}%")

    # ── Grid search ───────────────────────────────────────────────────────
    print("\n" + "─"*65)
    print("RUNNING GRID SEARCH  (96 combinations)...")
    print("─"*65)

    spy_rsi_thresholds  = [50, 55, 60, 65]
    spy_trend_thresholds= [0.0, 2.0, 4.0]
    s1_upper_bulls      = [45, 50, 55, 60]
    s1_upper_bears      = [35, 40]

    all_results = []
    total_combos = len(spy_rsi_thresholds)*len(spy_trend_thresholds)*len(s1_upper_bulls)*len(s1_upper_bears)
    done = 0

    for spy_r, spy_t, bull_u, bear_u in itertools.product(
        spy_rsi_thresholds, spy_trend_thresholds, s1_upper_bulls, s1_upper_bears
    ):
        params = {'spy_rsi_thresh':spy_r,'spy_trend_thresh':spy_t,
                  's1_upper_bull':bull_u,'s1_upper_bear':bear_u}
        trades, rlog = run_backtest(data, spy_data, params)
        m = metrics(trades, f"rsi≥{spy_r} trend≥{spy_t}% bull≤{bull_u} bear≤{bear_u}")
        m.update(params)
        m['trades_detail'] = trades
        all_results.append(m)
        done += 1
        if done % 16 == 0:
            print(f"  {done}/{total_combos} done...")

    print(f"  {total_combos}/{total_combos} done.\n")

    # ── Results table — all combinations ─────────────────────────────────
    res_df = pd.DataFrame(all_results).drop(columns=['trades_detail','label'])
    res_df = res_df.sort_values('ev', ascending=False)

    # Guard rail: EV >= baseline AND more trades than baseline
    beats_baseline = res_df[
        (res_df['ev'] >= bm['ev']) &
        (res_df['n']  >  bm['n'])
    ]

    print("─"*65)
    print(f"FULL GRID — sorted by EV  ({len(res_df)} combos)")
    print("─"*65)
    print(f"\n{'SPY RSI':>8} {'Trend':>7} {'BullRSI':>8} {'BearRSI':>8} "
          f"{'Trades':>7} {'Win%':>6} {'EV%':>7} {'Sharpe':>7} {'MaxDD':>7} "
          f"{'Bull/Bear':>10}  Flag")
    print("─"*90)
    for _, r in res_df.iterrows():
        flag = ''
        if r['ev'] >= bm['ev'] and r['n'] > bm['n']:
            flag = ' ✓ BEATS BASELINE'
        if r['n'] == bm['n'] and r['spy_rsi_thresh'] >= 999:
            flag = ' (baseline)'
        print(f"  {r['spy_rsi_thresh']:>6}  {r['spy_trend_thresh']:>6.0f}%  "
              f"{r['s1_upper_bull']:>7}  {r['s1_upper_bear']:>7}  "
              f"{r['n']:>6}  {r['win_rate']*100:>5.1f}%  "
              f"{r['ev']*100:>6.2f}%  {r['sharpe']:>6.2f}  "
              f"{r['max_dd']*100:>6.1f}%  "
              f"{r['n_bull']:>4}/{r['n_bear']:<4}"
              f"{flag}")

    # ── Top 5 that beat baseline ──────────────────────────────────────────
    print("\n" + "─"*65)
    if len(beats_baseline) == 0:
        print("NO COMBINATIONS beat baseline on both EV and trade count.")
        print("This means regime-aware widening HURTS quality even if it adds trades.")
        print("\nTop 5 by trade count (ignoring EV guard rail):")
        top5 = res_df.nlargest(5, 'n')
    else:
        print(f"TOP {min(5,len(beats_baseline))} COMBINATIONS BEATING BASELINE  "
              f"(EV ≥ {bm['ev']*100:.2f}% AND more trades)")
        top5 = beats_baseline.head(5)

    print("─"*65)
    for rank, (_, r) in enumerate(top5.iterrows(), 1):
        trades_detail = next(
            x['trades_detail'] for x in all_results
            if x['spy_rsi_thresh']   == r['spy_rsi_thresh']
            and x['spy_trend_thresh'] == r['spy_trend_thresh']
            and x['s1_upper_bull']    == r['s1_upper_bull']
            and x['s1_upper_bear']    == r['s1_upper_bear']
        )
        bull_trades = [t for t in trades_detail if t.get('regime') == 'bull']
        bear_trades = [t for t in trades_detail if t.get('regime') != 'bull']

        bm_bull = metrics(bull_trades)
        bm_bear = metrics(bear_trades)

        print(f"\n  #{rank}  SPY RSI≥{r['spy_rsi_thresh']}  "
              f"20d trend≥{r['spy_trend_thresh']:.0f}%  "
              f"Bull S1 RSI<{r['s1_upper_bull']}  "
              f"Bear S1 RSI<{r['s1_upper_bear']}")
        print(f"       Overall  : {int(r['n'])} trades  "
              f"win={r['win_rate']*100:.1f}%  "
              f"EV={r['ev']*100:.2f}%  "
              f"Sharpe={r['sharpe']:.2f}  "
              f"MaxDD={r['max_dd']*100:.1f}%")
        if bm_bull['n'] > 0:
            print(f"       Bull regime: {bm_bull['n']} trades  "
                  f"win={bm_bull['win_rate']*100:.1f}%  "
                  f"EV={bm_bull['ev']*100:.2f}%")
        if bm_bear['n'] > 0:
            print(f"       Bear regime: {bm_bear['n']} trades  "
                  f"win={bm_bear['win_rate']*100:.1f}%  "
                  f"EV={bm_bear['ev']*100:.2f}%")

        print(f"\n       Trade list:")
        print(f"       {'Symbol':<8} {'Entry':>10} {'Exit':>10} {'Hold':>5} "
              f"{'P&L%':>8} {'Regime':<8} {'Reason'}")
        print(f"       {'─'*8} {'─'*10} {'─'*10} {'─'*5} {'─'*8} {'─'*8} {'─'*16}")
        for t in sorted(trades_detail, key=lambda x: x['entry_date']):
            print(f"       {t['symbol']:<8} {str(t['entry_date']):>10} "
                  f"{str(t['exit_date']):>10} {t['hold_days']:>5}d "
                  f"{t['pnl_pct']*100:>+7.2f}%  "
                  f"{t.get('regime','?'):<8} {t['exit_reason']}")

    # ── Recommendation ────────────────────────────────────────────────────
    print("\n" + "─"*65)
    print("RECOMMENDATION")
    print("─"*65)

    if len(beats_baseline) == 0:
        best = res_df.nlargest(1,'n').iloc[0]
        print(f"""
  The grid search found NO combination that simultaneously increases
  trade count AND maintains EV ≥ {bm['ev']*100:.2f}%.

  Widening S1's RSI window in bull regimes adds trades but they are
  lower quality — the extra entries are in stocks with RSI 40-60
  that have ALREADY started recovering, so mean-reversion has less
  room to run.

  Phase 2 told us why: it's SPY context (market regime) that matters,
  not individual stock RSI. Adding trades in a bull market by widening
  RSI just chases momentum rather than capturing dips.

  ALTERNATIVE RECOMMENDATION (proceed to Phase 4 instead):
  → Keep the current tight RSI 25-40 threshold (right signal, rare but clean)
  → Use the XGBoost score from Phase 2 to ADD a 6th filter inside Claude
  → Pass the top features (spy_20d_trend, spy_vs_ma50, hl_range, pct_vs_ma200)
    into the Claude judge as structured context
  → Let Claude weight them — it handles non-linear regime logic better
    than hard thresholds
        """)
    else:
        best = beats_baseline.iloc[0]
        print(f"""
  Best combination: SPY RSI≥{best['spy_rsi_thresh']:.0f}, 20d trend≥{best['spy_trend_thresh']:.0f}%,
                    Bull S1 RSI<{best['s1_upper_bull']:.0f}, Bear S1 RSI<{best['s1_upper_bear']:.0f}
  Trades: {int(best['n'])} (vs {bm['n']} baseline)
  EV: {best['ev']*100:.2f}% (vs {bm['ev']*100:.2f}% baseline)
  Sharpe: {best['sharpe']:.2f} (vs {bm['sharpe']:.2f} baseline)

  CAUTION: Before deploying, note the combo count that beat baseline:
  {len(beats_baseline)} of 96 ({len(beats_baseline)/96*100:.0f}%) combinations beat baseline.
  {'Wide spread → robust result — regime awareness genuinely helps.' if len(beats_baseline) > 20
   else 'Narrow spread → possible overfit to this 2-year window. Treat with caution.'}
        """)

    print(f"{'='*65}")
    print(f"  PHASE 3 COMPLETE — awaiting your review before Phase 4")
    print(f"{'='*65}\n")

if __name__ == '__main__':
    main()
