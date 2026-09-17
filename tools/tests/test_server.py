"""Backend tests: pinyin engine units + REST API integration.

Runs a real WSGI server on a random port against a throwaway copy of the
database, and talks to it over HTTP. No third-party dependencies.

Run:  python tools/tests/test_server.py        (or: npm run test:server)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from server.__main__ import create_server  # noqa: E402
from server.pinyin_engine import (  # noqa: E402
    decode_syllable, encode_syllable, to_marks, to_numbers, to_plain,
)

DB_SOURCE = ROOT / "var" / "trainer.db"

_failures: list[str] = []


def enc(value) -> str:
    """ASCII-escape CJK so the suite is readable on any console codepage."""
    return str(value).encode("ascii", "backslashreplace").decode()


class EngineTests(unittest.TestCase):
    """Pure conversions - no database needed."""

    def test_decode_syllable(self):
        self.assertEqual(decode_syllable("xué"), ("xue", 2))
        self.assertEqual(decode_syllable("xue2"), ("xue", 2))
        self.assertEqual(decode_syllable("men"), ("men", None))
        self.assertEqual(decode_syllable("men5"), ("men", None))
        self.assertEqual(decode_syllable("lǜ"), ("lü", 4))
        self.assertEqual(decode_syllable("lv4"), ("lü", 4))

    def test_encode_syllable_mark_placement(self):
        self.assertEqual(encode_syllable("liu", 2), "liú")
        self.assertEqual(encode_syllable("gui", 4), "guì")
        self.assertEqual(encode_syllable("hao", 3), "hǎo")
        self.assertEqual(encode_syllable("xue", 2), "xué")
        self.assertEqual(encode_syllable("shuo", 1), "shuō")
        self.assertEqual(encode_syllable("nü", 3), "nǚ")
        self.assertEqual(encode_syllable("men", None), "men")

    def test_number_and_plain_forms(self):
        self.assertEqual(to_numbers("xué xiào"), "xue2xiao4")
        self.assertEqual(to_numbers("xue2xiao4"), "xue2xiao4", "accepts its own output")
        self.assertEqual(to_numbers("péng you"), "peng2you5")
        self.assertEqual(to_numbers("lǜ sè"), "lv4se4")
        self.assertEqual(to_plain("xué xiào"), "xuexiao")
        self.assertEqual(to_plain("lǜ sè"), "luse")
        self.assertEqual(to_plain("nǚ ér"), "nuer")
        self.assertEqual(to_marks("xue2xiao4"), "xué xiào")
        self.assertEqual(to_marks("xue2-xiao4"), "xué xiào")


class ApiTests(unittest.TestCase):
    """End-to-end HTTP tests against a real server process."""

    @classmethod
    def setUpClass(cls):
        # Scratch lives inside the workspace on purpose: sandboxes often block the
        # system temp directory, and tempfile.mkdtemp() creates a directory mode
        # that some of them refuse to write into, so the run directory is made
        # explicitly instead.
        scratch = ROOT / ".tmp" / "api-test"
        scratch.mkdir(parents=True, exist_ok=True)
        cls.tmp = scratch / f"run-{os.urandom(4).hex()}"
        cls.tmp.mkdir(parents=True, exist_ok=True)
        cls.db_path = cls.tmp / "test.db"
        if DB_SOURCE.exists():
            shutil.copy2(DB_SOURCE, cls.db_path)
        else:
            sys.path.insert(0, str(ROOT / "tools"))
            import build_database  # noqa: PLC0415
            build_database.main(["--db", str(cls.db_path), "--force"])

        cls.server = create_server("127.0.0.1", 0, cls.db_path, ROOT)
        cls.port = cls.server.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ------------------------------------------------------------ helpers --

    def request(self, method, path, payload=None, headers=None):
        url = f"{self.base}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
                return response.status, json.loads(body) if body else None, dict(response.headers)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8")
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = {"raw": body}
            headers = dict(error.headers)
            error.close()
            return error.code, parsed, headers

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, payload):
        return self.request("POST", path, payload)

    # ------------------------------------------------------- meta/health --

    def test_health(self):
        status, body, headers = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertIn("version", body)
        self.assertGreater(body["counts"]["chinese_words"], 1000)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_meta_lists_levels_and_categories(self):
        status, body, _ = self.get("/api/meta")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["levels"]), 5)
        self.assertTrue(all("count" in level for level in body["levels"]))
        self.assertTrue(any(item["id"] == "noun" for item in body["categories"]))
        self.assertGreater(body["words"], 1000)

    def test_me_includes_progress(self):
        status, body, _ = self.get("/api/users/me")
        self.assertEqual(status, 200)
        self.assertEqual(body["username"], "local")
        self.assertIn("progress", body)

    # -------------------------------------------------------------- words --

    def test_list_words_filtered(self):
        status, body, _ = self.get("/api/words?levels=1&limit=5")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["words"]), 5)
        self.assertTrue(all(word["lv"] == 1 for word in body["words"]))
        self.assertGreater(body["total"], 5)
        first = body["words"][0]
        for key in ("id", "s", "p", "pinyinPlain", "pinyinNumbers", "r", "c", "lv"):
            self.assertIn(key, first)
        self.assertTrue(first["p"], "word carries a tone-marked reading")
        self.assertTrue(first["pinyinNumbers"][-1].isdigit(), "numbers form ends in a tone digit")

    def test_list_words_search(self):
        status, body, _ = self.get("/api/words?search=xue&limit=10")
        self.assertEqual(status, 200)
        self.assertGreater(len(body["words"]), 0)

    def test_category_filter(self):
        status, body, _ = self.get("/api/words?categories=verb&limit=10")
        self.assertEqual(status, 200)
        self.assertTrue(all(word["c"] == "verb" for word in body["words"]))

    def test_random_words(self):
        status, body, _ = self.get("/api/words/random?count=8&levels=1,2&focusWeak=false")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["words"]), 8)
        self.assertEqual(len({word["s"] for word in body["words"]}), 8, "no duplicates")

    def test_get_word_by_id(self):
        _, listing, _ = self.get("/api/words?limit=1")
        word_id = listing["words"][0]["id"]
        status, body, _ = self.get(f"/api/words/{word_id}")
        self.assertEqual(status, 200)
        self.assertEqual(body["word"]["id"], word_id)

    def test_missing_word_is_404(self):
        status, body, _ = self.get("/api/words/999999")
        self.assertEqual(status, 404)
        self.assertEqual(body["code"], "not_found")

    # ------------------------------------------------------------- lookup --

    def test_lookup_known_word(self):
        status, body, _ = self.post("/api/lookup", {"text": "学校"})
        self.assertEqual(status, 200)
        self.assertEqual(body["segments"][0]["source"], "word")
        self.assertEqual(body["segments"][0]["pinyin"], "xué xiào")
        self.assertEqual(body["pinyinNumbers"].replace(" ", ""), "xue2xiao4")
        self.assertIsNotNone(body["segments"][0]["wordId"])
        self.assertFalse(body["hasFallback"])

    def test_lookup_sentence(self):
        status, body, _ = self.post("/api/lookup", {"text": "我喜欢学习汉语"})
        self.assertEqual(status, 200)
        # 喜欢 takes a neutral tone on the second syllable, and the phrase table
        # knows that; a character-only lookup would wrongly give "huān".
        self.assertEqual(body["pinyin"], "wǒ xǐ huan xué xí hàn yǔ")
        self.assertGreaterEqual(len(body["segments"]), 4)

    def test_lookup_resolves_polyphones(self):
        """The whole point of the phrase table: context-dependent readings."""
        cases = {
            "银行": "háng",     # bank   - not xíng
            "行走": "xíng",     # walk
            "音乐": "yuè",      # music  - not lè
            "快乐": "lè",       # happy
            "重庆": "chóng",    # Chongqing - not zhòng
            "重要": "zhòng",    # important
            "头发": "fà",       # hair   - not fā
            "发现": "fā",       # discover
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                status, body, _ = self.post("/api/lookup", {"text": text, "record": False})
                self.assertEqual(status, 200)
                self.assertIn(expected, body["pinyin"],
                              f"{enc(text)} -> {enc(body['pinyin'])} (want {expected})")

    def test_lookup_traditional_input_resolves_polyphones(self):
        """Traditional input is normalised to simplified before matching the word
        and phrase tables, so polyphones still resolve from context - while the
        segments keep the characters the learner actually typed."""
        cases = {
            "銀行": "háng",    # bank: 行 must be háng, not xíng
            "音樂": "yuè",     # music: 乐 must be yuè, not lè
            "重慶": "chóng",   # Chongqing: 重 must be chóng, not zhòng
            "頭髮": "fà",      # hair: 发 must be fà, not fā
            "還是": "hái",     # still: 还 must be hái, not huán
            "數學": "shù",     # maths: 数 must be shù, not shǔ
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                status, body, _ = self.post("/api/lookup", {"text": text, "record": False})
                self.assertEqual(status, 200)
                self.assertIn(expected, body["pinyin"],
                              f"{enc(text)} -> {enc(body['pinyin'])} (want {expected})")
                self.assertFalse(body["hasUnknown"], f"{enc(text)} reported unknown characters")
                joined = "".join(seg["text"] for seg in body["segments"])
                self.assertEqual(joined, text, "the learner's own characters must be preserved")

    def test_lookup_handles_multiple_traditional_variants(self):
        """One simplified character can map to several traditional forms
        (发 -> 發 and 髮); the lookup direction must cover all of them, not only
        the variant chosen for display."""
        status, body, _ = self.post("/api/lookup", {"text": "頭髮", "record": False})
        self.assertEqual(status, 200)
        self.assertEqual(body["pinyin"], "tóu fà", "髮 must normalise back to 发")

        status, body, _ = self.post("/api/lookup", {"text": "裏面", "record": False})
        self.assertEqual(status, 200)
        self.assertIn("lǐ", body["pinyin"], f"裏 must normalise back to 里: {enc(body['pinyin'])}")

    def test_lookup_handles_taiwan_forms(self):
        """為 and 裡 are Taiwan/Hong Kong forms that OpenCC keeps in a separate
        dictionary (TWVariants); they are far too common to leave unresolved."""
        cases = {"為": "wèi", "裡面": "lǐ", "為什麼": "wèi"}
        for text, expected in cases.items():
            with self.subTest(text=text):
                status, body, _ = self.post("/api/lookup", {"text": text, "record": False})
                self.assertEqual(status, 200)
                self.assertFalse(body["hasUnknown"], f"{enc(text)} has unknown characters")
                self.assertIn(expected, body["pinyin"],
                              f"{enc(text)} -> {enc(body['pinyin'])} (want {expected})")

    def test_script_map_is_seeded(self):
        counts = self.get("/api/health")[1]["counts"]
        self.assertGreater(counts.get("script_map", 0), 1000, "script_map must be populated")

    def test_lookup_mixed_text(self):
        status, body, _ = self.post("/api/lookup", {"text": "A学校B", "record": False})
        self.assertEqual(status, 200)
        sources = [segment["source"] for segment in body["segments"]]
        self.assertEqual(sources[0], "literal")
        self.assertEqual(sources[-1], "literal")
        self.assertIn("word", sources)

    def test_lookup_char_fallback_is_flagged(self):
        status, body, _ = self.post("/api/lookup", {"text": "龘", "record": False})
        self.assertEqual(status, 200)
        self.assertTrue(body["hasFallback"] or body["hasUnknown"])

    def test_lookup_rejects_empty(self):
        status, body, _ = self.post("/api/lookup", {"text": "   "})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "bad_request")

    def test_lookup_is_recorded_in_history(self):
        self.post("/api/lookup", {"text": "汉语"})
        _, body, _ = self.get("/api/library/history")
        self.assertTrue(any(item["query"] == "汉语" for item in body["history"]))

    # ------------------------------------------------------------ sessions --

    def _session_payload(self, session_id, correct_count=2, wrong_count=1):
        answers = []
        for index in range(correct_count):
            answers.append({
                "wordId": index + 1, "word": "同学", "userAnswer": "tong2xue2",
                "expected": "tóng xué", "isCorrect": True, "responseTimeMs": 1200 + index * 100,
                "at": 1_700_000_000_000 + index,
            })
        for index in range(wrong_count):
            answers.append({
                "wordId": 5, "word": "朋友", "userAnswer": "peng2you3",
                "expected": "péng you", "isCorrect": False, "skipped": False, "hintUsed": False,
                "responseTimeMs": 3000, "at": 1_700_000_000_500 + index,
            })
        return {
            "id": session_id,
            "startedAt": 1_700_000_000_000,
            "finishedAt": 1_700_000_030_000,
            "config": {"levels": [1], "requireTones": True},
            "answers": answers,
        }

    def test_session_lifecycle(self):
        payload = self._session_payload("test-session-1")
        status, body, _ = self.post("/api/sessions", payload)
        self.assertEqual(status, 201)
        session = body["session"]
        self.assertEqual(session["id"], "test-session-1")
        self.assertEqual(session["total"], 3)
        self.assertEqual(session["correct"], 2)
        self.assertAlmostEqual(session["accuracy"], 2 / 3, places=4)
        self.assertGreater(session["avgResponseMs"], 0)
        self.assertGreater(session["charsPerMinute"], 0)
        self.assertEqual(len(session["answers"]), 3)
        self.assertTrue(session["progressUpdates"])

        status, body, _ = self.get("/api/sessions/test-session-1")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["session"]["answers"]), 3)
        self.assertEqual(body["session"]["config"]["requireTones"], True)

        _, listing, _ = self.get("/api/sessions")
        self.assertTrue(any(item["id"] == "test-session-1" for item in listing["sessions"]))

        status, _, _ = self.request("DELETE", "/api/sessions/test-session-1")
        self.assertEqual(status, 200)
        status, _, _ = self.get("/api/sessions/test-session-1")
        self.assertEqual(status, 404)

    def test_session_save_is_idempotent(self):
        payload = self._session_payload("test-session-idem")
        self.post("/api/sessions", payload)
        self.post("/api/sessions", payload)
        _, body, _ = self.get("/api/sessions/test-session-idem")
        self.assertEqual(len(body["session"]["answers"]), 3, "answers must not be duplicated")
        self.request("DELETE", "/api/sessions/test-session-idem")

    def test_session_updates_word_progress(self):
        before = self.get("/api/progress")[1]["summary"]["attempts"]
        self.post("/api/sessions", self._session_payload("test-session-progress"))
        after = self.get("/api/progress")[1]["summary"]
        self.assertEqual(after["attempts"], before + 3)
        self.assertGreaterEqual(after["attempted"], 2)

        _, body, _ = self.get("/api/progress/words?filter=weak")
        weak = [item["simplified"] for item in body["words"]]
        self.assertIn("朋友", weak, f"the missed word should be weak: {enc(weak)}")

        self.request("DELETE", "/api/sessions/test-session-progress")

    def test_session_requires_id(self):
        status, body, _ = self.post("/api/sessions", {"answers": []})
        self.assertEqual(status, 400)

    def test_progress_map_hydration(self):
        """The client hydrates its whole progress map from this endpoint."""
        self.post("/api/sessions", self._session_payload("test-session-map"))
        status, body, _ = self.get("/api/progress/map")
        self.assertEqual(status, 200)
        self.assertIn("同学", body["progress"], "practised word missing from the map")
        entry = body["progress"]["同学"]
        for key in ("wordId", "simplified", "traditional", "pinyin",
                    "attempts", "correct", "lastAttempt", "mastery"):
            self.assertIn(key, entry)
        self.request("DELETE", "/api/sessions/test-session-map")

    def test_progress_summary_shape(self):
        _, body, _ = self.get("/api/progress")
        summary = body["summary"]
        for key in ("attempted", "attempts", "correct", "mastered", "weak", "totalWords", "levels"):
            self.assertIn(key, summary)
        self.assertEqual(len(summary["levels"]), 5)

    # ------------------------------------------------------------- library --

    def test_saved_words_round_trip(self):
        status, body, _ = self.post("/api/library/saved", {"simplified": "学校", "pinyin": "xué xiào"})
        self.assertEqual(status, 201)
        self.assertEqual(body["word"]["s"], "学校")
        self.assertEqual(body["word"]["t"], "學校", "traditional should be filled from the dictionary")

        _, body, _ = self.get("/api/library/saved")
        self.assertTrue(any(item["s"] == "学校" for item in body["words"]))

        status, body, _ = self.request("DELETE", "/api/library/saved?simplified=%E5%AD%A6%E6%A0%A1")
        self.assertEqual(status, 200)
        self.assertEqual(body["deleted"], 1)

    def test_saved_words_rejects_missing_field(self):
        status, body, _ = self.post("/api/library/saved", {"pinyin": "x"})
        self.assertEqual(status, 400)

    def test_history_clear(self):
        self.post("/api/library/history", {"query": "你好", "results": []})
        _, body, _ = self.get("/api/library/history")
        self.assertTrue(any(item["query"] == "你好" for item in body["history"]))
        status, body, _ = self.request("DELETE", "/api/library/history")
        self.assertEqual(status, 200)
        _, body, _ = self.get("/api/library/history")
        self.assertEqual(body["count"], 0)

    # ------------------------------------------------------------ settings --

    def test_settings_round_trip(self):
        payload = {"settings": {"theme": "light", "requireTones": False, "levels": [1, 2]}}
        status, body, _ = self.request("PUT", "/api/settings", payload)
        self.assertEqual(status, 200)
        self.assertEqual(body["settings"]["theme"], "light")
        _, body, _ = self.get("/api/settings")
        self.assertEqual(body["settings"]["requireTones"], False)
        self.assertEqual(body["settings"]["levels"], [1, 2])

    def test_settings_rejects_array(self):
        status, body, _ = self.request("PUT", "/api/settings", {"settings": [1, 2]})
        self.assertEqual(status, 400)

    # ------------------------------------------------------------- routing --

    def test_unknown_endpoint_is_404(self):
        status, body, _ = self.get("/api/does-not-exist")
        self.assertEqual(status, 404)

    def test_wrong_method_is_405(self):
        status, body, _ = self.request("DELETE", "/api/words")
        self.assertEqual(status, 405)
        self.assertIn("GET", body["error"])

    def test_options_preflight(self):
        status, _, headers = self.request("OPTIONS", "/api/words")
        self.assertEqual(status, 204)
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))

    def test_head_has_no_body(self):
        request = urllib.request.Request(f"{self.base}/api/health", method="HEAD")
        with urllib.request.urlopen(request, timeout=20) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")

    # -------------------------------------------------------------- static --

    def test_serves_index_and_assets(self):
        for path, needle in (("/", b"<html"), ("/assets/js/pinyin.js", b"checkAnswer"),
                             ("/data/words.json", b'"words"')):
            with self.subTest(path=path):
                with urllib.request.urlopen(f"{self.base}{path}", timeout=20) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(needle, response.read())

    def test_index_etag_revalidation(self):
        with urllib.request.urlopen(f"{self.base}/", timeout=20) as response:
            etag = response.headers.get("ETag")
        self.assertTrue(etag)
        request = urllib.request.Request(f"{self.base}/", headers={"If-None-Match": etag})
        try:
            urllib.request.urlopen(request, timeout=20)
            self.fail("expected 304")
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 304)

    def test_private_paths_are_not_served(self):
        for path in ("/var/trainer.db", "/server/api.py", "/tools/build_database.py", "/.tmp/pinyin.txt"):
            with self.subTest(path=path):
                status, _, _ = self.get(path)
                self.assertEqual(status, 404, f"{path} must not be served")

    def test_path_traversal_blocked(self):
        for path in ("/../server/api.py", "/assets/../../server/db.py", "/%2e%2e/server/db.py"):
            with self.subTest(path=path):
                status, _, _ = self.get(path)
                self.assertIn(status, (400, 403, 404))


def load_tests(loader, tests, pattern):  # noqa: ARG001
    return tests


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if not result.wasSuccessful():
        sys.exit(1)
    sys.exit(0)
