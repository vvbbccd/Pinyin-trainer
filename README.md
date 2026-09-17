# Chinese Pinyin Typing Trainer

A website for practising **Chinese pinyin typing**: it shows random Chinese words, you type
the pinyin, and it tells you exactly which syllable or tone was wrong. It also includes a
pinyin library that turns any Chinese text into pinyin, and a progress screen with
accuracy, typing speed and weak-word tracking.

**Full stack, no third-party dependencies.** A Python standard-library backend
(`http.server` + `sqlite3`) serves both the REST API and the browser client, and stores
everything in SQLite. The frontend still works with no backend at all — it falls back to
the static seed data and `localStorage`, and can migrate that data up later.

---

## Quick start

```powershell
cd ur file location

npm run db:build      # create + seed var/trainer.db   (once; ~20 s)#or python tools/build_databse.py
npm start             # python -m server  ->  http://127.0.0.1:8000/
```

Open **<http://127.0.0.1:8000/>**. The backend serves the app, the API and the data, so
it is all same-origin and needs no configuration.

Prefer to run the frontend on its own (not connected to database)?

```powershell
npm run serve         # python -m http.server 8123  ->  http://127.0.0.1:8123/
```

That serves the static app with no backend: words come from `data/words.json` and progress
is kept in the browser. Point it at a backend running elsewhere at any time with
`http://127.0.0.1:8123/?api=http://127.0.0.1:8000`, or from **Settings → Backend**.

### Server options

```powershell
python -m server --host 0.0.0.0 --port 8000 --db var/trainer.db
python -m server --no-static        # API only, no frontend
```

---

## Architecture

```
browser  ──HTTP──▶  server/ (WSGI, stdlib)  ──SQL──▶  var/trainer.db (SQLite)
   │                      │
   │                      └── phrase_pinyin (412k) + char_pinyin  → pinyin lookup
   └── falls back to data/*.json + localStorage when no backend answers
```

| Layer | Files | Notes |
|---|---|---|
| Backend entry | `server/__main__.py` | threaded WSGI server, CLI flags |
| HTTP | `server/http_app.py` | routing, JSON, CORS, static files, ETag |
| API | `server/api.py` | 20 REST endpoints |
| Data access | `server/repository.py` | all SQL + JSON serialisers |
| Schema | `server/schema.sql` | 9 tables, documented deviations |
| Connection | `server/db.py` | per-thread connections, WAL, transactions |
| Lookup engine | `server/pinyin_engine.py` | phrase DP, char fallback, tone sandhi |
| Frontend client | `assets/js/api.js` | fetch wrapper, probe, base-URL handling |
| State | `assets/js/store.js` | server mode with optimistic writes, local fallback |

### The lookup engine

The browser can only match a 5,000-word list and guesses a character's most common
reading. The server segments against **411,857 dictionary phrases** with a dynamic
program that prefers the longest match, so polyphones resolve from context:

It also applies the 一/不 tone-sandhi rules for characters resolved individually, and
flags anything it had to fall back on so the UI can warn. `pypinyin` is used
automatically if it happens to be installed, otherwise the engine runs standalone.

---

### Where it is still wrong

* **Words that are genuinely ambiguous on their own.** 转动 is both `zhuǎndòng`
  (to turn) and `zhuàndòng` (to rotate); the dictionary stores one and the trainer
  expects that one.
* **Long phrases missing from the table.** Segmentation is a longest-match dynamic
  program, so it can split differently from a human: 研究生命起源 segments as
  研究生 / 命 / 起源. This is a hard open problem in Chinese NLP, not a defect specific
  to this project.
* **Rare characters** outside the phrase table fall back to their most common reading;
  the API marks those segments `source: "char"` and the UI says so.
* **134 words were deliberately excluded** when building the seed dictionary: they are
  absent from the phrase table *and* contain a polyphonic character, so the only
  remaining option would be to guess (行长, 行走, 发型, 归还, 人参, 穿着). Words with no
  such ambiguity are still included, via their unambiguous character readings.

Fixing the first two properly needs word segmentation plus a language model — the
approach `pypinyin` + `jieba` takes, or a BERT-based disambiguator. The phrase-table
method is what `pypinyin` itself ships, and it is right for the overwhelming majority
of real text.

---

## REST API

