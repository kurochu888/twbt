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
        pd.DataFrame({"close": np.asarray(series[c], float)}, index=dates).rename_axis("date").to_csv(d / f"{c}.csv")
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
        bh = BuyHold(self.tmp.name, cost=cost, capital=1_000_000)
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
        self.assertAlmostEqual(eq["2020-01-31"], 1_500_000)
        # 2/28 跌一半：750 → 375，總值 1125；3/2 調回
        self.assertAlmostEqual(eq["2020-02-28"], 1_125_000)
        self.assertAlmostEqual(eq.iloc[-1], 1_125_000)
        # 不再平衡：500 → 1000 → 500，總值回到 1000
        flat = rb.run(cfg, self.dates[0], self.dates[-1])["同配置不再平衡"]
        self.assertAlmostEqual(flat.iloc[-1], 1_000_000)

    def test_band(self):
        rb = self.rb()
        # 門檻 ±30 點：1/31 正2 變成 1000/1500 = 66.7%，偏離 16.7 點 < 30，不調 → 跟不再平衡一樣
        wide = rb.run(RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0.30, 0.0), self.dates[0], self.dates[-1])
        self.assertAlmostEqual(wide["策略"].iloc[-1], 1_000_000)
        # 門檻 ±10 點、每天檢查：1/31 當天就調回 750/750，2/28 跌一半 → 375 + 750
        tight = rb.run(RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0.10, 0.0), self.dates[0], self.dates[-1])
        self.assertAlmostEqual(tight["策略"]["2020-02-28"], 1_125_000)

    def test_cash_interest_and_costs(self):
        rb = self.rb()
        out = rb.run(RebalConfig({"0050": 0.0, "CASH": 1.0}, "none", 0, 0.01), self.dates[0], self.dates[-1])
        years = (self.dates[-1] - self.dates[0]).days / 365.25          # 利息照日曆時間
        self.assertAlmostEqual(out["策略"].iloc[-1], 1_000_000 * 1.01 ** years)
        rb2 = self.rb(TaiwanCost())
        e = rb2.run(RebalConfig({"0050": 1.0}, "none", 0, 0.0), self.dates[0], self.dates[-1])["策略"]
        # 每股 1 元、一張 1,000 元：100 萬買 998 張（998,000 + 手續費 1,422），剩 578 元
        self.assertAlmostEqual(e.iloc[0], 578 + 998_000)
        # 期末賣 998,000：手續費＋證交稅 round(1,422.15 + 998) = 2,420
        self.assertAlmostEqual(e.iloc[-1], 578 + 998_000 - 2_420)

    def test_zero_fee_and_min_trade(self):
        from twbt.backtest.rebalance import MIN_TRADE
        free = TaiwanCost(discount=0)
        self.assertEqual(free.buy_cost(1e6, "etf"), 0.0)                 # 免手續費：連最低 20 元也不收
        self.assertAlmostEqual(free.sell_cost(1e6, "etf"), 1000.0)       # 證交稅照收
        # 偏離很小時不交易：門檻 0、每月檢查，但 0050 不動、只有現金利息讓比例微幅偏離
        rb = self.rb(TaiwanCost())
        out = rb.run(RebalConfig({"0050": 0.5, "CASH": 0.5}, "M", 0, 0.01), self.dates[0], self.dates[-1])
        self.assertEqual(out["交易次數"], 1)                              # 只有期初買進那一筆
        self.assertGreater(MIN_TRADE, 100)

    def test_all_cash(self):
        rb = self.rb()
        out = rb.run(RebalConfig({"CASH": 1.0}, "M", 0.05, 0.02), self.dates[0], self.dates[-1])   # 以前會當掉
        self.assertAlmostEqual(out["策略"].iloc[-1], 1_000_000 * 1.02 ** ((self.dates[-1] - self.dates[0]).days / 365.25))
        self.assertEqual(out["交易次數"], 0)

    def test_exposure(self):
        self.assertAlmostEqual(RebalConfig({"00631L": 0.65, "CASH": 0.35}).exposure(), 1.3)
        self.assertAlmostEqual(RebalConfig({"0050": 0.5, "00631L": 0.5}).exposure(), 1.5)


class TestRebalanceHalt(unittest.TestCase):
    def test_no_trade_on_halt_day(self):
        tmp = tempfile.TemporaryDirectory()
        dates = pd.bdate_range("2020-03-23", "2020-04-10")       # 4/1 是 4 月第一個交易日
        n = len(dates)
        p631 = np.where(dates < pd.Timestamp("2020-03-27"), 1.0, 2.0)
        flat = np.ones(n)
        write(Path(tmp.name), dates, {"TAIEX": flat, "0050": flat, "00631L": p631, "00675L": flat})
        # 00631L 3/31～4/2 暫停交易：長期序列裡沒有這幾天
        f = Path(tmp.name) / "long/00631L_long.csv"
        df = pd.read_csv(f, index_col=0, parse_dates=True)
        df[(df.index < "2020-03-31") | (df.index > "2020-04-02")].to_csv(f)
        bh = BuyHold(tmp.name, cost=NO_COST, capital=1_000_000)
        rb = RebalBacktest(bh)
        out = rb.run(RebalConfig({"00631L": 0.5, "CASH": 0.5}, "M", 0, 0.0), dates[0], dates[-1])
        log = [str(d.date()) for d, w in out["紀錄"]]
        self.assertNotIn("2020-04-01", log)                       # 暫停交易那天不調
        self.assertEqual(out["交易次數"], 1)                       # 4 月只檢查一次（4/1），所以整段只有期初那筆
        tmp.cleanup()


class TestRebalanceTrend(unittest.TestCase):
    def test_trend_sleeve(self):
        tmp = tempfile.TemporaryDirectory()
        path = [10, 10, 10, 10, 10, 11, 12, 13, 10.5, 8.5, 7.0, 5.5, 9.0, 10.0] + [10.0] * 20
        dates = pd.bdate_range("2021-01-04", periods=len(path))
        flat = np.ones(len(path))
        write(Path(tmp.name), dates, {"TAIEX": flat, "0050": flat, "00631L": path, "00675L": flat})
        bh = BuyHold(tmp.name, cost=NO_COST, capital=1_000_000)
        P = TrendParams(3, 5, 0.9, 1.0, 1.03, 0.15, 2)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        rb = RebalBacktest(bh, tb)
        cfg = RebalConfig({"00631L": 0.5, "CASH": 0.5}, "none", 0, 0.0, trend=True)
        out = rb.run(cfg, dates[0], dates[-1])
        eq = out["策略"]
        self.assertEqual(eq.index[0], dates[4])                   # 均線算得出來才開始
        # 第 5 天轉回續抱：目標 50 萬、一張 11,000 → 45 張（495,000）；第 8 天 10.5 出場 → 505,000 + 472,500
        self.assertAlmostEqual(eq[dates[8]], 977_500)
        # 第 9 天接刀第 1 層：目標 25% × 977,500 = 244,375，一張 8,500 → 28.75 → 29 張
        self.assertAlmostEqual(eq[dates[9]], 977_500)
        # 第 10 天接第 2 層：總值 731,000 + 29,000 × 7 = 934,000，目標 50% = 467,000 → 66.7 → 67 張
        self.assertAlmostEqual(eq[dates[10]], 934_000)
        nt = out["同配置不搭配均線"]                                 # 不搭配均線：一直放 50%
        self.assertAlmostEqual(nt.iloc[0], 1_000_000)
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
