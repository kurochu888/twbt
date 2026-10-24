"""再平衡策略：固定目標配置，照「定期」或「偏離門檻」調回比例。可以搭配均線訊號（正2 部位照均線進出）。

配置：{"0050": w, "00631L": w, "00675L": w, "CASH": w}，加總 = 1。現金照日曆時間計息：每個交易日乘 (1 + 年利率)^(距前一交易日天數 ÷ 365.25)。

什麼時候調回目標比例（rule）：
- freq：'none' / 'M'（每月）/ 'Q'（每季）/ 'H'（每半年）/ 'Y'（每年）——新的月份（季、半年、年）第一個交易日檢查
- band：偏離門檻（百分點，例如 0.10）。任一部位（含現金）比例跟目標差超過 band 才調整
  - freq 有設、band = 0：每次檢查都調回
  - freq 有設、band > 0：檢查日偏離超過門檻才調
  - freq = 'none'、band > 0：每天檢查
  - freq = 'none'、band = 0：永遠不調（等於買進後放著，對照組）
- 調整：用當天收盤價，先賣超過目標的、再用現金買不足的；手續費 0.1425% × 折扣（最低 20 元）、賣出加證交稅 0.1%
- 整張交易（一張 = 1000 股）：每一檔調到「最接近目標金額的張數」（四捨五入），買的時候現金不夠就少買；
  配息發現金，下次再平衡時一起調

搭配均線訊號（trend=True）：正2（00631L、00675L）的目標比例 = 配置比例 × 均線狀態
  （續抱 = 1、接刀已接 k 層 = k ÷ 層數、觀望或剛出場 = 0），不在正2 的部分放現金。
  均線有動作（出場／接刀／轉回續抱）那天，只把那一檔調到新的目標；平常照 rule 再平衡。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .data import KIND
from .lots import LotAccount
from .metrics import TRADING_DAYS, summarize
from .trend import HOLD, WAIT, TrendBacktest

ASSETS = ["0050", "00631L", "00675L"]
LEVERAGED = {"00631L", "00675L"}
EXPOSURE = {"0050": 1.0, "00631L": 2.0, "00675L": 2.0, "CASH": 0.0}
FREQ_NAME = {"none": "不定期", "M": "每月", "Q": "每季", "H": "每半年", "Y": "每年"}
MIN_TRADE = 1000      # 再平衡時單筆不到 1,000 元就不交易（不然最低手續費 20 元會吃掉小額調整，現實中也沒人這樣做）


@dataclass
class RebalConfig:
    weights: dict = field(default_factory=lambda: {"00631L": 0.5, "CASH": 0.5})
    freq: str = "Q"
    band: float = 0.0
    cash_rate: float = 0.01
    trend: bool = False

    def norm(self) -> dict:
        w = {k: float(v) for k, v in self.weights.items() if v and v > 0}
        s = sum(w.values())
        if s <= 0:
            raise ValueError("配置比例加總要大於 0")
        return {k: v / s for k, v in w.items()}

    def exposure(self) -> float:
        return sum(EXPOSURE[k] * v for k, v in self.norm().items())


def _period_key(ts: pd.Timestamp, freq: str):
    if freq == "M":
        return ts.year * 12 + ts.month
    if freq == "Q":
        return ts.year * 4 + (ts.month - 1) // 3
    if freq == "H":
        return ts.year * 2 + (ts.month - 1) // 6
    if freq == "Y":
        return ts.year
    return None


class RebalBacktest:
    def __init__(self, bh, tb: TrendBacktest | None = None):
        self.bh, self.rets, self.syn = bh, bh.rets, bh.syn
        self.tb = tb or TrendBacktest(bh)
        self.idx = self.rets.index
        from ..data.synthetic import year_frac
        self.dt = year_frac(self.idx).to_numpy()          # 現金利息照日曆時間算
        self.halt = bh.halt                               # 暫停交易（分割）的日子不能買賣
        self.lots = bh.lots

    # 某天正2 的均線狀態 → 比例（續抱 1、接刀 k/層數、其他 0）
    def _trend_frac(self, code: str, t: int) -> float:
        g = self.tb._sig[code]
        j = t - g["i0"]
        st, k = g["status"][j], g["layers"][j]
        if st == HOLD:
            return 1.0
        if st == WAIT and k > 0:
            return k / self.tb.params[code].pyramid_levels
        return 0.0

    def first_ok(self, cfg: RebalConfig) -> int:
        """這個配置最早可以從第幾天開始（每一檔都要有資料；搭配均線時正2 的均線要算得出來）。"""
        si = 0
        for c in cfg.norm():
            if c == "CASH":
                continue
            r = self.rets[c]
            si = max(si, self.idx.get_loc(r.first_valid_index()) - 1)
            if cfg.trend and c in LEVERAGED:
                si = max(si, self.tb._sig[c]["min_si"])
        return si

    def simulate(self, cfg: RebalConfig, si: int, ei: int, keep_trades: bool = False):
        w = cfg.norm()
        codes = [c for c in w if c != "CASH"]
        cost, capital = self.bh.cost, self.bh.capital
        acct = {c: LotAccount(0.0, cost, KIND[c]) for c in codes}   # 每一檔的股數（現金統一放 cash）
        PX = {c: self.lots[c]["px"] for c in codes}
        LOT = {c: self.lots[c]["lot"] for c in codes}
        DIV = {c: self.lots[c]["div"] for c in codes}
        cash = capital
        trades = 0
        log = []
        cur_t = si

        def target(t):
            tw = {}
            for c in codes:
                f = self._trend_frac(c, t) if (cfg.trend and c in LEVERAGED) else 1.0
                tw[c] = w[c] * f
            tw["CASH"] = 1 - sum(tw.values())
            return tw

        def hold(c):
            return acct[c].shares * PX[c][cur_t]

        def total():
            return cash + sum(hold(c) for c in codes)

        def trade_to(tw, only=None, small_ok=False):
            # small_ok：期初建立部位、均線訊號的進出不受 MIN_TRADE 限制；目標 0（出場）一定全部賣掉
            nonlocal cash, trades
            V = total()
            sel = [only] if only else [c for c in codes if small_ok or not self.halt[c][cur_t]]
            want = {}
            for c in sel:
                pl = PX[c][cur_t] * LOT[c][cur_t]
                want[c] = 0 if tw[c] == 0 else int(math.floor(tw[c] * V / pl + 0.5))   # 最接近目標的張數
            for c in sel:                                   # 先賣
                a, lot = acct[c], LOT[c][cur_t]
                have = int(round(a.shares / lot))
                if have > want[c]:
                    g = (have - want[c]) * lot * PX[c][cur_t]
                    if g < MIN_TRADE and not (small_ok or tw[c] == 0):
                        continue
                    a.cash = 0.0
                    a.sell_shares(a.shares if want[c] == 0 else (have - want[c]) * lot, PX[c][cur_t])
                    cash += a.cash
                    trades += 1
            for c in sel:                                   # 再用現金買
                a, lot = acct[c], LOT[c][cur_t]
                have = int(round(a.shares / lot))
                if have < want[c]:
                    pl = PX[c][cur_t] * lot
                    a.cash = cash
                    n = min(want[c] - have, a.max_lots(cash, pl))
                    if n <= 0 or (n * pl < MIN_TRADE and not small_ok):
                        continue
                    a.buy_lots(n, PX[c][cur_t], lot)
                    cash = a.cash
                    trades += 1

        trade_to(target(si), small_ok=True)
        eq = np.empty(ei - si + 1)
        eq[0] = total()
        last_key = _period_key(self.idx[si], cfg.freq)
        for t in range(si + 1, ei + 1):
            cur_t = t
            cash *= (1 + cfg.cash_rate) ** self.dt[t]
            for c in codes:
                if DIV[c][t] != 0:
                    cash += acct[c].shares * DIV[c][t]      # 配息發現金
            tw = target(t)
            # 均線有動作的正2：只調那一檔
            if cfg.trend:
                for c in codes:
                    if c in LEVERAGED:
                        g = self.tb._sig[c]
                        if g["act"][t - g["i0"]]:
                            trade_to(tw, only=c, small_ok=True)
                            if keep_trades:
                                log.append((self.idx[t], f"{c} 均線訊號"))
            # 定期／門檻
            key = _period_key(self.idx[t], cfg.freq)
            check = (cfg.freq == "none" and cfg.band > 0) or (key is not None and key != last_key)
            last_key = key
            if check:
                V = total()
                dev = max([abs(hold(c) / V - tw[c]) for c in codes] + [abs(cash / V - tw["CASH"])])   # 全部現金時 codes 是空的
                if cfg.band <= 0 or dev > cfg.band + 1e-12:
                    n0 = trades
                    trade_to(tw)
                    if keep_trades and trades > n0:               # 真的有成交才記
                        log.append((self.idx[t], "再平衡"))
            eq[t - si] = total()
        for c in codes:                                   # 期末全部賣出（扣成本）
            if acct[c].shares > 0:
                eq[-1] -= cost.sell_cost(hold(c), KIND[c])
        return eq, trades, log

    # ---------- 對外 ----------
    def run(self, cfg: RebalConfig, start, end) -> dict:
        s, e = self.bh._bounds(start, end)
        si, ei = self.idx.get_loc(s), self.idx.get_loc(e)
        si = max(si, self.first_ok(cfg))
        if si >= ei:
            raise ValueError("這個配置在這段期間沒有足夠的資料")
        eq, trades, log = self.simulate(cfg, si, ei, keep_trades=True)
        idx = self.idx[si:ei + 1]
        out = {"策略": pd.Series(eq, index=idx), "交易次數": trades, "紀錄": log}
        flat = RebalConfig(cfg.weights, "none", 0.0, cfg.cash_rate, cfg.trend)
        out["同配置不再平衡"] = pd.Series(self.simulate(flat, si, ei)[0], index=idx)
        if cfg.trend and any(c in LEVERAGED for c in cfg.norm()):      # 直接看出均線的效果
            nt = RebalConfig(cfg.weights, cfg.freq, cfg.band, cfg.cash_rate, False)
            out["同配置不搭配均線"] = pd.Series(self.simulate(nt, si, ei)[0], index=idx)
        return out

    def windows(self, cfg: RebalConfig, wins) -> pd.DataFrame:
        flat = RebalConfig(cfg.weights, "none", 0.0, cfg.cash_rate, cfg.trend)
        f0 = self.first_ok(cfg)
        rows = []
        for start, end in wins:
            try:
                s, e = self.bh._bounds(start, end)
            except ValueError:
                continue
            si, ei = self.idx.get_loc(s), self.idx.get_loc(e)
            if si < f0 or ei - si < 20:
                continue
            years = (e - s).days / 365.25
            row = {"起始日": s.date(), "結束日": e.date(), "年數": years}
            for name, c in (("策略", cfg), ("不再平衡", flat)):
                eq = self.simulate(c, si, ei)[0]
                net = eq[-1] / self.bh.capital
                row[f"{name}年化"] = net ** (1 / years) - 1 if net > 0 else -1.0
                row[f"{name}回撤"] = float((eq / np.maximum.accumulate(eq) - 1).min())
            rows.append(row)
        return pd.DataFrame(rows)

    def rolling(self, cfg: RebalConfig, years: float) -> pd.DataFrame:
        length = pd.DateOffset(months=round(years * 12))
        starts = pd.date_range(self.idx[0].to_period("M").to_timestamp(), self.idx[-1] - length, freq="MS")
        return self.windows(cfg, [(s, s + length) for s in starts])


def stats(eq: pd.Series) -> dict:
    s = summarize(eq)
    return {k: s[k] for k in ("起始日", "結束日", "總報酬", "年化報酬", "年化波動", "最大回撤", "夏普")}
