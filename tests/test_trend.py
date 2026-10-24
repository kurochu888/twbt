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
        pd.DataFrame({"close": close}, index=dates).rename_axis("date").to_csv(d / f"{code}.csv")   # 實際每股價格
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

    # 整張交易：一張 1000 股，價格 10～13 元 → 一張 1 萬多元
    def test_money_flow_no_cost(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1_000_000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        res = tb.run("0050", self.dates[0], self.dates[-1])
        D, eq = self.dates, res.equity
        # 均線（慢線 5 天）第 5 天（index 4）才算得出來，策略與買進持有都從那天開始
        self.assertEqual(eq.index[0], D[4])
        self.assertEqual(res.bh_equity.index[0], D[4])
        # 第 5 天 11 元轉回續抱：100 萬買 90 張（99 萬），剩 1 萬；第 8 天 10.5 元出場 → 95.5 萬
        self.assertAlmostEqual(eq[D[5]], 10_000 + 90_000 * 11)
        self.assertAlmostEqual(eq[D[8]], 955_000)
        # 第 9 天 8.5 元：出場現金的一半 477,500 → 56 張（476,000）；第 10 天 7 元：477,500 → 68 張（476,000），剩 3,000
        self.assertAlmostEqual(eq[D[9]], 955_000 - 476_000 + 56_000 * 8.5)
        self.assertAlmostEqual(eq[D[10]], 3_000 + 124_000 * 7.0)
        self.assertAlmostEqual(eq[D[11]], 3_000 + 124_000 * 5.5)
        # 第 12 天強反彈：剩 3,000 元買不起一張，股數不變；最後 10 元
        self.assertAlmostEqual(res.equity.iloc[-1], 3_000 + 124_000 * 10.0)
        self.assertEqual(list(res.events["動作"]), ["轉回續抱", "出場", "接刀 第 1 層", "接刀 第 2 層", "轉回續抱"])
        self.assertEqual(list(res.events["持有張數"]), [90, 0, 56, 124, 124])

    def test_start_mid_state(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1_000_000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        # 從第 9 天（已接刀 1 層）開始：用本金的一半 50 萬，8.5 元買 58 張（493,000）
        res = tb.run("0050", self.dates[9], self.dates[-1])
        self.assertEqual((res.start_status, res.start_layers), ("接刀中", 1))
        self.assertAlmostEqual(res.equity.iloc[0], 1_000_000)
        # 第 10 天 7 元：再用 50 萬買 71 張（497,000），剩 10,000
        self.assertAlmostEqual(res.equity.iloc[2], 10_000 + 129_000 * 5.5)
        # 從續抱中開始：第一天 12 元買 83 張（996,000），剩 4,000
        res2 = tb.run("0050", self.dates[6], self.dates[7])
        self.assertAlmostEqual(res2.equity.iloc[-1], 4_000 + 83_000 * 13)

    def test_costs(self):
        bh = BuyHold(self.tmp.name, cost=TaiwanCost(), capital=1_000_000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        res = tb.run("0050", self.dates[4], self.dates[8])
        # 第 5 天 11 元：90 張 = 990,000，手續費 round(990,000 × 0.1425%) = 1,411 → 剩 8,589
        # 第 8 天 10.5 元賣 90 張 = 945,000，手續費＋證交稅 round(1,346.625 + 945) = 2,292
        self.assertAlmostEqual(res.equity.iloc[-1], 8_589 + 945_000 - 2_292)

    def test_windows(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=1_000_000)
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        self.assertTrue(tb.windows([(self.dates[0], self.dates[-1])]).empty)   # 起點早於均線算得出來的日子，不比
        w = tb.windows([(self.dates[4], self.dates[-1])])
        self.assertEqual(set(w["標的"]), {"0050", "00631L 台灣50正2", "00675L 加權正2"})   # 大盤不跑策略
        self.assertTrue(np.allclose(w["持有總報酬"], 0.0))       # 10 元買 100 張 → 10 元賣
        self.assertAlmostEqual(w["策略總報酬"].iloc[0], 1_243_000 / 1_000_000 - 1)

    def test_too_little_money(self):
        bh = BuyHold(self.tmp.name, cost=NO_COST, capital=5_000)   # 一張 1 萬多，買不起
        tb = TrendBacktest(bh, {c: P for c in bh.rets.columns})
        res = tb.run("0050", self.dates[0], self.dates[-1])
        self.assertTrue(np.allclose(res.equity, 5_000))
        self.assertTrue(np.allclose(res.bh_equity, 5_000))


if __name__ == "__main__":
    unittest.main()
