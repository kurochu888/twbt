"""台股交易成本。

手續費 = 成交金額 × 0.1425% × 折扣，未滿 20 元以 20 元計（買賣各一次）
證交稅 = 賣出金額 × 稅率（只在賣出時）：股票 0.3%、股票型 ETF 0.1%
"""
from __future__ import annotations

from dataclasses import dataclass, field

TAX = {"stock": 0.003, "etf": 0.001, "index": 0.0}


@dataclass
class TaiwanCost:
    commission: float = 0.001425
    discount: float = 1.0          # 例如 0.28 代表 2.8 折
    min_fee: float = 20.0
    tax: dict = field(default_factory=lambda: dict(TAX))

    def fee(self, amount: float, kind: str) -> float:
        if kind == "index" or amount <= 0:
            return 0.0
        return max(amount * self.commission * self.discount, self.min_fee)

    def buy_cost(self, amount: float, kind: str) -> float:
        return self.fee(amount, kind)

    def sell_cost(self, amount: float, kind: str) -> float:
        return self.fee(amount, kind) + amount * self.tax.get(kind, 0.0)


NO_COST = TaiwanCost(commission=0.0, min_fee=0.0, tax={k: 0.0 for k in TAX})
