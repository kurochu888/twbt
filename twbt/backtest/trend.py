"""均線趨勢策略（接刀版）回測。

規則照 kurochu888/finance-app 的 computeTrend() / runBacktest()（app.template.html），逐行對應：

狀態：WATCH（觀望，還沒進場）→ HOLD（續抱）→ WAIT_RECOVER（接刀中）
每天收盤後（f = 快線、s = 慢線、fy = 前一天快線）：
- 續抱：收盤 < f × 出場乘數 → EXIT（全部賣出，記下「出場時的現金」）
- 觀望／接刀：
    站穩 = 收盤 > f 且 前一天收盤 > 前一天快線
    斜率 = f ≥ fy × 轉回斜率門檻
    強反彈 = 收盤 > f × 強反彈倍數
    (站穩 且 斜率) 或 強反彈 → RECOVER（剩下的現金全部買進，轉回續抱）
    否則 收盤 < min(基準價, s) × (1 − 接刀間距) 且 還沒接滿 → ADD（加碼一層 = 出場現金 ÷ 層數）
  基準價 = 上一次動作那天的收盤（還沒有動作過就用前一天收盤）
- 當天收盤成交（台股有盤後定價交易，可以用收盤價成交），手續費 0.1425% × 折扣（最低 20 元），賣出加證交稅 0.1%

訊號價格（signal_price）：
- "raw"（預設，跟 app 一樣）：只還原分割、不還原配息的價格。0050 除息那天均線看到的是下跌，跟 app 畫面一致
- "adjusted"：還原權息的總報酬價格
  正2 不配息，兩種一樣。分割暫停交易的日子 app 的歷史裡沒有，這裡也不算進均線。
整張交易（跟 app 一樣，一張 = 1000 股，用實際每股價格）：
- 轉回續抱：剩下的現金買「夠買的最多張數」；接刀：用「出場現金 ÷ 層數」買最多張數；出場：全部賣出
- 手續費、證交稅四捨五入到整數元
- 配息發現金（0050）；續抱中除息那天現金夠買一張就再投入，接刀中留著下次加碼／轉回時用

跟 app 的差別（刻意的）：
- 回測區間可以從任何一天開始：訊號一律從資料第一天開始回放，區間第一天照當時的狀態建立部位
  （續抱 = 全部買進；接刀已加碼 k 層 = 買進 k ÷ 層數；觀望 = 全部現金），跟「當時照策略操作的人」一樣
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from .costs import TaiwanCost
from .data import KIND
from .lots import LotAccount
from .metrics import TRADING_DAYS

WATCH, HOLD, WAIT = 0, 1, 2
NONE, RECOVER, ADD, EXIT = 0, 1, 2, 3
STATUS_NAME = {WATCH: "觀望", HOLD: "續抱", WAIT: "接刀中"}
ACTION_NAME = {RECOVER: "轉回續抱", ADD: "接刀", EXIT: "出場"}
LEVERAGE = {"TAIEX": 1, "0050": 1, "00631L": 2, "00675L": 2}


@dataclass
class TrendParams:
    ma_fast: int = 120
    ma_slow: int = 240
    exit_buffer: float = 0.90
    recover_slope: float = 1.002
    recover_strong: float = 1.03
    pyramid_gap: float = 0.15
    pyramid_levels: int = 2

    @classmethod
    def default(cls, leverage: float) -> "TrendParams":
        """跟 app 的 defaultTrendParams() 相同。"""
        if leverage >= 2:
            return cls(120, 240, 0.90, 1.002, 1.03, 0.15, 2)
        return cls(100, 200, 0.95, 1.002, 1.03, 0.15, 1)


def _sma(x: np.ndarray, w: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) >= w:
        c = np.cumsum(np.insert(x, 0, 0.0))
        out[w - 1:] = (c[w:] - c[:-w]) / w
    return out


def signals(close: np.ndarray, p: TrendParams) -> dict:
    """回放狀態機。close 是一段連續的價格（不可有缺值）。

    回傳每天的 action（當天收盤要做什麼）、做完之後的 status 與 layers（已加碼幾層）。
    """
    n = len(close)
    act = np.zeros(n, dtype=np.int8)
    status = np.zeros(n, dtype=np.int8)
    layers = np.zeros(n, dtype=np.int8)
    win = max(p.ma_fast, p.ma_slow)
    if n < win + 1:
        return {"act": act, "status": status, "layers": layers}
    maf, mas = _sma(close, p.ma_fast), _sma(close, p.ma_slow)
    st, base, cnt = WATCH, 0.0, 0
    for i in range(win, n):                       # 同 app：i 從 start + 1 = win 開始
        c, f, s, fy = close[i], maf[i], mas[i], maf[i - 1]
        a = NONE
        if st == HOLD:
            if c < f * p.exit_buffer:
                a = EXIT
        else:
            stable = c > f and close[i - 1] > maf[i - 1]
            slope = f >= fy * p.recover_slope
            strong = c > f * p.recover_strong
            ref = min(base if base > 0 else close[i - 1], s)
            if (stable and slope) or strong:
                a = RECOVER
            elif c < ref * (1 - p.pyramid_gap) and cnt < p.pyramid_levels:
                a = ADD
        if a == RECOVER:
            base, cnt, st = c, 0, HOLD
        elif a == ADD:
            base, cnt, st = c, cnt + 1, WAIT
        elif a == EXIT:
            base, cnt, st = c, 0, WAIT
        act[i], status[i], layers[i] = a, st, cnt
    return {"act": act, "status": status, "layers": layers}


@dataclass
class TrendResult:
    equity: pd.Series
    bh_equity: pd.Series
    events: pd.DataFrame
    start_status: str
    start_layers: int


class TrendBacktest:
    """對 BuyHold 已載入的報酬資料跑均線策略。

    params：{代號: TrendParams}，沒給的用 app 的預設值（依槓桿倍數）。
    """

    def __init__(self, bh, params: dict | None = None, signal_price: str = "raw", data_dir=None):
        from .data import load_signal_inputs
        self.bh = bh
        self.rets, self.syn = bh.rets, bh.syn
        self.params = {c: TrendParams.default(LEVERAGE[c]) for c in self.rets.columns}
        self.params.update(params or {})
        self.signal_price = signal_price
        sig_ret, traded = load_signal_inputs(data_dir or bh.data_dir, self.rets, self.syn, bh.tw50_excess)
        if signal_price == "adjusted":
            sig_ret = self.rets
        self._sig = {}
        for c in self.rets.columns:
            r = self.rets[c]
            first = r.first_valid_index()
            if first is None:
                continue
            i0 = self.rets.index.get_loc(first) - 1          # 前一天當作價格 1 的起點
            price = np.concatenate([[1.0], np.cumprod(1 + r.iloc[i0 + 1:].to_numpy())])   # 損益用（含息）
            spx = np.concatenate([[1.0], np.cumprod(1 + sig_ret[c].iloc[i0 + 1:].fillna(0).to_numpy())])
            mask = traded[c].iloc[i0:].to_numpy().copy()
            mask[0] = True
            sig = signals(spx[mask], self.params[c])           # 只用有交易的日子算均線
            pos = np.flatnonzero(mask)
            full = {}
            for k in ("act", "status", "layers"):
                arr = np.zeros(len(price), dtype=np.int8)
                if k == "act":
                    arr[pos] = sig[k]
                else:                                           # 暫停交易的日子維持前一天的狀態
                    idx = np.maximum.accumulate(np.where(mask, np.arange(len(mask)), 0))
                    arr = sig[k][np.searchsorted(pos, idx)]
                full[k] = arr
            win = max(self.params[c].ma_fast, self.params[c].ma_slow)
            # 均線第一次算得出來的那天（跟 app 的 runBacktest 起點一樣）；之前策略只能觀望，比較不公平
            min_si = i0 + int(pos[win - 1]) if len(pos) >= win else len(self.rets)
            self._sig[c] = {"i0": i0, "min_si": min_si, "price": price, **full}

    # ---------- 單一區間 ----------
    def run(self, asset: str, start, end) -> TrendResult:
        s, e = self.bh._bounds(start, end)
        g = self._sig.get(asset)
        if g is None or g["min_si"] >= len(self.rets):
            raise ValueError(f"{asset} 資料不夠算均線")
        first_ok = self.rets.index[g["min_si"]]
        if s < first_ok:                        # 均線還算不出來：從第一個算得出來的交易日開始
            s = first_ok
        if s >= e:
            raise ValueError(f"{asset} 均線最早 {first_ok.date()} 才算得出來")
        si, ei = self.rets.index.get_loc(s), self.rets.index.get_loc(e)
        eq, events, st0, k0 = self._simulate(asset, si, ei, keep_events=True)
        idx = self.rets.index[si:ei + 1]
        bh = self.bh.equity(asset, s, e)
        return TrendResult(pd.Series(eq, index=idx), bh, events, STATUS_NAME[st0], k0)

    def _simulate(self, asset, si, ei, keep_events=False):
        g, p = self._sig[asset], self.params[asset]
        o = g["i0"]
        act, status, layers = g["act"], g["status"], g["layers"]
        L, halt = self.bh.lots[asset], self.bh.halt[asset]
        LP, LOT, DIV = L["lp"], L["lot"], L["div"]
        acct = LotAccount(self.bh.capital, self.bh.cost, KIND[asset])
        j0 = si - o
        st0, k0 = int(status[j0]), int(layers[j0])
        cash_at_exit = self.bh.capital
        if st0 == HOLD:
            acct.buy_max(acct.cash, LP[si], LOT[si])
        elif st0 == WAIT and k0 > 0:
            acct.buy_max(cash_at_exit * k0 / p.pyramid_levels, LP[si], LOT[si])
        eq = np.empty(ei - si + 1)
        eq[0] = acct.value(LP[si], LOT[si])
        events = []
        for t in range(si + 1, ei + 1):
            j = t - o
            a, lp, lot = act[j], LP[t], LOT[t]
            if DIV[t] != 0:
                acct.cash += acct.shares * DIV[t]           # 配息發現金
            if a == RECOVER:
                acct.buy_max(acct.cash, lp, lot)
            elif a == ADD:
                acct.buy_max(cash_at_exit / p.pyramid_levels, lp, lot)
            elif a == EXIT:
                acct.sell_all(lp, lot)
                cash_at_exit = acct.cash
            elif DIV[t] != 0 and status[j] == HOLD and not halt[t]:
                acct.buy_max(acct.cash, lp, lot)            # 續抱中：配息夠買一張就再投入
            if a and keep_events:
                events.append({"日期": self.rets.index[t].date(), "動作": ACTION_NAME[int(a)]
                               + (f" 第 {int(layers[j])} 層" if a == ADD else ""),
                               "價格": lp / 1000, "持有張數": acct.lots(lot), "淨值": acct.value(lp, lot)})
            eq[t - si] = acct.value(lp, lot)
        # 期末賣出（扣成本），跟買進持有一樣
        eq[-1] = acct.final_value(LP[ei], LOT[ei])
        ev = pd.DataFrame(events, columns=["日期", "動作", "價格", "持有張數", "淨值"]) if keep_events else None
        return eq, ev, st0, k0

    # ---------- 多區間 ----------
    def windows(self, wins, assets=None) -> pd.DataFrame:
        from .data import NAMES
        assets = [a for a in (assets or list(self.rets.columns)) if a != "TAIEX" and a in self._sig]
        rows = []
        for start, end in wins:
            try:
                s, e = self.bh._bounds(start, end)
            except ValueError:
                continue
            si, ei = self.rets.index.get_loc(s), self.rets.index.get_loc(e)
            if ei - si < 20:
                continue
            for a in assets:
                if si < self._sig[a]["min_si"]:     # 均線還算不出來的起點不比
                    continue
                bh = self.bh._window_stats(a, s, e)
                if bh is None:
                    continue
                eq, _, _, _ = self._simulate(a, si, ei)
                years = (e - s).days / 365.25
                net = eq[-1] / self.bh.capital
                mdd = float((eq / np.maximum.accumulate(eq) - 1).min())
                rows.append({"標的": NAMES[a], "起始日": s.date(), "結束日": e.date(), "年數": years,
                             "策略總報酬": net - 1, "策略年化": net ** (1 / years) - 1 if net > 0 else -1.0,
                             "策略回撤": mdd, "持有總報酬": bh["總報酬"], "持有年化": bh["年化報酬"],
                             "持有回撤": bh["最大回撤"], "模擬資料占比": bh["模擬資料占比"]})
        return pd.DataFrame(rows)

    def rolling(self, years: float, assets=None) -> pd.DataFrame:
        idx = self.rets.index
        length = pd.DateOffset(months=round(years * 12))
        starts = pd.date_range(idx[0].to_period("M").to_timestamp(), idx[-1] - length, freq="MS")
        return self.windows([(s, s + length) for s in starts], assets)

    def random(self, n: int, years, assets=None, seed: int | None = 42) -> pd.DataFrame:
        """隨機區間（跟 BuyHold.random 抽同一組區間）。"""
        return self.windows(self.bh.random_windows(n, years, seed), assets)

    def params_dict(self) -> dict:
        return {c: asdict(p) for c, p in self.params.items()}
