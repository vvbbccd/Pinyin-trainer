"""Server-side pinyin lookup.

Why this exists: the browser prototype can only match against a 5,000-word list
and falls back to a character's most common reading. Here the lookup is driven by
two real datasets in SQLite:

  phrase_pinyin  ~412k multi-character phrases with context-correct readings
                 (the same table pypinyin ships), which resolves polyphones the
                 way a dictionary would: 银行 yín háng vs 行走 xíng zǒu
  char_pinyin    per-character readings, most common first, as the fallback

Segmentation is a dynamic program that prefers the longest dictionary phrase at
each position and avoids leaving characters unresolved. Uncovered characters fall
back to their primary reading and are flagged in the response so the UI can warn.

pypinyin is used when it happens to be installed (it applies a few extra rules);
otherwise this engine runs standalone with no third-party dependency at all.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any, Iterable, Sequence

CJK_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF))
NEUTRAL_TONE = 5
MAX_PHRASE_LEN = 8
SQL_CHUNK = 900

_TONE_ROWS = (
    ("a", "aāáǎà"),
    ("e", "eēéěè"),
    ("i", "iīíǐì"),
    ("o", "oōóǒò"),
    ("u", "uūúǔù"),
    ("ü", "üǖǘǚǜ"),
)

# 'ā' -> ('a', 1); 'a' -> ('a', None)
MARK_TO_PLAIN: dict[str, tuple[str, int | None]] = {}
for _plain, _glyphs in _TONE_ROWS:
    for _index, _glyph in enumerate(_glyphs):
        MARK_TO_PLAIN[_glyph] = (_plain, None if _index == 0 else _index)
del _plain, _glyphs, _index, _glyph


def is_cjk(char: str) -> bool:
    code = ord(char)
    return any(low <= code <= high for low, high in CJK_RANGES)


# --------------------------------------------------------------- tones ------

def decode_syllable(token: str) -> tuple[str, int | None]:
    """'xué' | 'xue2' | 'lv4' | 'men' -> ('xue', 2) / ('lü', 4) / ('men', None).

    A missing tone mark and an explicit 5 both mean the neutral tone. 'v' is the
    usual ASCII stand-in for ü and is normalised to ü here.
    """
    working = str(token).strip().lower().replace("u:", "ü").replace("v", "ü")
    tone: int | None = None

    digit = re.match(r"^([a-zü]+)([1-5])$", working)
    if digit:
        working, tone = digit.group(1), int(digit.group(2))

    base = ""
    for char in working:
        mapped = MARK_TO_PLAIN.get(char)
        if mapped:
            plain, marked = mapped
            base += plain
            if marked is not None and tone is None:
                tone = marked
        elif char == "ü":
            base += "ü"
        elif "a" <= char <= "z":
            base += char

    return base, (None if tone == NEUTRAL_TONE else tone)


def encode_syllable(base: str, tone: int | None) -> str:
    """('xue', 2) -> 'xué'. Mark placement follows the standard rules."""
    plain = str(base).lower().replace("u:", "ü").replace("v", "ü")
    if not tone or tone == NEUTRAL_TONE:
        return plain

    target = -1
    for vowel in ("a", "o", "e"):
        if vowel in plain:
            target = plain.index(vowel)
            break
    if target < 0:
        if "iu" in plain:
            target = plain.index("iu") + 1
        elif "ui" in plain:
            target = plain.index("ui") + 1
        else:
            for index in range(len(plain) - 1, -1, -1):
                if plain[index] in "iuü":
                    target = index
                    break
    if target < 0:
        return plain

    letter = plain[target]
    row = next((glyphs for vowel, glyphs in _TONE_ROWS if vowel == letter), None)
    if row is None or not 1 <= tone <= 4:
        return plain
    return plain[:target] + row[tone] + plain[target + 1:]


_SEPARATOR_RE = re.compile(r"[\s'\u2019\u00b7-]+")
_TOKEN_RE = re.compile(r"[a-z\u00c0-\u024f:]+[1-5]?", re.IGNORECASE)


def split_syllables(pinyin: str) -> list[str]:
    """Split pinyin into syllables.

    Handles every form this API produces or accepts: space separated
    ('xué xiào'), tone digits attached ('xue2xiao4') and separator-laden
    ('xue2-xiao4'). A run of tone-marked letters with no separators and no digits
    ('xuéxiào') needs a syllable inventory to split reliably, which lives in the
    browser grading engine; here it is treated as a single token.
    """
    text = str(pinyin or "").strip()
    if not text:
        return []
    if _SEPARATOR_RE.search(text):
        return [piece for piece in _SEPARATOR_RE.split(text) if piece]
    if re.search(r"[1-5]", text):
        return _TOKEN_RE.findall(text)
    return [text]


def to_numbers(pinyin: str) -> str:
    """'xué xiào' -> 'xue2xiao4'. Accepts digit-attached input too."""
    out = []
    for token in split_syllables(pinyin):
        base, tone = decode_syllable(token)
        out.append(base.replace("ü", "v") + str(tone or NEUTRAL_TONE))
    return "".join(out)


def to_plain(pinyin: str) -> str:
    """'xué xiào' -> 'xuexiao' (ü collapses to u, like the browser client)."""
    return "".join(
        decode_syllable(token)[0].replace("ü", "u") for token in split_syllables(pinyin)
    )


def to_marks(pinyin: str) -> str:
    """Normalise any accepted spelling to tone marks: 'xue2xiao4' -> 'xué xiào'."""
    return " ".join(
        encode_syllable(*decode_syllable(token)) for token in split_syllables(pinyin)
    )


# ------------------------------------------------------------- segments -----

def _literal_segment(text: str) -> dict[str, Any]:
    return {
        "text": text,
        "traditional": None,
        "pinyin": "",
        "pinyinNumbers": "",
        "pinyinPlain": "",
        "source": "literal",
        "level": None,
        "category": None,
        "wordId": None,
        "alternatives": [],
    }


def _char_segment(char: str, readings: Sequence[str] | None, key: str | None = None) -> dict[str, Any]:
    if not readings:
        return {
            "text": char,
            "traditional": None,
            "pinyin": None,
            "pinyinNumbers": None,
            "pinyinPlain": None,
            "source": "unknown",
            "level": None,
            "category": None,
            "wordId": None,
            "alternatives": [],
            "_key": key or char,
        }
    primary = readings[0]
    return {
        "text": char,
        "traditional": None,
        "pinyin": to_marks(primary),
        "pinyinNumbers": to_numbers(primary),
        "pinyinPlain": to_plain(primary),
        "source": "char",
        "level": None,
        "category": None,
        "wordId": None,
        "alternatives": list(readings[1:]),
        "_key": key or char,
    }


# --------------------------------------------------------------- engine -----

class PinyinEngine:
    """Phrase-dictionary lookup backed by SQLite."""

    def __init__(self, db, use_pypinyin: bool = True):
        self.db = db
        self.max_phrase_len = MAX_PHRASE_LEN
        self._phrase_cache: dict[str, str | None] = {}
        self._char_cache: dict[str, list[str] | None] = {}
        self.pypinyin = _load_pypinyin() if use_pypinyin else None
        self.simp_to_trad: dict[str, str] = {}
        self.trad_to_simp: dict[str, str] = {}
        self._warned_no_script_map = False
        self._ready = False

    # ------------------------------------------------------------- setup --

    def _ensure_ready(self) -> None:
        """Load the caches on first use.

        warm_up() is called explicitly at server start, but lookup() must not
        silently misbehave when the engine is used directly (tests, scripts), so
        readiness is also checked lazily.
        """
        if not self._ready:
            self.warm_up()

    def warm_up(self) -> None:
        """Cache the longest phrase and the simplified/traditional map."""
        try:
            longest = self.db.scalar("SELECT MAX(LENGTH(phrase)) FROM phrase_pinyin", default=0)
            if longest:
                self.max_phrase_len = min(int(longest), MAX_PHRASE_LEN)
        except Exception:  # noqa: BLE001 - table may be empty in a bare install
            self.max_phrase_len = MAX_PHRASE_LEN
        self._load_script_map()
        self._ready = True

    def _load_script_map(self) -> None:
        """Load simplified <-> traditional so traditional input can be normalised."""
        try:
            rows = self.db.query("SELECT simplified, traditional FROM script_map")
        except Exception:  # noqa: BLE001 - databases built before the table existed
            rows = []
        for row in rows:
            simplified, traditional = row["simplified"], row["traditional"]
            # first row wins for display (matches the browser's chosen variant),
            # while every variant maps back for traditional-input normalisation
            self.simp_to_trad.setdefault(simplified, traditional)
            self.trad_to_simp.setdefault(traditional, simplified)

        if not rows and not self._warned_no_script_map:
            if self.db.scalar("SELECT COUNT(*) FROM chinese_words", default=0):
                self._warned_no_script_map = True
                print("! script_map is empty, so traditional input falls back to"
                      " per-character readings. Fix: python tools/build_database.py")

    def to_simplified(self, text: str) -> str:
        """Character-for-character traditional -> simplified.

        One character in, one character out, so positions still line up with the
        text the learner actually typed.
        """
        if not self.trad_to_simp:
            return text
        return "".join(self.trad_to_simp.get(char, char) for char in text)

    def to_traditional(self, text: str) -> str:
        if not self.simp_to_trad:
            return text
        return "".join(self.simp_to_trad.get(char, char) for char in text)

    def has_phrase_data(self) -> bool:
        return bool(self.db.scalar("SELECT 1 FROM phrase_pinyin LIMIT 1", default=0))

    # ------------------------------------------------------------ lookup --

    def lookup(self, text: str) -> dict[str, Any]:
        """Segment `text` and attach pinyin in every accepted spelling."""
        self._ensure_ready()
        source = str(text or "")
        if not source.strip():
            return {
                "segments": [], "pinyin": "", "pinyinNumbers": "", "pinyinPlain": "",
                "unknownChars": [], "hasFallback": False, "hasUnknown": False,
                "source": self.source_label(),
            }

        segments: list[dict[str, Any]] = []
        index = 0
        while index < len(source):
            if not is_cjk(source[index]):
                end = index
                while end < len(source) and not is_cjk(source[end]):
                    end += 1
                segments.append(_literal_segment(source[index:end]))
                index = end
                continue

            end = index
            while end < len(source) and is_cjk(source[end]):
                end += 1
            run = source[index:end]
            # The word and phrase tables are keyed on simplified text, so match
            # against a simplified "shadow" of the run and keep the learner's own
            # characters for display. The map is 1:1 per character, so the two
            # strings have identical length and every index lines up.
            segments.extend(self._segment_run(run, self.to_simplified(run)))
            index = end

        self._apply_sandhi(segments)

        pinyin_parts = [segment["pinyin"] for segment in segments if segment.get("pinyin")]
        unknown = [segment["text"] for segment in segments if segment["source"] == "unknown"]

        for segment in segments:
            segment.pop("_key", None)

        return {
            "segments": segments,
            "pinyin": " ".join(pinyin_parts),
            "pinyinNumbers": " ".join(seg["pinyinNumbers"] for seg in segments if seg.get("pinyinNumbers")),
            "pinyinPlain": " ".join(seg["pinyinPlain"] for seg in segments if seg.get("pinyinPlain")),
            "unknownChars": unknown,
            "hasFallback": any(segment["source"] == "char" for segment in segments),
            "hasUnknown": bool(unknown),
            "source": self.source_label(),
        }

    def source_label(self) -> str:
        return "pypinyin" if self.pypinyin is not None else "database"

    # ------------------------------------------------------- segmentation --

    def _segment_run(self, run: str, shadow: str | None = None) -> list[dict[str, Any]]:
        """Dynamic program over one run of CJK characters.

        `run` is what the learner wrote; `shadow` is the same text normalised to
        simplified for dictionary matching. They are the same length, so a match
        found on the shadow is copied back onto the original characters.
        """
        shadow = run if shadow is None else shadow
        length = len(shadow)
        phrases = self._phrases_for(shadow)
        chars = self._chars_for(shadow)

        # best[i] = (unresolved_chars, segment_count, segmentation_from_i)
        best: list[tuple[int, int, list[dict[str, Any]]] | None] = [None] * (length + 1)
        best[length] = (0, 0, [])

        for start in range(length - 1, -1, -1):
            winner: tuple[int, int, list[dict[str, Any]]] | None = None
            for size in range(min(self.max_phrase_len, length - start), 0, -1):
                piece = shadow[start:start + size]          # for dictionary lookup
                written = run[start:start + size]           # for display
                tail = best[start + size]
                if tail is None:
                    continue

                if size >= 2:
                    syllables = phrases.get(piece)
                    if not syllables:
                        continue
                    segment = self._phrase_segment(piece, syllables, written)
                    unresolved = 0
                else:
                    readings = chars.get(piece)
                    segment = _char_segment(written, readings, key=piece)
                    unresolved = 0 if readings else 1

                candidate = (tail[0] + unresolved, tail[1] + 1, [segment, *tail[2]])
                # strict < keeps the longest phrase when the cost ties
                if winner is None or (candidate[0], candidate[1]) < (winner[0], winner[1]):
                    winner = candidate

            best[start] = winner

        result = best[0]
        if result:
            return result[2]
        return [_char_segment(run[i], chars.get(shadow[i]), key=shadow[i]) for i in range(length)]

    def _phrase_segment(self, phrase: str, syllables: str, written: str | None = None) -> dict[str, Any]:
        """Prefer the dictionary entry when the phrase is a known word.

        `phrase` is the simplified key used for lookup; `written` is the text the
        learner typed, which is what gets displayed.
        """
        display = written or phrase
        word = self.db.query_one(
            "SELECT id, simplified, traditional, pinyin, category, difficulty_level,"
            "       pinyin_plain, pinyin_numbers"
            "  FROM chinese_words WHERE simplified = ?",
            (phrase,),
        )
        if word is not None:
            return {
                "text": display,
                "traditional": word["traditional"],
                "pinyin": word["pinyin"],
                "pinyinNumbers": word["pinyin_numbers"],
                "pinyinPlain": word["pinyin_plain"],
                "source": "word",
                "level": word["difficulty_level"],
                "category": word["category"],
                "wordId": word["id"],
                "alternatives": [],
                "_key": phrase,
            }
        return {
            "text": display,
            "traditional": None,
            "pinyin": syllables,
            "pinyinNumbers": to_numbers(syllables),
            "pinyinPlain": to_plain(syllables),
            "source": "phrase",
            "level": None,
            "category": None,
            "wordId": None,
            "alternatives": [],
        }

    # ------------------------------------------------------------ lookups --

    def _phrases_for(self, run: str) -> dict[str, str]:
        """All dictionary phrases occurring in `run`, fetched in bulk.

        Cached phrases must be returned as well as freshly queried ones: the
        second lookup of the same text would otherwise see an empty result and
        silently fall back to character readings.
        """
        candidates: list[str] = []
        seen: set[str] = set()
        for start in range(len(run)):
            for size in range(2, min(self.max_phrase_len, len(run) - start) + 1):
                piece = run[start:start + size]
                if piece not in seen:
                    seen.add(piece)
                    candidates.append(piece)

        missing = [piece for piece in candidates if piece not in self._phrase_cache]
        for offset in range(0, len(missing), SQL_CHUNK):
            batch = missing[offset:offset + SQL_CHUNK]
            placeholders = ",".join("?" * len(batch))
            rows = self.db.query(
                f"SELECT phrase, syllables FROM phrase_pinyin WHERE phrase IN ({placeholders})",  # noqa: S608
                batch,
            )
            found = {row["phrase"]: row["syllables"] for row in rows}
            for piece in batch:
                self._phrase_cache[piece] = found.get(piece)

        if missing:
            self._trim(self._phrase_cache)

        return {
            piece: self._phrase_cache[piece]
            for piece in candidates
            if self._phrase_cache.get(piece)
        }

    def _chars_for(self, run: str) -> dict[str, list[str]]:
        wanted = [char for char in dict.fromkeys(run) if char not in self._char_cache]
        found: dict[str, list[str]] = {}
        for offset in range(0, len(wanted), SQL_CHUNK):
            batch = wanted[offset:offset + SQL_CHUNK]
            placeholders = ",".join("?" * len(batch))
            rows = self.db.query(
                f"SELECT char, readings FROM char_pinyin WHERE char IN ({placeholders})",  # noqa: S608
                batch,
            )
            for row in rows:
                try:
                    found[row["char"]] = json.loads(row["readings"])
                except (TypeError, ValueError):
                    found[row["char"]] = [row["readings"]]

        for char in wanted:
            self._char_cache[char] = found.get(char)

        return {char: readings for char, readings in self._char_cache.items() if readings is not None}

    @staticmethod
    def _trim(cache: dict, limit: int = 60000) -> None:
        if len(cache) > limit:
            for key in list(cache)[: limit // 2]:
                cache.pop(key, None)

    # ------------------------------------------------------------- sandhi --

    def _apply_sandhi(self, segments: list[dict[str, Any]]) -> None:
        """一 and 不 change tone before a fourth tone.

        pypinyin applies the same rule. Phrase entries already store the sandhi
        form, so this only affects characters resolved individually.
        """
        for index, segment in enumerate(segments):
            key = segment.get("_key") or segment["text"]
            if segment["source"] != "char" or key not in ("一", "不"):
                continue
            following = next(
                (seg for seg in segments[index + 1:] if seg.get("pinyin")),
                None,
            )
            next_tone = None
            if following:
                next_tone = decode_syllable(following["pinyin"].split()[0])[1]

            if key == "一":
                tone = 2 if next_tone == 4 else (4 if next_tone else 1)
                base = "yi"
            else:
                tone = 2 if next_tone == 4 else 4
                base = "bu"

            marked = encode_syllable(base, tone)
            segment["pinyin"] = marked
            segment["pinyinNumbers"] = to_numbers(marked)
            segment["pinyinPlain"] = to_plain(marked)


def _load_pypinyin():
    """Optional: use pypinyin when it is installed."""
    try:
        from pypinyin import Style, lazy_pinyin  # type: ignore
        return {"lazy_pinyin": lazy_pinyin, "Style": Style}
    except Exception:  # noqa: BLE001 - not installed, which is fine
        return None


@lru_cache(maxsize=4096)
def normalise_for_match(text: str, strict_u: bool = False) -> str:
    """Canonical comparison form, mirroring the browser grading engine."""
    parts = []
    for syllable in str(text).split():
        base, tone = decode_syllable(syllable)
        base = base.replace("ü", "v" if strict_u else "u")
        parts.append(f"{base}{tone or NEUTRAL_TONE}")
    return "".join(parts)


def iter_chunks(items: Iterable, size: int) -> Iterable[list]:
    batch: list = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
