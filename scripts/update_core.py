"""下載並整理核心標的：大盤（加權指數、報酬指數）、0050、00631L、00675L。

    python scripts/update_core.py              # 第一次：補齊全部歷史（約 1～2 小時，可中斷續跑）
    python scripts/update_core.py              # 之後：只補新月份（幾分鐘）
    python scripts/update_core.py --build-only # 不下載，只重新計算還原價

輸出 data/adjusted/：
    0050.csv、00631L.csv、00675L.csv：原始價、還原價、每日總報酬、事件
    TAIEX.csv：加權指數 close、報酬指數 tr_close
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

from twbt.data.adjust import adjust, load_splits, unexplained_jumps  # noqa: E402
from twbt.data.store import PriceStore  # noqa: E402
from twbt.data import synthetic as syn  # noqa: E402
from twbt.data.twse_hist import TwseClient  # noqa: E402

TW = ZoneInfo("Asia/Taipei")
# 標的 → 從哪個月開始抓（約略上市月份，更早的月份會回傳空資料）
CORE = {"0050": "2010-01", "00631L": "2014-10", "00675L": "2017-05"}  # 證交所個股日K只到 2010-01-04
TAIEX_START = "1990-01"   # 加權指數：盡量往前（更早沒資料的月份會自動略過）
TRI_START = "2003-01"     # 報酬指數：2003 年起公布
EXRIGHT_START = 2010
# 判斷「異常跳動」的門檻：一般 10% 漲跌停；槓桿型給寬一點
JUMP_LIMIT = {"0050": 0.105, "00631L": 0.21, "00675L": 0.21}


def months(start: str, end: date) -> list[str]:
    s = pd.Period(start, "M")
    return [p.strftime("%Y%m") for p in pd.period_range(s, pd.Period(end, "M"), freq="M")]


def fetch_monthly(store: PriceStore, cli: TwseClient, key: str, start: str, today: date, fn, save):
    done = store.done_months(key)
    all_m = months(start, today)
    recent = set(all_m[-2:])               # 最近兩個月每次都重抓，確保完整
    todo = [m for m in all_m if m not in done or m in recent]
    print(f"[{key}] 需要抓 {len(todo)} 個月", flush=True)
    for i, ym in enumerate(todo, 1):
        df = fn(ym)
        n = save(df)
        store.log_month(key, ym, n)
        if i % 12 == 0 or i == len(todo):
            print(f"  {key} {ym} 完成（{i}/{len(todo)}）", flush=True)


def download(store: PriceStore, cli: TwseClient, today: date):
    for code, start in CORE.items():
        fetch_monthly(store, cli, f"stock:{code}", start, today,
                      lambda ym, c=code: cli.stock_month(c, ym),
                      lambda df: store.upsert("stock_daily", df))
    fetch_monthly(store, cli, "taiex", TAIEX_START, today, cli.taiex_month,
                  lambda df: store.upsert("index_daily", df.assign(index_code="TAIEX")))
    fetch_monthly(store, cli, "tri", TRI_START, today, cli.tri_month,
                  lambda df: store.upsert("index_daily", df.assign(index_code="TAIEX_TR")))

    # 除權息：逐年查詢
    done = store.done_months("exright")
    for y in range(EXRIGHT_START, today.year + 1):
        if str(y) in done and y < today.year:
            continue
        ev = cli.exright(date(y, 1, 1), min(date(y, 12, 31), today), set(CORE))
        if not ev.empty:
            store.upsert("corp_events", ev.assign(source="TWSE TWT49U"))
        store.log_month("exright", str(y), len(ev))
        print(f"  除權息 {y}：核心標的 {len(ev)} 筆", flush=True)


def build_long(store: PriceStore, out_dir: Path, real: dict) -> None:
    """把上市前的模擬報酬接在真實資料前面，輸出 data/adjusted/long/。"""
    idx = store.query("SELECT date, index_code, close FROM index_daily")
    if idx.empty or "TAIEX_TR" not in set(idx.index_code):
        print("\n（大盤資料不足，略過長期模擬序列）"); return
    idx["date"] = pd.to_datetime(idx["date"])
    w = idx.pivot(index="date", columns="index_code", values="close").sort_index()
    px = w["TAIEX"].dropna()
    mkt_ret, info = syn.market_total_return(px, w["TAIEX_TR"])
    long_dir = out_dir / "long"
    long_dir.mkdir(parents=True, exist_ok=True)
    params = {"dividend_yield": info["股息估計（年化）"], "tri_start": info["報酬指數起日"]}

    mkt = pd.DataFrame({"close": px, "tr_ret": mkt_ret,
                        "is_synthetic": (mkt_ret.index < pd.Timestamp(info["報酬指數起日"])).astype(int)})
    mkt["tr_index"] = (1 + mkt["tr_ret"].fillna(0)).cumprod() * px.iloc[0]
    mkt.to_csv(long_dir / "TAIEX_long.csv", float_format="%.10g")
    lines = [f"大盤：{px.index[0].date()} 起；報酬指數 {info['報酬指數起日']} 起，"
             f"之前用價格指數 + 估計股息 {info['股息估計（年化）']:.2%}/年"]

    def report(name, real_ret, synth_ret):
        df = pd.concat([real_ret, synth_ret], axis=1, keys=["r", "s"], sort=True).dropna()
        te = (df.r - df.s).std() * 252 ** 0.5
        cum_r, cum_s = (1 + df.r).prod() - 1, (1 + df.s).prod() - 1
        return (f"{name}：重疊 {len(df)} 天，相關係數 {df.r.corr(df.s):.4f}，年化追蹤誤差 {te:.2%}，"
                f"累積報酬 真實 {cum_r:+.1%} / 模擬 {cum_s:+.1%}")

    # 0050：大盤含息報酬 + 年化差距
    if "0050" in real:
        r50 = real["0050"]
        gap = syn.annualized_gap(r50["ret"], mkt_ret)
        s50 = syn.shift_return(mkt_ret, gap)
        syn.splice(r50, s50).to_csv(long_dir / "0050_long.csv", float_format="%.10g")
        params["gap_0050"] = gap
        lines.append(f"0050 模擬：大盤含息報酬 {gap:+.2%}/年")
        lines.append("  " + report("0050", r50["ret"], s50))

    # 正2：基準一律用大盤含息報酬（實測比 0050 市價更貼近，且和 2003 年前的估計方式一致）
    for code, base, label in (("00631L", mkt_ret, "大盤含息"), ("00675L", mkt_ret, "大盤含息")):
        if code not in real:
            continue
        r = real[code]
        c = syn.calibrate_leverage(r["ret"], base)
        s = syn.leveraged_return(base, c)
        syn.splice(r, s).to_csv(long_dir / f"{code}_long.csv", float_format="%.10g")
        params[f"c_{code}"] = c
        lines.append(f"{code} 模擬：2 × {label}日報酬 {c:+.2%}/年（以累積報酬校正）")
        lines.append("  " + report(code, r["ret"], s))

    import json
    (long_dir / "params.json").write_text(json.dumps(params, indent=2), encoding="utf-8")
    text = "\n".join(lines)
    (long_dir / "calibration.txt").write_text(text + "\n", encoding="utf-8")
    print("\n=== 長期序列（含模擬）===\n" + text)


def build(store: PriceStore, out_dir: Path) -> bool:
    out_dir.mkdir(parents=True, exist_ok=True)
    ok = True
    real = {}
    for code in CORE:
        px = store.query("SELECT * FROM stock_daily WHERE code=? ORDER BY date", (code,))
        if px.empty:
            print(f"{code}：還沒有資料"); ok = False; continue
        px["date"] = pd.to_datetime(px["date"])
        px = px.set_index("date").dropna(subset=["close"])
        ev = store.query("SELECT date, kind, prev_close, ref_price, value FROM corp_events WHERE code=?", (code,))
        sp = load_splits(code).rename(columns={"resume_date": "date"})
        sp = sp.assign(kind="split")[["date", "kind", "ratio"]]
        events = pd.concat([ev.assign(ratio=float("nan")), sp], ignore_index=True)
        adj = adjust(px, events)
        cols = ["open", "high", "low", "close", "volume", "adj_open", "adj_high", "adj_low",
                "adj_close", "adj_factor", "ret", "event"]
        adj[cols].to_csv(out_dir / f"{code}.csv", float_format="%.10g")
        real[code] = adj

        n_ev = (adj["event"] != "").sum()
        jumps = unexplained_jumps(adj, JUMP_LIMIT[code])
        print(f"\n{code}：{len(adj)} 天（{adj.index[0].date()} ~ {adj.index[-1].date()}），事件 {n_ev} 次")
        warn = adj[adj["event"].str.contains("注意")]
        if not warn.empty:
            print("  ⚠ 官方前收與資料不一致：\n" + warn[["close", "event"]].to_string()); ok = False
        if jumps.empty:
            print("  ✓ 沒有無法解釋的跳動")
        else:
            print("  ⚠ 無法解釋的跳動（可能漏了分割或配息）：\n" + jumps.to_string()); ok = False

    idx = store.query("SELECT date, index_code, close FROM index_daily")
    if not idx.empty:
        idx["date"] = pd.to_datetime(idx["date"])
        w = idx.pivot(index="date", columns="index_code", values="close").sort_index()
        w = w.rename(columns={"TAIEX": "close", "TAIEX_TR": "tr_close"})
        w.to_csv(out_dir / "TAIEX.csv", float_format="%.2f")
        print(f"\n大盤：{len(w)} 天，加權指數 {w['close'].first_valid_index().date()} 起，"
              f"報酬指數 {w['tr_close'].first_valid_index().date() if 'tr_close' in w and w['tr_close'].notna().any() else '無'} 起")
    build_long(store, out_dir, real)
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/twbt.db")
    ap.add_argument("--out", default="data/adjusted")
    ap.add_argument("--gap", type=float, default=8.0, help="請求間隔秒數")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--backup-to", help="完成後把資料庫複製到這裡（例如 Google Drive）")
    ap.add_argument("--source", default="data/source",
                    help="原始資料 CSV 資料夾（放進 GitHub 的那份）；資料庫不存在時會從這裡重建")
    ap.add_argument("--web", default="docs/data", help="網頁用的資料輸出資料夾；設成空字串就不輸出")
    a = ap.parse_args()

    store = PriceStore(a.db, raw_dir=None)
    if not store.done_months("taiex") and Path(a.source).exists():
        n = store.import_csv(a.source)
        print(f"資料庫是空的，已從 {a.source} 匯入 {n} 張表")
    if not a.build_only:
        today = datetime.now(TW).date()
        try:
            download(store, TwseClient(min_gap=a.gap), today)
        except Exception as e:
            print(f"\n下載中斷：{e}\n已完成的部分都存好了，稍後再執行同一個指令會接著抓。")
            store.export_csv(a.source)
            if a.backup_to:
                store.backup(a.backup_to)
            sys.exit(1)
        store.export_csv(a.source)
    ok = build(store, Path(a.out))
    if a.web:
        from twbt.web_export import export_web  # noqa: E402
        info = export_web(Path(a.out), Path(a.web))
        print(f"\n網頁資料已輸出到 {a.web}（{info}）")
    if a.backup_to:
        store.backup(a.backup_to)
        print(f"已備份到 {a.backup_to}")
    print("\n全部檢查通過 ✓" if ok else "\n有需要注意的地方，請把上面的訊息貼給 Claude")


if __name__ == "__main__":
    main()
