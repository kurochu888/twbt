"""美股：Nasdaq-100 指數、QQQ、QLD（Yahoo Finance）。

    python scripts/update_us.py              # 下載最新資料（需要 yfinance）並重算
    python scripts/update_us.py --build-only # 不下載，只用 data/source_us 重算

原始資料 data/source_us/（放進 git）：NDX.csv（價格指數）、QQQ.csv、QLD.csv（XNDX.csv 含息報酬指數：有完整歷史才會用）
輸出 data/adjusted_us/（跟台股 data/adjusted 同樣的格式，回測程式共用）：
    QQQ.csv、QLD.csv：close（Yahoo 只還原分割的收盤）、adj_close（由收盤與配息自己算的還原價）、ret、price_ret、event
    NDX.csv：close（價格指數）、tr_close（報酬指數）
    splits.csv：分割（恢復交易日、倍數），整股交易換算用
    long/：NDX_long.csv、QQQ_long.csv、QLD_long.csv（含上市前模擬）、params.json、calibration.txt
網頁資料 docs/data/returns_us.json

上市前模擬（跟台股同一套方法，參數用真實資料重疊期間校正）：
- Nasdaq-100 含息：有含息報酬指數（^XNDX）就用；Yahoo 不給完整歷史時，改用「QQQ 含息報酬 + 內扣費用 0.20%/年」
  （QQQ 1999 年上市起）。之前的年份 = 價格指數 + 估計股息（跟含息序列重疊期間的年化差距）
- QQQ（1999-03-10 上市）：指數含息報酬 + 年化差距（主要是內扣費用）；價格報酬 = 指數價格報酬 + 同一個差距
- QLD（2006-06-21 上市）：2 × 指數含息日報酬 + 年化常數（以累積報酬校正：吸收借錢成本、內扣費用）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from twbt.data import synthetic as syn  # noqa: E402

JUMP_LIMIT = {"QQQ": 0.20, "QLD": 0.40}
QQQ_FEE = 0.0020           # QQQ 內扣費用（年），用 QQQ 推回指數含息報酬時加回去     # 單日漲跌超過這個就檢查（2000、2008、2020 的大日子都在範圍內）


def read_src(src: Path, name: str) -> pd.DataFrame:
    df = pd.read_csv(src / f"{name}.csv", index_col=0, parse_dates=True)
    df.index = pd.DatetimeIndex(df.index).astype("datetime64[ns]")
    return df.sort_index()


def build_etf(raw: pd.DataFrame) -> tuple[pd.DataFrame, list]:
    """Yahoo 的 Close、Dividends 已還原分割。ret = 總報酬（含配息）、price_ret = 只還原分割的價格報酬。"""
    df = raw[["open", "high", "low", "close", "adj_close", "volume"]].copy()
    div = raw.get("dividends", pd.Series(0.0, index=raw.index)).fillna(0)
    # 總報酬用「(收盤 + 當天除息的配息) ÷ 前一天收盤」，不用 Yahoo 的 Adj Close：
    # Adj Close 有捨入誤差，每天都會跟價格報酬差一點點，變成每天都有正負的「假配息」
    df["price_ret"] = df["close"].pct_change()
    df["ret"] = (df["close"] + div) / df["close"].shift(1) - 1
    adj = (1 + df["ret"].fillna(0)).cumprod()
    df["adj_close"] = adj / adj.iloc[-1] * df["close"].iloc[-1]       # 還原價（最新一天 = 收盤）
    ev = []
    spl = raw.get("splits", pd.Series(0.0, index=raw.index)).fillna(0)
    for d in df.index:
        e = []
        if div.get(d, 0) > 0:
            e.append(f"配息 {div[d]:.4f}")
        if spl.get(d, 0) > 0:
            e.append(f"分割 1 拆 {spl[d]:g}")
            ev.append((d, float(spl[d])))
        df.loc[d, "event"] = "、".join(e)
    df["event"] = df["event"].fillna("")
    return df, ev


def check(code: str, df: pd.DataFrame) -> bool:
    big = df[df["ret"].abs() > JUMP_LIMIT[code]]
    if big.empty:
        print(f"  ✓ {code} 沒有異常跳動")
        return True
    print(f"  ⚠ {code} 異常跳動（可能是資料錯誤或漏了分割）：\n" + big[["close", "ret", "event"]].to_string())
    return False


def build(src: Path, out: Path) -> bool:
    out.mkdir(parents=True, exist_ok=True)
    long_dir = out / "long"
    long_dir.mkdir(parents=True, exist_ok=True)
    ok = True
    ndx = read_src(src, "NDX")["close"].dropna()
    if (src / "XNDX.csv").exists() and len(read_src(src, "XNDX")) > 250:
        xndx, tr_src = read_src(src, "XNDX")["close"].dropna(), "含息報酬指數 ^XNDX"
    else:
        q = read_src(src, "QQQ")["adj_close"].dropna()
        q = q[q.index.isin(ndx.index)]
        qr = syn.shift_return(q.pct_change(), QQQ_FEE).fillna(0)
        xndx, tr_src = (1 + qr).cumprod() * 1000, f"QQQ 含息報酬 + 內扣費用 {QQQ_FEE:.2%}/年"
    pd.DataFrame({"close": ndx, "tr_close": xndx.reindex(ndx.index)}).to_csv(out / "NDX.csv", float_format="%.4f")
    mkt_ret, info = syn.market_total_return(ndx, xndx)
    params = {"dividend_yield": info["股息估計（年化）"], "tri_start": info["報酬指數起日"]}
    mkt = pd.DataFrame({"close": ndx, "tr_ret": mkt_ret,
                        "is_synthetic": (mkt_ret.index < pd.Timestamp(info["報酬指數起日"])).astype(int)})
    mkt["tr_index"] = (1 + mkt["tr_ret"].fillna(0)).cumprod() * ndx.iloc[0]
    mkt.to_csv(long_dir / "NDX_long.csv", float_format="%.10g")
    params["tr_source"] = tr_src
    lines = [f"Nasdaq-100：{ndx.index[0].date()} 起；含息（{tr_src}）{info['報酬指數起日']} 起，"
             f"之前用價格指數 + 估計股息 {info['股息估計（年化）']:.2%}/年"]
    px_ret = ndx.pct_change()

    def report(name, real_ret, synth_ret):
        df = pd.concat([real_ret, synth_ret], axis=1, keys=["r", "s"], sort=True).dropna()
        te = (df.r - df.s).std() * 252 ** 0.5
        cum_r, cum_s = (1 + df.r).prod() - 1, (1 + df.s).prod() - 1
        return (f"{name}：重疊 {len(df)} 天，相關係數 {df.r.corr(df.s):.4f}，年化追蹤誤差 {te:.2%}，"
                f"累積報酬 真實 {cum_r:+.1%} / 模擬 {cum_s:+.1%}")

    splits = []
    real = {}
    for code in ("QQQ", "QLD"):
        raw = read_src(src, code).dropna(subset=["close"])
        raw = raw[raw.index.isin(ndx.index) | (raw.index > ndx.index[-1])]   # 只留指數也有的交易日（日曆一致）
        df, ev = build_etf(raw)
        df.to_csv(out / f"{code}.csv", float_format="%.10g")
        real[code] = df
        splits += [(code, d.date().isoformat(), r) for d, r in ev]
        n_div = df["event"].str.contains("配息").sum()
        print(f"{code}：{len(df)} 天（{df.index[0].date()} ~ {df.index[-1].date()}），配息 {n_div} 次、分割 {len(ev)} 次")
        ok &= check(code, df)
    pd.DataFrame(splits, columns=["code", "resume_date", "ratio"]).to_csv(out / "splits.csv", index=False)

    # QQQ：指數含息 + 年化差距；價格報酬 = 指數價格報酬 + 同一個差距
    q = real["QQQ"]
    gap = syn.annualized_gap(q["ret"], mkt_ret)
    sq = syn.shift_return(mkt_ret, gap)
    longq = syn.splice(q, sq)
    pr = syn.shift_return(px_ret, gap).reindex(longq.index)
    rp = q["price_ret"].dropna()
    pr.loc[rp.index] = rp
    longq["price_ret"] = pr
    longq.to_csv(long_dir / "QQQ_long.csv", float_format="%.10g")
    params["gap_QQQ"] = gap
    lines.append(f"QQQ 模擬：指數含息報酬 {gap:+.2%}/年")
    lines.append("  " + report("QQQ", q["ret"], sq))

    # QLD：2 × 指數含息 + 年化常數；上市前不配息（價格報酬 = 總報酬），上市後用真實的價格報酬
    d = real["QLD"]
    c = syn.calibrate_leverage(d["ret"], mkt_ret)
    sd = syn.leveraged_return(mkt_ret, c)
    longd = syn.splice(d, sd)
    pr = longd["ret"].copy()
    rp = d["price_ret"].dropna()
    pr.loc[rp.index] = rp
    longd["price_ret"] = pr
    longd.to_csv(long_dir / "QLD_long.csv", float_format="%.10g")
    params["c_QLD"] = c
    lines.append(f"QLD 模擬：2 × 指數含息日報酬 {c:+.2%}/年（以累積報酬校正）")
    lines.append("  " + report("QLD", d["ret"], sd))

    params = {k: (float(f"{v:.12g}") if isinstance(v, float) else v) for k, v in params.items()}
    (long_dir / "params.json").write_text(json.dumps(params, indent=2), encoding="utf-8")
    text = "\n".join(lines)
    (long_dir / "calibration.txt").write_text(text + "\n", encoding="utf-8")
    print("\n=== 長期序列（含模擬）===\n" + text)
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="data/source_us")
    ap.add_argument("--out", default="data/adjusted_us")
    ap.add_argument("--web", default="docs/data", help="網頁資料輸出資料夾；空字串 = 不輸出")
    ap.add_argument("--build-only", action="store_true")
    a = ap.parse_args()
    if not a.build_only:
        from fetch_us import main as fetch
        if fetch() != 0:
            print("下載失敗，用上一次的資料重算")
    ok = build(Path(a.source), Path(a.out))
    if a.web and ok:
        from twbt.web_export import export_web
        print(f"\n網頁資料已輸出（{export_web(Path(a.out), Path(a.web))}）")
    elif a.web:
        print("\n檢查沒通過，這次不更新美股網頁資料")
    print("\n全部檢查通過 ✓" if ok else "\n有需要注意的地方，請把上面的訊息貼給 Claude")
    if not ok:
        sys.exit(2)


if __name__ == "__main__":
    main()
