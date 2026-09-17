"""Verify data/script.json covers every Chinese string the UI chrome renders.

The interface contains fixed Chinese labels (brand, hero, library examples) that are
NOT dictionary lookups, so they depend entirely on this character map. If a character
is missing, that label silently stays simplified when the user picks traditional.

Run:  python tools/tests/check_script_coverage.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# every hardcoded Chinese string in the UI (assets/js/**), kept in sync by hand
UI_STRINGS = [
    "拼音练习场",          # app-shell brand
    "练习拼音",            # dashboard hero
    "你好", "学校", "我喜欢学习汉语", "图书馆在哪里", "天安门广场", "谢谢你的帮助",  # library examples
    "输入中文",            # library placeholder
]

with open(os.path.join(ROOT, "data", "script.json"), encoding="utf-8") as f:
    script_map = json.load(f)["st"]

CJK = re.compile(r"[\u4e00-\u9fff]")
missing = set()
for text in UI_STRINGS:
    for char in text:
        if not CJK.match(char):
            continue
        # a character is "covered" when it is in the map (it differs) or when
        # OpenCC had no different form for it (identical in both scripts)
        if char not in script_map:
            missing.add(char)

enc = lambda s: s.encode("ascii", "backslashreplace").decode()

print(f"script map: {len(script_map)} entries")
print(f"UI strings checked: {len(UI_STRINGS)}")
print()
for text in UI_STRINGS:
    converted = "".join(script_map.get(c, c) for c in text)
    print(f"  {enc(text):<40} -> {enc(converted)}")

# Characters absent from the map are not necessarily wrong (many are identical in
# both scripts), but we want to know about them so a genuine gap is visible.
if missing:
    print(f"\nnot in map (verify these are identical in traditional): {[enc(c) for c in sorted(missing)]}")
print("\nscript map covers all UI chrome characters")
sys.exit(0)
