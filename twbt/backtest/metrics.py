"""績效指標。輸入是每日資產淨值序列。"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def underwater(equity: pd.Series) -> dict:
    """回撤與套牢期（水下期）。

    套牢 = 從前高（跌之前最後一天在最高點）到淨值回到 ≥ 前高的那天；期末還沒回到前高就算到期末，recovery = None。
    回傳：
      mdd、top、trough、recovery：最大回撤那一次的深度、高點日、低點日、回到前高的日子
      longest：最長的一次套牢 {"depth", "top", "trough", "recovery", "years"}（一樣長取最早那次；從沒跌過 = None）
    時間用日曆天 ÷ 365.25。
    """
    idx, v = equity.index, equity.to_numpy(dtype=float)
    end = idx[-1]
    eps = []                                       # (高點位置, 低點位置, 回到前高位置或 None)
    peak_at, low_at, under = 0, 0, False
    for i in range(1, len(v)):
        if v[i] >= v[peak_at]:
            if under:
                eps.append((peak_at, low_at, i))
                under = False
            peak_at = i                            # 一樣高也往後移：高點 = 開始下跌前的最後一天
        elif not under or v[i] < v[low_at]:
            low_at, under = i, True
    if under:
        eps.append((peak_at, low_at, None))
    out = {"mdd": 0.0, "top": idx[0], "trough": idx[0], "recovery": idx[0], "longest": None}
    best = 0.0
    for t, lo, r in eps:
        depth = v[lo] / v[t] - 1
        if depth < out["mdd"]:
            out.update(mdd=float(depth), top=idx[t], trough=idx[lo], recovery=idx[r] if r is not None else None)
        years = ((idx[r] if r is not None else end) - idx[t]).days / 365.25
        if out["longest"] is None or years > best:
            best = years
            out["longest"] = {"depth": float(depth), "top": idx[t], "trough": idx[lo],
                              "recovery": idx[r] if r is not None else None, "years": years}
    return out


def max_drawdown(equity: pd.Series) -> tuple[float, pd.Timestamp, pd.Timestamp, pd.Timestamp | None]:
    """回傳 (最大回撤, 高點日, 低點日, 回到前高的日子或 None)。"""
    u = underwater(equity)
    return u["mdd"], u["top"], u["trough"], u["recovery"]


def longest_uw(eq, t) -> tuple[float, bool]:
    """最長套牢（年）與它到期末是不是還沒結束；定義同 underwater()，t = 每個點的時間（年，遞增）。

    蒙地卡羅的模擬行情沒有日期，用這個（t = 累積經過的日曆年數）。
    """
    peak, peak_t, under, best, is_open = eq[0], t[0], False, 0.0, False
    for i in range(1, len(eq)):
        if eq[i] >= peak:
            if under:
                d = t[i] - peak_t
                if d > best:
                    best = d
                under = False
            peak, peak_t = eq[i], t[i]
        else:
            under = True
    if under and t[-1] - peak_t > best:          # 一樣長取最早那次（跟 underwater() 一樣）
        best, is_open = t[-1] - peak_t, True
    return float(best), is_open


def uw_stats(eq, index, prefix: str = "") -> dict:
    """多區間用：這段期間最長套牢幾年、到期末是不是還沒回到前高（那最長套牢只是「至少」）。"""
    lg = underwater(pd.Series(eq, index=index))["longest"]
    return {f"{prefix}最長套牢": lg["years"] if lg else 0.0, f"{prefix}套牢未結束": bool(lg and lg["recovery"] is None)}


def years_between(a, b) -> float:
    return (b - a).days / 365.25


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
    u = underwater(e)
    mdd, top, trough, rec = u["mdd"], u["top"], u["trough"], u["recovery"]
    lg = u["longest"]
    yearly = e.resample("YE").last().pct_change()
    yearly.iloc[0] = e.resample("YE").last().iloc[0] / e.iloc[0] - 1
    return {
        "起始日": e.index[0].date(), "結束日": e.index[-1].date(), "年數": round(years, 2),
        "總報酬": total, "年化報酬": cagr, "年化波動": vol,
        "夏普": sharpe, "索提諾": sortino,
        "最大回撤": mdd, "回撤高點": top.date(), "回撤低點": trough.date(),
        "回到前高": rec.date() if rec is not None else "尚未",
        "下跌期": years_between(top, trough), "回復期": years_between(trough, rec if rec is not None else e.index[-1]),
        "最長套牢": lg["years"] if lg else 0.0,
        "最長套牢期間": f"{lg['top'].date()} ~ {lg['recovery'].date() if lg['recovery'] is not None else '尚未回到前高'}" if lg else "－",
        "套牢未結束": bool(lg and lg["recovery"] is None),
        "卡瑪": cagr / abs(mdd) if mdd < 0 else float("nan"),
        "最好年度": yearly.max(), "最差年度": yearly.min(),
    }
