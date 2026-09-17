"""Sanity check for generated data/words.json + data/chars.json.

Verifies structural integrity and spot-checks known words.
ASCII-escaped output so it prints safely on a legacy CJK console codepage.
"""
import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CJK_RE = re.compile(r"^[\u4e00-\u9fff]+$")
SYLLABLE_RE = re.compile(r"^[a-zA-Z\u00c0-\u024f\u00fc\u00dc]+$")


def enc(value) -> str:
    return str(value).encode("ascii", "backslashreplace").decode()


with open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8") as f:
    words = json.load(f)["words"]
with open(os.path.join(ROOT, "data", "chars.json"), encoding="utf-8") as f:
    chars = json.load(f)["chars"]

by_word = {w["s"]: w for w in words}

problems = []
for w in words:
    if not CJK_RE.match(w["s"]):
        problems.append(f"non-CJK word: {w['s']!r}")
    syls = w["p"].split(" ")
    if len(syls) != len(w["s"]):
        problems.append(f"syllable/char mismatch: {w['s']} -> {w['p']}")
    if not all(SYLLABLE_RE.match(s) for s in syls):
        problems.append(f"bad syllable: {w['s']} -> {w['p']}")
    if not isinstance(w.get("r"), int) or w["r"] < 1:
        problems.append(f"bad rank on {w['s']}")
    if w.get("lv") not in (1, 2, 3, 4, 5):
        problems.append(f"bad level on {w['s']}: {w.get('lv')}")
    if w.get("t") == w["s"]:
        problems.append(f"redundant traditional on {w['s']}")
    if "a" in w and len(w["s"]) != 1:
        problems.append(f"alternatives on multi-char word {w['s']}")
    for alt in (w.get("a") or "").split("|"):
        if alt and not SYLLABLE_RE.match(alt):
            problems.append(f"bad alternative reading {alt!r} on {w['s']}")
    for ch in w["s"]:
        if ch not in chars:
            problems.append(f"char {ch} of {w['s']} missing from chars table")

ranks = [w["r"] for w in words]
if ranks != sorted(ranks) or len(set(ranks)) != len(ranks):
    problems.append("ranks are not a contiguous ascending sequence")

print("total words:", len(words), " chars:", len(chars))
print("problems:", len(problems))
for p in problems[:15]:
    print("  !", enc(p))

print("\n-- spot checks --")
spot = ["学校", "中国", "谢谢", "汉语", "拼音", "朋友", "苹果", "电影", "你好", "对不起",
        "长", "好", "了", "银行", "图书馆"]
for s in spot:
    w = by_word.get(s)
    if w is None:
        print("  missing:", enc(s))
    else:
        print("  lv%d rank %-5d %-14s -> %s%s" % (
            w["lv"], w["r"], enc(w["s"]), enc(w["p"]),
            ("   alt: " + enc(w["a"])) if w.get("a") else ""))

print("\n-- levels --")
print(" ", dict(sorted(Counter(w["lv"] for w in words).items())))
print("-- lengths --")
print(" ", dict(sorted(Counter(len(w["s"]) for w in words).items())))
print("-- categories --")
print(" ", dict(sorted(Counter(w["c"] for w in words).items(), key=lambda kv: -kv[1])))
print("\n-- level 1 sample --")
lvl1 = [w for w in words if w["lv"] == 1][:25]
print("  ", " ".join(f'{enc(w["s"])}({enc(w["p"])})' for w in lvl1))
print("-- level 5 sample --")
lvl5 = [w for w in words if w["lv"] == 5][:15]
print("  ", " ".join(f'{enc(w["s"])}({enc(w["p"])})' for w in lvl5))

sys.exit(1 if problems else 0)
