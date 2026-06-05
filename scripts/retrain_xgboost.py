import json
import os
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
from dotenv import load_dotenv
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import train_test_split
from xgboost import XGBClassifier
from supabase import create_client

load_dotenv(".env.local")

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ALPACA_KEY = os.environ["ALPACA_API_KEY"]
ALPACA_SECRET = os.environ["ALPACA_SECRET_KEY"]

WATCHLIST = [
    "NVDA", "MSFT", "META", "GOOGL", "AAPL", "AMZN", "AMD", "TSM",
    "BRK.B", "LLY", "JPM", "COST", "UNH", "V",
    "LMT", "RTX", "NOC", "GD",
    "XOM", "CVX", "COP", "SLB",
    "QQQ", "SPY", "XLK",
]

SECTOR_ETF = {
    "NVDA": "XLK", "MSFT": "XLK", "META": "XLK", "GOOGL": "XLK",
    "AAPL": "XLK", "AMZN": "XLK", "AMD": "XLK", "TSM": "XLK",
    "BRK.B": "XLF", "JPM": "XLF", "V": "XLF",
    "LLY": "XLV", "UNH": "XLV",
    "COST": "XLP",
    "LMT": "ITA", "RTX": "ITA", "NOC": "ITA", "GD": "ITA",
    "XOM": "XLE", "CVX": "XLE", "COP": "XLE", "SLB": "XLE",
    "QQQ": "SPY", "SPY": "SPY", "XLK": "XLK",
}


def alpaca_bars(symbol, start, end):
    url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
    params = {
        "timeframe": "1Day",
        "start": start,
        "end": end,
        "limit": 1000,
        "feed": "iex",
    }
    headers = {
        "APCA-API-KEY-ID": ALPACA_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET,
    }
    response = requests.get(url, params=params, headers=headers, timeout=30)
    response.raise_for_status()
    bars = response.json().get("bars", [])
    if not bars:
      return pd.DataFrame()
    frame = pd.DataFrame(bars)
    frame["date"] = pd.to_datetime(frame["t"]).dt.date.astype(str)
    return frame.rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})


def rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def enrich_decisions(decisions):
    start = (datetime.now(timezone.utc) - timedelta(days=800)).date().isoformat()
    end = datetime.now(timezone.utc).date().isoformat()
    bars_by_symbol = {}
    for symbol in set(WATCHLIST + ["SPY"] + list(SECTOR_ETF.values())):
        try:
            bars_by_symbol[symbol] = alpaca_bars(symbol, start, end)
        except Exception as exc:
            print(f"warn: could not fetch bars for {symbol}: {exc}")
            bars_by_symbol[symbol] = pd.DataFrame()

    rows = []
    last_signal_by_ticker = {}
    spy = bars_by_symbol.get("SPY", pd.DataFrame()).copy()
    if not spy.empty:
        spy["spy_rsi_at_signal"] = rsi(spy["close"])

    for decision in decisions:
        ticker = decision.get("ticker") or decision.get("symbol")
        if not ticker:
            continue
        date = str(decision.get("date") or decision.get("created_at"))[:10]
        bars = bars_by_symbol.get(ticker, pd.DataFrame()).copy()
        if bars.empty:
            continue
        bars = bars[bars["date"] <= date].copy()
        if len(bars) < 21:
            continue

        bars["rsi"] = rsi(bars["close"])
        bars["ma200"] = bars["close"].rolling(200).mean()
        bars["avg_volume_20"] = bars["volume"].rolling(20).mean()
        latest = bars.iloc[-1]
        prev3 = bars.iloc[-4] if len(bars) >= 4 else latest

        sector_symbol = SECTOR_ETF.get(ticker, "SPY")
        sector_bars = bars_by_symbol.get(sector_symbol, pd.DataFrame())
        sector_5day_return = None
        if len(sector_bars) >= 6:
            sector_window = sector_bars[sector_bars["date"] <= date]
            if len(sector_window) >= 6:
                sector_5day_return = (sector_window.iloc[-1]["close"] / sector_window.iloc[-6]["close"]) - 1

        spy_rsi_at_signal = None
        if not spy.empty:
            spy_row = spy[spy["date"] <= date].tail(1)
            if not spy_row.empty:
                spy_rsi_at_signal = spy_row.iloc[0]["spy_rsi_at_signal"]

        last_signal = last_signal_by_ticker.get(ticker)
        days_since_last_signal = 999 if not last_signal else (
            datetime.fromisoformat(date) - datetime.fromisoformat(last_signal)
        ).days
        last_signal_by_ticker[ticker] = date

        outcome = decision.get("outcomes", [{}])[0] if decision.get("outcomes") else {}
        if outcome.get("win") is None:
            continue

        rows.append({
            "ticker": ticker,
            "win": bool(outcome["win"]),
            "rsi_3day_slope": float(latest["rsi"] - rsi(bars["close"]).iloc[-4]) if pd.notna(prev3["close"]) else 0,
            "relative_volume": float(latest["volume"] / latest["avg_volume_20"]) if latest["avg_volume_20"] else 0,
            "distance_from_200ma": float((latest["close"] / latest["ma200"]) - 1) if pd.notna(latest["ma200"]) else 0,
            "spy_rsi_at_signal": float(spy_rsi_at_signal) if pd.notna(spy_rsi_at_signal) else 50,
            "sector_etf_5day_return": float(sector_5day_return) if sector_5day_return is not None else 0,
            "days_since_last_signal_on_ticker": days_since_last_signal,
        })
    return pd.DataFrame(rows)


