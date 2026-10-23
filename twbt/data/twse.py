"""證交所（上市）每日全市場收盤行情：下載與解析。

資料來源：證交所網站「每日收盤行情」MI_INDEX（type=ALLBUT0999，全部不含權證牛熊證）。
一次請求 = 一個交易日的全部上市股票／ETF，2004-02-11 起有資料，含後來下市的股票。
"""
from __future__ import annotations

import random
import re
import ssl
import time
from datetime import date

import pandas as pd
import requests
from requests.adapters import HTTPAdapter

MI_INDEX_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
MI_INDEX_URL_OLD = "https://www.twse.com.tw/exchangeReport/MI_INDEX"

NO_DATA_MARKERS = ("沒有符合條件", "查無資料")

COLUMNS = ["date", "code", "name", "volume", "trades", "value",
           "open", "high", "low", "close", "change", "no_compare"]


class NoTradingData(Exception):
    """這一天沒有資料（假日、颱風假或尚未收盤）。"""


class _LenientSSLAdapter(HTTPAdapter):
    """Python 3.13 起預設啟用 VERIFY_X509_STRICT，證交所憑證可能因此驗證失敗。

    這裡只關掉「嚴格模式」，仍然完整驗證憑證鏈與網域，不是關閉 SSL 驗證。
    """

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


def make_session() -> requests.Session:
    s = requests.Session()
    s.mount("https://", _LenientSSLAdapter())
    s.headers.update({
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"),
        "Accept": "application/json,text/plain,*/*",
    })
    return s


def fetch_mi_index(d: date, session: requests.Session | None = None,
                   retries: int = 3, timeout: int = 20) -> dict:
    """抓一天的原始 JSON。沒有資料時丟出 NoTradingData，網路錯誤重試後才放棄。"""
    session = session or make_session()
    params = {"date": d.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"}
    last_err: Exception | None = None
    url = MI_INDEX_URL
    for attempt in range(retries):
        if attempt:
            # 證交所限流時會回傳非 JSON 的頁面；等久一點再試（30、60、120 秒…）
            wait = 30 * 2 ** (attempt - 1) + random.uniform(0, 5)
            print(f"  {d} 第 {attempt} 次重試，先等 {wait:.0f} 秒（{last_err}）", flush=True)
            time.sleep(wait)
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code == 404 and url != MI_INDEX_URL_OLD:
                url = MI_INDEX_URL_OLD   # 新網址失效時改用舊網址
                last_err = RuntimeError("新網址 404，改用舊網址")
                continue
            r.raise_for_status()
            try:
                raw = r.json()
            except ValueError:
                last_err = RuntimeError("回應不是 JSON，可能被暫時限流")
                continue
            stat = str(raw.get("stat", ""))
            if stat == "OK":
                return raw
            if any(m in stat for m in NO_DATA_MARKERS):
                raise NoTradingData(stat)
            last_err = RuntimeError(f"證交所回應異常：{stat[:80]}")
        except requests.RequestException as e:
            last_err = e
    raise RuntimeError(f"{d} 下載失敗：{last_err}")


# ---------- 解析 ----------

def _iter_tables(raw: dict):
    """新版格式是 tables 陣列；舊版是 fields1/data1 ... fields9/data9。"""
    if isinstance(raw.get("tables"), list):
        for t in raw["tables"]:
            yield t.get("fields") or [], t.get("data") or []
    for key in raw:
        m = re.fullmatch(r"fields(\d+)", key)
        if m:
            yield raw[key] or [], raw.get(f"data{m.group(1)}") or []


def _num(x) -> float:
    """'1,234.50' → 1234.5；'--'、''、'X' → NaN。"""
    if x is None:
        return float("nan")
    s = re.sub(r"<[^>]+>", "", str(x)).replace(",", "").strip()
    if s in ("", "--", "---", "X", "除權息", "除息", "除權"):
        return float("nan")
    try:
        return float(s)
    except ValueError:
        return float("nan")


def _sign(x) -> tuple[int, bool]:
    """漲跌(+/-) 欄位常含 HTML，例如 <p style= color:red>+</p>。回傳 (正負號, 是否不比價)。"""
    s = re.sub(r"<[^>]+>", "", str(x or "")).strip()
    if "+" in s:
        return 1, False
    if "-" in s:
        return -1, False
    if "X" in s.upper():
        return 0, True   # 除權息、新上市等「不比價」
    return 0, False


def parse_mi_index(raw: dict, d: date) -> pd.DataFrame:
    """把一天的原始 JSON 轉成整齊的表格（每檔股票一列）。"""
    for fields, data in _iter_tables(raw):
        if "證券代號" in fields and "收盤價" in fields and data:
            idx = {f: i for i, f in enumerate(fields)}
            rows = []
            for r in data:
                sign, no_cmp = _sign(r[idx["漲跌(+/-)"]]) if "漲跌(+/-)" in idx else (0, False)
                diff = _num(r[idx["漲跌價差"]]) if "漲跌價差" in idx else float("nan")
                rows.append({
                    "date": d.isoformat(),
                    "code": str(r[idx["證券代號"]]).strip(),
                    "name": str(r[idx["證券名稱"]]).strip(),
                    "volume": _num(r[idx["成交股數"]]),
                    "trades": _num(r[idx["成交筆數"]]),
                    "value": _num(r[idx["成交金額"]]),
                    "open": _num(r[idx["開盤價"]]),
                    "high": _num(r[idx["最高價"]]),
                    "low": _num(r[idx["最低價"]]),
                    "close": _num(r[idx["收盤價"]]),
                    "change": float("nan") if no_cmp else sign * (0.0 if pd.isna(diff) else diff),
                    "no_compare": int(no_cmp),
                })
            return pd.DataFrame(rows, columns=COLUMNS)
    raise ValueError(f"{d} 找不到個股收盤行情表，證交所格式可能變了")
