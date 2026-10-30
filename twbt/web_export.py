"""輸出網頁用的資料檔 docs/data/returns.json。

格式（盡量精簡，手機也能很快載入）：
{
  "updated": "2026-10-22",
  "dates": [19900104, ...],                    # yyyymmdd 整數
  "assets": {
    "0050": {"name": ..., "kind": "etf", "first": 0, "first_real": 4970,
             "ret": [...], "ret_conservative": [...]}   # 每日報酬 × 1e8 取整數；null = 沒資料
  },
  "calibration": "...", "params": {...}
}
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .backtest.data import DIV_TAX, KIND, LEVERAGE, MARKETS, NAMES, SCALE, load_returns, load_signal_inputs, market_of


def _encode(s: pd.Series) -> list:
    v = s.to_numpy(dtype=float)
    return [None if np.isnan(x) else int(round(x * SCALE)) for x in v]


def _splits(code: str, idx: pd.DatetimeIndex, adjusted_dir: Path) -> list:
    from .data.adjust import load_splits
    f = adjusted_dir / "splits.csv"                  # 美股：update_us.py 從 Yahoo 的分割紀錄產生
    sp = pd.read_csv(f) if f.exists() else load_splits()
    out = []
    for _, x in sp[sp["code"].astype(str) == code].iterrows():
        rd = pd.Timestamp(x["resume_date"])
        if rd <= idx[-1]:
            out.append([int(np.searchsorted(idx.values, np.datetime64(rd))), float(x["ratio"])])
    return out


def export_web(adjusted_dir: Path, out_dir: Path) -> str:
    """台股輸出 returns.json、美股（data/adjusted_us）輸出 returns_us.json。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    market = market_of(adjusted_dir)
    mk = MARKETS[market]
    r, syn = load_returns(adjusted_dir, use_synthetic=True, tw50_excess=True)
    params_path = adjusted_dir / "long" / "params.json"
    has_params = params_path.exists()
    rc = load_returns(adjusted_dir, use_synthetic=True, tw50_excess=False)[0] if has_params else r
    idx = r.index
    sig, traded = load_signal_inputs(adjusted_dir, r, syn, True)
    sig_c = load_signal_inputs(adjusted_dir, rc, syn, False)[0] if has_params else sig
    assets = {}
    for code in r.columns:
        # first / first_real：可以當「買進日」的最早位置（之後每天都有報酬）
        first = int(idx.get_loc(r[code].first_valid_index())) - 1
        real_days = idx[(syn[code] == 0) & r[code].notna()]
        first_real = int(idx.get_loc(real_days[0])) - 1 if len(real_days) else None
        a = {"name": NAMES[code], "kind": KIND[code], "leverage": LEVERAGE[code], "first": first, "first_real": first_real,
             "ret": _encode(r[code])}
        if DIV_TAX.get(code):
            a["div_tax"] = DIV_TAX[code]
        if not np.allclose(rc[code].fillna(0), r[code].fillna(0)):
            a["ret_conservative"] = _encode(rc[code])
        # 均線策略的訊號價格（不含配息）；跟總報酬一樣就不重複存
        if not np.allclose(sig[code].fillna(0), r[code].fillna(0)):
            a["sig_ret"] = _encode(sig[code])
            if not np.allclose(sig_c[code].fillna(0), sig[code].fillna(0)):
                a["sig_ret_conservative"] = _encode(sig_c[code])
        # 序列開始之後、沒有交易的日子（分割暫停交易），均線不算這幾天
        halt = np.flatnonzero(~traded[code].to_numpy())
        a["halt"] = [int(i) for i in halt if i > first]
        # 整張交易：最新一天的實際收盤（每股價格從這裡往回推）、分割（恢復交易那天的位置、倍數）
        if KIND[code] != "index":
            raw = adjusted_dir / f"{code}.csv"
            a["px_last"] = float(pd.read_csv(raw, usecols=["close"])["close"].iloc[-1]) if raw.exists() else 1.0
            a["splits"] = _splits(code, idx, adjusted_dir)
        assets[code] = a
    cal = adjusted_dir / "long" / "calibration.txt"
    data = {
        "updated": idx[-1].date().isoformat(),
        "market": {"id": market, "currency": mk["currency"], "lot": mk["lot"], "tick": mk["tick"],
                   "cost_unit": mk["cost_unit"], "min_trade": mk["min_trade"], "capital": mk["capital"],
                   "bench": mk["bench"], "base": mk["base"], "lev": mk["lev"], "rebal": mk["rebal"]},
        "scale": SCALE,
        "dates": [int(d.strftime("%Y%m%d")) for d in idx],
        "assets": assets,
        "calibration": cal.read_text(encoding="utf-8") if cal.exists() else "",
        "params": json.loads(params_path.read_text(encoding="utf-8")) if has_params else {},
    }
    p = out_dir / ("returns.json" if market == "tw" else f"returns_{market}.json")
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return f"{len(idx)} 天，{p.stat().st_size / 1024:.0f} KB，最新 {data['updated']}"
