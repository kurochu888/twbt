import json, random, sys, warnings
warnings.simplefilter("ignore")
import os; ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT)
import numpy as np, pandas as pd
from twbt.backtest import BuyHold, TaiwanCost, us_cost
from twbt.backtest.data import MARKETS, NAMES
from twbt.backtest.trend import TrendBacktest, TrendParams, LEVERAGE
from twbt.backtest.rebalance import RebalBacktest, RebalConfig
from twbt.backtest.metrics import summarize
from twbt.backtest.robust import ParamSweep, GRIDS
rnd = random.Random(int(sys.argv[2]))
MARKET = os.environ.get("TWBT_MARKET", "tw")          # TWBT_MARKET=us：美股（data/adjusted_us）
MK = MARKETS[MARKET]
DATA = os.path.join(ROOT, "data/adjusted" if MARKET == "tw" else f"data/adjusted_{MARKET}")
ALL, TRADE = MK["assets"], MK["assets"][1:]
YEARS = ([1989, 1990, 1990, 1995, 2000, 2003, 2008, 2010, 2014, 2015, 2017, 2020, 2024, 2026, 2027] if MARKET == "tw"
         else [1984, 1985, 1987, 1990, 1999, 2000, 2002, 2006, 2008, 2010, 2020, 2022, 2026, 2027])
CAPS = [1_000_000, 50_000, 3_000_000] if MARKET == "tw" else [30_000, 2_000, 250_000]
D2 = dict(maFast=120, maSlow=240, exitBuffer=0.90, recoverSlope=1.001, recoverStrong=1.02, pyramidGap=0.15, pyramidLevels=2)
D1 = dict(maFast=100, maSlow=200, exitBuffer=0.925, recoverSlope=1.001, recoverStrong=1.02, pyramidGap=0.15, pyramidLevels=1)
def rand_date():
    y = rnd.choice(YEARS)
    return f"{y}-{rnd.randint(1,12):02d}-{rnd.randint(1,28):02d}"
def rand_params(lev):
    d = dict(D2 if lev == 2 else D1); c = {}
    if rnd.random() < 0.5:
        for k, lo, hi, integer in (("maFast", 2, 300, True), ("maSlow", 2, 400, True), ("exitBuffer", 0.7, 1.0, False),
                                    ("pyramidGap", 0.02, 0.4, False), ("pyramidLevels", 1, 5, True), ("recoverSlope", 0.99, 1.01, False), ("recoverStrong", 1.0, 1.2, False)):
            if rnd.random() < 0.4:
                c[k] = rnd.randint(lo, hi) if integer else round(rnd.uniform(lo, hi), 4)
    return c
def to_tp(lev, c):
    d = dict(D2 if lev == 2 else D1); d.update(c)
    return TrendParams(d["maFast"], d["maSlow"], d["exitBuffer"], d["recoverSlope"], d["recoverStrong"], d["pyramidGap"], d["pyramidLevels"])
cases = []
for k in range(int(sys.argv[3])):
    t = rnd.choice(["bh", "trend", "rebal"])
    s, e = rand_date(), rand_date()
    if rnd.random() < 0.7 and s > e: s, e = e, s
    case = dict(type=t, start=s, end=e, syn=rnd.random() < 0.7, excess=rnd.random() < 0.7, disc=rnd.choice([1, 0.6, 0.28, 0]),
                capital=rnd.choice(CAPS), sp=rnd.choice(["raw", "adjusted"]), market=MARKET,
                comm=rnd.choice([0, 0, 0.001, 0.0025]), minfee=rnd.choice([0, 1, 4.95]),
                custom={"1": rand_params(1), "2": rand_params(2)}, roll=rnd.choice([None, None, 3, 10, 20]))
    if t == "rebal":
        w = {c: rnd.choice([0, 0, 10, 25, 50, 65]) / 100 for c in (*MK["rebal"], "CASH")}
        if sum(w.values()) == 0: w["CASH"] = 1
        case.update(weights=w, freq=rnd.choice(["none", "M", "Q", "H", "Y"]), band=rnd.choice([0, 0, 0.03, 0.1]), cash=rnd.choice([0, 0.01, 0.02]), rtrend=rnd.random() < 0.5)
    cases.append(case)
# 參數穩健性：另外 8 組（每組要跑幾十個參數，比較慢）
ROB = {"exit": "均線出場", "pyramid": "接刀", "recover": "轉回"}
for k in range(8):
    cases.append(dict(type="robust", asset=rnd.choice(TRADE), grid=rnd.choice(list(ROB)), syn=rnd.random() < 0.7,
                      excess=rnd.random() < 0.7, disc=rnd.choice([1, 0.6, 0]), capital=rnd.choice(CAPS[:2]), sp=rnd.choice(["raw", "adjusted"]),
                      market=MARKET, comm=rnd.choice([0, 0.001]), minfee=rnd.choice([0, 1]),
                      custom={"1": rand_params(1), "2": rand_params(2)}, split=rnd.choice(["2005-01-01", "2010-01-01", "2018-06-01"]),
                      ws=rnd.choice(["1998-01-01", "2000-01-01", "2012-01-01"]), step=rnd.choice([2, 3, 5]), obj=rnd.choice(["cagr", "calmar"])))
