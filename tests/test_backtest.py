"""買進持有回測測試（不連網）：用可以手算的假資料驗證。"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.backtest import NO_COST, BuyHold, TaiwanCost, describe, win_rate  # noqa: E402
from twbt.backtest.metrics import max_drawdown, summarize  # noqa: E402

DATES = pd.bdate_range("2000-01-03", "2009-12-31")


def make_data(d: Path):
    (d / "long").mkdir(parents=True)
    (d / "long/params.json").write_text('{"gap_0050": 0.02, "c_00631L": 0.01, "c_00675L": -0.01}')
    n = len(DATES)
    r_mkt = np.full(n, 0.0004)
    r_mkt[0] = np.nan
    pd.DataFrame({"close": 1000.0, "tr_ret": r_mkt, "is_synthetic": 0, "tr_index": 1.0},
                 index=DATES).rename_axis("date").to_csv(d / "long/TAIEX_long.csv")
    for code, k in (("0050", 1), ("00631L", 2), ("00675L", 2)):
        r = r_mkt * k
        syn = (DATES < "2005-01-01").astype(int)
        if code == "0050":
            r = r.copy()
            r[(DATES >= "2006-03-01") & (DATES < "2006-03-08")] = np.nan   # 分割暫停交易
        pd.DataFrame({"ret": r, "adj_close": 1.0, "is_synthetic": syn},
                     index=DATES).rename_axis("date").to_csv(d / f"long/{code}_long.csv")


class TestBuyHold(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        make_data(Path(cls.tmp.name))
        cls.dir = cls.tmp.name

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_no_cost_matches_compounding(self):
        bh = BuyHold(self.dir, cost=NO_COST)
        eq = bh.equity("0050", "2001-01-01", "2001-12-31")
        days = len(eq) - 1
        self.assertAlmostEqual(eq.iloc[-1], 1_000_000 * 1.0004 ** days, places=4)

    def test_costs(self):
        c = TaiwanCost(discount=0.5)
        self.assertAlmostEqual(c.buy_cost(1_000_000, "etf"), 1_000_000 * 0.001425 * 0.5)
        self.assertEqual(c.buy_cost(1000, "etf"), 20.0)                 # 最低 20 元
        self.assertAlmostEqual(c.sell_cost(1_000_000, "etf"), 712.5 + 1000)   # ETF 稅 0.1%
        self.assertAlmostEqual(c.sell_cost(1_000_000, "stock"), 712.5 + 3000)
        self.assertEqual(c.sell_cost(1_000_000, "index"), 0.0)
        bh = BuyHold(self.dir, cost=TaiwanCost())
        eq = bh.equity("0050", "2001-01-01", "2001-12-31")
        days = len(eq) - 1
        gross = (1_000_000 - 1425) * 1.0004 ** days
        self.assertAlmostEqual(eq.iloc[-1], gross - gross * 0.001425 - gross * 0.001, places=4)
        # 大盤是基準，不扣成本
        eq_m = bh.equity("TAIEX", "2001-01-01", "2001-12-31")
        self.assertAlmostEqual(eq_m.iloc[-1], 1_000_000 * 1.0004 ** days, places=4)

    def test_halt_days_are_zero_return(self):
        bh = BuyHold(self.dir, cost=NO_COST)
        r = bh.rets.loc["2006-03-01":"2006-03-07", "0050"]
        self.assertTrue((r == 0).all())
        eq = bh.equity("0050", "2006-01-01", "2006-12-31")   # 不會因暫停交易而失敗
        self.assertTrue(np.isfinite(eq.iloc[-1]))

    def test_period_and_synthetic_share(self):
        bh = BuyHold(self.dir)
        st, cur = bh.period("2004-01-01", "2005-12-31")
        self.assertAlmostEqual(st.loc["模擬資料占比", "0050"], 0.5, delta=0.02)
        self.assertEqual(st.loc["模擬資料占比", "大盤（含息）"], 0.0)
        bh_real = BuyHold(self.dir, use_synthetic=False)
        st2, _ = bh_real.period("2004-01-01", "2005-12-31")
        self.assertNotIn("0050", st2.columns)                 # 有模擬段就被略過
        self.assertIn("大盤（含息）", st2.columns)

    def test_rolling_and_random(self):
        bh = BuyHold(self.dir, cost=NO_COST)
        r = bh.rolling(3)
        counts = r.groupby("標的").size()
        self.assertEqual(counts.nunique(), 1)                 # 每個標的區間數相同
        self.assertEqual(counts.iloc[0], 84)                  # 2000-01 ~ 2006-12 每月一個起點
        d = describe(r)
        self.assertEqual(d.loc["虧損機率", "0050"], 0.0)
        self.assertEqual(win_rate(r, "00631L 台灣50正2", "0050"), 1.0)
        a = bh.random(50, (2, 4), seed=7)
        b = bh.random(50, (2, 4), seed=7)
        pd.testing.assert_frame_equal(a, b)                   # 同一個 seed 結果相同
        self.assertTrue(((a["年數"] > 1.9) & (a["年數"] < 4.1)).all())


    def test_conservative_synthetic(self):
        bh = BuyHold(self.dir, tw50_excess=False)
        pre = bh.syn["0050"] == 1
        np.testing.assert_allclose(bh.rets.loc[pre, "0050"].iloc[1:], bh.rets.loc[pre, "TAIEX"].iloc[1:])
        # 00631L：2 × 大盤 + (0.01 − 2 × 0.02)/年
        exp = 2 * 0.0004 + np.expm1(-0.03 / 252)
        self.assertAlmostEqual(bh.rets.loc[pre, "00631L"].iloc[5], exp)
        # 真實段不受影響
        post = bh.syn["0050"] == 0
        self.assertAlmostEqual(bh.rets.loc[post, "0050"].iloc[5], 0.0004)


class TestMetrics(unittest.TestCase):
    def test_drawdown(self):
        idx = pd.bdate_range("2020-01-01", periods=6)
        eq = pd.Series([100, 120, 90, 60, 130, 110.0], index=idx)
        mdd, top, trough, rec = max_drawdown(eq)
        self.assertAlmostEqual(mdd, -0.5)
        self.assertEqual((top, trough, rec), (idx[1], idx[3], idx[4]))
        s = summarize(eq)
        self.assertAlmostEqual(s["總報酬"], 0.10)


if __name__ == "__main__":
    unittest.main()
