"""資料品質檢查：抓出可疑的資料列，回測前先看一眼。"""
from __future__ import annotations

import pandas as pd

# 台股漲跌幅限制：2015-06-01 起 10%，之前 7%
LIMIT_CHANGE_DATE = pd.Timestamp("2015-06-01")


def check_stock(df: pd.DataFrame) -> pd.DataFrame:
    """檢查單一股票的日K（store.load() 的輸出）。回傳有問題的列與原因。"""
    issues = []
    d = df.copy()
    traded = d["close"].notna()

    # 1. OHLC 互相矛盾
    bad_ohlc = traded & ((d["low"] > d[["open", "close"]].min(axis=1)) |
                         (d["high"] < d[["open", "close"]].max(axis=1)) |
                         (d["low"] <= 0))
    for t in d.index[bad_ohlc]:
        issues.append((t, "OHLC 不合理"))

    # 2. 前一日收盤 + 漲跌價差 應等於今天收盤（除權息等「不比價」日除外）
    prev_close = d["close"].where(traded).ffill().shift(1)
    expect = prev_close + d["change"]
    mismatch = traded & (d["no_compare"] == 0) & prev_close.notna() & \
        ((expect - d["close"]).abs() > 0.011)
    for t in d.index[mismatch]:
        issues.append((t, f"漲跌價差對不上（預期 {expect[t]:.2f}，實際 {d.at[t, 'close']:.2f}）"))

    # 3. 漲跌幅超過當時的漲跌停限制
    ref = d["close"] - d["change"]
    pct = (d["change"] / ref).abs()
    limit = pd.Series(0.07, index=d.index).where(d.index < LIMIT_CHANGE_DATE, 0.10)
    over = traded & (d["no_compare"] == 0) & (pct > limit + 0.005)
    for t in d.index[over]:
        issues.append((t, f"漲跌幅 {pct[t]:.1%} 超過限制"))

    return pd.DataFrame(issues, columns=["date", "issue"]).sort_values("date")
