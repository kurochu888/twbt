"""本地資料庫：用 Python 內建的 SQLite，一個檔案搞定，不用另外安裝資料庫。"""
from __future__ import annotations

import json
import sqlite3
from datetime import date
from pathlib import Path

import pandas as pd

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_price (
    date TEXT NOT NULL, code TEXT NOT NULL, name TEXT,
    volume REAL, trades REAL, value REAL,
    open REAL, high REAL, low REAL, close REAL,
    change REAL, no_compare INTEGER,
    market TEXT NOT NULL DEFAULT 'TWSE',
    PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_price_code ON daily_price(code, date);
-- 記錄每個日期抓過沒、結果如何（trading = 有資料；holiday = 沒交易）
CREATE TABLE IF NOT EXISTS fetch_log (
    date TEXT NOT NULL, market TEXT NOT NULL,
    status TEXT NOT NULL, rows INTEGER, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, market)
);
-- 逐月下載的個股日K（STOCK_DAY）
CREATE TABLE IF NOT EXISTS stock_daily (
    date TEXT NOT NULL, code TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL,
    volume REAL, value REAL, trades REAL, change REAL, note TEXT,
    PRIMARY KEY (date, code)
);
-- 指數：TAIEX = 加權指數、TAIEX_TR = 加權報酬指數（含息）
CREATE TABLE IF NOT EXISTS index_daily (
    date TEXT NOT NULL, index_code TEXT NOT NULL, close REAL,
    PRIMARY KEY (date, index_code)
);
-- 公司行為：kind = 息 / 權 / 權息 / split
CREATE TABLE IF NOT EXISTS corp_events (
    date TEXT NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL,
    prev_close REAL, ref_price REAL, value REAL, ratio REAL, source TEXT,
    PRIMARY KEY (date, code, kind)
);
-- 逐月下載紀錄（key 例如 stock:0050、taiex、tri）
CREATE TABLE IF NOT EXISTS month_log (
    key TEXT NOT NULL, ym TEXT NOT NULL, rows INTEGER,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key, ym)
);
"""


class PriceStore:
    def __init__(self, db_path: str | Path = "data/twbt.db", raw_dir: str | Path | None = "data/raw"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.raw_dir = Path(raw_dir) if raw_dir else None
        self.conn = sqlite3.connect(self.db_path)
        self.conn.executescript(SCHEMA)

    # ----- 寫入 -----
    def save_raw(self, d: date, market: str, raw: dict) -> None:
        """原始 JSON 也留一份：日後解析邏輯改了，不用重新下載。"""
        if not self.raw_dir:
            return
        p = self.raw_dir / market / str(d.year) / f"{d:%Y%m%d}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    def upsert_prices(self, df: pd.DataFrame, market: str = "TWSE") -> int:
        if df.empty:
            return 0
        df = df.assign(market=market)
        cols = list(df.columns)
        sql = (f"INSERT OR REPLACE INTO daily_price ({','.join(cols)}) "
               f"VALUES ({','.join('?' * len(cols))})")
        rows = [tuple(None if pd.isna(v) else v for v in rec)
                for rec in df.itertuples(index=False, name=None)]
        with self.conn:
            self.conn.executemany(sql, rows)
        return len(rows)

    def upsert(self, table: str, df: pd.DataFrame) -> int:
        """通用寫入：同主鍵的資料會被覆蓋。"""
        if df.empty:
            return 0
        cols = list(df.columns)
        sql = (f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) "
               f"VALUES ({','.join('?' * len(cols))})")
        rows = [tuple(None if pd.isna(v) else v for v in rec)
                for rec in df.itertuples(index=False, name=None)]
        with self.conn:
            self.conn.executemany(sql, rows)
        return len(rows)

    def log_month(self, key: str, ym: str, rows: int) -> None:
        with self.conn:
            self.conn.execute("INSERT OR REPLACE INTO month_log (key, ym, rows) VALUES (?,?,?)",
                              (key, ym, rows))

    def done_months(self, key: str) -> set[str]:
        return {r[0] for r in self.conn.execute("SELECT ym FROM month_log WHERE key=?", (key,))}

    def query(self, sql: str, params: tuple = ()) -> pd.DataFrame:
        return pd.read_sql_query(sql, self.conn, params=params)

    # ----- 匯出／匯入 CSV（放進 GitHub 用：文字檔每天只增加幾行，資料庫可隨時重建） -----
    CSV_TABLES = {
        "stock_daily": ["date", "code"],
        "index_daily": ["date", "index_code"],
        "corp_events": ["date", "code", "kind"],
        "month_log": ["key", "ym"],
    }

    def export_csv(self, out_dir: str | Path) -> None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for table, keys in self.CSV_TABLES.items():
            df = self.query(f"SELECT * FROM {table} ORDER BY {', '.join(keys[::-1])}")
            if table == "month_log":
                df = df.drop(columns=["fetched_at"])   # 時間戳每次都變，不放進 git
            df.to_csv(out / f"{table}.csv", index=False)

    def import_csv(self, in_dir: str | Path) -> int:
        """從 CSV 匯入（同主鍵覆蓋）。回傳匯入的資料表數。"""
        n = 0
        for table in self.CSV_TABLES:
            p = Path(in_dir) / f"{table}.csv"
            if p.exists():
                df = pd.read_csv(p, dtype={"code": str, "ym": str, "key": str, "date": str})
                self.upsert(table, df)
                n += 1
        return n

    def log_fetch(self, d: date, market: str, status: str, rows: int = 0) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO fetch_log (date, market, status, rows) VALUES (?,?,?,?)",
                (d.isoformat(), market, status, rows))

    # ----- 讀取 -----
    def fetched_dates(self, market: str = "TWSE") -> set[str]:
        cur = self.conn.execute("SELECT date FROM fetch_log WHERE market=?", (market,))
        return {r[0] for r in cur}

    def trading_days(self, market: str = "TWSE") -> list[str]:
        cur = self.conn.execute(
            "SELECT date FROM fetch_log WHERE market=? AND status='trading' ORDER BY date", (market,))
        return [r[0] for r in cur]

    def load(self, code: str, start: str | None = None, end: str | None = None) -> pd.DataFrame:
        """讀一檔股票的日K，index 是日期。"""
        q = "SELECT * FROM daily_price WHERE code=?"
        args: list = [code]
        if start:
            q += " AND date>=?"; args.append(start)
        if end:
            q += " AND date<=?"; args.append(end)
        df = pd.read_sql_query(q + " ORDER BY date", self.conn, params=args)
        df["date"] = pd.to_datetime(df["date"])
        return df.set_index("date")

    def load_field(self, field: str = "close", start: str | None = None,
                   end: str | None = None) -> pd.DataFrame:
        """全市場寬表：列=日期、欄=股票代號。之後做選股策略會用到。"""
        if field not in {"open", "high", "low", "close", "volume", "value", "change"}:
            raise ValueError(field)
        q = f"SELECT date, code, {field} FROM daily_price WHERE 1=1"
        args: list = []
        if start:
            q += " AND date>=?"; args.append(start)
        if end:
            q += " AND date<=?"; args.append(end)
        df = pd.read_sql_query(q, self.conn, params=args)
        df["date"] = pd.to_datetime(df["date"])
        return df.pivot(index="date", columns="code", values=field).sort_index()

    def summary(self) -> dict:
        c = self.conn
        return {
            "交易日數": c.execute("SELECT COUNT(*) FROM fetch_log WHERE status='trading'").fetchone()[0],
            "非交易日數": c.execute("SELECT COUNT(*) FROM fetch_log WHERE status='holiday'").fetchone()[0],
            "資料筆數": c.execute("SELECT COUNT(*) FROM daily_price").fetchone()[0],
            "股票檔數": c.execute("SELECT COUNT(DISTINCT code) FROM daily_price").fetchone()[0],
            "最早日期": c.execute("SELECT MIN(date) FROM daily_price").fetchone()[0],
            "最新日期": c.execute("SELECT MAX(date) FROM daily_price").fetchone()[0],
        }

    def backup(self, target: str | Path) -> None:
        """用 SQLite 內建備份功能複製一份（不會拷到寫一半的檔案）。"""
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".tmp")
        dst = sqlite3.connect(tmp)
        with dst:
            self.conn.backup(dst)
        dst.close()
        tmp.replace(target)

    def close(self):
        self.conn.close()
