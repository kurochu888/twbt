"""均線策略參數穩健性檢查：參數掃描（熱力圖）、樣本內外、walk-forward。

想回答的問題：預設參數（正2 快線 120、出場 0.90…）是真的有效，還是剛好貼合過去？
- 參數掃描：兩個參數各取一排值、其他照預設，每一組都跑一次。好的參數附近應該是一片「高原」，
  換成相鄰的值結果差不多；只有一個尖峰、旁邊都差很多 = 過度擬合
- 樣本內外：前一段挑參數、後一段驗證。前段排名好的組合，後段也要排名好才算數（看兩段排名的相關係數）
- walk-forward：每隔幾年用「到當時為止」的歷史重挑一次參數，接下來幾年照用，接起來看整段績效；
  這是「當時的人實際做得到的」最佳化，拿來跟一直用預設參數、買進持有比

做法：每一組參數都從同一天開始照策略操作到期末（跟 TrendBacktest 一樣扣成本、整張交易），
同一天開始 = 所有組合裡均線最晚算得出來的那天，避免均線短的組合多跑一段開頭。
各段績效直接從這條淨值切出來（= 那段期間一直照策略操作的人看到的），所以切出的每段不含期初買、期末賣的成本
（一次進出約 0.2%～0.4%，跟參數之間的差距比起來很小）；walk-forward 換參數那天也不另外算調整部位的成本。
"""
from __future__ import annotations

import itertools
from dataclasses import asdict, replace

import numpy as np
import pandas as pd

from .metrics import longest_uw

OBJECTIVES = {"年化": "年化", "報酬回撤比": "報酬回撤比"}

# 預設掃描範圍：依槓桿倍數（正2 預設 120 / 0.90，0050 預設 100 / 0.95，都在範圍中間）
GRIDS = {
    "均線出場": {2: {"ma_fast": [60, 80, 100, 120, 150, 180, 240], "exit_buffer": [0.85, 0.875, 0.90, 0.925, 0.95, 0.97]},
             1: {"ma_fast": [50, 70, 100, 130, 160, 200], "exit_buffer": [0.90, 0.925, 0.95, 0.97, 0.98, 1.0]}},
    "接刀": {2: {"pyramid_gap": [0.05, 0.10, 0.15, 0.20, 0.25, 0.30], "pyramid_levels": [1, 2, 3, 4]},
           1: {"pyramid_gap": [0.05, 0.10, 0.15, 0.20, 0.25, 0.30], "pyramid_levels": [1, 2, 3, 4]}},
    "轉回": {2: {"recover_slope": [1.0, 1.001, 1.002, 1.004, 1.006], "recover_strong": [1.01, 1.02, 1.03, 1.05, 1.08, 1.12]},
           1: {"recover_slope": [1.0, 1.001, 1.002, 1.004, 1.006], "recover_strong": [1.01, 1.02, 1.03, 1.05, 1.08, 1.12]}},
}


