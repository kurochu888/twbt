"""蒙地卡羅測試：均線策略 vs 買進持有。

    python scripts/montecarlo.py                 # 預設：00631L、0050 × 含模擬/只用真實 × 5 種區塊長度
    python scripts/montecarlo.py --n 500         # 快速版
輸出 data/montecarlo/summary.csv 與每組的路徑明細。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

from twbt.backtest import BuyHold  # noqa: E402
from twbt.backtest.data import NAMES, load_signal_inputs  # noqa: E402
from twbt.backtest.montecarlo import monte_carlo, summarize_mc  # noqa: E402
from twbt.backtest.trend import LEVERAGE, TrendParams  # noqa: E402

BLOCKS = {1: "每天打亂", 20: "約 1 個月", 60: "約 3 個月", 120: "約半年", 250: "約 1 年"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/adjusted")
    ap.add_argument("--out", default="data/montecarlo")
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--years", type=float, default=10)
    ap.add_argument("--seed", type=int, default=20261024)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    rows = []
    for syn_on in (True, False):
        bh = BuyHold(a.data, use_synthetic=syn_on)
        sig, _ = load_signal_inputs(a.data, bh.rets, bh.syn)
        for code in ("00631L", "0050"):
            r = bh.rets[code].dropna()
            src = f"{r.index[0].date()}～{r.index[-1].date()}" + ("（含模擬）" if syn_on else "（只用真實）")
            p = TrendParams.default(LEVERAGE[code])
            for block, label in BLOCKS.items():
                df = monte_carlo(r, sig[code], p, n=a.n, years=a.years, block=block, seed=a.seed + block,
                                 px0=float(bh.lots[code]["px"][-1]))   # 從現在的每股價格出發（整張交易）
                df.to_csv(out / f"{code}_{'syn' if syn_on else 'real'}_b{block}.csv", index=False)
                s = summarize_mc(df, a.years)
                rows.append({"標的": NAMES[code], "取樣來源": src, "區塊長度": f"{block} 天（{label}）", **s})
                print(f"{code} {src} 區塊 {block:>3}：策略贏 {s['策略贏的機率']:.0%}，年化差中位數 {s['年化差 中位數']:+.1%}，"
                      f"回撤中位數 {s['策略回撤 中位數']:.0%} vs {s['持有回撤 中位數']:.0%}", flush=True)
    pd.DataFrame(rows).to_csv(out / "summary.csv", index=False, encoding="utf-8-sig")
    print(f"\n已輸出 {out / 'summary.csv'}")


if __name__ == "__main__":
    main()
