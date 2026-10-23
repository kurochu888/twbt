"""資料層離線測試：不連網，用模擬的證交所回應驗證解析、儲存與檢查邏輯。

執行：python -m unittest discover tests -v
"""
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from twbt.data.quality import check_stock  # noqa: E402
from twbt.data.store import PriceStore  # noqa: E402
from twbt.data.twse import parse_mi_index  # noqa: E402

FIELDS = ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價",
          "最低價", "收盤價", "漲跌(+/-)", "漲跌價差", "最後揭示買價", "最後揭示買量",
          "最後揭示賣價", "最後揭示賣量", "本益比"]


def row(code, name, o, h, l, c, sign, diff, vol="1,000,000"):
    return [code, name, vol, "500", "123,456,789", o, h, l, c, sign, diff,
            c, "10", c, "10", "20.5"]


def new_format(rows):
    return {"stat": "OK", "date": "20261022", "tables": [
        {"title": "價格指數", "fields": ["指數", "收盤指數"], "data": [["發行量加權股價指數", "23,000"]]},
        {"title": "每日收盤行情", "fields": FIELDS, "data": rows},
    ]}


def old_format(rows):
    return {"stat": "OK", "fields1": ["指數", "收盤指數"], "data1": [["x", "1"]],
            "fields9": FIELDS, "data9": rows}


class TestParse(unittest.TestCase):
    def test_new_format(self):
        raw = new_format([
            row("2330", "台積電", "1,450.00", "1,465.00", "1,445.00", "1,460.00",
                "<p style= color:red>+</p>", "15.00"),
            row("0050", "元大台灣50", "62.10", "62.50", "61.80", "61.90",
                "<p style= color:green>-</p>", "0.35"),
            row("1234", "停牌股", "--", "--", "--", "--", "<p> </p>", "0.00", vol="0"),
            row("2884", "玉山金", "30.00", "30.20", "29.90", "30.10", "X", "0.00"),
        ])
        df = parse_mi_index(raw, date(2026, 10, 22))
        self.assertEqual(len(df), 4)
        tsmc = df.set_index("code").loc["2330"]
        self.assertEqual(tsmc["close"], 1460.0)
        self.assertEqual(tsmc["change"], 15.0)
        self.assertEqual(df.set_index("code").loc["0050", "change"], -0.35)
        self.assertTrue(df.set_index("code")["close"].isna()["1234"])
        e = df.set_index("code").loc["2884"]
        self.assertEqual(e["no_compare"], 1)
        self.assertTrue(e["change"] != e["change"])  # NaN
        self.assertEqual(df.loc[0, "code"], "2330")  # 代號保留字串（0050 不會變成 50）
        self.assertIn("0050", set(df["code"]))

    def test_old_format(self):
        raw = old_format([row("2330", "台積電", "500", "505", "498", "503", "+", "3.00")])
        df = parse_mi_index(raw, date(2020, 1, 2))
        self.assertEqual(df.loc[0, "close"], 503.0)
        self.assertEqual(df.loc[0, "date"], "2020-01-02")

    def test_missing_table(self):
        with self.assertRaises(ValueError):
            parse_mi_index({"stat": "OK", "tables": []}, date(2026, 1, 2))


class TestStoreAndQuality(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = PriceStore(Path(self.tmp.name) / "t.db", Path(self.tmp.name) / "raw")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _put(self, d, rows):
        raw = new_format(rows)
        df = parse_mi_index(raw, d)
        self.store.save_raw(d, "TWSE", raw)
        self.store.log_fetch(d, "TWSE", "trading", self.store.upsert_prices(df))

    def test_roundtrip_and_resume(self):
        self._put(date(2026, 10, 20), [row("2330", "台積電", "100", "101", "99", "100", "+", "1.00")])
        self._put(date(2026, 10, 21), [row("2330", "台積電", "100", "103", "100", "102", "+", "2.00")])
        self.store.log_fetch(date(2026, 10, 10), "TWSE", "holiday")
        # 重複寫入同一天不會產生重複資料
        self._put(date(2026, 10, 21), [row("2330", "台積電", "100", "103", "100", "102", "+", "2.00")])

        df = self.store.load("2330")
        self.assertEqual(list(df["close"]), [100.0, 102.0])
        self.assertEqual(self.store.fetched_dates(), {"2026-10-10", "2026-10-20", "2026-10-21"})
        self.assertEqual(self.store.trading_days(), ["2026-10-20", "2026-10-21"])
        self.assertTrue((Path(self.tmp.name) / "raw/TWSE/2026/20261021.json").exists())
        wide = self.store.load_field("close")
        self.assertEqual(wide.loc["2026-10-21", "2330"], 102.0)
        self.assertEqual(check_stock(df).shape[0], 0)

    def test_backup(self):
        self._put(date(2026, 10, 20), [row("2330", "台積電", "100", "101", "99", "100", "+", "1.00")])
        target = Path(self.tmp.name) / "drive" / "twbt.db"
        self.store.backup(target)
        copy = PriceStore(target, raw_dir=None)
        self.assertEqual(copy.load("2330")["close"].iloc[0], 100.0)
        copy.close()

    def test_quality_flags(self):
        self._put(date(2026, 10, 19), [row("9999", "測試", "100", "100", "100", "100", "+", "0.00")])
        # 漲跌價差對不上：前收 100 +5 應為 105，實際 108
        self._put(date(2026, 10, 20), [row("9999", "測試", "105", "108", "104", "108", "+", "5.00")])
        # OHLC 矛盾：最高價低於收盤價
        self._put(date(2026, 10, 21), [row("9999", "測試", "108", "107", "106", "108.5", "+", "0.50")])
        # 超過漲停 10%
        self._put(date(2026, 10, 22), [row("9999", "測試", "120", "122", "119", "122", "+", "13.50")])
        issues = check_stock(self.store.load("9999"))
        text = " ".join(issues["issue"])
        self.assertIn("漲跌價差對不上", text)
        self.assertIn("OHLC", text)
        self.assertIn("超過限制", text)


if __name__ == "__main__":
    unittest.main()
