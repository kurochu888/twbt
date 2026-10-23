"""蒙地卡羅抽樣測試（不連網）。"""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.backtest import NO_COST  # noqa: E402
from twbt.backtest.montecarlo import bootstrap_indices, monte_carlo  # noqa: E402
from twbt.backtest.trend import TrendParams  # noqa: E402


class TestBootstrap(unittest.TestCase):
    def test_block_lengths(self):
        rng = np.random.default_rng(1)
        idx = bootstrap_indices(1000, 200_000, 50, rng)
        self.assertTrue((idx >= 0).all() and (idx < 1000).all())
        # 區塊內是連續的：相鄰差 1（或繞回 −999）的比例 ≈ 1 − 1/50
        cont = np.mean(np.isin(np.diff(idx), (1, -999)))
        self.assertAlmostEqual(cont, 1 - 1 / 50, delta=0.003)
        iid = bootstrap_indices(1000, 100_000, 1, rng)
        self.assertLess(np.mean(np.diff(iid) == 1), 0.01)

    def test_constant_market(self):
        # 每天固定上漲：策略最後也會全部投入，報酬接近買進持有、回撤是 0
        dates = pd.bdate_range("2000-01-01", periods=600)
        r = pd.Series(0.001, index=dates)
        df = monte_carlo(r, r, TrendParams(10, 20, 0.9, 1.0, 1.03, 0.15, 2), n=5, years=1, block=10, cost=NO_COST)
        self.assertTrue((df["策略回撤"] == 0).all() and (df["持有回撤"] == 0).all())
        self.assertTrue(np.allclose(df["持有年化"], 1.001 ** 252 - 1))
        self.assertTrue((df["策略年化"] <= df["持有年化"] + 1e-12).all())   # 晚一天進場，不可能比較多


if __name__ == "__main__":
    unittest.main()
