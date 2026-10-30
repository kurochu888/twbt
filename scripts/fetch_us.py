"""下載美股原始資料（Yahoo Finance，yfinance）到 data/source_us/。

每檔一個 CSV：date, open, high, low, close, adj_close, volume, dividends, splits
- close：只還原分割的收盤（Yahoo 的 Close）；adj_close：還原分割與配息（Yahoo 的 Adj Close）
- dividends：除息日每股配息（以當時股數計，Yahoo 已換算成現在的股）；splits：分割倍數（0 = 沒有）
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "source_us"
# Nasdaq-100 含息報酬指數（^XNDX）Yahoo 只給最近幾天，含息基準改用 QQQ 推算（見 update_us.py）
TICKERS = {"NDX": "^NDX", "QQQ": "QQQ", "QLD": "QLD"}


def fetch(symbol: str) -> pd.DataFrame:
    import yfinance as yf
    try:
        h = yf.Ticker(symbol).history(period="max", auto_adjust=False, actions=True)
    except Exception:                                # noqa: BLE001
        h = pd.DataFrame()
    if h.empty:                                      # 有些指數不給 period="max"，改用起始日
        h = yf.Ticker(symbol).history(start="1985-01-01", auto_adjust=False, actions=True)
    if h.empty:
        raise RuntimeError(f"{symbol} 沒有資料")
    h.index = pd.DatetimeIndex(h.index).tz_localize(None).normalize()
    h = h.rename(columns={"Open": "open", "High": "high", "Low": "low", "Close": "close",
                          "Adj Close": "adj_close", "Volume": "volume", "Dividends": "dividends",
                          "Stock Splits": "splits"})
    cols = ["open", "high", "low", "close", "adj_close", "volume", "dividends", "splits"]
    for c in cols:
        if c not in h:
            h[c] = 0.0
    h = h[cols]
    h = h[~h.index.duplicated(keep="last")].dropna(subset=["close"])
    h.index.name = "date"
    return h


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    ok = True
    for name, sym in TICKERS.items():
        try:
            df = fetch(sym)
        except Exception as e:                       # noqa: BLE001
            print(f"{name}: 失敗 {e}")
            ok = False
            continue
        df.to_csv(OUT / f"{name}.csv", float_format="%.10g")
        print(f"{name}: {len(df)} 天 {df.index[0].date()} ~ {df.index[-1].date()}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
