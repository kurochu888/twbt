"""台股交易成本。

手續費 = 成交金額 × 0.1425% × 折扣，未滿 20 元以 20 元計（買賣各一次）
證交稅 = 賣出金額 × 稅率（只在賣出時）：股票 0.3%、股票型 ETF 0.1%
買進、賣出的成本都四捨五入到整數元（跟 finance-app 的 defaultFee 一樣）

美股（us_cost）：手續費 = 成交金額 × 費率（預設 0，多數美國券商免手續費），可設每筆最低；沒有證交稅；
成本四捨五入到 0.01 美元（unit）
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

TAX = {"stock": 0.003, "etf": 0.001, "index": 0.0}


@dataclass
class TaiwanCost:
    commission: float = 0.001425
    discount: float = 1.0          # 例如 0.28 代表 2.8 折
    min_fee: float = 20.0
    tax: dict = field(default_factory=lambda: dict(TAX))
    unit: float = 1.0              # 成本四捨五入的單位：台股 1 元、美股 0.01 美元

    def _round(self, x: float) -> float:
        if self.unit == 1.0:
            return float(math.floor(x + 0.5))
        return math.floor(x / self.unit + 0.5) * self.unit

    def fee(self, amount: float, kind: str) -> float:
        # 免手續費（折扣 0）時連最低 20 元也不收
        if kind == "index" or amount <= 0 or self.commission * self.discount <= 0:
            return 0.0
        return max(amount * self.commission * self.discount, self.min_fee)

    def buy_cost(self, amount: float, kind: str) -> float:
        return self._round(self.fee(amount, kind))

    def sell_cost(self, amount: float, kind: str) -> float:
        return self._round(self.fee(amount, kind) + amount * self.tax.get(kind, 0.0))


NO_COST = TaiwanCost(commission=0.0, min_fee=0.0, tax={k: 0.0 for k in TAX})


def us_cost(commission: float = 0.0, min_fee: float = 0.0) -> TaiwanCost:
    """美股成本：commission 是費率（例如 0.001 = 0.1%），min_fee 每筆最低（美元）；沒有證交稅。"""
    return TaiwanCost(commission=commission, discount=1.0, min_fee=min_fee,
                      tax={k: 0.0 for k in TAX}, unit=0.01)


def default_cost(market: str) -> TaiwanCost:
    return us_cost() if market == "us" else TaiwanCost()
