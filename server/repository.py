"""Data access: every SQL statement the API needs, plus JSON serialisers.

Serialised shapes deliberately match what the browser client already consumes
(camelCase, epoch-millisecond timestamps), so switching the frontend between
local storage and this API needs no changes in the view code.
"""

from __future__ import annotations

import json
import random
import time
from typing import Any, Iterable, Sequence

from .db import Database
from .pinyin_engine import PinyinEngine, to_numbers, to_plain

DEFAULT_USERNAME = "local"

MASTERED_THRESHOLD = 0.8
WEAK_THRESHOLD = 0.55

# Weights for the weak-word-aware sampler, mirroring the browser client.
WEIGHT_UNSEEN = 1.6
WEIGHT_WEAK = 4.0
WEIGHT_LEARNING = 1.4
WEIGHT_KNOWN = 0.7

LEVELS = (
    (1, "Foundations", "Greetings, pronouns and the highest-frequency characters."),
    (2, "Everyday", "Daily life: food, travel, study, work and feelings."),
    (3, "Common", "General vocabulary that shows up constantly in writing."),
    (4, "Wider", "Less frequent words, longer and more specific."),
    (5, "Advanced", "Lower-frequency words, idioms and proper nouns."),
)


def now_ms() -> int:
    return int(time.time() * 1000)


# ----------------------------------------------------------- serialisers ----

def word_to_json(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "s": row["simplified"],
        "t": row["traditional"],
        "p": row["pinyin"],
        "pinyinPlain": row["pinyin_plain"],
        "pinyinNumbers": row["pinyin_numbers"],
        "f": row["frequency"],
        "r": row["frequency_rank"],
        "c": row["category"],
        "lv": row["difficulty_level"],
    }


def progress_to_json(row) -> dict[str, Any]:
    return {
        "wordId": row["word_id"],
        "simplified": row["simplified"],
        "traditional": row["traditional"],
        "pinyin": row["pinyin"],
        "attempts": row["attempts"],
        "correct": row["correct_attempts"],
        "lastAttempt": row["last_attempt"],
        "mastery": row["mastery_score"],
    }


def answer_to_json(row) -> dict[str, Any]:
    return {
        "wordId": row["word_id"],
        "word": row["word_simplified"],
        "userAnswer": row["user_answer"],
        "expected": row["correct_answer"],
        "isCorrect": bool(row["is_correct"]),
        "skipped": bool(row["skipped"]),
        "hintUsed": bool(row["hint_used"]),
        "responseTimeMs": row["response_time_ms"],
        "level": row["difficulty_level"],
        "category": row["category"],
        "at": row["answered_at"],
    }


def session_to_json(row, answers: list | None = None) -> dict[str, Any]:
    try:
        config = json.loads(row["config"] or "{}")
    except (TypeError, ValueError):
        config = {}
    payload = {
        "id": row["id"],
        "userId": row["user_id"],
        "startedAt": row["started_at"],
        "finishedAt": row["finished_at"],
        "score": row["score"],
        "total": row["total_answers"],
        "correct": row["correct_answers"],
        "accuracy": row["accuracy"],
        "avgResponseMs": row["avg_response_ms"],
        "charsPerMinute": row["chars_per_minute"],
        "durationMs": row["duration_ms"],
        "config": config,
        "answers": [],
    }
    if answers is not None:
        payload["answers"] = [answer_to_json(answer) for answer in answers]
        payload["missed"] = [item["word"] for item in payload["answers"] if not item["isCorrect"]]
    return payload


# ----------------------------------------------------------- repository -----