def main():
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    response = supabase.table("decisions").select("*, outcomes(*)").eq("outcome_resolved", True).execute()
    decisions = response.data or []
    frame = enrich_decisions(decisions)

    if len(frame) < 30 or frame["win"].nunique() < 2:
        print(f"Skipping retrain: need at least 30 labeled mixed outcomes, got {len(frame)}")
        return

    features = [
        "rsi_3day_slope",
        "relative_volume",
        "distance_from_200ma",
        "spy_rsi_at_signal",
        "sector_etf_5day_return",
        "days_since_last_signal_on_ticker",
    ]
    train, test = train_test_split(frame, test_size=0.25, random_state=42, stratify=frame["win"])
    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.08,
        subsample=0.9,
        colsample_bytree=0.9,
        eval_metric="logloss",
    )
    model.fit(train[features], train["win"])

    probabilities = model.predict_proba(test[features])[:, 1]
    predictions = probabilities >= 0.5
    metrics = {
        "accuracy": accuracy_score(test["win"], predictions),
        "roc_auc": roc_auc_score(test["win"], probabilities),
        "samples": len(frame),
    }
    feature_importance = dict(zip(features, model.feature_importances_.tolist()))
    model_version = f"xgb-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"

    score_rows = []
    latest_by_ticker = frame.sort_values("days_since_last_signal_on_ticker").drop_duplicates("ticker")
    for _, row in latest_by_ticker.iterrows():
        feature_values = row[features].to_dict()
        probability = float(model.predict_proba(pd.DataFrame([feature_values]))[0][1])
        score_rows.append({
            "ticker": row["ticker"],
            "probability": probability,
            "feature_values": feature_values,
            "model_version": model_version,
        })

    if score_rows:
        supabase.table("xgboost_scores").insert(score_rows).execute()

    supabase.table("model_history").insert({
        "model_version": model_version,
        "metrics": json.loads(json.dumps(metrics)),
        "feature_importance": json.loads(json.dumps(feature_importance)),
        "artifact_path": None,
    }).execute()

    print(json.dumps({
        "model_version": model_version,
        "metrics": metrics,
        "feature_importance": feature_importance,
        "scores_written": len(score_rows),
    }, indent=2))


if __name__ == "__main__":
    main()