Base `http://127.0.0.1:8000/api`. All responses are JSON; timestamps are epoch
milliseconds. There is no authentication yet — every request acts as the single local
user (`X-User` / `?user=` select another by id or username).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, version, row counts |
| GET | `/meta` | word/char/phrase counts, the 5 levels, all categories |
| GET | `/words` | list + filter: `?levels=1,2&categories=verb&search=&limit=&offset=` |
| GET | `/words/random` | `?count=&levels=&categories=&focusWeak=` — weak-aware sampling |
| GET | `/words/:id` | one word |
| POST | `/lookup` | `{text}` → segments with pinyin, source per segment, unknown chars |
| GET | `/sessions` | history, newest first |
| POST | `/sessions` | save a finished session (idempotent upsert; updates progress) |
| GET | `/sessions/:id` | one session with all answers |
| DELETE | `/sessions/:id` | delete a session and its answers |
| GET | `/progress` | summary + weak/strong words |
| GET | `/progress/map` | whole progress table keyed by word (client hydration) |
| GET | `/progress/words` | `?filter=all\|weak\|mastered` |
| DELETE | `/progress` | reset all progress |
| GET/POST/DELETE | `/library/saved` | saved words |
| GET/POST/DELETE | `/library/history` | lookup history |
| GET/PUT | `/settings` | per-user settings JSON |
| GET | `/users/me` | current user + their progress summary |

```powershell
# examples
curl http://127.0.0.1:8000/api/words?levels=1&limit=3
curl -X POST http://127.0.0.1:8000/api/lookup -H "Content-Type: application/json" -d "{\"text\":\"银行\"}"
```

Word objects use the compact keys the client already consumes:
`s` simplified · `t` traditional · `p` pinyin with tone marks · `pinyinPlain` ·
`pinyinNumbers` · `r` frequency rank · `f` raw frequency · `c` category · `lv` level 1–5.

---

## Database

`var/trainer.db` (SQLite, ~12 MB) is built by `tools/build_database.py`:

| Table | Rows | From `basic.txt` |
|---|---|---|
| `chinese_words` | 5,000 | CHINESE_WORD |
| `training_sessions` | — | TRAINING_SESSION |
| `training_answers` | — | TRAINING_ANSWER |
| `user_word_progress` | — | USER_WORD_PROGRESS |
| `users` | 1 | *(new — gives `user_id` a target)* |
| `saved_words`, `lookup_history` | — | *(new — the Library)* |
| `user_settings` | — | *(new — server-side preferences)* |
| `phrase_pinyin` | 411,857 | *(new — context-correct readings)* |
| `char_pinyin` | 3,796 | *(new — per-character fallback)* |
| `script_map` | 1,917 | *(new — simplified ↔ traditional, both directions)* |

**Deviations from the classes in `basic.txt`** (all deliberate):

* `chinese_words` gained `category`, `difficulty_level`, `pinyin_plain`,
  `pinyin_numbers`, `syllables` and `syllable_count` — derived at build time so the API
  never reformats pinyin.
* `training_sessions.id` is a **client-generated TEXT id**, not an integer, so an offline
  session can be replayed and upserted idempotently. It also stores derived totals
  (`accuracy`, `avg_response_ms`, `chars_per_minute`, `duration_ms`) and a `config` JSON blob.
* `training_answers.word_id` is **nullable**, with `word_simplified` as a fallback, so an
  answer is never dropped when a word is missing from the dictionary. It also records
  `skipped`, `hint_used`, `level` and `category`.
* `user_word_progress` matches your class exactly (`attempts`, `correct_attempts`,
  `last_attempt`, `mastery_score`) with a unique key per `(user_id, word_id)`. Mastery is
  an exponential moving average — the same formula the browser uses offline
  (`0.65 × old + 0.35 × outcome`), so progress is identical in both modes.
* No accounts: `users` holds one row (`local`) and every request uses it.

## What still needs work

1. **Authentication.** `user_id` is plumbing only; there is no login. Multi-user support
   means adding auth and honouring `X-User` from a session rather than a header.
2. **Phrase-level traditional conversion.** The script map is character-level, so
   里 → 裏 rather than the Taiwanese 裡, and a few context-dependent words are imperfect.
   OpenCC phrase conversion on the server would fix it.
3. **Session sync when offline for a long time.** Local sessions upload on demand from
   Settings; there is no automatic background retry.
4. **Scaling.** `/words/random` loads the candidate set into memory for weak-aware
   weighting — fine for 5,000 words, not for a million. SQL-side weighted sampling would
   be the next step.

---

## Project layout

