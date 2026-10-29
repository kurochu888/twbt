"""參數穩健性檢查測試（不連網）：隨機漫步價格、短均線，結果跟直接跑 TrendBacktest 對照。"""
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.backtest import BuyHold  # noqa: E402
from twbt.backtest.robust import ParamSweep  # noqa: E402
from twbt.backtest.trend import TrendBacktest, TrendParams  # noqa: E402
from tests.test_trend import write_data  # noqa: E402

BASE = TrendParams(ma_fast=10, ma_slow=20, exit_buffer=0.95, recover_slope=1.0, recover_strong=1.03,
                   pyramid_gap=0.1, pyramid_levels=2)
GRID = {"ma_fast": [5, 10, 30], "exit_buffer": [0.9, 0.95]}


class TestParamSweep(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        rng = np.random.default_rng(7)
        close = 20 * np.exp(np.cumsum(rng.normal(0.0003, 0.015, 3000)))
        cls.dates = write_data(Path(cls.tmp.name), close)
        cls.bh = BuyHold(cls.tmp.name)
        cls.tb = TrendBacktest(cls.bh, {c: BASE for c in cls.bh.rets.columns})
        cls.ps = ParamSweep(cls.tb, "0050", GRID)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_same_start_and_matches_trend(self):
        ps, tb = self.ps, self.tb
        self.assertEqual(tb.params["0050"], BASE)                     # 掃完參數要還原
        self.assertEqual(ps.default, ps.combos.index({"ma_fast": 10, "exit_buffer": 0.95}))
        # 同一天開始 = 均線最長的組合（快線 30）第一次算得出來那天
        tb2 = TrendBacktest(self.bh, {c: replace(BASE, ma_fast=30) for c in self.bh.rets.columns})
        self.assertEqual(ps.si, tb2._sig["0050"]["min_si"])
        for i in (0, ps.default, len(ps.combos) - 1):                 # 每一組都跟直接用那組參數跑一樣
            t = TrendBacktest(self.bh, {c: replace(BASE, **ps.combos[i]) for c in self.bh.rets.columns})
            eq, _, _, _ = t._simulate("0050", ps.si, ps.ei)
            np.testing.assert_allclose(ps.eq[i], eq)
        bh, _ = self.bh._path("0050", ps.si, ps.ei)
        np.testing.assert_allclose(ps.bh, bh)

    def test_table(self):
        ps = self.ps
        df = ps.table(roll_years=2)
        self.assertEqual(len(df), 6)
        eq = ps.eq[ps.default]
        years = (ps.dates[-1] - ps.dates[0]).days / 365.25
        row = df.loc[ps.default]
        self.assertTrue(row["預設"])
        self.assertAlmostEqual(row["年化"], (eq[-1] / eq[0]) ** (1 / years) - 1)
        self.assertAlmostEqual(row["最大回撤"], (eq / np.maximum.accumulate(eq) - 1).min())
        self.assertGreater(df.attrs["windows"], 10)
        self.assertTrue(((df["2年贏持有比例"] >= 0) & (df["2年贏持有比例"] <= 1)).all())
        h = ps.heat(df, "年化")
        self.assertEqual(h.shape, (3, 2))
        self.assertAlmostEqual(h.loc[10, 0.95], row["年化"])
        pl = ps.plateau(df, "年化")                                   # 角落：自己 + 右、下兩個鄰居
        self.assertAlmostEqual(pl.loc[(5, 0.9)], np.mean([h.loc[5, 0.9], h.loc[5, 0.95], h.loc[10, 0.9]]))

    def test_split(self):
        split = self.dates[1500]
        s = self.ps.split_test(split)
        ins = self.ps.table(None, split - np.timedelta64(1, "D"), roll_years=None)
        best = int(ins["年化"].idxmax())
        self.assertEqual(s["樣本內最佳"], self.ps.combos[best])
        self.assertLessEqual(abs(s["排名相關係數"]), 1)

    def test_walk_forward(self):
        ps = self.ps
        w = ps.walk_forward(self.dates[1200], step_years=2)
        blocks, cv = w["每段"], w["淨值"]
        self.assertEqual(cv.index[0], self.dates[1200])
        self.assertAlmostEqual(cv["walk-forward"].iloc[0], 1.0)
        # 每一段的報酬 = 那段選到的組合同期的報酬，一段一段接起來
        total = 1.0
        for _, b in blocks.iterrows():
            k = ps.combos.index({n: b[n] for n in ps.names})
            a, e = ps.dates.get_loc(str(b["開始"])), ps.dates.get_loc(str(b["結束"]))
            total *= ps.eq[k][e] / ps.eq[k][a]
            # 選的是「到這段開始前一天」為止年化最高的組合
            ins = ps.table(None, ps.dates[a - 1], roll_years=None)
            self.assertEqual(k, int(ins["年化"].idxmax()))
        self.assertAlmostEqual(cv["walk-forward"].iloc[-1], total)
        self.assertEqual(str(blocks["結束"].iloc[-1]), str(ps.dates[-1].date()))

    def test_single_combo_walk_forward_equals_default(self):
        ps = ParamSweep(self.tb, "0050", {"ma_fast": [10], "exit_buffer": [0.95]})
        cv = ps.walk_forward(self.dates[1200], step_years=1)["淨值"]
        np.testing.assert_allclose(cv["walk-forward"], cv["預設參數"])


if __name__ == "__main__":
    unittest.main()
