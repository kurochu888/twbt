"""整張交易（一張 = 1000 股）用的價格資料與帳戶。網頁版 docs/engine.js 的 lotSeries()／LotAccount 逐行對應。

每股價格（px）：以最新一天的實際收盤為錨，往回用「不含配息、只還原分割」的價格報酬推回去，
    單位是「現在的一股」。分割前的一張 = 1000 股 × 分割倍數（例如 0050 2025 年一拆四前，一張 = 4000 個現在的股），
    所以 px × 每張股數 = 當時一張的實際金額（真實期間跟證交所收盤價一致）。上市前（模擬段）照同樣方法往回推。
每張金額（lp）：真實期間 = 實際收盤（到分）× 1000，四捨五入到 10 元（實際成交價只有兩位小數），
    這樣手續費剛好卡在 .5 元時不會因為浮點誤差捨入方向不同；模擬段 = px × 每張股數。
配息（div）：除息那天每股發多少現金 = 前一天價格 × (總報酬 − 價格報酬) ÷ (1 + 總報酬)
    （總報酬 = 收盤 ÷ 除息參考價、價格報酬 = 收盤 ÷ 前一天收盤，兩式相減剛好是配息金額）。
    0050 上市前的模擬段每天都有一點股息（年化約 3.5%）。正2 不配息。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd

LOT = 1000


def rnd(x: float) -> float:
    """四捨五入到整數元（Python 的 round() 是銀行家捨入，跟網頁的 Math.round 不同，所以自己寫）。"""
    return math.floor(x + 0.5)


def load_lot_inputs(data_dir: str | Path, rets: pd.DataFrame, price_ret: pd.DataFrame,
                    syn: pd.DataFrame | None = None) -> dict:
    """回傳 {代號: {"px", "lot", "lp", "div"}}（大盤不能交易，不算）。

    rets：每日總報酬；price_ret：不含配息的價格報酬（load_signal_inputs 的第一個結果）；syn：是否模擬（決定哪段是真實價格）。
    """
    from ..data.adjust import load_splits
    d = Path(data_dir)
    idx = rets.index
    try:
        splits = load_splits()
    except Exception:                        # noqa: BLE001
        splits = pd.DataFrame(columns=["code", "resume_date", "ratio"])
    out = {}
    for code in rets.columns:
        if code == "TAIEX":
            continue
        raw = d / f"{code}.csv"
        last = float(pd.read_csv(raw, usecols=["close"])["close"].iloc[-1]) if raw.exists() else 1.0
        s = price_ret[code].to_numpy(dtype=float)
        r = rets[code].to_numpy(dtype=float)
        n = len(idx)
        px = np.full(n, np.nan)
        px[-1] = last
        for t in range(n - 1, 0, -1):         # 從最新一天往回推
            if np.isnan(s[t]) or np.isnan(px[t]):
                break
            px[t - 1] = px[t] / (1 + s[t])
        lot = np.full(n, float(LOT))
        for _, x in splits[splits["code"].astype(str) == code].iterrows():
            rd = pd.Timestamp(x["resume_date"])
            if rd <= idx[-1]:                 # 資料範圍之後的分割不算
                lot[idx < rd] *= float(x["ratio"])
        lp = px * lot
        first_real = 0
        if syn is not None:
            real_days = idx[(syn[code] == 0).to_numpy() & ~np.isnan(r)]
            first_real = idx.get_loc(real_days[0]) - 1 if len(real_days) else n
        for t in range(max(first_real, 0), n):
            if not np.isnan(lp[t]):
                lp[t] = math.floor(lp[t] / 10 + 0.5) * 10          # 真實期間：實際成交價 × 1000
        div = np.zeros(n)
        for t in range(1, n):
            if not (np.isnan(r[t]) or np.isnan(s[t]) or np.isnan(px[t - 1])) and r[t] != s[t]:
                div[t] = px[t - 1] * (r[t] - s[t]) / (1 + r[t])
        out[code] = {"px": px, "lot": lot, "lp": lp, "div": div}
    return out


class LotAccount:
    """一筆錢：現金 + 股數（整張買賣）。手續費、證交稅四捨五入到整數元（跟 finance-app 一樣）。"""

    def __init__(self, capital: float, cost, kind: str):
        self.cash, self.shares, self.cost, self.kind = float(capital), 0.0, cost, kind
        self.rate = cost.commission * cost.discount

    def max_lots(self, budget: float, lot_price: float) -> int:
        """這筆預算（含手續費）最多買幾張。"""
        budget = min(budget, self.cash)
        if not (budget > 0 and lot_price > 0):
            return 0
        n = math.floor(budget / (lot_price * (1 + self.rate)))
        while n > 0 and n * lot_price + self.cost.buy_cost(n * lot_price, self.kind) > budget:
            n -= 1                                     # 最低手續費 20 元時可能還不夠
        return n

    # lp = 每張金額、lot = 每張股數（現在的股）；張數 = 股數 ÷ 每張股數，一定是整數
    def lots(self, lot: float) -> int:
        return int(round(self.shares / lot))

    def buy_lots(self, n: int, lp: float, lot: float) -> bool:
        if n <= 0:
            return False
        gross = n * lp
        self.cash -= gross + self.cost.buy_cost(gross, self.kind)
        self.shares += n * lot
        return True

    def buy_max(self, budget: float, lp: float, lot: float) -> bool:
        return self.buy_lots(self.max_lots(budget, lp), lp, lot)

    def sell_lots(self, n: int, lp: float, lot: float) -> bool:
        if n <= 0:
            return False
        gross = n * lp
        self.cash += gross - self.cost.sell_cost(gross, self.kind)
        self.shares -= n * lot
        return True

    def sell_all(self, lp: float, lot: float) -> bool:
        ok = self.sell_lots(self.lots(lot), lp, lot)
        self.shares = 0.0
        return ok

    def value(self, lp: float, lot: float) -> float:
        return self.cash + self.lots(lot) * lp

    def final_value(self, lp: float, lot: float) -> float:
        """期末全部賣出後的金額（扣手續費、證交稅）。"""
        n = self.lots(lot)
        if n <= 0:
            return self.cash
        gross = n * lp
        return self.cash + gross - self.cost.sell_cost(gross, self.kind)
