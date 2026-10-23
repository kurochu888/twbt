"""下載證交所上市股票每日行情到本地資料庫。可以隨時中斷，下次會從沒抓過的日期接著抓。

用法：
    python scripts/update_prices.py --start 2026-10-01            # 抓到今天
    python scripts/update_prices.py --start 2004-02-11 --end 2026-10-22
    python scripts/update_prices.py --days 10                     # 只補最近 10 天
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.data.store import PriceStore  # noqa: E402
from twbt.data.twse import NoTradingData, fetch_mi_index, make_session, parse_mi_index  # noqa: E402

EARLIEST = date(2004, 2, 11)
TW = ZoneInfo("Asia/Taipei")  # Colab 等雲端主機是 UTC 時區，一律用台灣時間判斷


def parse_args():
    p = argparse.ArgumentParser(description="下載證交所每日收盤行情")
    p.add_argument("--start", help="開始日期 YYYY-MM-DD")
    p.add_argument("--end", help="結束日期 YYYY-MM-DD（預設今天）")
    p.add_argument("--days", type=int, help="只抓最近 N 天（和 --start 擇一）")
    p.add_argument("--db", default="data/twbt.db")
    p.add_argument("--raw", default="data/raw", help="原始 JSON 存放資料夾")
    p.add_argument("--backup-to", help="定期把資料庫備份到這個路徑（例如 Google Drive）")
    p.add_argument("--backup-every", type=int, default=50, help="每抓幾天備份一次")
    p.add_argument("--sleep", type=float, default=3.5, help="每次請求間隔秒數，別調太低以免被封鎖")
    p.add_argument("--refetch", action="store_true", help="已抓過的日期也重抓")
    return p.parse_args()


def main():
    a = parse_args()
    now = datetime.now(TW)
    today = now.date()
    end = datetime.strptime(a.end, "%Y-%m-%d").date() if a.end else today
    if a.days:
        start = end - timedelta(days=a.days)
    elif a.start:
        start = datetime.strptime(a.start, "%Y-%m-%d").date()
    else:
        sys.exit("請指定 --start 或 --days")
    start = max(start, EARLIEST)

    store = PriceStore(a.db, a.raw)
    done = set() if a.refetch else store.fetched_dates("TWSE")
    todo = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    todo = [d for d in todo if d.weekday() < 5 and d.isoformat() not in done]
    # 今天還沒收盤（約 14:30 後才完整），先跳過
    if todo and todo[-1] == today and now.hour < 15:
        todo.pop()

    print(f"要抓 {len(todo)} 個平日（{start} ~ {end}），預估約 {len(todo) * (a.sleep + 1) / 60:.0f} 分鐘")
    session = make_session()
    failed = []
    streak = 0  # 連續失敗次數
    for i, d in enumerate(todo, 1):
        try:
            raw = fetch_mi_index(d, session)
            df = parse_mi_index(raw, d)
            store.save_raw(d, "TWSE", raw)
            n = store.upsert_prices(df, "TWSE")
            store.log_fetch(d, "TWSE", "trading", n)
            msg = f"{n} 檔"
            streak = 0
        except NoTradingData:
            store.log_fetch(d, "TWSE", "holiday", 0)
            msg = "休市"
            streak = 0
        except Exception as e:  # 失敗的不寫 log，下次會重抓
            failed.append(d)
            streak += 1
            msg = f"失敗：{e}"
        print(f"[{i}/{len(todo)}] {d} {msg}", flush=True)
        if a.backup_to and i % a.backup_every == 0:
            store.backup(a.backup_to)
            print(f"  已備份到 {a.backup_to}", flush=True)
        if streak >= 3:
            print("  連續失敗 3 次，可能被證交所限流，暫停 10 分鐘…", flush=True)
            time.sleep(600)
            streak = 0
        time.sleep(a.sleep + random.uniform(0, 1.5))

    if a.backup_to:
        store.backup(a.backup_to)
        print(f"已備份到 {a.backup_to}")
    print("\n完成。資料庫現況：")
    for k, v in store.summary().items():
        print(f"  {k}: {v}")
    if failed:
        print(f"\n有 {len(failed)} 天失敗，再跑一次同樣的指令就會補抓：{', '.join(map(str, failed[:10]))}")


if __name__ == "__main__":
    main()
