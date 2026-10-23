"""還原股價邏輯測試（不連網）。"""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.data.adjust import adjust, load_splits, unexplained_jumps  # noqa: E402
from twbt.data.twse_hist import roc_to_date  # noqa: E402


def prices(rows):
    df = pd.DataFrame(rows, columns=["date", "close", "change"])
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")
    for c in ("open", "high", "low"):
        df[c] = df["close"]
    return df


class TestAdjust(unittest.TestCase):
    def test_dividend_and_split(self):
        px = prices([
            ("2025-01-02", 200.0, 0.0),
            ("2025-01-03", 200.0, 0.0),     # 除息 2 元：參考價 198，收 198 → 報酬 0
            ("2025-01-06", 198.0, np.nan),
            ("2025-01-07", 199.98, 1.98),   # 漲 1%
            # 1 拆 4，停止交易數天，01-10 恢復交易（事件日 01-09 不是交易日）
            ("2025-01-10", 50.0, np.nan),   # 199.98/4 = 49.995 → 漲約 0.01%
        ])
        ev = pd.DataFrame([
            {"date": "2025-01-06", "kind": "息", "prev_close": 200.0, "ref_price": 198.0, "value": 2.0, "ratio": np.nan},
            {"date": "2025-01-09", "kind": "split", "prev_close": np.nan, "ref_price": np.nan, "value": np.nan, "ratio": 4},
        ])
        a = adjust(px, ev)
        self.assertAlmostEqual(a.loc["2025-01-06", "ret"], 0.0)
        self.assertAlmostEqual(a.loc["2025-01-07", "ret"], 0.01)
        self.assertAlmostEqual(a.loc["2025-01-10", "ret"], 50 / 49.995 - 1)
        self.assertIn("分割", a.loc["2025-01-10", "event"])
        # 最新一天還原價 = 原始價
        self.assertEqual(a["adj_close"].iloc[-1], 50.0)
        # 還原價的漲跌幅 = 總報酬
        np.testing.assert_allclose(a["adj_close"].pct_change().iloc[1:], a["ret"].iloc[1:], rtol=1e-12)
        # 第一天：200 × 0.99 × 0.25
        self.assertAlmostEqual(a["adj_close"].iloc[0], 200 * 0.99 * 0.25)
        self.assertTrue(unexplained_jumps(a, 0.105).empty)

    def test_detects_missing_split(self):
        px = prices([("2025-01-02", 200.0, 0.0), ("2025-01-03", 50.0, np.nan)])
        jumps = unexplained_jumps(adjust(px, pd.DataFrame(columns=["date", "kind", "ratio"])), 0.105)
        self.assertEqual(len(jumps), 1)

    def test_roc_date(self):
        self.assertEqual(str(roc_to_date("115/09/01")), "2026-09-01")
        self.assertEqual(str(roc_to_date("114年01月17日")), "2025-01-17")

    def test_splits_table(self):
        s = load_splits()
        self.assertEqual(set(s.code), {"0050", "00631L"})
        self.assertEqual(int(s[s.code == "00631L"].ratio.iloc[0]), 22)


if __name__ == "__main__":
    unittest.main()
