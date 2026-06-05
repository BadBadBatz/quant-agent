#!/usr/bin/env python3
"""
Phase 2 — Feature Engineering + XGBoost
Predict 5-day forward return direction from Alpaca-derivable features only.
No production files modified.
"""

import os, sys, time, warnings
from datetime import date, timedelta
from collections import defaultdict

warnings.filterwarnings("ignore")

import requests
import pandas as pd
import numpy as np
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import roc_auc_score, classification_report, precision_score, recall_score
from sklearn.preprocessing import StandardScaler
import xgboost as xgb

# ── Credentials ──────────────────────────────────────────────────────────────
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

# ── Universe ─────────────────────────────────────────────────────────────────
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

# Sector ETFs for sector-momentum features
SECTOR_ETF_MAP = {
    'tech':      'XLK',
    'finance':   'XLF',
    'healthcare':'XLV',
    'consumer':  'XLP',
    'defense':   'ITA',
    'energy':    'XLE',
    'etf':       'SPY',
}
EXTRA_FETCH = ['SPY', 'XLK', 'XLF', 'XLV', 'XLP', 'ITA', 'XLE', 'VXX']

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
        if r.status_code != 200:
            return pd.DataFrame()
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
    return df[['date','open','high','low','close','volume']].set_index('date').sort_index()

# ── Indicators ────────────────────────────────────────────────────────────────
def calc_rsi(closes, period=14):
    delta    = closes.diff()
    gain     = delta.clip(lower=0)
    loss     = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period-1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period-1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def add_base_indicators(df):
    df = df.copy()
    df['rsi']         = calc_rsi(df['close'])
    df['ma50']        = df['close'].rolling(50).mean()
    df['ma200']       = df['close'].rolling(200).mean()
    df['avg_vol_20']  = df['volume'].rolling(20).mean()
    return df

