"""買進持有回測：自訂區間、固定長度滾動、隨機區間。

規則：
- 起始日（含）之後第一個交易日，以收盤價全額買進（扣買進手續費）
- 期間配息自動再投入（用總報酬計算）
- 結束日（含）之前最後一個交易日，以收盤價全部賣出（扣手續費與證交稅）
- 大盤（TAIEX）是比較基準，不扣任何成本
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .costs import TaiwanCost
from .data import KIND, NAMES, load_returns
from .metrics import TRADING_DAYS, summarize


class BuyHold:
    def __init__(self, data_dir: str | Path, use_synthetic: bool = True,
                 capital: float = 1_000_000, cost: TaiwanCost | None = None, rf: float = 0.0,
                 tw50_excess: bool = True):
        self.rets, self.syn = load_returns(data_dir, use_synthetic, tw50_excess)
        self.data_dir, self.tw50_excess = data_dir, tw50_excess
        self.capital = capital
        self.cost = cost or TaiwanCost()
        self.rf = rf
        self.use_synthetic = use_synthetic

    # ---------- 單一區間 ----------
    def _bounds(self, start, end) -> tuple[pd.Timestamp, pd.Timestamp]:
        idx = self.rets.index
        s = idx[idx >= pd.Timestamp(start)]
        e = idx[idx <= pd.Timestamp(end)]
        if s.empty or e.empty or s[0] >= e[-1]:
            raise ValueError(f"區間 {start} ~ {end} 沒有足夠的交易日")
        return s[0], e[-1]

    def equity(self, asset: str, start, end) -> pd.Series:
        """每日資產淨值（期末已扣賣出成本）。"""
        s, e = self._bounds(start, end)
        r = self.rets.loc[s:e, asset]
        if r.iloc[1:].isna().any():
            first = self.rets[asset].first_valid_index()
            raise ValueError(f"{asset} 在 {s.date()} ~ {e.date()} 有缺資料"
                             f"（真實資料從 {first.date() if first is not None else '－'} 起）；"
                             f"可改用 use_synthetic=True 或調整區間")
        kind = KIND[asset]
        invested = self.capital - self.cost.buy_cost(self.capital, kind)
        growth = (1 + r.iloc[1:]).cumprod()
        eq = pd.concat([pd.Series([invested], index=[s]), invested * growth])
        final = eq.iloc[-1]
        eq.iloc[-1] = final - self.cost.sell_cost(final, kind)
        return eq

    def period(self, start, end, assets=None) -> tuple[pd.DataFrame, pd.DataFrame]:
        """自訂區間。回傳 (指標表, 各標的淨值曲線)。"""
        assets = assets or list(self.rets.columns)
        stats, curves = {}, {}
        for a in assets:
            try:
                eq = self.equity(a, start, end)
            except ValueError as err:
                print(f"略過 {a}：{err}")
                continue
            st = summarize(eq, self.rf)
            st["期末金額"] = eq.iloc[-1]
            s, e = eq.index[0], eq.index[-1]
            st["模擬資料占比"] = self.syn.loc[s:e, a].mean()
            stats[NAMES[a]] = st
            curves[NAMES[a]] = eq
        return pd.DataFrame(stats), pd.DataFrame(curves)

    # ---------- 多個區間 ----------
    def _window_stats(self, asset: str, s: pd.Timestamp, e: pd.Timestamp) -> dict | None:
        r = self.rets[asset].loc[s:e].iloc[1:].to_numpy()
        if len(r) < 20 or np.isnan(r).any():
            return None
        kind = KIND[asset]
        inv = 1 - self.cost.buy_cost(self.capital, kind) / self.capital
        eq = inv * np.cumprod(1 + r)
        final = eq[-1] * self.capital
        final_net = (final - self.cost.sell_cost(final, kind)) / self.capital
        years = (e - s).days / 365.25
        path = np.concatenate([[inv], eq])
        mdd = float((path / np.maximum.accumulate(path) - 1).min())
        return {
            "起始日": s.date(), "結束日": e.date(), "年數": years,
            "總報酬": final_net - 1,
            "年化報酬": final_net ** (1 / years) - 1 if final_net > 0 else -1.0,
            "最大回撤": mdd,
            "年化波動": float(np.std(r, ddof=1) * np.sqrt(len(r) / years)),
            "模擬資料占比": float(self.syn[asset].loc[s:e].mean()),
        }

    def windows(self, windows: list[tuple], assets=None) -> pd.DataFrame:
        """對一組 (起, 迄) 區間逐一回測，回傳長表：每列 = 一個區間 × 一個標的。"""
        assets = assets or list(self.rets.columns)
        rows = []
        for start, end in windows:
            try:
                s, e = self._bounds(start, end)
            except ValueError:
                continue
            for a in assets:
                st = self._window_stats(a, s, e)
                if st:
                    rows.append({"標的": NAMES[a], **st})
        return pd.DataFrame(rows)

    def rolling(self, years: float, assets=None, step: str = "MS",
                first=None, last=None) -> pd.DataFrame:
        """固定長度滾動：每個 step（預設每月初）一個起點，長度 years 年。"""
        idx = self.rets.index
        first = pd.Timestamp(first) if first else idx[0]
        last = pd.Timestamp(last) if last else idx[-1]
        length = pd.DateOffset(months=round(years * 12))
        # 從第一個月的月初開始（起點會自動對齊到之後第一個交易日）
        starts = pd.date_range(first.to_period("M").to_timestamp(), last - length, freq=step)
        return self.windows([(s, s + length) for s in starts], assets)

    def random(self, n: int, years, assets=None, seed: int | None = 42,
               first=None, last=None) -> pd.DataFrame:
        return self.windows(self.random_windows(n, years, seed, first, last), assets)

    def random_windows(self, n: int, years, seed: int | None = 42, first=None, last=None) -> list:
        """隨機區間：起點隨機；years 可以是固定值（例如 10）或範圍（例如 (5, 15)）。

        seed 固定時結果可以重現；seed=None 每次都不同。
        """
        rng = np.random.default_rng(seed)
        idx = self.rets.index
        first = pd.Timestamp(first) if first else idx[0]
        last = pd.Timestamp(last) if last else idx[-1]
        lo, hi = (years, years) if np.isscalar(years) else years
        wins = []
        for _ in range(n * 3):                     # 多抽一些，扔掉超出範圍的
            L = rng.uniform(lo, hi)
            length = pd.DateOffset(months=max(1, round(L * 12)))
            latest = last - length
            if latest <= first:
                raise ValueError(f"資料期間不夠 {hi} 年")
            span = (latest - first).days
            s = first + pd.Timedelta(days=int(rng.integers(0, span + 1)))
            wins.append((s, s + length))
            if len(wins) >= n:
                break
        return wins


def describe(results: pd.DataFrame, col: str = "年化報酬") -> pd.DataFrame:
    """把多區間的結果整理成分布摘要（每個標的一欄）。"""
    def q(p):
        return lambda x: x.quantile(p)
    g = results.groupby("標的", sort=False)
    out = pd.DataFrame({
        "區間數": g[col].count(),
        "平均": g[col].mean(),
        "最差": g[col].min(),
        "5%": g[col].agg(q(0.05)),
        "25%": g[col].agg(q(0.25)),
        "中位數": g[col].median(),
        "75%": g[col].agg(q(0.75)),
        "95%": g[col].agg(q(0.95)),
        "最好": g[col].max(),
    })
    if col in ("年化報酬", "總報酬"):
        out["虧損機率"] = g["總報酬"].agg(lambda x: (x < 0).mean())
    return out.T


def worst_best(results: pd.DataFrame, col: str = "年化報酬") -> pd.DataFrame:
    """每個標的最差、最好的區間是哪一段。"""
    rows = []
    for name, g in results.groupby("標的", sort=False):
        for label, i in (("最差", g[col].idxmin()), ("最好", g[col].idxmax())):
            r = g.loc[i]
            rows.append({"標的": name, "": label, "起始日": r["起始日"], "結束日": r["結束日"],
                         col: r[col], "最大回撤": r["最大回撤"]})
    return pd.DataFrame(rows)


def win_rate(results: pd.DataFrame, a: str, b: str, col: str = "年化報酬") -> float:
    """同一組區間裡，標的 a 勝過 b 的比例。"""
    p = results.pivot_table(index=["起始日", "結束日"], columns="標的", values=col)
    p = p[[a, b]].dropna()
    return float((p[a] > p[b]).mean())
