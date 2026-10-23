"""證交所逐月歷史資料：個股日K、加權指數、報酬指數、除權除息結果。

適合「只追少數標的」的情境：一檔股票一個月只要一次請求。
"""
from __future__ import annotations

import random
import re
import time
from datetime import date

import pandas as pd
import requests

from .twse import _num, make_session

BASE = "https://www.twse.com.tw/rwd/zh"
URLS = {
    "stock": f"{BASE}/afterTrading/STOCK_DAY",       # 個股日成交資訊
    "taiex": f"{BASE}/afterTrading/FMTQIK",          # 市場成交資訊（含加權指數）
    "tri": f"{BASE}/TAIEX/MFI94U",                   # 發行量加權股價報酬指數
    "exright": f"{BASE}/exRight/TWT49U",             # 除權除息計算結果表
}
NO_DATA = ("沒有符合條件", "查無資料", "很抱歉", "查詢日期小於")


class Throttled(RuntimeError):
    pass


def roc_to_date(s: str) -> date:
    """民國日期 → 西元：'115/09/01'、'114年01月17日' 都可以。"""
    y, m, d = (int(x) for x in re.findall(r"\d+", s)[:3])
    return date(y + 1911, m, d)


class TwseClient:
    """統一控管請求速度：每次請求至少間隔 min_gap 秒，被限流時自動長時間等待。"""

    def __init__(self, min_gap: float = 8.0, verbose: bool = True):
        self.s = make_session()
        self.min_gap = min_gap
        self.verbose = verbose
        self._last = 0.0

    def _wait_gap(self):
        gap = self.min_gap + random.uniform(0, 2) - (time.time() - self._last)
        if gap > 0:
            time.sleep(gap)

    def get(self, kind: str, params: dict, retries: int = 6) -> dict | None:
        """回傳 JSON；沒有資料回 None；被限流或連線失敗會等待後重試。"""
        params = {**params, "response": "json"}
        err = None
        for attempt in range(retries):
            if attempt:
                # 被封鎖通常要幾分鐘到半小時才解除：1、3、10、20、30 分鐘
                wait = (60, 180, 600, 1200, 1800)[min(attempt, 5) - 1] + random.uniform(0, 10)
                if self.verbose:
                    print(f"    （{err}）等 {wait:.0f} 秒後重試…", flush=True)
                time.sleep(wait)
                # 被擋住後，沿用同一條連線會一直拿到封鎖頁；換一條新連線
                self.s.close()
                self.s = make_session()
            self._wait_gap()
            try:
                r = self.s.get(URLS[kind], params=params, timeout=30)
                self._last = time.time()
                r.raise_for_status()
                j = r.json()
            except ValueError:
                snippet = " ".join(r.text[:60].split())
                err = f"回應不是 JSON（HTTP {r.status_code}：{snippet}…）"
                continue
            except requests.RequestException as e:
                self._last = time.time()
                err = f"連線錯誤 {e.__class__.__name__}"
                continue
            stat = str(j.get("stat", "OK"))
            if stat == "OK":
                return j
            if any(m in stat for m in NO_DATA):
                return None
            err = f"異常回應 {stat[:40]}"
        raise Throttled(f"{kind} {params} 重試 {retries} 次仍失敗：{err}")

    # ---------- 各資料表 ----------
    def stock_month(self, code: str, ym: str) -> pd.DataFrame:
        """個股某月日K。ym 例如 '202609'。"""
        j = self.get("stock", {"date": ym + "01", "stockNo": code})
        cols = ["date", "code", "volume", "value", "open", "high", "low", "close", "change", "trades", "note"]
        if not j or not j.get("data"):
            return pd.DataFrame(columns=cols)
        f = {k: i for i, k in enumerate(j["fields"])}
        rows = []
        for r in j["data"]:
            chg = str(r[f["漲跌價差"]])
            rows.append({
                "date": roc_to_date(r[f["日期"]]).isoformat(), "code": code,
                "volume": _num(r[f["成交股數"]]), "value": _num(r[f["成交金額"]]),
                "open": _num(r[f["開盤價"]]), "high": _num(r[f["最高價"]]),
                "low": _num(r[f["最低價"]]), "close": _num(r[f["收盤價"]]),
                # 'X0.00' 代表不比價（除權息、分割恢復交易首日等），漲跌價差無意義
                "change": float("nan") if "X" in chg.upper() else _num(chg),
                "trades": _num(r[f["成交筆數"]]),
                "note": str(r[f["註記"]]).strip() if "註記" in f else "",
            })
        return pd.DataFrame(rows, columns=cols)

    def taiex_month(self, ym: str) -> pd.DataFrame:
        j = self.get("taiex", {"date": ym + "01"})
        if not j or not j.get("data"):
            return pd.DataFrame(columns=["date", "close"])
        f = {k: i for i, k in enumerate(j["fields"])}
        return pd.DataFrame([{"date": roc_to_date(r[f["日期"]]).isoformat(),
                              "close": _num(r[f["發行量加權股價指數"]])} for r in j["data"]])

    def tri_month(self, ym: str) -> pd.DataFrame:
        j = self.get("tri", {"date": ym + "01"})
        if not j or not j.get("data"):
            return pd.DataFrame(columns=["date", "close"])
        return pd.DataFrame([{"date": roc_to_date(r[0]).isoformat(), "close": _num(r[1])}
                             for r in j["data"]])

    def exright(self, start: date, end: date, codes: set[str] | None = None) -> pd.DataFrame:
        """除權除息計算結果。證交所以「除權息前收盤價」與「除權息參考價」記錄，最準確。"""
        j = self.get("exright", {"startDate": f"{start:%Y%m%d}", "endDate": f"{end:%Y%m%d}"})
        cols = ["date", "code", "prev_close", "ref_price", "value", "kind"]
        if not j or not j.get("data"):
            return pd.DataFrame(columns=cols)
        f = {k: i for i, k in enumerate(j["fields"])}
        rows = []
        for r in j["data"]:
            code = str(r[f["股票代號"]]).strip()
            if codes and code not in codes:
                continue
            rows.append({"date": roc_to_date(r[f["資料日期"]]).isoformat(), "code": code,
                         "prev_close": _num(r[f["除權息前收盤價"]]),
                         "ref_price": _num(r[f["除權息參考價"]]),
                         "value": _num(r[f["權值+息值"]]),
                         "kind": str(r[f["權/息"]]).strip()})
        return pd.DataFrame(rows, columns=cols)
