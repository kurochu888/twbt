"""均線趨勢策略測試（不連網）：短均線 + 手刻價格路徑，每個動作都能手算。"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.backtest import NO_COST, BuyHold, TaiwanCost  # noqa: E402
from twbt.backtest.trend import ADD, EXIT, HOLD, RECOVER, WAIT, WATCH, TrendBacktest, TrendParams, signals  # noqa: E402

P = TrendParams(ma_fast=3, ma_slow=5, exit_buffer=0.9, recover_slope=1.0, recover_strong=1.03,
                pyramid_gap=0.15, pyramid_levels=2)


class TestSignals(unittest.TestCase):
    def test_state_machine(self):
        # 前 5 天暖身（慢線要 5 天），之後：上漲 → 續抱 → 急跌出場 → 再跌兩層接刀 → 反彈轉回續抱
        close = np.array([10, 10, 10, 10, 10,      # 0-4 暖身
                          11, 12, 13,              # 5-7 站上快線 → 轉回續抱
                          10.5,                    # 8 跌破 快線×0.9 → 出場
                          8.5,                     # 9 < min(基準 10.5, 慢線) × 0.85 → 接刀第 1 層
                          7.0,                     # 10 < 8.5 × 0.85 → 接刀第 2 層
                          5.5,                     # 11 已接滿，不再加碼
                          9.0, 10.0])              # 12-13 強反彈 → 轉回續抱
        s = signals(close, P)
        act = list(s["act"])
        self.assertEqual(act[5], RECOVER)          # 第 5 天：11 > 快線(10.33)×1.03 強反彈
        self.assertEqual(s["status"][7], HOLD)
        self.assertEqual(act[8], EXIT)             # 快線 (12+13+10.5)/3=11.83, ×0.9=10.65 > 10.5
        self.assertEqual(act[9], ADD)
        self.assertEqual(act[10], ADD)
        self.assertEqual(s["layers"][10], 2)
        self.assertEqual(act[11], 0)               # 接滿了
        self.assertEqual(s["status"][11], WAIT)
        self.assertIn(RECOVER, act[12:])
        self.assertTrue((s["status"][:5] == WATCH).all())

    def test_not_enough_history(self):
        s = signals(np.ones(5), P)                 # 需要 慢線 + 1 = 6 天
        self.assertTrue((s["act"] == 0).all())


def write_data(d: Path, close: np.ndarray):
    (d / "long").mkdir(parents=True)
    dates = pd.bdate_range("2020-01-01", periods=len(close))
    r = np.concatenate([[np.nan], close[1:] / close[:-1] - 1])
    pd.DataFrame({"close": 1.0, "tr_ret": r, "is_synthetic": 0, "tr_index": 1.0}, index=dates
                 ).rename_axis("date").to_csv(d / "long/TAIEX_long.csv")
    for code in ("0050", "00631L", "00675L"):
        pd.DataFrame({"ret": r, "adj_close": 1.0, "is_synthetic": 0}, index=dates
                     ).rename_axis("date").to_csv(d / f"long/{code}_long.csv")
    (d / "long/params.json").write_text('{"gap_0050": 0, "c_00631L": 0, "c_00675L": 0}')
    return dates


class TestTrendBacktest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        path = [10, 10, 10, 10, 10, 11, 12, 13, 10.5, 8.5, 7.0, 5.5, 9.0, 10.0]
        self.close = np.array(path + [10.0] * 20, dtype=float)      # 後面持平，讓多區間測試有足夠天數
        self.dates = write_data(Path(self.tmp.name), self.close)

    def tearDown(self):
        self.tmp.cleanup()

    def test_money_flow_no_cost(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        res = tb.run("0050", self.dates[0], self.dates[-1])
        c, D, eq = self.close, self.dates, res.equity
        # 均線（慢線 5 天）第 5 天（index 4）才算得出來，策略與買進持有都從那天開始
        self.assertEqual(eq.index[0], D[4])
        self.assertEqual(res.bh_equity.index[0], D[4])
        # 第 5 天以 11 全押：1000/11 單位；第 8 天 10.5 出場
        cash = 1000 / 11 * 10.5
        self.assertAlmostEqual(eq[D[8]], cash)
        # 第 9、10 天各用出場現金的一半
        u = (cash / 2) / 8.5 + (cash / 2) / 7.0
        self.assertAlmostEqual(eq[D[10]], u * 7.0)
        self.assertAlmostEqual(eq[D[11]], u * 5.5)
        # 第 12 天強反彈：現金已經是 0，單位不變
        self.assertAlmostEqual(res.equity.iloc[-1], u * c[-1])
        self.assertEqual(list(res.events["動作"]), ["轉回續抱", "出場", "接刀 第 1 層", "接刀 第 2 層", "轉回續抱"])

    def test_start_mid_state(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        # 從第 9 天（已接刀 1 層）開始：先買出場現金的 1/2（= 本金的一半）
        res = tb.run("0050", self.dates[9], self.dates[-1])
        self.assertEqual((res.start_status, res.start_layers), ("接刀中", 1))
        self.assertAlmostEqual(res.equity.iloc[0], 1000)
        u = 500 / 8.5 + 500 / 7.0
        self.assertAlmostEqual(res.equity.iloc[2], u * 5.5)
        # 從續抱中開始：第一天全部買進
        res2 = tb.run("0050", self.dates[6], self.dates[7])
        self.assertAlmostEqual(res2.equity.iloc[-1], 1000 / 12 * 13)

    def test_costs(self):
        cost = TaiwanCost()
        bh = BuyHold(self.tmp.name, cost=cost, capital=1_000_000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        res = tb.run("0050", self.dates[4], self.dates[8])
        gross = 1_000_000 / 1.001425                     # 第 5 天全押：手續費 = 買進金額 × 0.1425%
        units = gross / 11
        sell = units * 10.5
        self.assertAlmostEqual(res.equity.iloc[-1], sell - sell * 0.001425 - sell * 0.001, places=6)

    def test_windows(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        self.assertTrue(tb.windows([(self.dates[0], self.dates[-1])]).empty)   # 起點早於均線算得出來的日子，不比
        w = tb.windows([(self.dates[4], self.dates[-1])])
        self.assertEqual(set(w["標的"]), {"0050", "00631L 台灣50正2", "00675L 加權正2"})   # 大盤不跑策略
        self.assertTrue(np.allclose(w["持有總報酬"], 0.0))       # 10 → 10
        self.assertAlmostEqual(w["策略總報酬"].iloc[0], (1000 / 11 * 10.5 / 2 * (1 / 8.5 + 1 / 7.0)) * 10 / 1000 - 1)


if __name__ == "__main__":
    unittest.main()