class ParamSweep:
    """一檔標的、一組參數格點，每一組從同一天開始各跑一條淨值。

    tb = TrendBacktest；grid = {參數名: [值, ...]}（其他參數照 tb 目前的設定）。
    """

    def __init__(self, tb, asset: str, grid: dict, start=None, end=None):
        self.tb, self.asset, self.grid = tb, asset, grid
        self.base = tb.params[asset]
        self.names = list(grid)
        self.combos = [dict(zip(self.names, v)) for v in itertools.product(*grid.values())]
        idx = tb.rets.index
        first = idx[0] if start is None else pd.Timestamp(start)
        last = idx[-1] if end is None else pd.Timestamp(end)
        sigs, min_si = [], 0
        try:
            for c in self.combos:
                tb.set_params(asset, replace(self.base, **c))
                g = tb._sig[asset]
                sigs.append((g["act"], g["status"], g["layers"]))
                min_si = max(min_si, g["min_si"])
            si = max(min_si, int(idx.searchsorted(first)))
            ei = int(idx.searchsorted(last, side="right")) - 1
            if ei - si < 250:
                raise ValueError(f"{asset} 均線算得出來之後不到一年（最早 {idx[min(min_si, len(idx) - 1)].date()}）")
            self.si, self.ei = si, ei
            self.dates = idx[si:ei + 1]
            self.t = np.asarray((self.dates - self.dates[0]).days, dtype=float) / 365.25
            self.eq, self.trades = [], []
            for c, (act, status, layers) in zip(self.combos, sigs):
                g = tb._sig[asset]
                g["act"], g["status"], g["layers"] = act, status, layers
                tb.params[asset] = replace(self.base, **c)
                eq, _, _, _ = tb._simulate(asset, si, ei)
                self.eq.append(eq)
                o = g["i0"]
                self.trades.append(int(np.count_nonzero(act[si + 1 - o:ei + 1 - o])))
            self.eq = np.array(self.eq)
            self.bh, _ = tb.bh._path(asset, si, ei)
        finally:
            tb.set_params(asset, self.base)
        self.default = next((i for i, c in enumerate(self.combos)
                             if all(np.isclose(getattr(self.base, k), v) for k, v in c.items())), None)

    # ---------- 切一段出來算 ----------
    def _pos(self, start, end) -> tuple[int, int]:
        a = 0 if start is None else int(self.dates.searchsorted(pd.Timestamp(start)))
        b = len(self.dates) - 1 if end is None else int(self.dates.searchsorted(pd.Timestamp(end), side="right")) - 1
        if b - a < 20:
            raise ValueError(f"{start} ~ {end} 太短")
        return a, b

    def _stats(self, eq, a, b) -> dict:
        x = eq[a:b + 1]
        years = self.t[b] - self.t[a]
        net = x[-1] / x[0]
        mdd = float((x / np.maximum.accumulate(x) - 1).min())
        cagr = net ** (1 / years) - 1 if net > 0 else -1.0
        return {"年化": cagr, "最大回撤": mdd, "報酬回撤比": cagr / -mdd if mdd < 0 else np.nan,
                "最長套牢": longest_uw(x, self.t[a:b + 1])[0]}

    def table(self, start=None, end=None, roll_years: float | None = 10) -> pd.DataFrame:
        """每組參數一列：這段期間的年化、回撤、最長套牢、交易次數；
        roll_years：再加上這段期間內所有 N 年區間（每月一個起點）贏買進持有的比例、年化差中位數、最差的 N 年。"""
        a, b = self._pos(start, end)
        wins = self._roll(a, b, roll_years) if roll_years else []
        bh = self._stats(self.bh, a, b)
        if wins:
            bh_roll = np.array([self._cagr(self.bh, s, e) for s, e in wins])
        rows = []
        for i, c in enumerate(self.combos):
            r = {**c, **self._stats(self.eq[i], a, b)}
            r["年化差"] = r["年化"] - bh["年化"]
            if start is None and end is None:
                r["交易次數"] = self.trades[i]
            if wins:
                st = np.array([self._cagr(self.eq[i], s, e) for s, e in wins])
                d = st - bh_roll
                r[f"{roll_years:g}年贏持有比例"] = float(np.mean(d > 0))
                r[f"{roll_years:g}年年化差中位數"] = float(np.median(d))
                r[f"最差{roll_years:g}年年化"] = float(st.min())
            r["預設"] = i == self.default
            rows.append(r)
        df = pd.DataFrame(rows)
        df.attrs.update(start=self.dates[a].date(), end=self.dates[b].date(), bh=bh, windows=len(wins))
        return df

    def _cagr(self, eq, s, e):
        net = eq[e] / eq[s]
        return net ** (1 / (self.t[e] - self.t[s])) - 1 if net > 0 else -1.0

    def _roll(self, a, b, years):
        d = self.dates
        length = pd.DateOffset(months=round(years * 12))
        starts = pd.date_range(d[a].to_period("M").to_timestamp(), d[b] - length, freq="MS")
        out = []
        for s in starts:
            i = max(a, int(d.searchsorted(s)))
            j = int(d.searchsorted(s + length, side="right")) - 1
            if j - i >= 20:
                out.append((i, j))
        return out

    # ---------- 樣本內外 ----------
    def split_test(self, split, objective: str = "年化", start=None, end=None) -> dict:
        """前段（start ~ split 前一天）挑參數、後段（split ~ end）驗證。"""
        split = pd.Timestamp(split)
        ins = self.table(start, split - pd.Timedelta(days=1), roll_years=None)
        oos = self.table(split, end, roll_years=None)
        rank_in = ins[objective].rank(ascending=False)
        rank_out = oos[objective].rank(ascending=False)
        best = int(ins[objective].idxmax())
        n = len(self.combos)
        pick = lambda df, i: {k: df.loc[i, k] for k in ("年化", "最大回撤", "報酬回撤比", "最長套牢")}  # noqa: E731
        return {
            "樣本內": f"{ins.attrs['start']} ~ {ins.attrs['end']}", "樣本外": f"{oos.attrs['start']} ~ {oos.attrs['end']}",
            "組合數": n, "目標": objective,
            "排名相關係數": float(rank_in.corr(rank_out)),
            "樣本內最佳": {k: self.combos[best][k] for k in self.names},
            "最佳組合 樣本外排名": int(rank_out[best]),
            "最佳組合 樣本外": pick(oos, best),
            "預設 樣本外排名": int(rank_out[self.default]) if self.default is not None else None,
            "預設 樣本外": pick(oos, self.default) if self.default is not None else None,
            "樣本外 中位數組合": {k: float(oos[k].median()) for k in ("年化", "最大回撤", "報酬回撤比")},
            "持有 樣本外": {k: oos.attrs["bh"][k] for k in ("年化", "最大回撤", "報酬回撤比", "最長套牢")},
            "表": ins.add_suffix("_樣本內").join(oos[[objective, "最大回撤"]].add_suffix("_樣本外")),
        }

    # ---------- walk-forward ----------
    def walk_forward(self, first_test, step_years: float = 5, objective: str = "年化",
                     lookback_years: float | None = None, pick: str = "best") -> dict:
        """從 first_test 起每 step_years 年重挑一次參數（用之前全部的歷史，或最近 lookback_years 年），
        接下來 step_years 年照用。回傳每段選了什麼、接起來的淨值，以及一直用預設、買進持有的同期淨值。
        pick：「best」= 挑最高的那組；「plateau」= 挑高原中間（同 suggest()）。"""
        d = self.dates
        t0 = pd.Timestamp(first_test)
        if t0 <= d[0] + pd.DateOffset(years=3):
            raise ValueError(f"第一次挑參數前至少要 3 年歷史（策略從 {d[0].date()} 開始）")
        step = pd.DateOffset(months=round(step_years * 12))
        a0 = int(d.searchsorted(t0))
        wf = np.empty(len(d) - a0)
        wf[0], blocks, cur = 1.0, [], t0
        while True:
            a = int(d.searchsorted(cur))
            if a >= len(d) - 1:
                break
            b = min(len(d) - 1, int(d.searchsorted(cur + step)))
            hist0 = None if lookback_years is None else cur - pd.DateOffset(months=round(lookback_years * 12))
            ins = self.table(hist0 if hist0 is None or hist0 > d[0] else None, d[a - 1], roll_years=None)
            k = int(ins[objective].idxmax()) if pick == "best" else self.suggest(ins, objective)["i"]
            seg = self.eq[k][a:b + 1] / self.eq[k][a]
            wf[a - a0:b - a0 + 1] = wf[a - a0] * seg
            blocks.append({"開始": d[a].date(), "結束": d[b].date(), **self.combos[k],
                           "預設": k == self.default, "這段年化": self._cagr(self.eq[k], a, b),
                           "預設這段年化": self._cagr(self.eq[self.default], a, b) if self.default is not None else np.nan,
                           "持有這段年化": self._cagr(self.bh, a, b)})
            if b >= len(d) - 1:
                break
            cur = d[b]
        idx = d[a0:]
        curves = pd.DataFrame({"walk-forward": wf, "預設參數": self.eq[self.default][a0:] / self.eq[self.default][a0]
                               if self.default is not None else np.nan,
                               "買進持有": self.bh[a0:] / self.bh[a0]}, index=idx)
        t = self.t[a0:]
        summ = {}
        for col in curves:
            x = curves[col].to_numpy()
            if np.isnan(x).any():
                continue
            mdd = float((x / np.maximum.accumulate(x) - 1).min())
            cagr = x[-1] ** (1 / (t[-1] - t[0])) - 1
            summ[col] = {"年化": cagr, "最大回撤": mdd, "報酬回撤比": cagr / -mdd if mdd < 0 else np.nan,
                         "最長套牢": longest_uw(x, t)[0]}
        return {"每段": pd.DataFrame(blocks), "淨值": curves, "摘要": pd.DataFrame(summ).T}

    def heat(self, df: pd.DataFrame, col: str) -> pd.DataFrame:
        """兩個參數的掃描結果轉成熱力圖表格（列 = 第一個參數、欄 = 第二個）。"""
        if len(self.names) != 2:
            raise ValueError("熱力圖要剛好兩個參數")
        return df.pivot(index=self.names[0], columns=self.names[1], values=col)

    def plateau(self, df: pd.DataFrame, col: str) -> pd.Series:
        """每一組跟它上下左右相鄰組合的平均（含自己）。高原上的組合，自己跟鄰居平均差不多；尖峰則差很多。"""
        h = self.heat(df, col).to_numpy()
        out = np.full_like(h, np.nan)
        for i, j in np.ndindex(h.shape):
            nb = [h[x, y] for x, y in ((i, j), (i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1))
                  if 0 <= x < h.shape[0] and 0 <= y < h.shape[1]]
            out[i, j] = np.nanmean(nb)
        hp = self.heat(df, col)
        return pd.DataFrame(out, index=hp.index, columns=hp.columns).stack().rename(f"{col}（鄰近平均）")

    def suggest(self, df: pd.DataFrame, col: str) -> dict:
        """建議參數：每一格跟上下左右鄰居（共 5 格）的平均最高的那組，只從不在邊緣的格子裡選
        （邊緣沒有外側的鄰居可以比，看不出是不是高原）。回傳 {"i": 第幾組, "score": 鄰近平均, "worst": 5 格裡最差的}。"""
        nx, ny = len(self.grid[self.names[0]]), len(self.grid[self.names[1]])
        v = df[col].to_numpy(dtype=float)
        inner = [(x, y) for x in range(1, nx - 1) for y in range(1, ny - 1)]
        cells = inner or [(x, y) for x in range(nx) for y in range(ny)]
        best = None
        for x, y in cells:
            nb = [v[a * ny + b] for a, b in ((x, y), (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
                  if 0 <= a < nx and 0 <= b < ny and not np.isnan(v[a * ny + b])]
            if not nb:
                continue
            score = sum(nb) / len(nb)
            if best is None or score > best["score"]:
                best = {"i": x * ny + y, "score": score, "worst": min(nb)}
        return best

    def params_of(self, i: int) -> dict:
        return asdict(replace(self.base, **self.combos[i]))
