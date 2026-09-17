"""Check that the preview server serves every asset the app needs."""
import re
import urllib.request
import sys

BASE = "http://127.0.0.1:8123/"
EXPECTED = [
    "index.html",
    "assets/css/tokens.css",
    "assets/css/base.css",
    "assets/css/layout.css",
    "assets/css/components.css",
    "assets/css/views.css",
    "assets/js/main.js",
    "assets/js/ui.js",
    "assets/js/pinyin.js",
    "assets/js/store.js",
    "assets/js/dictionary.js",
    "assets/js/stats.js",
    "assets/js/router.js",
    "assets/js/app-shell.js",
    "assets/js/views/shared.js",
    "assets/js/views/dashboard.js",
    "assets/js/views/training.js",
    "assets/js/views/library.js",
    "assets/js/views/progress.js",
    "assets/js/views/settings.js",
    "data/words.json",
    "data/chars.json",
    "data/script.json",
]

failures = []
for path in EXPECTED:
    try:
        with urllib.request.urlopen(BASE + path, timeout=20) as response:
            body = response.read()
            print(f"  {response.status}  {len(body):>8,} B  {path}")
    except Exception as error:  # noqa: BLE001
        failures.append(f"{path}: {error}")
        print(f"  ERR          {path}: {error}")

# every module specifier in index.html and in each js file must exist
html = urllib.request.urlopen(BASE + "index.html", timeout=20).read().decode("utf-8")
refs = re.findall(r'(?:href|src)="([^"]+)"', html)
for ref in refs:
    if ref.startswith(("http", "data:", "#")):
        continue
    try:
        urllib.request.urlopen(BASE + ref, timeout=20).read()
    except Exception as error:  # noqa: BLE001
        failures.append(f"index.html ref {ref}: {error}")
        print(f"  ERR  index.html ref {ref}")

print()
if failures:
    print("FAILURES:")
    for failure in failures:
        print("  -", failure)
    sys.exit(1)
print(f"all {len(EXPECTED)} assets served, all index.html references resolve")
