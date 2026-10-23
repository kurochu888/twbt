"""上市前的模擬序列：讓回測能涵蓋 0050、正2 還沒上市的年代（例如 2000 年網路泡沫）。

原則：
- 模擬參數一律用「真實資料重疊期間」校正，而不是憑感覺設定。
- 輸出欄位 is_synthetic 標示哪幾天是模擬的，報告裡要能看出來。

三種模擬：
1. 大盤含息報酬（報酬指數公布前）：價格指數報酬 + 每日股息估計
   股息估計 = 報酬指數與價格指數在重疊期間的年化差距
2. 0050（上市前）：大盤含息報酬 + 校正後的年化差距（費用、成分股差異）
3. 正2（上市前）：2 × 標的「價格」指數日報酬 + 校正後的年化常數
   正2 主要持有期貨，期貨價格不含股息，所以用價格指數；常數吸收了
   現金利息、管理費、期貨轉倉成本等。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def annualized_gap(a: pd.Series, b: pd.Series) -> float:
    """兩個日報酬序列在重疊期間的「平均每日差距 × 252」。"""
    df = pd.concat([a, b], axis=1, keys=["a", "b"], sort=True).astype(float).dropna()
    if len(df) < 60:
        raise ValueError("重疊期間太短，無法校正")
    return float((np.log1p(df["a"]) - np.log1p(df["b"])).mean() * TRADING_DAYS)


def market_total_return(price_close: pd.Series, tr_close: pd.Series) -> tuple[pd.Series, dict]:
    """大盤每日含息報酬。有報酬指數用報酬指數，之前用「價格報酬 + 估計股息」。"""
    px_ret = price_close.pct_change()
    tr_ret = tr_close.reindex(price_close.index).pct_change()
    dy = annualized_gap(tr_ret, px_ret)            # 年化股息估計
    first_tr = tr_close.dropna().index[1]          # 報酬指數第一個有報酬的日子
    est = np.expm1(np.log1p(px_ret) + dy / TRADING_DAYS)
    ret = tr_ret.where(tr_ret.index >= first_tr, est)
    info = {"股息估計（年化）": dy, "報酬指數起日": first_tr.date().isoformat()}
    return ret, info


def calibrate_leverage(real_ret: pd.Series, base_ret: pd.Series, leverage: float = 2.0) -> float:
    """找出年化常數 c，使模擬正2在重疊期間的「累積報酬」等於真實正2（二分法求解）。

    用累積報酬而不是平均日報酬來校正，因為長期回測最在意的是最後累積了多少。
    """
    df = pd.concat([real_ret, base_ret], axis=1, keys=["real", "base"], sort=True).astype(float).dropna()
    if len(df) < 60:
        raise ValueError("重疊期間太短，無法校正")
    target = np.log1p(df["real"]).sum()

    def total(c):
        return np.log1p(leveraged_return(df["base"], c, leverage)).sum()

    lo, hi = -0.5, 0.5
    for _ in range(100):
        mid = (lo + hi) / 2
        if total(mid) < target:
            lo = mid
        else:
            hi = mid
    return float((lo + hi) / 2)


def leveraged_return(base_ret: pd.Series, annual_c: float, leverage: float = 2.0) -> pd.Series:
    """每日重新平衡的槓桿報酬。單日虧損最多 -100%（實際上不會發生，保護用）。"""
    r = leverage * base_ret + np.expm1(annual_c / TRADING_DAYS)
    return r.clip(lower=-0.999)


def shift_return(base_ret: pd.Series, annual_gap: float) -> pd.Series:
    """在基準報酬上加一個年化差距（對數空間）。"""
    return np.expm1(np.log1p(base_ret) + annual_gap / TRADING_DAYS)


def splice(real: pd.DataFrame, synth_ret: pd.Series) -> pd.DataFrame:
    """把模擬報酬接在真實資料前面。

    real：adjust() 的輸出（需有 ret、adj_close、close）
    回傳：date 索引的 ret、adj_close（含模擬段，與真實段在接點連續）、is_synthetic
    """
    # 統一日期格式（不同來源的時間精度可能不同，混在一起會出錯）
    real = real.copy()
    real.index = pd.DatetimeIndex(real.index).astype("datetime64[ns]")
    synth_ret = synth_ret.copy()
    synth_ret.index = pd.DatetimeIndex(synth_ret.index).astype("datetime64[ns]")

    start = real.index[0]
    pre = synth_ret[synth_ret.index < start].dropna()
    real_ret = real["ret"].astype(float).copy()
    # 真實資料第一天沒有前一日可比，用模擬報酬補上那一天
    real_ret.iloc[0] = synth_ret.get(start, 0.0) if not pre.empty else np.nan
    ret = pd.concat([pre, real_ret]).sort_index()
    # 上市第一天的報酬也是模擬值（沒有前一天的真實價格可比），一併標成模擬
    is_syn = pd.Series((ret.index <= start) if not pre.empty else (ret.index < start), index=ret.index)
    # 從接點往回推模擬段的還原價：P_{t-1} = P_t / (1 + r_t)
    adj = real["adj_close"].astype(float).reindex(ret.index)
    if not pre.empty:
        growth = (1 + ret).loc[:start]                 # 含接點當天
        back = growth[::-1].cumprod()[::-1]            # 從 t 到接點的累積
        p0 = real["adj_close"].iloc[0]
        # back[t] 含 t 當天的報酬，價格只需要 t 之後到接點的連乘
        adj.loc[pre.index] = p0 / (back.loc[pre.index] / (1 + ret.loc[pre.index])).values
    out = pd.DataFrame({"ret": ret, "adj_close": adj, "is_synthetic": is_syn.astype(int)})
    out.index.name = "date"
    return out
