"""模擬序列測試（不連網）：用已知參數產生假資料，確認校正能把參數找回來。"""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.data.synthetic import (calibrate_leverage, leveraged_return, market_total_return,  # noqa: E402
                                 shift_return, splice)

rng = np.random.default_rng(0)
DATES = pd.bdate_range("1995-01-02", periods=3000)


class TestSynthetic(unittest.TestCase):
    def test_market_tr_recovers_dividend(self):
        px_ret = pd.Series(rng.normal(0.0003, 0.012, len(DATES)), index=DATES)
        px = 1000 * (1 + px_ret).cumprod()
        tr_ret = shift_return(px_ret, 0.03)            # 真實股息 3%
        tr = (1000 * (1 + tr_ret).cumprod()).where(DATES >= DATES[1500])   # 後半段才有報酬指數
        ret, info = market_total_return(px, tr)
        self.assertAlmostEqual(info["股息估計（年化）"], 0.03, places=6)
        # 前半段用估計、後半段用真實報酬指數，兩者都應與 tr_ret 幾乎相同
        np.testing.assert_allclose(ret.iloc[2:], tr_ret.iloc[2:], atol=1e-12)

    def test_leverage_calibration(self):
        base = pd.Series(rng.normal(0.0003, 0.012, len(DATES)), index=DATES)
        real = leveraged_return(base, -0.02)           # 真實年化拖累 -2%
        c = calibrate_leverage(real.iloc[2000:], base.iloc[2000:])
        self.assertAlmostEqual(c, -0.02, places=6)

    def test_splice_continuity(self):
        syn = pd.Series(rng.normal(0.0005, 0.01, len(DATES)), index=DATES)
        real_idx = DATES[1000:]
        real_ret = syn.loc[real_idx].copy()
        adj = 50 * (1 + real_ret).cumprod()
        real = pd.DataFrame({"ret": real_ret, "adj_close": adj})
        real.iloc[0, 0] = np.nan                       # 真實第一天沒有報酬
        out = splice(real, syn)
        self.assertEqual(out["is_synthetic"].sum(), 1001)   # 含上市第一天
        self.assertEqual(out["adj_close"].iloc[-1], adj.iloc[-1])
        # 整段還原價的日報酬 = ret（含接點）
        np.testing.assert_allclose(out["adj_close"].pct_change().iloc[1:], out["ret"].iloc[1:], rtol=1e-10)


if __name__ == "__main__":
    unittest.main()
