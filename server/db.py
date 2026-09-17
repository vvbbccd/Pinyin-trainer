"""SQLite access layer.

Thread-safe by construction: every thread gets its own connection (the stdlib
``sqlite3`` module forbids sharing one connection across threads by default), and
writes are serialised through a lock. WAL mode keeps readers from blocking on the
writer, which matters because the dev server is threaded.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Sequence

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.schema_path = SCHEMA_PATH
        self._local = threading.local()
        self._write_lock = threading.RLock()
        self._initialised = False

    # ------------------------------------------------------------ connect --

    @property
    def connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(
                self.path,
                timeout=20,
                isolation_level=None,  # autocommit; transactions are explicit
                check_same_thread=True,
            )
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA busy_timeout = 20000")
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ------------------------------------------------------------- schema --

    def init_schema(self) -> None:
        with self._write_lock:
            self.connection.executescript(self.schema_path.read_text(encoding="utf-8"))
            self._initialised = True

    @property
    def initialised(self) -> bool:
        return self._initialised

    def table_exists(self, name: str) -> bool:
        row = self.query_one(
            "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
            (name,),
        )
        return row is not None

    # ------------------------------------------------------------ reading --

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        return list(self.connection.execute(sql, params).fetchall())

    def query_one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        return self.connection.execute(sql, params).fetchone()

    def scalar(self, sql: str, params: Sequence[Any] = (), default: Any = None) -> Any:
        row = self.query_one(sql, params)
        if row is None:
            return default
        value = row[0]
        return default if value is None else value

    # ------------------------------------------------------------ writing --

    def execute(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        with self._write_lock:
            return self.connection.execute(sql, params)

    def execute_many(self, sql: str, rows: Iterable[Sequence[Any]]) -> None:
        with self._write_lock:
            self.connection.executemany(sql, rows)

    def insert(self, sql: str, params: Sequence[Any] = ()) -> int:
        cursor = self.execute(sql, params)
        return int(cursor.lastrowid or 0)

    @contextmanager
    def transaction(self):
        """Explicit transaction. Nested use joins the outer one."""
        conn = self.connection
        if getattr(self._local, "in_tx", False):
            yield conn
            return
        with self._write_lock:
            self._local.in_tx = True
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except Exception:
                conn.execute("ROLLBACK")
                raise
            else:
                conn.execute("COMMIT")
            finally:
                self._local.in_tx = False

    # ----------------------------------------------------------- bulk load --

    def bulk_insert(self, sql: str, rows: Iterable[Sequence[Any]], chunk: int = 5000) -> int:
        """Fast path for seeding: one transaction, batched executemany."""
        total = 0
        batch: list[Sequence[Any]] = []
        with self.transaction():
            for row in rows:
                batch.append(row)
                if len(batch) >= chunk:
                    self.connection.executemany(sql, batch)
                    total += len(batch)
                    batch.clear()
            if batch:
                self.connection.executemany(sql, batch)
                total += len(batch)
        return total

    # -------------------------------------------------------------- stats --

    def stats(self) -> dict[str, int]:
        counts = {}
        for table in (
            "users", "chinese_words", "training_sessions", "training_answers",
            "user_word_progress", "saved_words", "lookup_history", "user_settings",
            "phrase_pinyin", "char_pinyin", "script_map",
        ):
            if self.table_exists(table):
                counts[table] = self.scalar(f"SELECT COUNT(*) FROM {table}", default=0)  # noqa: S608
        return counts