```
index.html                  app shell (sidebar, top bar, outlet)
assets/css/                 tokens · base · layout · components · views
assets/js/
  main.js                   bootstrap: state, backend probe, routes
  api.js                    REST client, probe, base-URL resolution
  router.js                 hash router, async views, per-view cleanup
  app-shell.js              sidebar + top bar (shows backend status)
  store.js                  server/local persistence, optimistic writes
  dictionary.js             seed data, filtering, sampling, segmentation, script map
  pinyin.js                 grading engine (marks ↔ numbers, segmentation, sandhi)
  stats.js                  accuracy, speed, streaks, weak words, level mastery
  ui.js                     DOM helpers, icons, toasts, modals, components
  views/                    dashboard · training · library · progress · settings
server/                     Python backend (see Architecture)
data/words.json             5,000 words  (generated)
data/chars.json             3,796 chars  (generated)
data/script.json            1,823 simplified -> traditional characters (generated)
var/trainer.db              SQLite database (generated, git-ignored)
tools/                      data pipeline, database builder, tests
basic.txt                   your original plan, untouched
```

## Tests

```powershell
npm test               # 83 engine assertions + module import check   (no dependencies)
npm run test:server    # 38 backend tests: engine units + REST API over HTTP
npm run test:smoke     # 50 end-to-end checks in jsdom, local/offline mode
npm run test:all       # all of the above
```

`test:integration` (28 checks) drives the real app in jsdom against a **live** backend and
verifies that words, lookups, sessions, progress, saved words and settings all land in
SQLite — including the polyphone lookup that only the server can get right:

```powershell
python -m server --db .tmp/it/trainer.db      # in one terminal
npm run test:integration                      # in another
```

---

## Fixed since the first version

* **Sidebar/top bar highlighted the previous route.** The shell listened to raw
  `hashchange` events, which fired *before* the router committed the new path. It now
  uses the router's `onRouteChange` hook. Regression-tested.
* **Interface Chinese stayed simplified in Traditional mode.** The nav brand, hero,
  library example chips and placeholder were hardcoded simplified. They now go through
  `applyScript()` using `data/script.json`. Regression-tested.
* Traditional input is now also *looked up* correctly in the Library (the segment matcher
  consults both indexes), and `chars.json` was extended with traditional characters.
* **The backend console crashed on cp950 terminals** when printing its Chinese banner;
  entry points now reconfigure stdout to UTF-8 with replacement characters.
* **Phrase lookup returned stale results from cache** — a second lookup of the same text
  silently fell back to character readings because only freshly-queried phrases were
  returned. Caught by the backend test suite.
* **Traditional input produced wrong readings on the server** — 銀行 came out
  `yín xíng`, 音樂 `yīn lè`, 重慶 `zhòng qìng`. The word and phrase tables are keyed on
  simplified text, and the server never normalised. It now maps traditional input
  through `script_map` before matching, covering OpenCC's multiple variants
  (发 → 發 *and* 髮) and the Taiwan forms in `TWVariants` (為, 裡). Regression-tested
  against six polyphone pairs plus the variant and Taiwan cases.
* `Database.stats()` did not know about `script_map`, so `/api/health` silently reported
  it as absent. Caught by the new test.


## Screens

| Route | Screen | What it does |
|---|---|---|
| `#/` | **Dashboard** | Entry points plus at-a-glance accuracy, words practised, streak, 14-day activity, accuracy trend and words to revisit |
| `#/training` | **Training setup** | Difficulty levels, word types, session length, marking strictness |
| `#/training/session` | **The drill** | Random word → type pinyin → Enter → correct/incorrect feedback → next |
| `#/training/results/:id` | **Session results** | Score, speed, every answer, slowest words, "practise the missed words" |
| `#/library` | **Library** | Chinese text → pinyin (word-matched, with per-character fallback), saved words, search history |
| `#/progress` | **Progress** | Accuracy, typing speed, words practised, weak words, level mastery, full history |
| `#/settings` | **Settings** | Theme, script, marking rules, session defaults, backup/restore/erase |

### The drill in detail

* Shows the word large, in simplified, traditional, or both (your setting).
* Accepts the answer as **tone marks** (`xué xiào`), **tone numbers** (`xue2xiao4`) or
  **plain letters** (`xuexiao`) — spaces, apostrophes and hyphens are all optional.
* Gives **syllable-level feedback**: a strip under the answer marks each syllable as
  correct, wrong letters, or wrong/missing tone.
* Optional on-screen tone keypad, hint button (counts as a miss), skip, and end-session.
* Endless mode tops the queue up as you go; fixed sessions end with a results screen.

---

## What I changed vs. `basic.txt`

Your structure was followed for every major function. These are the deliberate
modifications — nothing was removed:

**Navigation / structure**

1. **Settings is a top-level nav item** (`#/settings`). In your plan it sits under
   Home/Dashboard; the Dashboard still links to it. This keeps the sidebar flat and
   makes settings reachable from anywhere.
