"""再平衡策略測試（不連網）：手刻價格，每一步都能手算。"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.backtest import NO_COST, BuyHold, TaiwanCost  # noqa: E402
from twbt.backtest.rebalance import RebalBacktest, RebalConfig  # noqa: E402
from twbt.backtest.trend import TrendBacktest, TrendParams  # noqa: E402


def write(d: Path, dates, series: dict):
    (d / "long").mkdir(parents=True)
    def r(x):
        x = np.asarray(x, float)
        return np.concatenate([[np.nan], x[1:] / x[:-1] - 1])
    pd.DataFrame({"close": 1.0, "tr_ret": r(series["TAIEX"]), "is_synthetic": 0, "tr_index": 1.0}, index=dates
                 ).rename_axis("date").to_csv(d / "long/TAIEX_long.csv")
    for c in ("0050", "00631L", "00675L"):
        pd.DataFrame({"ret": r(series[c]), "adj_close": 1.0, "is_synthetic": 0}, index=dates
                     ).rename_axis("date").to_csv(d / f"long/{c}_long.csv")
    (d / "long/params.json").write_text('{"gap_0050": 0, "c_00631L": 0, "c_00675L": 0, "dividend_yield": 0}')


class TestRebalance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # 跨三個月：1 月底到 3 月初。00631L 1 月漲一倍、2 月跌一半；0050 不動
        self.dates = pd.bdate_range("2020-01-27", "2020-03-06")
        n = len(self.dates)
        p631 = np.ones(n)
        for i, d in enumerate(self.dates):
            p631[i] = 1.0 if d < pd.Timestamp("2020-01-31") else (2.0 if d < pd.Timestamp("2020-02-28") else 1.0)
        flat = np.ones(n)
        write(Path(self.tmp.name), self.dates, {"TAIEX": flat, "0050": flat, "00631L": p631, "00675L": flat})

    def tearDown(self):
        self.tmp.cleanup()

    def rb(self, cost=NO_COST):
        bh = BuyHold(self.tmp.name, cost=cost, capital=1000)
        return RebalBacktest(bh)

    def test_single_asset_no_rebalance_equals_buyhold(self):
        rb = self.rb()
        out = rb.run(RebalConfig({"00631L": 1.0}, "none", 0, 0.0), self.dates[0], self.dates[-1])
        bh = rb.bh.equity("00631L", self.dates[0], self.dates[-1])
        np.testing.assert_allclose(out["策略"].to_numpy(), bh.to_numpy())

    def test_monthly_rebalance_math(self):
        rb = self.rb()
        cfg = RebalConfig({"00631L": 0.5, "CASH": 0.5}, "M", 0, 0.0)
        eq = rb.run(cfg, self.dates[0], self.dates[-1])["策略"]
        # 1/31 漲一倍：500 → 1000，總值 1500；2/3（2 月第一個交易日）調回 750/750
        self.assertAlmostEqual(eq["2020-01-31"], 1500)
        # 2/28 跌一半：750 → 375，總值 1125；3/2 調回
        self.assertAlmostEqual(eq["2020-02-28"], 1125)
        self.assertAlmostEqual(eq.iloc[-1], 1125)
        # 不再平衡：500 → 1000 → 500，總值回到 1000
        flat = rb.run(cfg, self.dates[0], self.dates[-1])["同配置不再平衡"]
        self.assertAlmostEqual(flat.iloc[-1], 1000)

    def test_band(self):
        rb = self.rb()
        # 門檻 ±30 點：1/31 正2 變成 1000/1500 = 66.7%，偏離 16.7 點 < 30，不調 → 跟不再平衡一樣
        wide = rb.run(RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0.30, 0.0), self.dates[0], self.dates[-1])
        self.assertAlmostEqual(wide["策略"].iloc[-1], 1000)
        # 門檻 ±10 點、每天檢查：1/31 當天就調回 750/750，2/28 跌一半 → 375 + 750
        tight = rb.run(RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0.10, 0.0), self.dates[0], self.dates[-1])
        self.assertAlmostEqual(tight["策略"]["2020-02-28"], 1125)

    def test_cash_interest_and_costs(self):
        rb = self.rb()
        out = rb.run(RebalConfig({"0050": 0.0, "CASH": 1.0}, "none", 0, 0.01), self.dates[0], self.dates[-1])
        days = len(self.dates) - 1
        self.assertAlmostEqual(out["策略"].iloc[-1], 1000 * 1.01 ** (days / 252))
        rb2 = self.rb(TaiwanCost())
        rb2.bh.capital = 1_000_000
        e = rb2.run(RebalConfig({"0050": 1.0}, "none", 0, 0.0), self.dates[0], self.dates[-1])["策略"]
        invested = 1_000_000 / 1.001425                          # 買進金額含手續費 = 100 萬
        self.assertAlmostEqual(e.iloc[0], invested)                 # 買進當天淨值 = 扣掉手續費後的市值
        self.assertAlmostEqual(e.iloc[-1], invested - invested * (0.001425 + 0.001), places=4)

    def test_exposure(self):
        self.assertAlmostEqual(RebalConfig({"00631L": 0.65, "CASH": 0.35}).exposure(), 1.3)
        self.assertAlmostEqual(RebalConfig({"0050": 0.5, "00631L": 0.5}).exposure(), 1.5)


class TestRebalanceTrend(unittest.TestCase):
    def test_trend_sleeve(self):
        tmp = tempfile.TemporaryDirectory()
        path = [10, 10, 10, 10, 10, 11, 12, 13, 10.5, 8.5, 7.0, 5.5, 9.0, 10.0] + [10.0] * 20
        dates = pd.bdate_range("2021-01-04", periods=len(path))
        flat = np.ones(len(path))
        write(Path(tmp.name), dates, {"TAIEX": flat, "0050": flat, "00631L": path, "00675L": flat})
        bh = BuyHold(tmp.name, cost=NO_COST, capital=1000)
        P = TrendParams(3, 5, 0.9, 1.0, 1.03, 0.15, 2)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        rb = RebalBacktest(bh, tb)
        cfg = RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0, 0.0, trend=True)
        eq = rb.run(cfg, dates[0], dates[-1])["策略"]
        self.assertEqual(eq.index[0], dates[4])                   # 均線算得出來才開始
        # 第 5 天轉回續抱：正2 買到 50%（500）；第 8 天 10.5 出場
        v8 = 500 / 11 * 10.5 + 500
        self.assertAlmostEqual(eq[dates[8]], v8)
        # 第 9 天接刀第 1 層：目標 = 50% × 1/2 = 25%
        u = 0.25 * v8 / 8.5
        self.assertAlmostEqual(eq[dates[9]], v8)
        cash = v8 - 0.25 * v8
        v10 = u * 7.0 + cash                                       # 第 10 天接第 2 層：調到 50%
        self.assertAlmostEqual(eq[dates[10]], v10)
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
