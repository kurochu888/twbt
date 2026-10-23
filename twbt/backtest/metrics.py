"""績效指標。輸入是每日資產淨值序列。"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def max_drawdown(equity: pd.Series) -> tuple[float, pd.Timestamp, pd.Timestamp, pd.Timestamp | None]:
    """回傳 (最大回撤, 高點日, 低點日, 回到前高的日子或 None)。"""
    peak = equity.cummax()
    dd = equity / peak - 1
    trough = dd.idxmin()
    top = equity.loc[:trough].idxmax()
    after = equity.loc[trough:]
    rec = after[after >= equity.loc[top]]
    return float(dd.min()), top, trough, (rec.index[0] if len(rec) else None)


def summarize(equity: pd.Series, rf: float = 0.0) -> dict:
    """常用指標。rf = 年化無風險利率（計算夏普用）。"""
    e = equity.dropna()
    years = (e.index[-1] - e.index[0]).days / 365.25
    total = e.iloc[-1] / e.iloc[0] - 1
    cagr = (1 + total) ** (1 / years) - 1 if years > 0 and total > -1 else float("nan")
    r = e.pct_change().dropna()
    # 年化用「這段期間平均一年幾個交易日」，不是固定 252（1990 年代週六也開盤，一年 280 天左右）
    ppy = len(r) / years if years > 0 else TRADING_DAYS
    vol = r.std() * np.sqrt(ppy)
    ex = r - rf / ppy
    sharpe = ex.mean() / r.std() * np.sqrt(ppy) if r.std() > 0 else float("nan")
    down = r[r < 0]
    sortino = ex.mean() / down.std() * np.sqrt(ppy) if len(down) > 1 else float("nan")
    mdd, top, trough, rec = max_drawdown(e)
    yearly = e.resample("YE").last().pct_change()
    yearly.iloc[0] = e.resample("YE").last().iloc[0] / e.iloc[0] - 1
    return {
        "起始日": e.index[0].date(), "結束日": e.index[-1].date(), "年數": round(years, 2),
        "總報酬": total, "年化報酬": cagr, "年化波動": vol,
        "夏普": sharpe, "索提諾": sortino,
        "最大回撤": mdd, "回撤高點": top.date(), "回撤低點": trough.date(),
        "回到前高": rec.date() if rec is not None else "尚未",
        "卡瑪": cagr / abs(mdd) if mdd < 0 else float("nan"),
        "最好年度": yearly.max(), "最差年度": yearly.min(),
    }
