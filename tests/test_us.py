"""美股：成本取整到 0.01 美元、市場判斷、配息預扣 30%。"""
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from twbt.backtest.costs import TaiwanCost, us_cost
from twbt.backtest.data import market_of
from twbt.backtest.lots import load_lot_inputs


class TestUsCost(unittest.TestCase):
    def test_free_by_default(self):
        c = us_cost()
        self.assertEqual(c.buy_cost(12345.67, "etf"), 0.0)
        self.assertEqual(c.sell_cost(12345.67, "etf"), 0.0)        # 沒有證交稅

    def test_rate_and_min_rounded_to_cent(self):
        c = us_cost(0.001, 1.0)
        self.assertAlmostEqual(c.buy_cost(4567.891, "etf"), 4.57)
        self.assertAlmostEqual(c.sell_cost(300.0, "etf"), 1.00)     # 0.30 < 最低 1 美元

    def test_taiwan_unchanged(self):
        c = TaiwanCost()
        self.assertEqual(c.buy_cost(100_000, "etf"), 143.0)
        self.assertEqual(c.sell_cost(100_000, "etf"), 243.0)


class TestUsLots(unittest.TestCase):
    def test_market_and_dividend_withholding(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "long").mkdir()
            idx = pd.bdate_range("2020-01-01", periods=5)
            pd.DataFrame({"tr_ret": 0.0, "is_synthetic": 0}, index=idx).to_csv(d / "long" / "NDX_long.csv")
            self.assertEqual(market_of(d), "us")
            pd.DataFrame({"close": [100.0] * 5}, index=idx).to_csv(d / "QQQ.csv")
            pd.DataFrame(columns=["code", "resume_date", "ratio"]).to_csv(d / "splits.csv", index=False)
            # 第 3 天：價格不變、總報酬 +1% → 每股配息 = 100 × 0.01 / 1.01，入帳 70%
            r = pd.DataFrame({"QQQ": [np.nan, 0, 0.01, 0, 0]}, index=idx)
            s = pd.DataFrame({"QQQ": [np.nan, 0, 0, 0, 0]}, index=idx)
            L = load_lot_inputs(d, r, s)["QQQ"]
            self.assertEqual(L["lot"][0], 1.0)                              # 一次 1 股
            self.assertAlmostEqual(L["div"][2], 100 * 0.01 / 1.01 * 0.7)
            self.assertAlmostEqual(L["lp"][0], 100.0)


if __name__ == "__main__":
    unittest.main()
