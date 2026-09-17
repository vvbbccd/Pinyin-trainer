-- ============================================================================
--  Chinese Pinyin Typing Trainer — database schema (SQLite)
--
--  Mirrors the classes in basic.txt:
--      CHINESE_WORD          -> chinese_words
--      TRAINING_SESSION      -> training_sessions
--      TRAINING_ANSWER       -> training_answers
--      USER_WORD_PROGRESS    -> user_word_progress
--
--  Documented deviations from basic.txt (see README, "Database schema"):
--    * users exists so TRAINING_SESSION.user_id has something to point at.
--    * chinese_words gained category, difficulty_level, pinyin_plain,
--      pinyin_numbers and syllable_count — all derived at build time so the
--      API never has to recompute pinyin formatting.
--    * training_sessions stores derived totals (accuracy, avg_response_ms,
--      chars_per_minute) and a config JSON blob; its id is a client-generated
--      TEXT id so an offline session can be replayed idempotently.
--    * training_answers gained skipped, hint_used, level and category, and its
--      word_id is nullable with word_simplified as a fallback so an answer is
--      never dropped when a word is missing from the dictionary.
--    * user_word_progress matches USER_WORD_PROGRESS exactly (attempts,
--      correct_attempts, last_attempt, mastery_score) plus a unique key per user.
--    * saved_words and lookup_history back the Library, which basic.txt did not
--      model as tables.
--    * phrase_pinyin / char_pinyin make the pinyin lookup data-driven instead of
--      hard-coded: phrase_pinyin holds ~412k context-correct readings.
--
--  Timestamps are INTEGER milliseconds since the Unix epoch, matching the
--  JavaScript client, so no timezone conversion is needed anywhere.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users ----

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

-- -------------------------------------------------------- chinese_words ----

CREATE TABLE IF NOT EXISTS chinese_words (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  simplified       TEXT    NOT NULL UNIQUE,
  traditional      TEXT,
  pinyin           TEXT    NOT NULL,            -- tone marks:  xué xiào
  pinyin_plain     TEXT    NOT NULL,            -- no tones:    xuexiao
  pinyin_numbers   TEXT    NOT NULL,            -- tone digits: xue2xiao4
  syllables        TEXT    NOT NULL,            -- JSON array of tone-marked syllables
  frequency        INTEGER NOT NULL DEFAULT 0,  -- raw corpus frequency
  frequency_rank   INTEGER NOT NULL,            -- 1 = most frequent
  category         TEXT    NOT NULL DEFAULT 'other',
  difficulty_level INTEGER NOT NULL DEFAULT 3,  -- 1..5
  syllable_count   INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_words_level    ON chinese_words (difficulty_level);
CREATE INDEX IF NOT EXISTS idx_words_category ON chinese_words (category);
CREATE INDEX IF NOT EXISTS idx_words_rank     ON chinese_words (frequency_rank);
CREATE INDEX IF NOT EXISTS idx_words_trad     ON chinese_words (traditional);

-- ----------------------------------------------------- training_sessions ----

CREATE TABLE IF NOT EXISTS training_sessions (
  id               TEXT    PRIMARY KEY,         -- client-generated, opaque
  user_id          INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NOT NULL,
  score            REAL    NOT NULL DEFAULT 0,  -- correct / total, 0..1
  total_answers    INTEGER NOT NULL DEFAULT 0,
  correct_answers  INTEGER NOT NULL DEFAULT 0,
  accuracy         REAL    NOT NULL DEFAULT 0,
  avg_response_ms  REAL    NOT NULL DEFAULT 0,
  chars_per_minute REAL    NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  config           TEXT    NOT NULL DEFAULT '{}',  -- JSON: levels, categories, strictness…
  created_at       INTEGER NOT NULL,
  synced_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_time ON training_sessions (user_id, finished_at DESC);

-- ------------------------------------------------------ training_answers ----

CREATE TABLE IF NOT EXISTS training_answers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT    NOT NULL REFERENCES training_sessions (id) ON DELETE CASCADE,
  word_id          INTEGER REFERENCES chinese_words (id) ON DELETE SET NULL,
  word_simplified  TEXT    NOT NULL,
  user_answer      TEXT    NOT NULL DEFAULT '',
  correct_answer   TEXT    NOT NULL,
  is_correct       INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  hint_used        INTEGER NOT NULL DEFAULT 0,
  response_time_ms INTEGER NOT NULL DEFAULT 0,
  difficulty_level INTEGER,
  category         TEXT,
  answered_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_answers_session ON training_answers (session_id);
CREATE INDEX IF NOT EXISTS idx_answers_word    ON training_answers (word_id);

-- -------------------------------------------------- user_word_progress -----

CREATE TABLE IF NOT EXISTS user_word_progress (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  word_id          INTEGER NOT NULL REFERENCES chinese_words (id) ON DELETE CASCADE,
  attempts         INTEGER NOT NULL DEFAULT 0,
  correct_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt     INTEGER,
  mastery_score    REAL    NOT NULL DEFAULT 0.5,
  UNIQUE (user_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_user_mastery ON user_word_progress (user_id, mastery_score);

-- --------------------------------------------------------------- library ---

CREATE TABLE IF NOT EXISTS saved_words (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  word_id      INTEGER REFERENCES chinese_words (id) ON DELETE SET NULL,
  simplified   TEXT    NOT NULL,
  traditional  TEXT,
  pinyin       TEXT    NOT NULL,
  saved_at     INTEGER NOT NULL,
  UNIQUE (user_id, simplified, pinyin)
);

CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_words (user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS lookup_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  query       TEXT    NOT NULL,
  result      TEXT    NOT NULL DEFAULT '[]',   -- JSON: the segments returned
  source      TEXT    NOT NULL DEFAULT 'database',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_user ON lookup_history (user_id, created_at DESC);

-- -------------------------------------------------------------- settings ---

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  data       TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- --------------------------------------------- pinyin lookup source data ---

-- Context-correct readings for multi-character phrases (from
-- mozillazg/phrase-pinyin-data, the same table pypinyin ships).
CREATE TABLE IF NOT EXISTS phrase_pinyin (
  phrase    TEXT PRIMARY KEY,
  syllables TEXT NOT NULL                  -- space separated, tone marks
) WITHOUT ROWID;

-- Per-character readings, most common first (from mozillazg/pinyin-data).
CREATE TABLE IF NOT EXISTS char_pinyin (
  char     TEXT PRIMARY KEY,
  readings TEXT NOT NULL                   -- JSON array
) WITHOUT ROWID;

-- Character-level simplified <-> traditional mapping (OpenCC STCharacters).
-- The word and phrase tables are keyed on simplified text, so traditional input
-- is normalised through this map before lookup. That is what lets 銀行 resolve
-- to yín háng instead of falling back to a character's primary reading.
--
-- One simplified character can have SEVERAL traditional forms (发 -> 發 and 髮,
-- 里 -> 裏 and 裡), so the key is the pair, not the simplified character alone.
CREATE TABLE IF NOT EXISTS script_map (
  simplified  TEXT NOT NULL,
  traditional TEXT NOT NULL,
  PRIMARY KEY (simplified, traditional)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_script_traditional ON script_map (traditional);