# ── Feature engineering ───────────────────────────────────────────────────────
def build_features(df, spy_df, sector_df, vxx_df=None):
    """
    All features derivable from Alpaca OHLCV bars.
    VXX is optional; if absent, vix_proxy is left as NaN (noted as TODO stub).
    """
    f = pd.DataFrame(index=df.index)

    # --- Current system signals (as continuous values, not booleans) ---
    f['rsi']              = df['rsi']
    f['pct_vs_ma50']      = (df['close'] / df['ma50'] - 1) * 100
    f['vol_ratio']        = df['volume'] / df['avg_vol_20']

    # Current system signals as booleans (feature value = 0/1)
    f['s1_rsi_bool']      = ((df['rsi'] > 25) & (df['rsi'] < 40)).astype(int)
    f['s2_ma50_bool']     = (df['close'] > df['ma50'] * 0.97).astype(int)
    f['s3_vol_bool']      = (df['volume'] > df['avg_vol_20'] * 1.4).astype(int)

    # --- New features ---
    # RSI momentum
    f['rsi_slope_3d']     = df['rsi'].diff(3)
    f['rsi_slope_7d']     = df['rsi'].diff(7)
    f['rsi_vs_ma_rsi']    = df['rsi'] - df['rsi'].rolling(14).mean()

    # Volume features
    f['vol_ratio_5d']     = f['vol_ratio'].rolling(5).mean()
    f['vol_ratio_slope']  = f['vol_ratio'].diff(3)

    # Price distance features
    f['pct_vs_ma200']     = (df['close'] / df['ma200'] - 1) * 100
    f['ma50_vs_ma200']    = (df['ma50'] / df['ma200'] - 1) * 100   # golden/death cross proxy

    # Price momentum
    f['price_mom_5d']     = df['close'].pct_change(5)  * 100
    f['price_mom_10d']    = df['close'].pct_change(10) * 100
    f['price_mom_20d']    = df['close'].pct_change(20) * 100

    # Intraday features
    f['intraday_dir']     = (df['close'] - df['open']) / df['open'] * 100
    f['hl_range']         = (df['high'] - df['low']) / df['close'] * 100
    f['close_vs_high']    = (df['close'] - df['high']) / df['high'] * 100   # where in range did it close?
    f['close_vs_low']     = (df['close'] - df['low'])  / df['low']  * 100

    # Volatility (rolling std of returns)
    daily_ret             = df['close'].pct_change()
    f['vol_10d']          = daily_ret.rolling(10).std() * 100
    f['vol_20d']          = daily_ret.rolling(20).std() * 100

    # --- Market context (SPY) ---
    spy_aligned           = spy_df['close'].reindex(df.index, method='ffill')
    spy_rsi_aligned       = calc_rsi(spy_df['close']).reindex(df.index, method='ffill')
    spy_ma50              = spy_df['close'].rolling(50).mean().reindex(df.index, method='ffill')

    f['spy_rsi']          = spy_rsi_aligned
    f['spy_5d_trend']     = spy_aligned.pct_change(5)  * 100
    f['spy_20d_trend']    = spy_aligned.pct_change(20) * 100
    f['spy_vs_ma50']      = (spy_aligned / spy_ma50 - 1) * 100

    # --- Sector context ---
    if sector_df is not None and not sector_df.empty:
        sec_aligned       = sector_df['close'].reindex(df.index, method='ffill')
        sec_rsi           = calc_rsi(sector_df['close']).reindex(df.index, method='ffill')
        f['sector_rsi']   = sec_rsi
        f['sector_5d']    = sec_aligned.pct_change(5) * 100
        f['sector_vs_spy']= (sec_aligned / spy_aligned - 1) * 100   # relative sector strength
    else:
        f['sector_rsi']   = np.nan
        f['sector_5d']    = np.nan
        f['sector_vs_spy']= np.nan

    # --- VXX as VIX proxy (TODO stub if not available) ---
    if vxx_df is not None and not vxx_df.empty:
        vxx_aligned       = vxx_df['close'].reindex(df.index, method='ffill')
        f['vix_proxy']    = vxx_aligned.pct_change(5) * 100   # VXX 5d change as fear gauge
    else:
        f['vix_proxy']    = np.nan   # TODO: pull from CBOE or use paid data source

    return f

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    end_date   = date.today().isoformat()
    start_date = (date.today() - timedelta(days=800)).isoformat()   # extra buffer for MA200

    print(f"\n{'='*60}")
    print(f"  QUANT AGENT — PHASE 2: FEATURE ANALYSIS + XGBOOST")
    print(f"  Period : {start_date} → {end_date}")
    print(f"{'='*60}\n")

    # ── Fetch all data ────────────────────────────────────────────────────
    all_fetch = list(set(SYMBOLS + EXTRA_FETCH))
    print(f"Fetching bars for {len(all_fetch)} symbols (universe + sector ETFs)...")
    raw = {}
    for sym in all_fetch:
        try:
            df = fetch_bars(sym, start_date, end_date)
            if len(df) >= 210:
                raw[sym] = add_base_indicators(df)
                print(f"  {sym:8s} {len(df)} bars")
            else:
                print(f"  SKIP {sym}: only {len(df)} bars")
        except Exception as e:
            print(f"  ERROR {sym}: {e}")
        time.sleep(0.05)

    spy_df = raw.get('SPY', pd.DataFrame())
    vxx_df = raw.get('VXX', None)
    print(f"\nLoaded {len(raw)} symbols.\n")

    # ── Build feature matrix ──────────────────────────────────────────────
    print("Engineering features...")
    all_rows = []

    for sym in SYMBOLS:
        if sym not in raw:
            continue
        df     = raw[sym]
        sector = SECTOR_MAP.get(sym, 'etf')
        etf    = SECTOR_ETF_MAP.get(sector, 'SPY')
        sec_df = raw.get(etf, pd.DataFrame())

        feat_df = build_features(df, spy_df, sec_df, vxx_df)

        # Target: 5-day forward return direction
        fwd_5d  = df['close'].shift(-5) / df['close'] - 1
        target  = (fwd_5d > 0).astype(int)
        fwd_ret = fwd_5d   # keep raw return for analysis

        combined = feat_df.copy()
        combined['symbol']  = sym
        combined['sector']  = sector
        combined['target']  = target
        combined['fwd_ret'] = fwd_ret
        combined['close']   = df['close']

        all_rows.append(combined)

    full_df = pd.concat(all_rows).dropna(subset=['target'])
    print(f"  Full matrix: {len(full_df):,} rows × {len(full_df.columns)} columns")

    # ── Drop rows with too many NaNs (early history for MA200) ───────────
    feature_cols = [c for c in full_df.columns
                    if c not in ('symbol','sector','target','fwd_ret','close')]
    full_df = full_df.dropna(subset=[c for c in feature_cols
                                     if c not in ('vix_proxy','sector_rsi','sector_5d','sector_vs_spy')])
    print(f"  After dropping NaN rows: {len(full_df):,} rows\n")

    # ── Current signals: raw hit rates and forward-return lift ────────────
    print("─"*60)
    print("CURRENT SIGNAL PREDICTIVE POWER (raw lift analysis)")
    print("─"*60)
    print(f"\n{'Signal':<35} {'Days':>6} {'Pct':>6} {'FwdRet5d when ON':>18} {'FwdRet5d when OFF':>18} {'Lift':>8}")
    print(f"{'─'*35} {'─'*6} {'─'*6} {'─'*18} {'─'*18} {'─'*8}")

    base_ret = full_df['fwd_ret'].mean() * 100
    for sig_col, label in [
        ('s1_rsi_bool',  'S1: RSI 25–40'),
        ('s2_ma50_bool', 'S2: Price > MA50×0.97'),
        ('s3_vol_bool',  'S3: Volume > 1.4×'),
    ]:
        on  = full_df[full_df[sig_col] == 1]['fwd_ret']
        off = full_df[full_df[sig_col] == 0]['fwd_ret']
        n   = len(on)
        pct = n / len(full_df) * 100
        lift = on.mean() * 100 - off.mean() * 100
        marker = ' ← POSITIVE' if on.mean() > off.mean() else ' ← NEGATIVE'
        print(f"{label:<35} {n:>6,} {pct:>5.1f}%  {on.mean()*100:>+16.3f}%  {off.mean()*100:>+16.3f}%  {lift:>+6.3f}%{marker}")

    print(f"\n  Baseline 5d forward return (all days): {base_ret:+.3f}%")

    # ── Train / test split (time-ordered) ────────────────────────────────
    print("\n" + "─"*60)
    print("XGBOOST — TRAINING")
    print("─"*60)

    # Sort by date (index), then split 70/30
    full_df_sorted = full_df.sort_index()
    cutoff_idx     = int(len(full_df_sorted) * 0.70)
    cutoff_date    = full_df_sorted.index[cutoff_idx]

    train_df = full_df_sorted.iloc[:cutoff_idx]
    test_df  = full_df_sorted.iloc[cutoff_idx:]

    # Remove last 5 rows (target leak: fwd_ret not yet realised)
    train_df = train_df.iloc[:-5]
    test_df  = test_df.iloc[:-5]

    # Fill remaining NaNs with median (for sector/vix features)
    fill_cols = [c for c in feature_cols if c in full_df.columns]
    train_medians = train_df[fill_cols].median()
    X_train = train_df[fill_cols].fillna(train_medians)
    X_test  = test_df[fill_cols].fillna(train_medians)
    y_train = train_df['target']
    y_test  = test_df['target']

    print(f"  Train: {len(X_train):,} rows  ({str(train_df.index[0])} → {str(train_df.index[-1])})")
    print(f"  Test : {len(X_test):,} rows  ({str(test_df.index[0])} → {str(test_df.index[-1])})")
    print(f"  Features: {len(fill_cols)}")
    print(f"  Target balance — train: {y_train.mean()*100:.1f}% up  |  test: {y_test.mean()*100:.1f}% up\n")

    # Class balance
    scale_pos = (y_train == 0).sum() / (y_train == 1).sum()

    model = xgb.XGBClassifier(
        n_estimators      = 500,
        max_depth         = 4,
        learning_rate     = 0.05,
        subsample         = 0.8,
        colsample_bytree  = 0.8,
        scale_pos_weight  = scale_pos,
        eval_metric       = 'auc',
        early_stopping_rounds = 30,
        random_state      = 42,
        verbosity         = 0,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    y_prob  = model.predict_proba(X_test)[:,1]
    y_pred  = (y_prob > 0.5).astype(int)
    auc     = roc_auc_score(y_test, y_prob)
    prec    = precision_score(y_test, y_pred, zero_division=0)
    rec     = recall_score(y_test, y_pred, zero_division=0)

    print(f"  AUC (test):       {auc:.4f}")
    print(f"  Precision (test): {prec:.4f}")
    print(f"  Recall (test):    {rec:.4f}")
    print(f"  Best iteration:   {model.best_iteration}")

    # ── Feature importance ────────────────────────────────────────────────
    print("\n" + "─"*60)
    print("FEATURE IMPORTANCE (XGBoost gain — how much each feature reduces loss)")
    print("─"*60)

    importance = model.get_booster().get_score(importance_type='gain')
    imp_df = (pd.Series(importance)
                .sort_values(ascending=False)
                .reset_index())
    imp_df.columns = ['feature','gain']
    imp_df['rank'] = range(1, len(imp_df)+1)
    total_gain = imp_df['gain'].sum()
    imp_df['pct'] = imp_df['gain'] / total_gain * 100
    imp_df['cumulative_pct'] = imp_df['pct'].cumsum()

    # Flag current system signals
    current_signals = {'s1_rsi_bool','s2_ma50_bool','s3_vol_bool',
                       'rsi','pct_vs_ma50','vol_ratio'}

    print(f"\n{'Rank':<5} {'Feature':<25} {'Gain%':>8} {'Cumul%':>8}  Bar")
    print(f"{'─'*5} {'─'*25} {'─'*8} {'─'*8}  {'─'*30}")
    for _, row in imp_df.iterrows():
        bar   = '█' * int(row['pct'] / 2)
        flag  = ' ◄ IN SYSTEM' if row['feature'] in current_signals else ''
        print(f"  {row['rank']:<3} {row['feature']:<25} {row['pct']:>7.2f}%  {row['cumulative_pct']:>7.2f}%  {bar}{flag}")
        if row['cumulative_pct'] > 90:
            remaining = len(imp_df) - row['rank']
            if remaining > 0:
                print(f"  ... {remaining} features below 90% cumulative (omitted)")
            break

    # ── Score decile analysis ─────────────────────────────────────────────
    print("\n" + "─"*60)
    print("SCORE → ACTUAL RETURN LIFT  (test set, decile buckets)")
    print("─"*60)
    print("Does a higher XGBoost score actually predict better 5d returns?\n")

    test_analysis = test_df[['fwd_ret']].copy()
    test_analysis['prob']   = y_prob
    test_analysis['decile'] = pd.qcut(y_prob, 10, labels=False, duplicates='drop')

    decile_stats = (test_analysis
                    .groupby('decile')['fwd_ret']
                    .agg(['mean','count','std'])
                    .reset_index())

    print(f"  {'Decile':<10} {'Avg 5d Return':>15} {'N':>6}  Bar")
    print(f"  {'─'*10} {'─'*15} {'─'*6}  {'─'*25}")
    for _, row in decile_stats.iterrows():
        ret_pct = row['mean'] * 100
        bar_len = int(abs(ret_pct) * 4)
        bar     = ('▶' if ret_pct > 0 else '◀') + ('█' * min(bar_len, 30))
        label   = f"D{int(row['decile'])+1:02d} (prob {'lowest' if row['decile']==0 else 'highest' if row['decile']==9 else '':>7})"
        print(f"  {label:<18} {ret_pct:>+12.3f}%  {int(row['count']):>5}  {bar}")

    # ── Verdict on current signals ─────────────────────────────────────────
    print("\n" + "─"*60)
    print("VERDICT: ARE YOUR CURRENT 5 SIGNALS ACTUALLY PREDICTIVE?")
    print("─"*60)

    in_system_features = [f for f in current_signals if f in importance]
    not_in_top = [f for f in current_signals if f not in importance]

    print(f"\n  Current system features found in model importance: {len(in_system_features)}/{len(current_signals)}")
    if not_in_top:
        print(f"  NOT used by model at all: {not_in_top}  (zero predictive value in this data)")

    print()
    for feat in sorted(in_system_features, key=lambda x: -importance.get(x,0)):
        rank = imp_df[imp_df['feature']==feat]['rank'].values
        pct  = importance.get(feat, 0) / total_gain * 100
        rank_str = f"#{rank[0]}" if len(rank) else 'unranked'
        print(f"  {feat:<25}  rank {rank_str:<6}  {pct:.2f}% of gain")

    # Top features NOT in current system
    top10 = imp_df.head(10)['feature'].tolist()
    new_winners = [f for f in top10 if f not in current_signals]
    print(f"\n  Top 10 features NOT currently in your system:")
    for f in new_winners:
        row  = imp_df[imp_df['feature']==f].iloc[0]
        lift = full_df.groupby(pd.qcut(full_df[f].rank(pct=True), 5, duplicates='drop'))['fwd_ret'].mean()
        spread = (lift.iloc[-1] - lift.iloc[0]) * 100
        print(f"    {f:<25}  rank #{row['rank']:<3}  {row['pct']:.2f}% gain  (Q5 vs Q1 fwd-ret spread: {spread:+.2f}%)")

    # ── FOMC stub notice ──────────────────────────────────────────────────
    print("\n" + "─"*60)
    print("TODO STUBS — DATA NOT AVAILABLE FROM ALPACA")
    print("─"*60)
    print("""
  vix_level       → TODO: Pull from CBOE (https://www.cboe.com/tradable_products/vix/)
                           or use VXX ETF as proxy (already fetched, limited history).
                           Likely high importance during regime-change periods.

  days_to_earnings → TODO: Polygon.io /v3/reference/events API (free tier available).
                           Earnings within 5 days historically increases volatility
                           and reduces signal reliability. Worth adding.

  dark_pool_ratio  → TODO: Requires paid subscription (Quandl FINRA/OTCBB data,
                           ~$50/month). Not essential for this scale.
    """)

    print(f"{'='*60}")
    print(f"  PHASE 2 COMPLETE — awaiting your review before Phase 3")
    print(f"{'='*60}\n")

if __name__ == '__main__':
    main()
