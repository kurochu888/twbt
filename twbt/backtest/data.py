"""載入回測用的每日報酬。"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ASSETS = ["TAIEX", "0050", "00631L", "00675L"]
NAMES = {"TAIEX": "大盤（含息）", "0050": "0050", "00631L": "00631L 台灣50正2", "00675L": "00675L 加權正2"}
# 證交稅類別：index 是比較基準、不能直接交易，不收任何成本
KIND = {"TAIEX": "index", "0050": "etf", "00631L": "etf", "00675L": "etf"}


def load_returns(data_dir: str | Path, use_synthetic: bool = True,
                 tw50_excess: bool = True) -> tuple[pd.DataFrame, pd.DataFrame]:
    """回傳 (每日總報酬, 是否為模擬) 兩張表，列 = 交易日、欄 = 標的。

    use_synthetic=False：只用真實資料，上市前為空值。
    tw50_excess=False：保守版模擬。0050、00631L 上市前不套用「台灣50 贏大盤」的
        校正差距（這段差距主要來自 2010 年後的台積電，不一定適用更早的年代）。
    """
    d = Path(data_dir) / "long"
    rets, syn = {}, {}
    m = pd.read_csv(d / "TAIEX_long.csv", index_col=0, parse_dates=True)
    rets["TAIEX"], syn["TAIEX"] = m["tr_ret"], m["is_synthetic"]
    for code in ASSETS[1:]:
        x = pd.read_csv(d / f"{code}_long.csv", index_col=0, parse_dates=True)
        rets[code], syn[code] = x["ret"], x["is_synthetic"]
    r = pd.DataFrame(rets).sort_index().astype(float)
    # 某標的序列開始之前的日子（例如第一天）視為模擬；之後的空缺（暫停交易）視為真實
    s = pd.DataFrame(syn).reindex(r.index)
    for c in s:
        start = syn[c].index.min()
        s.loc[s.index < start, c] = 1
    s = s.fillna(0).astype(int)
    if not tw50_excess:
        p = json.loads((d / "params.json").read_text(encoding="utf-8"))
        mkt = r["TAIEX"]
        pre50 = s["0050"] == 1
        r.loc[pre50, "0050"] = mkt[pre50]
        # 00631L ≈ 2 × (大盤 + 台灣50差距) − 成本，拿掉差距：c − 2 × 差距
        c = p["c_00631L"] - 2 * p["gap_0050"]
        pre631 = s["00631L"] == 1
        r.loc[pre631, "00631L"] = (2 * mkt[pre631] + np.expm1(c / 252)).clip(lower=-0.999)
    # 上市後的缺值 = 暫停交易（例如分割期間）：價格凍結、報酬為 0，恢復交易日再反映
    for c in r:
        first = r[c].first_valid_index()
        if first is not None:
            r.loc[first:, c] = r.loc[first:, c].fillna(0.0)
    if not use_synthetic:
        r = r.mask(s == 1)
    r.index = pd.DatetimeIndex(r.index).astype("datetime64[ns]")
    s.index = r.index
    return r, s


def load_signal_inputs(data_dir: str | Path, rets: pd.DataFrame, syn: pd.DataFrame,
                       tw50_excess: bool = True) -> tuple[pd.DataFrame, pd.DataFrame]:
    """均線策略的訊號輸入：(不含配息的價格報酬, 當天有沒有交易)。

    - 價格報酬：0050 用 0050_long.csv 的 price_ret（只還原分割，跟 finance-app 一樣）；
      其他標的不配息，就是總報酬本身。tw50_excess=False 時 0050 上市前改用「大盤 − 估計股息」。
    - 有沒有交易：該標的長期序列裡有沒有這一天（分割暫停交易的日子沒有），均線不算這幾天。
    """
    d = Path(data_dir) / "long"
    price = rets.copy()
    traded = pd.DataFrame(True, index=rets.index, columns=rets.columns)
    for code in ASSETS[1:]:
        x = pd.read_csv(d / f"{code}_long.csv", index_col=0, parse_dates=True)
        x.index = pd.DatetimeIndex(x.index).astype("datetime64[ns]")
        traded[code] = rets.index.isin(x.index)
        if "price_ret" in x:
            pr = x["price_ret"].reindex(rets.index)
            if not tw50_excess and code == "0050":
                dy = json.loads((d / "params.json").read_text(encoding="utf-8"))["dividend_yield"]
                pre = syn[code] == 1
                pr[pre] = np.expm1(np.log1p(rets.loc[pre, code]) - dy / 252)
            price[code] = pr.where(rets[code].notna())
    first = {c: rets[c].first_valid_index() for c in rets}
    for c in price:
        if first[c] is not None:
            price.loc[first[c]:, c] = price.loc[first[c]:, c].fillna(0.0)
    return price, traded
