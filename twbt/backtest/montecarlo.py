"""蒙地卡羅測試：用歷史日報酬重新拼接出大量「沒發生過、但性質相似」的行情，看均線策略贏買進持有有多穩。

做法：stationary block bootstrap（Politis & Romano 1994）
- 從歷史日報酬裡隨機挑起點，連續取一段（長度平均 block 天、幾何分布），一段一段接起來
- 區塊越長，越保留原本的趨勢與波動聚集；block = 1 等於每天完全打亂（沒有趨勢），
  可以拿來當對照：策略的優勢如果來自「趨勢會延續」，打亂後應該消失
- 同一天的總報酬（損益用）和不含配息的價格報酬（訊號用）一起抽，兩者保持一致

每條路徑：前面 warmup 天讓均線累積（策略觀望、不計績效），之後 years 年比較策略與買進持有，
兩者同一天開始、都扣手續費與證交稅（策略的每次進出、買進持有的期初買與期末賣）。
整張交易：每條路徑從「現在的每股價格」（px0）出發，一張 1000 股、沒有分割；配息發現金（規則同 lots.py）。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .costs import TaiwanCost
from .lots import LOT, LotAccount
from .trend import ADD, EXIT, HOLD, RECOVER, TrendParams, signals

TRADING_DAYS = 252


def bootstrap_indices(n_src: int, length: int, block: float, rng: np.random.Generator) -> np.ndarray:
    """回傳長度 length 的來源索引。block = 平均區塊長度（天）。"""
    if block <= 1:
        return rng.integers(0, n_src, length)
    out = np.empty(length, dtype=np.int64)
    p = 1.0 / block
    i = 0
    while i < length:
        start = rng.integers(0, n_src)
        L = min(rng.geometric(p), length - i)
        idx = (start + np.arange(L)) % n_src          # 繞回開頭（stationary bootstrap 的標準做法）
        out[i:i + L] = idx
        i += L
    return out


def path_prices(ret: np.ndarray, sig_ret: np.ndarray, px0: float) -> tuple:
    """模擬路徑的每股價格與每股配息（第 0 天 = px0）。"""
    n = len(ret) + 1
    px, div = np.empty(n), np.zeros(n)
    px[0] = px0
    for j in range(1, n):
        r, s = ret[j - 1], sig_ret[j - 1]
        px[j] = px[j - 1] * (1 + s)
        if r != s:
            div[j] = px[j - 1] * (r - s) / (1 + r)
    return px, div


def _run_path(ret: np.ndarray, sig_ret: np.ndarray, p: TrendParams, warm: int,
              capital: float, cost: TaiwanCost, kind: str, px0: float = 100.0) -> tuple:
    px, div = path_prices(ret, sig_ret, px0)
    spx = np.concatenate([[1.0], np.cumprod(1 + sig_ret)])
    sig = signals(spx, p)
    act, status = sig["act"], sig["status"]
    si = warm                                          # 均線剛算得出來那天（觀望、全部現金）
    n = len(px)
    acct = LotAccount(capital, cost, kind)
    cash_at_exit = capital
    eq = np.empty(n - si)
    eq[0] = capital
    trades = 0
    for t in range(si + 1, n):
        a = act[t]
        if div[t] != 0:
            acct.cash += acct.shares * div[t]
        if a == RECOVER:
            acct.buy_max(acct.cash, px[t] * LOT, LOT); trades += 1
        elif a == ADD:
            acct.buy_max(cash_at_exit / p.pyramid_levels, px[t] * LOT, LOT); trades += 1
        elif a == EXIT:
            acct.sell_all(px[t] * LOT, LOT); cash_at_exit = acct.cash; trades += 1
        elif div[t] != 0 and status[t] == HOLD:
            acct.buy_max(acct.cash, px[t] * LOT, LOT)
        eq[t - si] = acct.value(px[t] * LOT, LOT)
    eq[-1] = acct.final_value(px[-1] * LOT, LOT)
    # 買進持有：同一天買最多張數、配息夠一張就再投入、最後一天賣出
    b = LotAccount(capital, cost, kind)
    b.buy_max(b.cash, px[si] * LOT, LOT)
    bh = np.empty(n - si)
    bh[0] = b.value(px[si] * LOT, LOT)
    for t in range(si + 1, n):
        if div[t] != 0:
            b.cash += b.shares * div[t]
            b.buy_max(b.cash, px[t] * LOT, LOT)
        bh[t - si] = b.value(px[t] * LOT, LOT)
    bh[-1] = b.final_value(px[-1] * LOT, LOT)
    return eq, bh, trades


def _stats(eq: np.ndarray, years: float, capital: float) -> tuple:
    net = eq[-1] / capital                               # 以投入金額為基準（期初買進的手續費也算進去，跟網頁版一樣）
    cagr = net ** (1 / years) - 1 if net > 0 else -1.0
    mdd = float((eq / np.maximum.accumulate(eq) - 1).min())
    return cagr, mdd


def monte_carlo(ret: pd.Series, sig_ret: pd.Series, params: TrendParams, *, n: int = 2000, years: float = 10,
                block: float = 60, seed: int = 0, capital: float = 1_000_000,
                cost: TaiwanCost | None = None, kind: str = "etf", px0: float = 100.0) -> pd.DataFrame:
    """回傳每條路徑一列：策略與買進持有的年化、回撤、進出次數。px0 = 路徑起點的每股價格（建議用最新收盤）。"""
    cost = cost or TaiwanCost()
    from ..data.synthetic import year_frac
    r = ret.to_numpy(dtype=float)
    s = sig_ret.reindex(ret.index).to_numpy(dtype=float)
    dt = year_frac(ret.index).to_numpy()
    ok = ~(np.isnan(r) | np.isnan(s))
    r, s, dt = r[ok], s[ok], dt[ok]
    warm = max(params.ma_fast, params.ma_slow) - 1
    ppy = len(r) / dt[1:].sum()                         # 取樣歷史平均一年幾個交易日（1990 年代比較多）
    length = warm + int(round(years * ppy))
    rng = np.random.default_rng(seed)
    rows = []
    for k in range(n):
        idx = bootstrap_indices(len(r), length, block, rng)
        eq, bh, trades = _run_path(r[idx], s[idx], params, warm, capital, cost, kind, px0)
        yrs = dt[idx[warm:]].sum()                      # 這條路徑實際經過的日曆時間
        sc, sm = _stats(eq, yrs, capital)
        bc, bm = _stats(bh, yrs, capital)
        rows.append((sc, sm, bc, bm, trades))
    return pd.DataFrame(rows, columns=["策略年化", "策略回撤", "持有年化", "持有回撤", "進出次數"])


def summarize_mc(df: pd.DataFrame, years: float = 10) -> dict:
    d = df["策略年化"] - df["持有年化"]
    return {
        "路徑數": len(df),
        "策略贏的機率": float((d > 0).mean()),
        "年化差 中位數": float(d.median()),
        "年化差 5%": float(d.quantile(0.05)),
        "年化差 95%": float(d.quantile(0.95)),
        "策略年化 中位數": float(df["策略年化"].median()),
        "持有年化 中位數": float(df["持有年化"].median()),
        "策略年化 5%": float(df["策略年化"].quantile(0.05)),
        "持有年化 5%": float(df["持有年化"].quantile(0.05)),
        "策略 10 年後虧損機率": float((df["策略年化"] < 0).mean()),
        "持有 10 年後虧損機率": float((df["持有年化"] < 0).mean()),
        "策略回撤 中位數": float(df["策略回撤"].median()),
        "持有回撤 中位數": float(df["持有回撤"].median()),
        "策略回撤 5%（很差的情況）": float(df["策略回撤"].quantile(0.05)),
        "持有回撤 5%（很差的情況）": float(df["持有回撤"].quantile(0.05)),
        "回撤比較小的機率": float((df["策略回撤"] > df["持有回撤"]).mean()),
        "年均進出次數": float(df["進出次數"].mean() / years),
    }
