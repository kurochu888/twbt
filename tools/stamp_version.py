"""蓋網頁版本號：版本 = 日期 · 程式內容的 hash（跟 finance-app 的 build.py 一樣，不手動編號，改了程式就自動換）。

    python tools/stamp_version.py           # 程式有改就更新版本號（沒改就什麼都不動）
    python tools/stamp_version.py --check   # 只檢查版本號是不是最新的（測試用；過期會回傳 1）

hash 算的是 docs/ 裡的 index.html、style.css、app.js、engine.js、plot.js（先把舊的版本號拿掉再算，所以重跑結果一樣）。
寫進去的地方：
- index.html：style.css?v=、app.js?v=（換版時瀏覽器一定會抓新的檔案，不會用快取的舊版）
- app.js：BUILD_HASH、BUILD_DATE、import 的 engine.js?v=、plot.js?v=
- version.json：{"hash", "date"}，打開中的網頁定期問這個檔案，換版了就提示重新整理
資料（data/returns.json）每天更新，不算在版本裡。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DOCS = Path(__file__).resolve().parents[1] / "docs"
FILES = ["index.html", "style.css", "app.js", "engine.js", "plot.js"]
V_RE = re.compile(r"\?v=[0-9a-f]{10}")
HASH_RE = re.compile(r"const BUILD_HASH = '[^']*';")
DATE_RE = re.compile(r"const BUILD_DATE = '[^']*';")


def normalize(text: str) -> str:
    """拿掉版本號本身，hash 才不會因為蓋了版本號又改變。"""
    text = V_RE.sub("?v=", text)
    text = HASH_RE.sub("const BUILD_HASH = '';", text)
    return DATE_RE.sub("const BUILD_DATE = '';", text)


def content_hash() -> str:
    h = hashlib.sha256()
    for name in FILES:
        h.update(name.encode() + b"\0" + normalize((DOCS / name).read_text(encoding="utf-8")).encode())
    return h.hexdigest()[:10]


def current() -> dict:
    try:
        return json.loads((DOCS / "version.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def stamp(h: str, date: str) -> None:
    idx = (DOCS / "index.html").read_text(encoding="utf-8")
    idx = re.sub(r'href="style\.css(\?v=[0-9a-f]*)?"', f'href="style.css?v={h}"', idx)
    idx = re.sub(r'src="app\.js(\?v=[0-9a-f]*)?"', f'src="app.js?v={h}"', idx)
    (DOCS / "index.html").write_text(idx, encoding="utf-8")
    app = (DOCS / "app.js").read_text(encoding="utf-8")
    app = re.sub(r"'\./engine\.js(\?v=[0-9a-f]*)?'", f"'./engine.js?v={h}'", app)
    app = re.sub(r"'\./plot\.js(\?v=[0-9a-f]*)?'", f"'./plot.js?v={h}'", app)
    app = HASH_RE.sub(f"const BUILD_HASH = '{h}';", app)
    app = DATE_RE.sub(f"const BUILD_DATE = '{date}';", app)
    (DOCS / "app.js").write_text(app, encoding="utf-8")
    (DOCS / "version.json").write_text(json.dumps({"hash": h, "date": date}) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    h = content_hash()
    cur = current()
    app = (DOCS / "app.js").read_text(encoding="utf-8")
    ok = cur.get("hash") == h and f"const BUILD_HASH = '{h}';" in app and f"?v={h}" in (DOCS / "index.html").read_text(encoding="utf-8")
    if a.check:
        if not ok:
            print(f"網頁版本號過期：程式內容 {h}，version.json {cur.get('hash')}。請執行 python tools/stamp_version.py")
            return 1
        print(f"版本號是最新的：{cur.get('date')} · {h}")
        return 0
    if ok:
        print(f"程式沒有改，版本維持 {cur.get('date')} · {h}")
        return 0
    date = datetime.now(ZoneInfo("Asia/Taipei")).date().isoformat()
    stamp(h, date)
    print(f"新版本：{date} · {h}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
