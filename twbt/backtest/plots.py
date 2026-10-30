"""回測圖表。圖上文字用英文，避免 Colab 沒有中文字型時變成方框。"""
from __future__ import annotations

import matplotlib.pyplot as plt
import pandas as pd

LABEL = {"大盤（含息）": "TAIEX TR", "0050": "0050",
         "00631L 台灣50正2": "00631L (TW50 2x)", "00675L 加權正2": "00675L (TAIEX 2x)",
         "Nasdaq-100（含息）": "NDX TR", "QQQ": "QQQ", "QLD 那斯達克正2": "QLD (NDX 2x)"}
COLOR = {"TAIEX TR": "#7f7f7f", "0050": "#1f77b4", "00631L (TW50 2x)": "#d62728", "00675L (TAIEX 2x)": "#ff7f0e",
         "NDX TR": "#7f7f7f", "QQQ": "#1f77b4", "QLD (NDX 2x)": "#d62728"}


def _lab(name):
    return LABEL.get(name, name)


def plot_equity(curves: pd.DataFrame, title: str = "Buy & Hold", log: bool = True):
    """上：資產成長（對數刻度）；下：回撤。"""
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True,
                                   gridspec_kw={"height_ratios": [2, 1]})
    for col in curves:
        lab = _lab(col)
        eq = curves[col].dropna()
        ax1.plot(eq.index, eq / eq.iloc[0], label=lab, color=COLOR.get(lab), lw=1.4)
        ax2.plot(eq.index, (eq / eq.cummax() - 1) * 100, color=COLOR.get(lab), lw=1)
    if log:
        ax1.set_yscale("log")
    ax1.set_ylabel("Growth of 1")
    ax1.set_title(title)
    ax1.legend()
    ax1.grid(alpha=0.3)
    ax2.set_ylabel("Drawdown %")
    ax2.grid(alpha=0.3)
    fig.tight_layout()
    return fig


def plot_windows(results: pd.DataFrame, col: str = "年化報酬", title: str = ""):
    """左：依起始日排列的結果；右：分布箱形圖。"""
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.5), gridspec_kw={"width_ratios": [2.2, 1]})
    names = list(dict.fromkeys(results["標的"]))
    data = []
    for n in names:
        g = results[results["標的"] == n].sort_values("起始日")
        lab = _lab(n)
        ax1.plot(pd.to_datetime(g["起始日"]), g[col] * 100, ".", ms=3, label=lab, color=COLOR.get(lab))
        data.append(g[col].to_numpy() * 100)
    ax1.axhline(0, color="k", lw=0.8)
    ax1.set_xlabel("Start date")
    ax1.set_ylabel({"年化報酬": "CAGR %", "最大回撤": "Max drawdown %", "總報酬": "Total return %"}.get(col, col))
    ax1.legend(markerscale=4)
    ax1.grid(alpha=0.3)
    ax1.set_title(title)
    ax2.boxplot(data, tick_labels=[_lab(n).split(" ")[0] for n in names], whis=(5, 95))
    ax2.axhline(0, color="k", lw=0.8)
    ax2.set_title("Distribution (whiskers 5%-95%)")
    ax2.grid(alpha=0.3)
    fig.tight_layout()
    return fig
