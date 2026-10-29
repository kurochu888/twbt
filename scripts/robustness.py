"""均線策略參數穩健性檢查：參數掃描熱力圖、樣本內外、walk-forward。

    python scripts/robustness.py                         # 00631L、0050，掃「快線 × 出場乘數」
    python scripts/robustness.py --grid 接刀 --asset 00631L
    python scripts/robustness.py --grid all --split 2014-11-01 --objective 報酬回撤比
輸出 data/robustness/：每組參數的結果（*_sweep.csv）、樣本內外（*_split.csv）、walk-forward（*_wf.csv）、摘要 summary.txt。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

from twbt.backtest import BuyHold  # noqa: E402
from twbt.backtest.data import NAMES  # noqa: E402
from twbt.backtest.robust import GRIDS, OBJECTIVES, ParamSweep  # noqa: E402
from twbt.backtest.trend import LEVERAGE, TrendBacktest  # noqa: E402

PCT = {"年化", "最大回撤", "年化差", "10年贏持有比例", "10年年化差中位數", "最差10年年化"}


def heat_text(ps, df, col):
    h = ps.heat(df, col)
    fmt = (lambda v: f"{v:6.1%}") if col in PCT or "比例" in col or "年化" in col else (lambda v: f"{v:6.2f}")
    d = ps.combos[ps.default] if ps.default is not None else {}
    lines = [f"  {col}（列 {ps.names[0]}、欄 {ps.names[1]}；* = 預設）",
             "  " + " " * 9 + "".join(f"{c:>9g}" for c in h.columns)]
    for r in h.index:
        cells = []
        for c in h.columns:
            mark = "*" if d.get(ps.names[0]) == r and d.get(ps.names[1]) == c else " "
            cells.append(f"{fmt(h.loc[r, c]):>8}{mark}")
        lines.append(f"  {r:>9g}" + "".join(cells))
    return "\n".join(lines)


def report(ps, df, split, wf, objective, ws, step) -> str:
    bh = df.attrs["bh"]
    n = len(df)
    out = [f"期間 {df.attrs['start']} ~ {df.attrs['end']}，{n} 組參數；買進持有 年化 {bh['年化']:.1%}、"
           f"最大回撤 {bh['最大回撤']:.0%}、最長套牢 {bh['最長套牢']:.1f} 年"]
    for col in ("年化", "最大回撤", "10年贏持有比例"):
        out.append(heat_text(ps, df, col))
    beat = (df["年化差"] > 0).mean()
    out.append(f"  全期年化贏買進持有的組合：{beat:.0%}；10 年贏持有比例 中位數組合 {df['10年贏持有比例'].median():.0%}"
               f"（共 {df.attrs['windows']} 個 10 年區間{'，太少、參考就好' if df.attrs['windows'] < 36 else ''}）")
    if ps.default is not None:
        r = df[objective].rank(ascending=False)
        out.append(f"  預設參數的{objective}排第 {int(r[ps.default])} / {n}")
    pl = ps.plateau(df, objective)
    best = df[objective].idxmax()
    key = tuple(ps.combos[best].values())
    out.append(f"  {objective}最高：{ps.combos[best]} = {df.loc[best, objective]:.3g}，"
               f"它跟鄰居的平均 {pl.loc[key]:.3g}（差越多越像尖峰）；"
               f"鄰近平均最高：{dict(zip(ps.names, (float(v) for v in pl.idxmax())))} = {pl.max():.3g}")
    sg = ps.suggest(df, objective)
    if sg:
        same = "（= 預設）" if sg["i"] == ps.default else ""
        out.append(f"  建議參數（自己＋上下左右鄰居的{objective}平均最高、不在邊緣）：{ps.combos[sg['i']]}{same}，"
                   f"鄰近平均 {sg['score']:.3g}、5 格裡最差 {sg['worst']:.3g}")
        wp = ps.walk_forward(ws, step, objective, pick="plateau")["摘要"]
        a, b = wp.loc["walk-forward", "年化"], wp.loc["預設參數", "年化"]
        out.append(f"    這個方法在歷史上（{ws.date()} 起每 {step:g} 年用之前的歷史重挑）：年化 {a:.1%}，一直用預設 {b:.1%} → "
                   + ("可以考慮換" if sg["i"] != ps.default and a >= b + 0.003 else "維持預設"))
    s = split
    out.append(f"\n  樣本內外（目標：{s['目標']}）：樣本內 {s['樣本內']}，樣本外 {s['樣本外']}")
    out.append(f"    兩段排名相關係數 {s['排名相關係數']:+.2f}（接近 +1 = 前段好的後段也好；≤ 0 = 前段挑的參數沒有參考價值）")
    f = lambda x: f"年化 {x['年化']:.1%}、回撤 {x['最大回撤']:.0%}、報酬回撤比 {x['報酬回撤比']:.2f}"  # noqa: E731
    out.append(f"    樣本內最佳 {s['樣本內最佳']}：樣本外排第 {s['最佳組合 樣本外排名']} / {s['組合數']}，{f(s['最佳組合 樣本外'])}")
    if s["預設 樣本外"] is not None:
        out.append(f"    預設參數：樣本外排第 {s['預設 樣本外排名']} / {s['組合數']}，{f(s['預設 樣本外'])}")
    out.append(f"    所有組合樣本外中位數：{f(s['樣本外 中位數組合'])}")
    out.append(f"    買進持有樣本外：{f(s['持有 樣本外'])}")
    out.append(f"\n  walk-forward（每 {wf['step']:g} 年用之前全部歷史重挑，目標：{objective}）")
    for _, b in wf["每段"].iterrows():
        p = ", ".join(f"{k}={b[k]:g}" for k in ps.names)
        out.append(f"    {b['開始']} ~ {b['結束']}：選 {p}{'（= 預設）' if b['預設'] else ''}，"
                   f"年化 {b['這段年化']:+.1%}（預設 {b['預設這段年化']:+.1%}、持有 {b['持有這段年化']:+.1%}）")
    for name, x in wf["摘要"].iterrows():
        out.append(f"    {name}：{f(x)}、最長套牢 {x['最長套牢']:.1f} 年")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/adjusted")
    ap.add_argument("--out", default="data/robustness")
    ap.add_argument("--asset", nargs="+", default=["00631L", "0050"])
    ap.add_argument("--grid", default="均線出場", choices=[*GRIDS, "all"])
    ap.add_argument("--split", default="2010-01-01", help="樣本內外分界（預設 2010：0050 有真實資料起）")
    ap.add_argument("--wf-start", default="2000-01-01")
    ap.add_argument("--wf-step", type=float, default=5)
    ap.add_argument("--objective", default="年化", choices=list(OBJECTIVES))
    ap.add_argument("--real", action="store_true", help="只用真實資料（不含上市前模擬）")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    bh = BuyHold(a.data, use_synthetic=not a.real)
    tb = TrendBacktest(bh)
    texts = []
    for code in a.asset:
        for gname in (GRIDS if a.grid == "all" else [a.grid]):
            ps = ParamSweep(tb, code, GRIDS[gname][LEVERAGE[code]])
            df = ps.table()
            d0, d1 = ps.dates[0], ps.dates[-1]
            sp = pd.Timestamp(a.split)
            if not d0 + pd.DateOffset(years=3) <= sp <= d1 - pd.DateOffset(years=3):   # 兩段都要至少 3 年
                sp = pd.Timestamp(year=(d0 + (d1 - d0) / 2).year, month=1, day=1)
                print(f"（{code} 策略從 {d0.date()} 開始，樣本內外分界改成 {sp.date()}）")
            ws = max(pd.Timestamp(a.wf_start), pd.Timestamp(year=d0.year + 4, month=1, day=1))
            if ws != pd.Timestamp(a.wf_start):
                print(f"（{code} walk-forward 第一次挑參數前要至少 3 年歷史，改從 {ws.date()} 開始）")
            split = ps.split_test(sp, a.objective)
            wf = {**ps.walk_forward(ws, a.wf_step, a.objective), "step": a.wf_step}
            tag = f"{code}_{gname}"
            df.to_csv(out / f"{tag}_sweep.csv", index=False, encoding="utf-8-sig")
            split["表"].to_csv(out / f"{tag}_split.csv", index=False, encoding="utf-8-sig")
            wf["每段"].to_csv(out / f"{tag}_wf.csv", index=False, encoding="utf-8-sig")
            t = f"===== {NAMES[code]}：{gname}（{'只用真實' if a.real else '含模擬'}）=====\n" + report(ps, df, split, wf, a.objective, ws, a.wf_step)
            print(t + "\n", flush=True)
            texts.append(t)
    (out / "summary.txt").write_text("\n\n".join(texts) + "\n", encoding="utf-8")
    print(f"已輸出 {out}")


if __name__ == "__main__":
    pd.set_option("display.width", 200)
    main()