2. **Progress/Statistics appears twice, at two depths.** The Dashboard carries a short
   summary (accuracy, mastered words, streak, trend); the full `#/progress` page under
   *User/Progress* carries the detail. Your plan listed Progress under both headings.
3. **Training is split into three routes** — setup / session / results — so difficulty
   selection is a real screen (also choosing word types and session length) and results
   are linkable and survive a page refresh.
4. **The Dashboard gained a stats summary and recent-session list.** Your plan had
   Home/Dashboard → four entries only; I added the overview because an empty landing
   page made the app feel unfinished.

**New features inside existing sections**

5. **Training:** hint button, skip, endless mode, auto-advance with adjustable delay,
   focus-on-weak-words weighting, part-of-speech filter, tone keypad, live
   accuracy/streak/timer, and a "practise the missed words" replay.
6. **Library:** per-character breakdown with *all* dictionary readings, tone-format
   toggle (marks / numbers / plain), copy-pinyin and copy-aligned-text, click-a-word to
   save, and "practise these words" which hands the lookup straight to the trainer.
7. **Progress:** accuracy trend chart, 14-day activity strip, streak, per-level mastery
   bars, 7/30/all-time range filter, per-session delete, and progress reset. All five
   items you listed (accuracy, typing speed, words practised, weak words, history) are
   present.
8. **Traditional characters are supported**, since your training example mentions
   學校. The Traditional setting converts both dictionary words *and* the fixed
   interface labels (nav brand, hero, library examples). The mapping is
   **character-level** (OpenCC `STCharacters`), not phrase-level, so a few words may
   have an imperfect traditional form — and it picks OpenCC's standard form, e.g.
   里 → 裏 rather than the Taiwanese 裡. A backend can do this properly with OpenCC
   phrase conversion.

**Data layer**

9. `data/words.json` (5,000 words), `data/chars.json` (3,796 characters) and
   `data/script.json` (1,823 simplified→traditional characters) are generated by
   `tools/build_dictionary.py` from open datasets. They are the offline seed for the
   frontend; the database built from the same sources is what the app uses when the
   backend is running.
10. **Difficulty levels 1–5 are my own grouping** — corpus frequency bands plus a
    hand-curated beginner list (`tools/vocabulary.json`). They are **not** official HSK
    levels, and the UI does not claim to be.

**Database schema**

11. The backend implements your four classes as `chinese_words`, `training_sessions`,
    `training_answers` and `user_word_progress`, with additions on top. The exact
    deviations are listed under [Database](#database) above rather than repeated here.

---

## How answers are graded

`assets/js/pinyin.js` is the engine (covered by 83 unit tests). It is deliberately
forgiving about *format* and strict about *content*:

| Input | Verdict |
|---|---|
| `xue2xiao4`, `xué xiào`, `xuéxiào`, `XUE2XIAO4`, `xue2-xiao4` | all accepted |
| `xue xiao` | rejected while "require tones" is on; accepted when it is off |
| `xue1xiao4` | rejected, and reported as *"Tone is wrong on syllable 1"* |
| `lu4` for 綠 `lǜ` | accepted by default (lenient ü); rejected if "distinguish ü from u" is on |
| `yi1ge4` for 一个 `yí gè` | accepted — 一/不 tone sandhi counts as correct |
| `peng2you` for 朋友 `péng you` | accepted — neutral tone may be written, omitted, or as `5` |
| `chang2` for 長 `zhǎng` | accepted — single characters accept any of their real readings |
| `xúe` (mark on the wrong vowel) | accepted — the tone is read, not its position |

Vocabulary segmentation is handled by a dynamic-programming splitter over the ~410 valid
pinyin syllables, so unseparated input like `gong1gong4qi4che1` is graded per syllable.

## Data pipeline

`data/*.json` are build artefacts for the offline mode, and they are also the input to
the database builder. Regenerate them with:

```powershell
npm run data:all            # fetch sources -> build -> validate (needs Python 3)
```

Sources, all permissively licensed, are cached in `.tmp/` (disposable):
[jieba](https://github.com/fxsjy/jieba) word frequencies (MIT),
[mozillazg/phrase-pinyin-data](https://github.com/mozillazg/phrase-pinyin-data) (MIT),
[mozillazg/pinyin-data](https://github.com/mozillazg/pinyin-data) (MIT),
[OpenCC](https://github.com/BYVoid/OpenCC) `STCharacters` (Apache-2.0).
`tools/vocabulary.json` holds the only hand-authored data — **characters only**, never
pinyin, so no reading is typed by hand and every reading comes from the datasets.

`var/trainer.db` is built from the same sources by `npm run db:build`, which additionally
loads `phrase_pinyin.txt` into the `phrase_pinyin` table for server-side lookup.

