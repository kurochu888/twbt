"""網頁版本號要跟程式內容一致（改了 docs/ 的程式卻忘了跑 tools/stamp_version.py 會失敗）。"""
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestVersion(unittest.TestCase):
    def test_stamp_is_current(self):
        r = subprocess.run([sys.executable, str(ROOT / "tools/stamp_version.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
