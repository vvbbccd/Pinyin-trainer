"""Dev diagnostic: explain why specific words are / are not in data/words.json."""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, ".tmp")
CJK_RE = re.compile(r"^[\u4e00-\u9fff]+$")

TARGETS = ["学校", "中国", "谢谢", "汉语", "拼音", "北京", "你好", "对不起", "谢谢", "朋友", "苹果", "电影"]

raw = {}
for line in open(os.path.join(TMP, "jieba_dict.txt"), encoding="utf-8"):
    parts = line.split()
    if len(parts) >= 3 and parts[0] in TARGETS:
        raw[parts[0]] = (int(parts[1]) if parts[1].isdigit() else 0, parts[2])

phrases = {}
for line in open(os.path.join(TMP, "phrase_pinyin.txt"), encoding="utf-8"):
    line = line.split("#")[0].strip()
    if not line or ":" not in line:
        continue
    k, _, v = line.partition(":")
    k = k.strip()
    if k in TARGETS:
        phrases[k] = v.split()

chars = {}
for line in open(os.path.join(TMP, "pinyin.txt"), encoding="utf-8"):
    line = line.split("#")[0].strip()
    if not line or ":" not in line:
        continue
    code, _, v = line.partition(":")
    if code.strip().upper().startswith("U+"):
        chars[chr(int(code.strip()[2:], 16))] = [x.strip() for x in v.split(",") if x.strip()]

out = json.load(open(os.path.join(ROOT, "data", "words.json"), encoding="utf-8"))["words"]
by_word = {w["s"]: w for w in out}

# frequency rank among all jieba words
entries = []
for line in open(os.path.join(TMP, "jieba_dict.txt"), encoding="utf-8"):
    p = line.split()
    if len(p) >= 2 and p[1].isdigit():
        entries.append((p[0], int(p[1]), p[2] if len(p) > 2 else ""))
entries.sort(key=lambda t: (-t[1], t[0]))
rank_of = {e[0]: i + 1 for i, e in enumerate(entries)}

enc = lambda s: str(s).encode("ascii", "backslashreplace").decode()
for t in dict.fromkeys(TARGETS):
    info = raw.get(t)
    print(f"--- {enc(t)}")
    print("   jieba:", (info[0], info[1]) if info else None, " freqrank:", rank_of.get(t))
    print("   phrase:", [enc(x) for x in phrases.get(t, [])] or None)
    print("   char readings:", [enc(ch) + ":" + str([enc(r) for r in chars.get(ch, [])]) for ch in t])
    print("   in words.json:", t in by_word, by_word[t]["r"] if t in by_word else "")
