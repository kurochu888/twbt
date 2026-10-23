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

from .backtest.data import KIND, NAMES, load_returns

SCALE = 1e10


def _encode(s: pd.Series) -> list:
    v = s.to_numpy(dtype=float)
    return [None if np.isnan(x) else int(round(x * SCALE)) for x in v]


def export_web(adjusted_dir: Path, out_dir: Path) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    r, syn = load_returns(adjusted_dir, use_synthetic=True, tw50_excess=True)
    params_path = adjusted_dir / "long" / "params.json"
    has_params = params_path.exists()
    rc = load_returns(adjusted_dir, use_synthetic=True, tw50_excess=False)[0] if has_params else r
    idx = r.index
    assets = {}
    for code in r.columns:
        # first / first_real：可以當「買進日」的最早位置（之後每天都有報酬）
        first = int(idx.get_loc(r[code].first_valid_index())) - 1
        real_days = idx[(syn[code] == 0) & r[code].notna()]
        first_real = int(idx.get_loc(real_days[0])) - 1 if len(real_days) else None
        a = {"name": NAMES[code], "kind": KIND[code], "first": first, "first_real": first_real,
             "ret": _encode(r[code])}
        if not np.allclose(rc[code].fillna(0), r[code].fillna(0)):
            a["ret_conservative"] = _encode(rc[code])
        assets[code] = a
    cal = adjusted_dir / "long" / "calibration.txt"
    data = {
        "updated": idx[-1].date().isoformat(),
        "scale": SCALE,
        "dates": [int(d.strftime("%Y%m%d")) for d in idx],
        "assets": assets,
        "calibration": cal.read_text(encoding="utf-8") if cal.exists() else "",
        "params": json.loads(params_path.read_text(encoding="utf-8")) if has_params else {},
    }
    p = out_dir / "returns.json"
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return f"{len(idx)} 天，{p.stat().st_size / 1024:.0f} KB，最新 {data['updated']}"