out = []
for c in cases:
    r = {"case": c}
    try:
        cost = TaiwanCost(discount=c["disc"]) if MARKET == "tw" else us_cost(c["comm"], c["minfee"])
        bh = BuyHold(DATA, use_synthetic=c["syn"], tw50_excess=c["excess"], cost=cost, capital=c["capital"])
        params = {code: to_tp(2 if LEVERAGE[code] >= 2 else 1, c["custom"]["2" if LEVERAGE[code] >= 2 else "1"]) for code in bh.rets.columns}
        if c["type"] == "bh":
            res = {}
            for code in ALL:
                try:
                    eq = bh.equity(code, c["start"], c["end"]); st = summarize(eq)
                    res[code] = [str(eq.index[0].date()), float(eq.iloc[-1]), st["最大回撤"], st["最長套牢"], str(st["回撤高點"]), str(st["回到前高"])]
                except ValueError: res[code] = None
            r["period"] = res
            if c["roll"]: w = bh.rolling(c["roll"]); r["roll"] = {k: [len(v), float(v["年化報酬"].median()), float(v["最長套牢"].median()), int(v["套牢未結束"].sum())] for k, v in w.groupby("標的")} if len(w) else {}
        elif c["type"] == "trend":
            tb = TrendBacktest(bh, params, signal_price=c["sp"]); res = {}
            for code in TRADE:
                try:
                    x = tb.run(code, c["start"], c["end"]); st = summarize(x.equity)
                    res[code] = [str(x.equity.index[0].date()), float(x.equity.iloc[-1]), st["最大回撤"], len(x.events), st["最長套牢"]]
                except ValueError: res[code] = None
            r["period"] = res
            if c["roll"]: w = tb.rolling(c["roll"]); r["roll"] = {k: [len(v), float(v["策略年化"].median()), float(v["策略最長套牢"].median()), float(v["持有最長套牢"].median())] for k, v in w.groupby("標的")} if len(w) else {}
        elif c["type"] == "robust":
            tb = TrendBacktest(bh, params, signal_price=c["sp"])
            ps = ParamSweep(tb, c["asset"], GRIDS[ROB[c["grid"]]][LEVERAGE[c["asset"]]])
            d0, d1 = ps.dates[0], ps.dates[-1]          # 分界、起點不合理時自動調整（同 scripts/robustness.py、網頁）
            sp = pd.Timestamp(c["split"])
            if not d0 + pd.DateOffset(years=3) <= sp <= d1 - pd.DateOffset(years=3):
                sp = pd.Timestamp(year=(d0 + (d1 - d0) / 2).year, month=1, day=1)
            ws = pd.Timestamp(c["ws"])
            if ws < pd.Timestamp(year=d0.year + 4, month=1, day=1) or ws > d1 - pd.DateOffset(months=12):
                ws = pd.Timestamp(year=d0.year + 4, month=1, day=1)
            obj = {"cagr": "年化", "calmar": "報酬回撤比"}[c["obj"]]
            df = ps.table(); s = ps.split_test(sp, obj); w = ps.walk_forward(ws, c["step"], obj)
            r["robust"] = [str(sp.date()), str(ws.date()), str(d0.date()), df.attrs["windows"], ps.default, float(df["年化"].sum()), float(df["最大回撤"].sum()),
                           float(df["最長套牢"].sum()), float(df["10年贏持有比例"].sum()) if "10年贏持有比例" in df else None, int(df["交易次數"].sum()), s["排名相關係數"], s["最佳組合 樣本外排名"],
                           s["預設 樣本外排名"], float(w["摘要"].loc["walk-forward", "年化"]), float(w["摘要"].loc["買進持有", "最大回撤"]), len(w["每段"]), ps.suggest(df, obj)["i"],
                           float(ps.walk_forward(ws, c["step"], obj, pick="plateau")["摘要"].loc["walk-forward", "年化"])]
        else:
            tb = TrendBacktest(bh, params, signal_price=c["sp"]); rb = RebalBacktest(bh, tb)
            cfg = RebalConfig(c["weights"], c["freq"], c["band"], c["cash"], c["rtrend"])
            try:
                x = rb.run(cfg, c["start"], c["end"]); st = summarize(x["策略"])
                r["period"] = [str(x["策略"].index[0].date()), float(x["策略"].iloc[-1]), st["最大回撤"], x["交易次數"], float(x["同配置不再平衡"].iloc[-1]), st["最長套牢"]]
            except ValueError: r["period"] = None
            if c["roll"]: w = rb.rolling(cfg, c["roll"]); r["roll"] = [len(w), float(w["策略年化"].median()) if len(w) else None,
                                      float(w["策略最長套牢"].median()) if len(w) else None, float(w["不再平衡最長套牢"].median()) if len(w) else None]
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"
    out.append(r)
json.dump(out, open(sys.argv[1], "w"), default=str)
print("python 完成", len(out), "組；例外", sum("error" in x for x in out))
for x in out:
    if "error" in x: print("  例外：", x["error"], x["case"]["type"])
