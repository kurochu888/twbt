#!/bin/bash
# Python 版與網頁版（docs/engine.js）隨機比對：產生隨機設定，兩邊各算一次，數字要完全一致。
#   bash tools/crosscheck.sh [亂數種子] [組數]
# 需要 Node.js；先跑過 python scripts/update_core.py --build-only 產生 data/adjusted。
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
cp docs/engine.js "$T/engine.mjs"
cp tools/crosscheck_js.mjs "$T/"
python3 -W ignore tools/crosscheck_py.py "$T/cases.json" "${1:-7}" "${2:-120}"
node "$T/crosscheck_js.mjs" "$T/cases.json" docs/data/returns.json
