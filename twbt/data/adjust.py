"""還原股價：把除權息、分割的影響「還原」回去，讓價格序列能直接算報酬。

做法（向後還原，最新一天 = 實際價格）：
  每個事件日 t 有一個調整係數 f_t = 參考價 / 前一交易日收盤價
    - 配息：f = 除息參考價 / 除息前收盤（證交所 TWT49U 官方數字）
    - 分割 1 拆 N：f = 1 / N
  還原價_t = 原始價_t × (t 之後所有事件係數的連乘)
  每日總報酬 = 收盤_t / (收盤_{t-1} × f_t) − 1（配息視為再投入）
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

SPLITS_CSV = Path(__file__).with_name("splits.csv")


def load_splits(code: str | None = None) -> pd.DataFrame:
    df = pd.read_csv(SPLITS_CSV, dtype={"code": str})
    return df[df.code == code] if code else df


def event_factors(prices: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """把事件轉成每日調整係數。prices 需有 date(index)、close；events 需有 date、kind、ref_price、ratio。"""
    close = prices["close"]
    prev_close = close.shift(1)
    out = []
    for _, e in events.iterrows():
        t = pd.Timestamp(e["date"])
        if t not in close.index:
            # 事件日沒有成交（例如分割後幾天才恢復），掛到之後第一個交易日
            later = close.index[close.index > t]
            if later.empty:
                continue
            t = later[0]
        pc = prev_close.get(t)
        if e["kind"] == "split":
            f = 1.0 / e["ratio"]
            desc = f"分割 1拆{e['ratio']:g}"
        else:
            f = e["ref_price"] / e["prev_close"]
            desc = f"{e['kind']} {e['value']:g} 元"
            # 交叉檢查：證交所記錄的除權息前收盤，應等於我們資料的前一日收盤
            if pc is not None and not np.isnan(pc) and abs(pc - e["prev_close"]) > 0.011:
                desc += f"（注意：前收 {pc} 與官方 {e['prev_close']} 不同）"
        out.append({"date": t, "factor": f, "split": f if e["kind"] == "split" else 1.0, "event": desc})
    if not out:
        return pd.DataFrame(columns=["factor", "split", "event"], index=pd.DatetimeIndex([], name="date"))
    df = pd.DataFrame(out).groupby("date").agg(factor=("factor", "prod"), split=("split", "prod"),
                                               event=("event", "; ".join))
    return df


def adjust(prices: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    """回傳含原始價、還原價、每日總報酬的表。"""
    p = prices.sort_index().copy()
    fac = event_factors(p, events)
    p["factor"] = fac["factor"].reindex(p.index).fillna(1.0)
    p["event"] = fac["event"].reindex(p.index).fillna("")
    # t 之後所有事件係數連乘：從尾巴往前累乘，再錯開一天
    after = p["factor"][::-1].cumprod()[::-1].shift(-1).fillna(1.0)
    p["adj_factor"] = after
    for c in ("open", "high", "low", "close"):
        p[f"adj_{c}"] = p[c] * after
    p["ret"] = p["close"] / (p["close"].shift(1) * p["factor"]) - 1
    # 只還原分割、不含股息的「價格報酬」（用來模擬正2，因為正2追蹤的是價格指數）
    split = fac["split"].reindex(p.index).fillna(1.0)
    p["price_ret"] = p["close"] / (p["close"].shift(1) * split) - 1
    return p


def unexplained_jumps(adj: pd.DataFrame, limit: float) -> pd.DataFrame:
    """找出「沒有事件卻大幅跳動」的日子：通常代表漏掉分割或配息。"""
    big = adj["ret"].abs() > limit
    x_day = adj["change"].isna() & adj["close"].notna() & (adj["event"] == "")
    x_day.iloc[0] = False
    bad = adj[big | x_day]
    return bad[["close", "change", "ret", "event"]]
