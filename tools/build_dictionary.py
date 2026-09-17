"""Build-time generator for the prototype's static dictionary.

Reads (from .tmp/, downloaded by tools/fetch_data.py):
  jieba_dict.txt    word<space>freq<space>pos      - word list + corpus frequency
  phrase_pinyin.txt phrase: pinyin syllables       - context-correct phrase pinyin
  pinyin.txt        U+XXXX: r1,r2  # char          - per-character readings
  STCharacters.txt  simplified<TAB>traditional     - OpenCC simplified -> traditional
Reads (authored):
  tools/vocabulary.json                            - curated level 1 / level 2 words

Writes:
  data/words.json   training words: s=simplified t=traditional p=pinyin r=freq rank
                    c=category lv=level (1..5)
  data/chars.json   character -> readings table for the Pinyin Library fallback

Field mapping to the planned database schema (basic.txt):
  s  -> chinese_words.simplified      t -> chinese_words.traditional
  r  -> chinese_words.frequency       c/lv -> chinese_words.category / difficulty

Run:  python tools/build_dictionary.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, ".tmp")
DATA = os.path.join(ROOT, "data")

CJK_RE = re.compile(r"^[\u4e00-\u9fff]+$")
SYLLABLE_RE = re.compile(r"^[a-zA-Z\u00c0-\u024f\u00fc\u00dc]+$")

MAX_WORDS = 5000
MIN_FREQ = 80
MIN_LEN, MAX_LEN = 1, 4

# jieba POS -> coarse category shown in the UI
POS_CATEGORY = {
    "n": "noun", "nr": "name", "ns": "place", "nt": "org", "nz": "proper", "ng": "noun",
    "v": "verb", "vn": "verb", "vd": "verb", "vg": "verb", "vi": "verb",
    "a": "adjective", "an": "adjective", "ad": "adjective", "ag": "adjective",
    "d": "adverb", "m": "number", "mq": "number", "q": "measure", "r": "pronoun",
    "t": "time", "f": "direction", "s": "place", "b": "other", "z": "other",
    "i": "idiom", "l": "idiom", "j": "abbrev", "e": "interjection", "o": "onomatopoeia",
    "x": "other", "eng": "foreign", "y": "particle", "u": "particle", "p": "preposition",
    "c": "conjunction", "h": "prefix", "k": "suffix", "g": "other", "un": "other",
}
# Only drop entries that are not Chinese words at all. Proper nouns and idioms are
# legitimate practice material, so ns/nt/nz/nr/l/i are kept.
SKIP_POS = {"eng", "x", "un", "zg"}

LEVEL3_RANK = 1000
LEVEL4_RANK = 2500

# Characters included in the simplified -> traditional map for UI chrome.
# Low threshold on purpose: the interface renders fixed Chinese labels (nav,
# examples, headings) that are not dictionary lookups, so the map needs to
# cover common characters generally, not just the ones in the word list.
SCRIPT_MIN_FREQ = 50


def script_keys(words: list[dict], raw_words: list[tuple[str, int, str]]) -> set[str]:
    """The simplified characters the script map should cover."""
    keys: set[str] = set()
    for word in words:
        keys.update(word["s"])
        if "t" in word:
            keys.update(word["t"])
    for word, freq, _pos in raw_words:
        if len(word) == 1 and freq >= SCRIPT_MIN_FREQ and CJK_RE.match(word):
            keys.add(word)
    return keys


def build_script_map(
    trad_table: dict[str, str],
    keys: set[str],
) -> dict[str, str]:
    """Simplified -> traditional for common characters, to keep the file small."""
    mapping: dict[str, str] = {}
    for char in keys:
        traditional = trad_table.get(char)
        # only single-character, actually-different mappings are useful here
        if traditional and traditional != char and len(traditional) == 1:
            mapping[char] = traditional
    return mapping


def load_tw_variants() -> dict[str, list[str]]:
    """OpenCC TWVariants: standard traditional -> Taiwan/Hong Kong forms.

    STCharacters maps 为 only to 爲 and 里 only to 裏, so a reader typing the very
    common Taiwan forms 為 and 裡 would miss the dictionary entirely. This is the
    dictionary that closes that gap.
    """
    out: dict[str, list[str]] = {}
    path = os.path.join(TMP, "TWVariants.txt")
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            key, _, values = line.partition("\t")
            key = key.strip()
            vals = [value for value in values.split() if value]
            if key and vals:
                out[key] = vals
    return out


def merge_tw_variants(reverse_map: dict[str, str], tw_variants: dict[str, list[str]]) -> dict[str, str]:
    """Extend traditional -> simplified with Taiwan/Hong Kong forms."""
    out = dict(reverse_map)
    for standard, variants in tw_variants.items():
        simplified = reverse_map.get(standard)
        if not simplified:
            continue
        for variant in variants:
            out.setdefault(variant, simplified)
    return out


def strip_comments(line: str) -> str:
    idx = line.find("#")
    return line if idx < 0 else line[:idx]


def load_char_readings() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    with open(os.path.join(TMP, "pinyin.txt"), encoding="utf-8") as f:
        for line in f:
            line = strip_comments(line).strip()
            if not line or ":" not in line:
                continue
            code, _, readings = line.partition(":")
            code = code.strip()
            if not code.upper().startswith("U+"):
                continue
            try:
                ch = chr(int(code[2:], 16))
            except ValueError:
                continue
            items = [r.strip().lower() for r in readings.split(",") if r.strip()]
            if items:
                out[ch] = items
    return out


def load_phrases() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    with open(os.path.join(TMP, "phrase_pinyin.txt"), encoding="utf-8") as f:
        for line in f:
            line = strip_comments(line).strip()
            if not line or ":" not in line:
                continue
            phrase, _, readings = line.partition(":")
            phrase = phrase.strip()
            if not CJK_RE.match(phrase):
                continue
            syls = readings.split()
            if len(syls) != len(phrase):
                continue
            if not all(SYLLABLE_RE.match(s) for s in syls):
                continue
            out.setdefault(phrase, [s.lower() for s in syls])
    return out


def load_words() -> list[tuple[str, int, str]]:
    out = []
    with open(os.path.join(TMP, "jieba_dict.txt"), encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                freq = int(parts[1])
            except ValueError:
                continue
            out.append((parts[0], freq, parts[2] if len(parts) > 2 else ""))
    out.sort(key=lambda t: (-t[1], t[0]))
    return out


def load_traditional_variants() -> dict[str, list[str]]:
    """OpenCC STCharacters maps one simplified character to SEVERAL traditional
    forms: 发 -> 發 髮, 里 -> 裏 里 哩, 台 -> 臺 檯 颱 台. Keep them all.

    The first variant is the one used for display; the rest are needed to turn
    traditional INPUT back into simplified before a dictionary lookup.
    """
    out: dict[str, list[str]] = {}
    path = os.path.join(TMP, "STCharacters.txt")
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            key, _, values = line.partition("\t")
            key = key.strip()
            vals = [value for value in values.split() if value]
            if key and vals:
                out[key] = vals
    return out


def load_traditional() -> dict[str, str]:
    """The display form: first traditional variant per simplified character."""
    return {
        simplified: variants[0]
        for simplified, variants in load_traditional_variants().items()
        if variants
    }


def build_reverse_variants(
    variants: dict[str, list[str]], keys: set[str]
) -> dict[str, str]:
    """traditional variant -> simplified, covering every variant, not just the first."""
    out: dict[str, str] = {}
    for simplified in keys:
        for variant in variants.get(simplified, []):
            if variant != simplified:
                out.setdefault(variant, simplified)
    return out


def to_traditional(word: str, table: dict[str, str]) -> str:
    return "".join(table.get(ch, ch) for ch in word)


def category_for(pos: str) -> str:
    if pos in POS_CATEGORY:
        return POS_CATEGORY[pos]
    for prefix in ("n", "v", "a", "d", "m", "q", "t"):
        if pos.startswith(prefix):
            return POS_CATEGORY.get(prefix, "other")
    return "other"


def resolve_pinyin(
    word: str, phrases: dict[str, list[str]], chars: dict[str, list[str]]
) -> tuple[list[str] | None, list[str] | None, bool]:
    """Return (syllables, alternative_readings, derived_from_chars).

    Phrase data is authoritative and polyphone-safe. For a single character we take
    pinyin-data's primary reading and expose the rest as accepted alternatives, so a
    learner who types 长 as either zhang or chang is still correct.
    """
    syls = phrases.get(word)
    if syls is not None:
        return syls, None, False
    if len(word) == 1:
        readings = chars.get(word, [])
        if readings:
            return [readings[0]], readings[1:] or None, True
        return None, None, False
    # Multi-character fallback only when every character is unambiguous.
    if all(len(chars.get(ch, [])) == 1 for ch in word):
        return [chars[ch][0] for ch in word], None, True
    return None, None, False


def main() -> int:
    if not os.path.isdir(TMP):
        print("missing .tmp/ - run tools/fetch_data.py first", file=sys.stderr)
        return 1

    print("loading sources ...")
    char_readings = load_char_readings()
    phrases = load_phrases()
    raw_words = load_words()
    variants_table = load_traditional_variants()
    trad_table = {simplified: variants[0] for simplified, variants in variants_table.items() if variants}
    with open(os.path.join(ROOT, "tools", "vocabulary.json"), encoding="utf-8") as f:
        vocab = json.load(f)
    print(f"  chars={len(char_readings)} phrases={len(phrases)} raw words={len(raw_words)}")

    curated: dict[str, int] = {}
    for level, key in ((1, "level1"), (2, "level2")):
        for w in vocab.get(key, []):
            curated.setdefault(w, level)
    print(f"  curated words: {len(curated)}")

    entries: list[dict] = []
    seen: set[str] = set()
    stats = {"derived": 0, "curated_missing_pinyin": [], "curated_bad_len": []}

    def add(word: str, freq: int, pos: str, level: int | None) -> bool:
        if word in seen or not CJK_RE.match(word):
            return False
        if not (MIN_LEN <= len(word) <= MAX_LEN):
            return False
        if any(ch not in char_readings for ch in word):
            return False
        syls, alts, derived = resolve_pinyin(word, phrases, char_readings)
        if syls is None:
            return False
        seen.add(word)
        if derived:
            stats["derived"] += 1
        entry = {"s": word, "p": " ".join(syls), "f": freq, "c": category_for(pos)}
        if alts:
            entry["a"] = "|".join(alts)
        trad = to_traditional(word, trad_table)
        if trad != word:
            entry["t"] = trad
        if level is not None:
            entry["_lv"] = level
        entries.append(entry)
        return True

    # 1) curated vocabulary first, so beginner levels are never crowded out
    jieba_map = {w: (f, p) for w, f, p in raw_words}
    for word, level in curated.items():
        if len(word) > MAX_LEN or len(word) < MIN_LEN:
            stats["curated_bad_len"].append(word)
            continue
        freq, pos = jieba_map.get(word, (0, "n"))
        if not add(word, freq, pos, level):
            stats["curated_missing_pinyin"].append(word)

    # 2) fill remaining slots from the corpus, highest frequency first
    for word, freq, pos in raw_words:
        if len(entries) >= MAX_WORDS:
            break
        if freq < MIN_FREQ or pos in SKIP_POS:
            continue
        add(word, freq, pos, None)

    entries.sort(key=lambda e: (-e["f"], e["s"]))
    for i, entry in enumerate(entries):
        entry["r"] = i + 1
        if "_lv" not in entry:
            entry["lv"] = 3 if entry["r"] <= LEVEL3_RANK else (4 if entry["r"] <= LEVEL4_RANK else 5)
        else:
            entry["lv"] = entry.pop("_lv")

    # keep a stable, readable key order
    order = ["s", "t", "p", "a", "r", "f", "c", "lv"]
    words_out = [{k: e[k] for k in order if k in e} for e in entries]

    # simplified -> traditional character map for interface chrome (not lookups)
    script_map = build_script_map(trad_table, script_keys(words_out, raw_words))
    reverse_map = build_reverse_variants(variants_table, set(script_map) | set(script_map.values()))
    # Taiwan/Hong Kong forms (為, 裡) are a separate dictionary
    tw_table = load_tw_variants()
    before = len(reverse_map)
    reverse_map = merge_tw_variants(reverse_map, tw_table)
    tw_added = len(reverse_map) - before
    if tw_table:
        print(f"  added {tw_added} Taiwan/HK variant mappings from TWVariants.txt")
    else:
        print("  ! TWVariants.txt missing: Taiwan forms (為, 裡) will not resolve as input")

    # Character table: every character the word list can show, in both scripts,
    # plus the map's own values, so a traditional lookup still resolves.
    used_chars = {ch for e in words_out for ch in e["s"]}
    for entry in words_out:
        if "t" in entry:
            used_chars.update(entry["t"])
    used_chars.update(script_map.values())
    for word, freq, _pos in raw_words:
        if len(word) == 1 and freq >= 2000 and CJK_RE.match(word):
            used_chars.add(word)
    chars_out = {ch: char_readings[ch] for ch in sorted(used_chars) if ch in char_readings}

    os.makedirs(DATA, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    with open(os.path.join(DATA, "words.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "meta": {
                    "generated": stamp,
                    "count": len(words_out),
                    "note": "Static seed data for the UI prototype. The backend will serve this from a real DB.",
                    "fields": {
                        "s": "simplified", "t": "traditional (omitted when identical)",
                        "p": "pinyin, space separated, tone marks",
                        "a": "accepted alternative readings (single characters only)",
                        "r": "frequency rank", "f": "corpus frequency",
                        "c": "category", "lv": "difficulty level 1-5",
                    },
                    "sources": [
                        "jieba dict.txt (MIT)",
                        "mozillazg/phrase-pinyin-data (MIT)",
                        "mozillazg/pinyin-data (MIT)",
                        "OpenCC STCharacters (Apache-2.0)",
                    ],
                },
                "words": words_out,
            },
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    with open(os.path.join(DATA, "chars.json"), "w", encoding="utf-8") as f:
        json.dump(
            {"meta": {"generated": stamp, "count": len(chars_out)}, "chars": chars_out},
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    # script_map was built above, before the character table (which needs its values)
    with open(os.path.join(DATA, "script.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "meta": {
                    "generated": stamp,
                    "count": len(script_map),
                    "variants": len(reverse_map),
                    "note": "Character-level simplified<->traditional map for UI labels and "
                            "for normalising traditional input before a dictionary lookup. "
                            "Phrase-level conversion needs OpenCC's phrase dictionaries.",
                    "source": "OpenCC STCharacters (Apache-2.0)",
                },
                # display direction: first variant only (发 -> 發)
                "st": script_map,
                # lookup direction: EVERY variant (髮 -> 发, 裡 -> 里), so traditional
                # input normalises to simplified before matching words and phrases
                "variants": reverse_map,
            },
            f,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    wsize = os.path.getsize(os.path.join(DATA, "words.json"))
    csize = os.path.getsize(os.path.join(DATA, "chars.json"))
    ssize = os.path.getsize(os.path.join(DATA, "script.json"))
    levels: dict[int, int] = {}
    cats: dict[str, int] = {}
    for e in words_out:
        levels[e["lv"]] = levels.get(e["lv"], 0) + 1
        cats[e["c"]] = cats.get(e["c"], 0) + 1

    print(f"words.json  {wsize/1024:8.1f} KB  ({len(words_out)} words, {stats['derived']} from char fallback)")
    print(f"chars.json  {csize/1024:8.1f} KB  ({len(chars_out)} characters)")
    print(f"script.json {ssize/1024:8.1f} KB  ({len(script_map)} simplified->traditional characters)")
    print("levels:", dict(sorted(levels.items())))
    print("categories:", dict(sorted(cats.items(), key=lambda kv: -kv[1])))
    print("curated without safe pinyin:", json.dumps(stats["curated_missing_pinyin"], ensure_ascii=True))
    print("curated bad length:", json.dumps(stats["curated_bad_len"], ensure_ascii=True))
    print("sample:", json.dumps(words_out[:4], ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
