"""查看某檔股票的資料並做品質檢查。

用法：
    python scripts/show_stock.py 2330
    python scripts/show_stock.py 0050 --start 2026-01-01
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.data.quality import check_stock  # noqa: E402
from twbt.data.store import PriceStore  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("code")
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--db", default="data/twbt.db")
    a = p.parse_args()

    df = PriceStore(a.db, raw_dir=None).load(a.code, a.start, a.end)
    if df.empty:
        sys.exit(f"資料庫裡沒有 {a.code}，先跑 update_prices.py")
    print(f"{a.code} {df['name'].iloc[-1]}：{len(df)} 筆，{df.index[0].date()} ~ {df.index[-1].date()}\n")
    print(df[["open", "high", "low", "close", "change", "volume"]].tail(10).to_string())

    issues = check_stock(df)
    print(f"\n品質檢查：{'沒有發現問題' if issues.empty else f'{len(issues)} 筆可疑資料'}")
    if not issues.empty:
        print(issues.tail(20).to_string(index=False))
        print("（除權息、新上市前 5 天、減資恢復交易等情況出現在這裡是正常的）")


if __name__ == "__main__":
    main()
