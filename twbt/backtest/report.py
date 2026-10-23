"""把結果表格整理成好讀的格式（百分比、千分位）。"""
from __future__ import annotations

import pandas as pd

PCT_ROWS = {"總報酬", "年化報酬", "年化波動", "最大回撤", "最好年度", "最差年度", "模擬資料占比",
            "平均", "最差", "5%", "25%", "中位數", "75%", "95%", "最好", "虧損機率"}
NUM2_ROWS = {"夏普", "索提諾", "卡瑪"}


def fmt_stats(df: pd.DataFrame, pct_values: bool = True) -> pd.DataFrame:
    """列是指標、欄是標的的表 → 格式化成文字。"""
    out = df.copy().astype(object)
    for row in out.index:
        for col in out.columns:
            v = df.at[row, col]
            if isinstance(v, (int, float)) and not isinstance(v, bool) and pd.notna(v):
                if row == "區間數":
                    out.at[row, col] = f"{int(v)}"
                elif row in PCT_ROWS and pct_values:
                    out.at[row, col] = f"{v:.1%}"
                elif row in NUM2_ROWS:
                    out.at[row, col] = f"{v:.2f}"
                elif row == "期末金額":
                    out.at[row, col] = f"{v:,.0f}"
    return out


def fmt_rows(df: pd.DataFrame) -> pd.DataFrame:
    """每列一筆資料的表（例如最差/最好區間）→ 百分比欄位格式化。"""
    out = df.copy()
    for c in out.columns:
        if c in PCT_ROWS:
            out[c] = out[c].map(lambda v: f"{v:.1%}" if pd.notna(v) else "")
    return out
