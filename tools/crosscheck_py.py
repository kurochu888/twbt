import json, random, sys, warnings
warnings.simplefilter("ignore")
import os; ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT)
import numpy as np, pandas as pd
from twbt.backtest import BuyHold, TaiwanCost
from twbt.backtest.trend import TrendBacktest, TrendParams, LEVERAGE
from twbt.backtest.rebalance import RebalBacktest, RebalConfig
from twbt.backtest.metrics import summarize
rnd = random.Random(int(sys.argv[2]))
D2 = dict(maFast=120, maSlow=240, exitBuffer=0.90, recoverSlope=1.002, recoverStrong=1.03, pyramidGap=0.15, pyramidLevels=2)
D1 = dict(maFast=100, maSlow=200, exitBuffer=0.95, recoverSlope=1.002, recoverStrong=1.03, pyramidGap=0.15, pyramidLevels=1)
def rand_date():
    y = rnd.choice([1989, 1990, 1990, 1995, 2000, 2003, 2008, 2010, 2014, 2015, 2017, 2020, 2024, 2026, 2027])
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
                capital=rnd.choice([1_000_000, 50_000, 3_000_000]), sp=rnd.choice(["raw", "adjusted"]),
                custom={"1": rand_params(1), "2": rand_params(2)}, roll=rnd.choice([None, None, 3, 10, 20]))
    if t == "rebal":
        w = {c: rnd.choice([0, 0, 10, 25, 50, 65]) / 100 for c in ("0050", "00631L", "00675L", "CASH")}
        if sum(w.values()) == 0: w["CASH"] = 1
        case.update(weights=w, freq=rnd.choice(["none", "M", "Q", "H", "Y"]), band=rnd.choice([0, 0, 0.03, 0.1]), cash=rnd.choice([0, 0.01, 0.02]), rtrend=rnd.random() < 0.5)
    cases.append(case)
out = []
for c in cases:
    r = {"case": c}
    try:
        bh = BuyHold(os.path.join(ROOT, "data/adjusted"), use_synthetic=c["syn"], tw50_excess=c["excess"], cost=TaiwanCost(discount=c["disc"]), capital=c["capital"])
        params = {code: to_tp(2 if LEVERAGE[code] >= 2 else 1, c["custom"]["2" if LEVERAGE[code] >= 2 else "1"]) for code in bh.rets.columns}
        if c["type"] == "bh":
            res = {}
            for code in ("TAIEX", "0050", "00631L", "00675L"):
                try:
                    eq = bh.equity(code, c["start"], c["end"]); st = summarize(eq)
                    res[code] = [str(eq.index[0].date()), float(eq.iloc[-1]), st["最大回撤"]]
                except ValueError: res[code] = None
            r["period"] = res
            if c["roll"]: w = bh.rolling(c["roll"]); r["roll"] = {k: [len(v), float(v["年化報酬"].median())] for k, v in w.groupby("標的")} if len(w) else {}
        elif c["type"] == "trend":
            tb = TrendBacktest(bh, params, signal_price=c["sp"]); res = {}
            for code in ("0050", "00631L", "00675L"):
                try:
                    x = tb.run(code, c["start"], c["end"]); st = summarize(x.equity)
                    res[code] = [str(x.equity.index[0].date()), float(x.equity.iloc[-1]), st["最大回撤"], len(x.events)]
                except ValueError: res[code] = None
            r["period"] = res
            if c["roll"]: w = tb.rolling(c["roll"]); r["roll"] = {k: [len(v), float(v["策略年化"].median())] for k, v in w.groupby("標的")} if len(w) else {}
        else:
            tb = TrendBacktest(bh, params, signal_price=c["sp"]); rb = RebalBacktest(bh, tb)
            cfg = RebalConfig(c["weights"], c["freq"], c["band"], c["cash"], c["rtrend"])
            try:
                x = rb.run(cfg, c["start"], c["end"]); st = summarize(x["策略"])
                r["period"] = [str(x["策略"].index[0].date()), float(x["策略"].iloc[-1]), st["最大回撤"], x["交易次數"], float(x["同配置不再平衡"].iloc[-1])]
            except ValueError: r["period"] = None
            if c["roll"]: w = rb.rolling(cfg, c["roll"]); r["roll"] = [len(w), float(w["策略年化"].median()) if len(w) else None]
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"
    out.append(r)
json.dump(out, open(sys.argv[1], "w"), default=str)
print("python 完成", len(out), "組；例外", sum("error" in x for x in out))
for x in out:
    if "error" in x: print("  例外：", x["error"], x["case"]["type"])