class Repository:
    def __init__(self, db: Database):
        self.db = db
        self.engine = PinyinEngine(db)

    # ------------------------------------------------------------- users --

    def ensure_user(self, username: str = DEFAULT_USERNAME) -> int:
        row = self.db.query_one("SELECT id FROM users WHERE username = ?", (username,))
        if row is not None:
            return int(row["id"])
        return self.db.insert(
            "INSERT INTO users (username, display_name, created_at) VALUES (?, ?, ?)",
            (username, "Local learner", now_ms()),
        )

    def get_user(self, user_id: int):
        return self.db.query_one("SELECT * FROM users WHERE id = ?", (user_id,))

    # -------------------------------------------------------------- meta --

    def meta(self) -> dict[str, Any]:
        by_level = {
            int(row["difficulty_level"]): int(row["count"])
            for row in self.db.query(
                "SELECT difficulty_level, COUNT(*) AS count FROM chinese_words GROUP BY difficulty_level"
            )
        }
        by_category = [
            {"id": row["category"], "count": int(row["count"])}
            for row in self.db.query(
                "SELECT category, COUNT(*) AS count FROM chinese_words"
                " GROUP BY category ORDER BY count DESC"
            )
        ]
        return {
            "words": self.db.scalar("SELECT COUNT(*) FROM chinese_words", default=0),
            "characters": self.db.scalar("SELECT COUNT(*) FROM char_pinyin", default=0),
            "phrases": self.db.scalar("SELECT COUNT(*) FROM phrase_pinyin", default=0),
            "levels": [
                {"id": level, "name": name, "desc": desc, "count": by_level.get(level, 0)}
                for level, name, desc in LEVELS
            ],
            "categories": by_category,
            "lookupEngine": self.engine.source_label(),
            "lookupHasPhrases": self.engine.has_phrase_data(),
        }

    # ------------------------------------------------------------- words --

    def _word_filters(
        self, levels: Sequence[int] | None, categories: Sequence[str] | None, search: str | None,
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if levels:
            clauses.append(f"difficulty_level IN ({','.join('?' * len(levels))})")
            params.extend(levels)
        if categories:
            clauses.append(f"category IN ({','.join('?' * len(categories))})")
            params.extend(categories)
        if search:
            clauses.append("(simplified LIKE ? OR traditional LIKE ? OR pinyin LIKE ? OR pinyin_plain LIKE ?)")
            needle = f"%{search}%"
            params.extend([needle, needle, needle, needle])
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        return where, params

    def list_words(
        self,
        levels: Sequence[int] | None = None,
        categories: Sequence[str] | None = None,
        search: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        where, params = self._word_filters(levels, categories, search)
        total = int(self.db.scalar(f"SELECT COUNT(*) FROM chinese_words{where}", params, default=0))  # noqa: S608
        rows = self.db.query(
            f"SELECT * FROM chinese_words{where} ORDER BY frequency_rank LIMIT ? OFFSET ?",  # noqa: S608
            [*params, limit, offset],
        )
        return [word_to_json(row) for row in rows], total

    def get_word(self, word_id: int) -> dict | None:
        row = self.db.query_one("SELECT * FROM chinese_words WHERE id = ?", (word_id,))
        return word_to_json(row) if row else None

    def find_word(self, simplified: str) -> dict | None:
        row = self.db.query_one(
            "SELECT * FROM chinese_words WHERE simplified = ? OR traditional = ? LIMIT 1",
            (simplified, simplified),
        )
        return word_to_json(row) if row else None

    def random_words(
        self,
        count: int = 20,
        levels: Sequence[int] | None = None,
        categories: Sequence[str] | None = None,
        focus_weak: bool = True,
        user_id: int | None = None,
    ) -> list[dict]:
        where, params = self._word_filters(levels, categories, None)

        if not focus_weak or user_id is None:
            rows = self.db.query(
                f"SELECT * FROM chinese_words{where} ORDER BY RANDOM() LIMIT ?",  # noqa: S608
                [*params, count],
            )
            return [word_to_json(row) for row in rows]

        # Weak-word-aware sampling: pull the candidate rows with their mastery and
        # weight them in Python. The filter columns only exist on chinese_words,
        # so the unqualified names in `where` stay unambiguous after the join.
        rows = self.db.query(
            "SELECT w.*, p.mastery_score AS mastery, p.attempts AS attempts"
            "  FROM chinese_words w"
            "  LEFT JOIN user_word_progress p ON p.word_id = w.id AND p.user_id = ?"
            f"{where}",  # noqa: S608
            [user_id, *params],
        )
        if not rows:
            return []

        pool = list(rows)
        weights = []
        for row in pool:
            attempts = row["attempts"]
            mastery = row["mastery"]
            if attempts is None:
                weights.append(WEIGHT_UNSEEN)
            elif attempts >= 2 and (mastery or 0) < WEAK_THRESHOLD:
                weights.append(WEIGHT_WEAK)
            elif (mastery or 0) < MASTERED_THRESHOLD:
                weights.append(WEIGHT_LEARNING)
            else:
                weights.append(WEIGHT_KNOWN)

        chosen: list[dict] = []
        for _ in range(min(count, len(pool))):
            index = _weighted_pick(weights)
            chosen.append(word_to_json(pool.pop(index)))
            weights.pop(index)
        return chosen

    # ---------------------------------------------------------- progress --

    def record_outcome(self, user_id: int, word_id: int, is_correct: bool, when: int | None = None):
        """Update USER_WORD_PROGRESS with the same EWMA the client uses."""
        when = when or now_ms()
        row = self.db.query_one(
            "SELECT * FROM user_word_progress WHERE user_id = ? AND word_id = ?",
            (user_id, word_id),
        )
        if row is None:
            mastery = 0.75 if is_correct else 0.2
            self.db.execute(
                "INSERT INTO user_word_progress"
                " (user_id, word_id, attempts, correct_attempts, last_attempt, mastery_score)"
                " VALUES (?, ?, 1, ?, ?, ?)",
                (user_id, word_id, 1 if is_correct else 0, when, mastery),
            )
        else:
            mastery = row["mastery_score"] * 0.65 + (1.0 if is_correct else 0.0) * 0.35
            self.db.execute(
                "UPDATE user_word_progress"
                "   SET attempts = attempts + 1,"
                "       correct_attempts = correct_attempts + ?,"
                "       last_attempt = ?,"
                "       mastery_score = ?"
                " WHERE user_id = ? AND word_id = ?",
                (1 if is_correct else 0, when, mastery, user_id, word_id),
            )
        return self.db.query_one(
            "SELECT p.*, w.simplified, w.traditional, w.pinyin"
            "  FROM user_word_progress p JOIN chinese_words w ON w.id = p.word_id"
            " WHERE p.user_id = ? AND p.word_id = ?",
            (user_id, word_id),
        )

    def progress_summary(self, user_id: int) -> dict[str, Any]:
        total = int(self.db.scalar("SELECT COUNT(*) FROM chinese_words", default=0))
        row = self.db.query_one(
            "SELECT COUNT(*) AS practiced,"
            "       COALESCE(SUM(attempts), 0) AS attempts,"
            "       COALESCE(SUM(correct_attempts), 0) AS correct,"
            "       COALESCE(SUM(CASE WHEN mastery_score >= ? THEN 1 ELSE 0 END), 0) AS mastered,"
            "       COALESCE(SUM(CASE WHEN attempts >= 2 AND mastery_score < ? THEN 1 ELSE 0 END), 0) AS weak"
            "  FROM user_word_progress WHERE user_id = ?",
            (MASTERED_THRESHOLD, WEAK_THRESHOLD, user_id),
        )
        level_rows = {
            int(r["difficulty_level"]): r
            for r in self.db.query(
                "SELECT w.difficulty_level,"
                "       COUNT(*) AS attempted,"
                "       SUM(p.attempts) AS attempts,"
                "       SUM(p.correct_attempts) AS correct,"
                "       SUM(CASE WHEN p.mastery_score >= ? THEN 1 ELSE 0 END) AS mastered"
                "  FROM user_word_progress p JOIN chinese_words w ON w.id = p.word_id"
                " WHERE p.user_id = ? GROUP BY w.difficulty_level",
                (MASTERED_THRESHOLD, user_id),
            )
        }
        return {
            "attempted": int(row["practiced"] or 0),
            "attempts": int(row["attempts"] or 0),
            "correct": int(row["correct"] or 0),
            "mastered": int(row["mastered"] or 0),
            "weak": int(row["weak"] or 0),
            "totalWords": total,
            "levels": [
                {
                    "level": level,
                    "name": name,
                    "attempted": int((level_rows.get(level) or {"attempted": 0})["attempted"] or 0),
                    "attempts": int((level_rows.get(level) or {"attempts": 0})["attempts"] or 0),
                    "correct": int((level_rows.get(level) or {"correct": 0})["correct"] or 0),
                    "mastered": int((level_rows.get(level) or {"mastered": 0})["mastered"] or 0),
                }
                for level, name, _desc in LEVELS
            ],
        }

    def progress_words(self, user_id: int, which: str = "all", limit: int = 50) -> list[dict]:
        clauses = ["p.user_id = ?"]
        if which == "weak":
            clauses.append("p.attempts >= 2 AND p.mastery_score < 0.55")
        elif which == "mastered":
            clauses.append("p.mastery_score >= 0.8")
        order = "p.mastery_score ASC" if which == "weak" else "p.mastery_score DESC"
        rows = self.db.query(
            "SELECT p.*, w.simplified, w.traditional, w.pinyin, w.category, w.difficulty_level"
            "  FROM user_word_progress p JOIN chinese_words w ON w.id = p.word_id"
            f" WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ?",  # noqa: S608
            [user_id, limit],
        )
        output = []
        for row in rows:
            item = progress_to_json(row)
            item["level"] = row["difficulty_level"]
            item["category"] = row["category"]
            item["accuracy"] = (row["correct_attempts"] / row["attempts"]) if row["attempts"] else 0.0
            output.append(item)
        return output

    def progress_map(self, user_id: int) -> dict[str, dict]:
        """Whole progress table keyed by simplified form, for client hydration."""
        rows = self.db.query(
            "SELECT p.*, w.simplified, w.traditional, w.pinyin"
            "  FROM user_word_progress p JOIN chinese_words w ON w.id = p.word_id"
            " WHERE p.user_id = ?",
            (user_id,),
        )
        return {row["simplified"]: progress_to_json(row) for row in rows}

    def reset_progress(self, user_id: int) -> int:
        with self.db.transaction():
            deleted = self.db.connection.execute(
                "DELETE FROM user_word_progress WHERE user_id = ?", (user_id,)
            ).rowcount
            self.db.connection.execute(
                "DELETE FROM training_answers WHERE session_id IN"
                " (SELECT id FROM training_sessions WHERE user_id = ?)",
                (user_id,),
            )
            self.db.connection.execute("DELETE FROM training_sessions WHERE user_id = ?", (user_id,))
        return int(deleted or 0)

    # ---------------------------------------------------------- sessions --

    def save_session(self, user_id: int, payload: dict) -> dict[str, Any]:
        """Idempotent upsert of a finished session (client-generated id)."""
        session_id = str(payload.get("id") or "").strip()
        if not session_id:
            raise ValueError("session id is required")

        answers = payload.get("answers") or []
        total = len(answers)
        correct = sum(1 for answer in answers if answer.get("isCorrect"))
        started_at = int(payload.get("startedAt") or now_ms())
        finished_at = int(payload.get("finishedAt") or now_ms())
        duration = max(0, finished_at - started_at)
        chars = sum(len(str(answer.get("word") or "")) for answer in answers)
        total_response = sum(float(answer.get("responseTimeMs") or 0) for answer in answers)

        record = (
            session_id,
            user_id,
            started_at,
            finished_at,
            (correct / total) if total else 0.0,
            total,
            correct,
            (correct / total) if total else 0.0,
            (total_response / total) if total else 0.0,
            (chars / (duration / 60000)) if duration > 0 else 0.0,
            duration,
            json.dumps(payload.get("config") or {}, ensure_ascii=False),
            now_ms(),
            now_ms(),
        )

        word_ids: dict[str, int] = {}
        with self.db.transaction():
            self.db.connection.execute(
                "INSERT INTO training_sessions"
                " (id, user_id, started_at, finished_at, score, total_answers, correct_answers,"
                "  accuracy, avg_response_ms, chars_per_minute, duration_ms, config, created_at, synced_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT (id) DO UPDATE SET"
                "   finished_at = excluded.finished_at, score = excluded.score,"
                "   total_answers = excluded.total_answers, correct_answers = excluded.correct_answers,"
                "   accuracy = excluded.accuracy, avg_response_ms = excluded.avg_response_ms,"
                "   chars_per_minute = excluded.chars_per_minute, duration_ms = excluded.duration_ms,"
                "   config = excluded.config, synced_at = excluded.synced_at",
                record,
            )
            # re-syncing a session replaces its answers rather than duplicating them
            self.db.connection.execute("DELETE FROM training_answers WHERE session_id = ?", (session_id,))
            for answer in answers:
                simplified = str(answer.get("word") or "").strip()
                word_id = answer.get("wordId")
                if simplified not in word_ids:
                    row = self.db.query_one(
                        "SELECT id FROM chinese_words WHERE simplified = ? LIMIT 1", (simplified,)
                    )
                    word_ids[simplified] = int(row["id"]) if row else 0
                resolved = word_ids[simplified] or None
                if word_id and resolved is None:
                    resolved = int(word_id)
                self.db.connection.execute(
                    "INSERT INTO training_answers"
                    " (session_id, word_id, word_simplified, user_answer, correct_answer, is_correct,"
                    "  skipped, hint_used, response_time_ms, difficulty_level, category, answered_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        session_id,
                        resolved,
                        simplified,
                        str(answer.get("userAnswer") or ""),
                        str(answer.get("expected") or ""),
                        1 if answer.get("isCorrect") else 0,
                        1 if answer.get("skipped") else 0,
                        1 if answer.get("hintUsed") else 0,
                        int(float(answer.get("responseTimeMs") or 0)),
                        answer.get("level"),
                        answer.get("category"),
                        int(answer.get("at") or finished_at),
                    ),
                )

        # progress updates happen after the session is durable
        updated = []
        for answer in answers:
            word_id = word_ids.get(str(answer.get("word") or "").strip())
            if not word_id:
                continue
            row = self.record_outcome(
                user_id, word_id, bool(answer.get("isCorrect")), int(answer.get("at") or finished_at)
            )
            if row is not None:
                updated.append(progress_to_json(row))

        session = self.get_session(session_id, user_id)
        session["progressUpdates"] = updated
        return session

    def list_sessions(self, user_id: int, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self.db.query(
            "SELECT * FROM training_sessions WHERE user_id = ?"
            " ORDER BY finished_at DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset),
        )
        sessions = []
        for row in rows:
            session = session_to_json(row)
            session["answers"] = [
                answer_to_json(answer)
                for answer in self.db.query(
                    "SELECT * FROM training_answers WHERE session_id = ? ORDER BY id", (row["id"],)
                )
            ]
            sessions.append(session)
        return sessions

    def get_session(self, session_id: str, user_id: int) -> dict | None:
        row = self.db.query_one(
            "SELECT * FROM training_sessions WHERE id = ? AND user_id = ?", (session_id, user_id)
        )
        if row is None:
            return None
        answers = self.db.query(
            "SELECT * FROM training_answers WHERE session_id = ? ORDER BY id", (session_id,)
        )
        return session_to_json(row, list(answers))

    def delete_session(self, session_id: str, user_id: int) -> bool:
        cursor = self.db.execute(
            "DELETE FROM training_sessions WHERE id = ? AND user_id = ?", (session_id, user_id)
        )
        return bool(cursor.rowcount)

    def session_stats(self, user_id: int) -> dict[str, Any]:
        row = self.db.query_one(
            "SELECT COUNT(*) AS sessions,"
            "       COALESCE(SUM(total_answers), 0) AS answered,"
            "       COALESCE(SUM(correct_answers), 0) AS correct,"
            "       COALESCE(SUM(duration_ms), 0) AS duration"
            "  FROM training_sessions WHERE user_id = ?",
            (user_id,),
        )
        return {
            "sessions": int(row["sessions"] or 0),
            "answered": int(row["answered"] or 0),
            "correct": int(row["correct"] or 0),
            "durationMs": int(row["duration"] or 0),
        }

    # ----------------------------------------------------------- library --

    def list_saved(self, user_id: int, limit: int = 200) -> list[dict]:
        rows = self.db.query(
            "SELECT * FROM saved_words WHERE user_id = ? ORDER BY saved_at DESC LIMIT ?",
            (user_id, limit),
        )
        return [
            {
                "s": row["simplified"],
                "t": row["traditional"],
                "p": row["pinyin"],
                "wordId": row["word_id"],
                "savedAt": row["saved_at"],
            }
            for row in rows
        ]

    def add_saved(self, user_id: int, simplified: str, pinyin: str, traditional: str | None = None):
        word = self.find_word(simplified)
        if word:
            traditional = traditional or word["t"]
            pinyin = pinyin or word["p"]
        self.db.execute(
            "INSERT INTO saved_words (user_id, word_id, simplified, traditional, pinyin, saved_at)"
            " VALUES (?,?,?,?,?,?) ON CONFLICT (user_id, simplified, pinyin) DO NOTHING",
            (user_id, word["id"] if word else None, simplified, traditional, pinyin, now_ms()),
        )
        row = self.db.query_one(
            "SELECT * FROM saved_words WHERE user_id = ? AND simplified = ? AND pinyin = ?",
            (user_id, simplified, pinyin),
        )
        return {
            "s": row["simplified"],
            "t": row["traditional"],
            "p": row["pinyin"],
            "wordId": row["word_id"],
            "savedAt": row["saved_at"],
        }

    def remove_saved(self, user_id: int, simplified: str, pinyin: str | None = None) -> int:
        if pinyin:
            cursor = self.db.execute(
                "DELETE FROM saved_words WHERE user_id = ? AND simplified = ? AND pinyin = ?",
                (user_id, simplified, pinyin),
            )
        else:
            cursor = self.db.execute(
                "DELETE FROM saved_words WHERE user_id = ? AND simplified = ?", (user_id, simplified)
            )
        return int(cursor.rowcount or 0)

    def list_history(self, user_id: int, limit: int = 60) -> list[dict]:
        rows = self.db.query(
            "SELECT * FROM lookup_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
        output = []
        for row in rows:
            try:
                results = json.loads(row["result"] or "[]")
            except (TypeError, ValueError):
                results = []
            output.append({"query": row["query"], "at": row["created_at"], "results": results})
        return output

    def add_history(self, user_id: int, query: str, results: list | None = None) -> None:
        text = str(query or "").strip()
        if not text:
            return
        with self.db.transaction():
            # one entry per distinct query, newest first
            self.db.connection.execute(
                "DELETE FROM lookup_history WHERE user_id = ? AND query = ?", (user_id, text)
            )
            self.db.connection.execute(
                "INSERT INTO lookup_history (user_id, query, result, source, created_at)"
                " VALUES (?,?,?,?,?)",
                (user_id, text, json.dumps(results or [], ensure_ascii=False),
                 self.engine.source_label(), now_ms()),
            )

    def clear_history(self, user_id: int) -> int:
        cursor = self.db.execute("DELETE FROM lookup_history WHERE user_id = ?", (user_id,))
        return int(cursor.rowcount or 0)

    # ---------------------------------------------------------- settings --

    def get_settings(self, user_id: int) -> dict | None:
        row = self.db.query_one("SELECT data FROM user_settings WHERE user_id = ?", (user_id,))
        if row is None:
            return None
        try:
            return json.loads(row["data"] or "{}")
        except (TypeError, ValueError):
            return None

    def put_settings(self, user_id: int, data: dict) -> dict:
        self.db.execute(
            "INSERT INTO user_settings (user_id, data, updated_at) VALUES (?,?,?)"
            " ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (user_id, json.dumps(data or {}, ensure_ascii=False), now_ms()),
        )
        return data or {}

    # ------------------------------------------------------------ lookup --

    def lookup(self, text: str) -> dict[str, Any]:
        return self.engine.lookup(text)


def _weighted_pick(weights: Sequence[float]) -> int:
    total = sum(weights)
    if total <= 0:
        return random.randrange(len(weights))
    roll = random.random() * total
    for index, weight in enumerate(weights):
        roll -= weight
        if roll <= 0:
            return index
    return len(weights) - 1
