/* ==========================================================================
   store.js — application state, persistence and progress bookkeeping.

   Two persistence modes, chosen at startup by probing the backend:

     'server'  the REST API is reachable: settings, sessions, answers, progress
               and the library live in SQLite. Writes are optimistic — local
               state updates immediately and the request is sent in the
               background, so the UI never blocks on the network.
     'local'   no backend: everything stays in localStorage (the original
               prototype behaviour), and no data is lost when a backend appears
               later because Settings offers a one-click migration.

   The in-memory shapes are identical in both modes, and mirror the tables in
   basic.txt:

     STORED SHAPE                         TABLE
     settings                             user_settings
     sessions[]                           TRAINING_SESSION
     sessions[].answers[]                 TRAINING_ANSWER
     progress[simplified]                 USER_WORD_PROGRESS
     library.saved[] / library.history[]  saved_words / lookup_history
   ========================================================================== */

import { api, probe, getStatus, isOnline, ApiError } from './api.js';
import { toast } from './ui.js';

const NS = 'pinyin-trainer:v1';
const KEYS = {
  settings: `${NS}:settings`,
  sessions: `${NS}:sessions`,
  progress: `${NS}:progress`,
  library: `${NS}:library`,
};

export const STORAGE_KEYS = KEYS;

export const DEFAULT_SETTINGS = {
  /* appearance */
  theme: 'dark',                 // dark | light | system
  script: 'simplified',          // simplified | traditional | both
  fontSize: 'md',                // sm | md | lg  (scales the drill word)

  /* what the trainer shows while answering */
  revealPinyin: 'after',         // after | never | always
  showTimer: true,

  /* answer checking */
  requireTones: true,
  strictU: false,                // true = ü must be typed as "v"
  toneInput: 'either',           // either | marks | numbers (hint / keypad only)

  /* session defaults */
  levels: [1, 2],
  categories: [],
  sessionSize: 20,               // 0 = endless
  autoAdvance: true,
  autoAdvanceDelay: 1100,
  sound: false,
  shuffle: true,

  /* library */
  libraryToneDisplay: 'marks',   // marks | numbers | plain
  libraryShowPerChar: true,
};

const MAX_SESSIONS = 200;
const MAX_HISTORY = 60;
const MAX_SAVED = 500;

const listeners = new Set();
let state = null;
let syncTimer = null;

/* ---------------------------------------------------------------- mode --- */

export const isServerMode = () => state?.mode === 'server';
export const getMode = () => state?.mode || 'local';
export const getBackendStatus = () => getStatus();

/** Human-readable summary for the sidebar and the settings screen. */
export function describeMode() {
  if (!state) return 'starting…';
  if (state.mode === 'server') {
    const version = getStatus().version ? ` v${getStatus().version}` : '';
    return `Connected to the backend${version} — data is stored in SQLite.`;
  }
  return 'Offline: no backend reachable, so data is stored in this browser only.';
}

/* --------------------------------------------------------------- load ---- */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (error) {
    console.warn(`[store] could not read ${key}`, error);
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // quota exceeded / private mode: keep working in memory
    console.warn(`[store] could not write ${key}`, error);
    return false;
  }
}

export function loadState() {
  const savedSettings = readJson(KEYS.settings, {}) || {};
  state = {
    mode: 'local',
    settings: { ...DEFAULT_SETTINGS, ...savedSettings },
    sessions: readJson(KEYS.sessions, []) || [],
    progress: readJson(KEYS.progress, {}) || {},
    library: { history: [], saved: [], ...(readJson(KEYS.library, {}) || {}) },
  };
  if (!Array.isArray(state.sessions)) state.sessions = [];
  applyTheme();
  return state;
}

/**
 * Probe the backend and hydrate from it when available. Safe to call again
 * (Settings uses it to reconnect); local data is never overwritten blindly.
 */
export async function initStore({ silent = false } = {}) {
  if (!state) loadState();
  const online = await probe();

  if (!online) {
    state.mode = 'local';
    emit();
    return { mode: 'local', error: getStatus().error };
  }

  state.mode = 'server';
  const problems = [];

  try {
    const [settings, sessions, progress, saved, history] = await Promise.all([
      api.settings.get().catch((error) => { problems.push(`settings: ${error.message}`); return null; }),
      api.sessions.list({ limit: 200 }).catch((error) => { problems.push(`sessions: ${error.message}`); return null; }),
      api.progress.map().catch((error) => { problems.push(`progress: ${error.message}`); return null; }),
      api.savedWords.list({ limit: 500 }).catch((error) => { problems.push(`saved words: ${error.message}`); return null; }),
      api.history.list({ limit: 60 }).catch((error) => { problems.push(`history: ${error.message}`); return null; }),
    ]);

    // Settings: a fresh database returns null, so push the local defaults up.
    const remoteSettings = settings?.settings;
    if (remoteSettings && typeof remoteSettings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...remoteSettings };
      writeJson(KEYS.settings, state.settings);
      applyTheme();
    } else {
      persistSettings();
    }

    if (sessions?.sessions) state.sessions = sessions.sessions.slice(0, MAX_SESSIONS);
    if (progress?.progress) state.progress = progress.progress;
    if (saved?.words) state.library.saved = saved.words.slice(0, MAX_SAVED);
    if (history?.history) state.library.history = history.history.slice(0, MAX_HISTORY);

    // keep the local cache in step so a later offline start still has data
    writeJson(KEYS.sessions, state.sessions);
    writeJson(KEYS.progress, state.progress);
    writeJson(KEYS.library, state.library);
  } catch (error) {
    problems.push(error.message);
  }

  emit();
  if (problems.length && !silent) {
    console.warn('[store] some data could not be loaded from the backend', problems);
  }
  return { mode: 'server', problems };
}

/** Push everything currently held locally up to the backend. */
export async function migrateLocalToServer({ onProgress } = {}) {
  if (!isServerMode()) return { ok: false, message: 'No backend is connected.' };
  const local = {
    sessions: readJson(KEYS.sessions, []) || [],
    progress: readJson(KEYS.progress, {}) || {},
    library: readJson(KEYS.library, {}) || {},
  };

  const already = new Set(getState().sessions.map((session) => session.id));
  const pending = local.sessions.filter((session) => session && session.id && !already.has(session.id));
  const result = {
    sessions: 0, saved: 0, skipped: local.sessions.length - pending.length, failed: 0,
  };

  for (const [index, session] of pending.entries()) {
    try {
      await api.sessions.save(session);
      result.sessions += 1;
    } catch (error) {
      console.warn('[store] could not migrate session', session.id, error);
      result.failed += 1;
    }
    if (onProgress) onProgress(index + 1, pending.length);
  }

  for (const item of local.library.saved || []) {
    try {
      await api.savedWords.add({ simplified: item.s, pinyin: item.p, traditional: item.t });
      result.saved += 1;
    } catch { result.failed += 1; }
  }

  await initStore({ silent: true });
  return { ok: true, ...result };
}

/** Local-only data that has not reached the backend yet (for the settings UI). */
export function pendingLocalCounts() {
  const sessions = readJson(KEYS.sessions, []) || [];
  const saved = (readJson(KEYS.library, {}) || {}).saved || [];
  const known = new Set((state?.sessions || []).map((session) => session.id));
  return {
    sessions: sessions.filter((session) => session?.id && !known.has(session.id)).length,
    saved: saved.length,
    progress: Object.keys(readJson(KEYS.progress, {}) || {}).length,
  };
}

export function getState() {
  if (!state) loadState();
  return state;
}

export const getSettings = () => getState().settings;
export const getSessions = () => getState().sessions;
export const getProgress = () => getState().progress;
export const getLibrary = () => getState().library;

/* -------------------------------------------------------- subscriptions -- */

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener(getState());
    } catch (error) {
      console.error('[store] listener failed', error);
    }
  }
}

/**
 * Tell the user when a background write fails. Rate-limited so a backend that
 * goes down does not produce a toast per answer.
 */
let lastSyncWarning = 0;
function notifySyncFailure(message) {
  const now = Date.now();
  if (now - lastSyncWarning < 8000) return;
  lastSyncWarning = now;
  try {
    toast(message, { type: 'danger', timeout: 5000 });
  } catch { /* running without a DOM (tests) */ }
}

/* ------------------------------------------------------------ settings --- */

/** Queue settings to the backend, coalescing bursts of changes into one PUT. */
function syncSettingsSoon() {
  if (!isServerMode()) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    api.settings.put(getSettings()).catch((error) => {
      console.warn('[store] settings did not reach the backend', error);
    });
  }, 400);
}

function persistSettings() {
  writeJson(KEYS.settings, getSettings());
  syncSettingsSoon();
}

export function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  state.settings = next;
  writeJson(KEYS.settings, next);
  applyTheme();
  syncSettingsSoon();
  emit();
  return next;
}

export function resetSettings() {
  state.settings = { ...DEFAULT_SETTINGS };
  writeJson(KEYS.settings, state.settings);
  applyTheme();
  syncSettingsSoon();
  emit();
}

function applyTheme() {
  const theme = getSettings().theme;
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeSetting = theme;
  document.documentElement.dataset.fontSize = getSettings().fontSize || 'md';
}

/** Re-resolve the theme when the OS preference changes. */
export function watchSystemTheme() {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => { if (getSettings().theme === 'system') applyTheme(); };
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

/* ------------------------------------------------------------ progress --- */

/**
 * USER_WORD_PROGRESS. Keyed by the simplified form because the seed dictionary's
 * numeric ids are regenerated by the build script; the backend will key on word_id.
 */
export function recordOutcome(word, isCorrect, when = Date.now()) {
  const key = word.s;
  const existing = state.progress[key] || {
    wordId: word.id ?? null,
    simplified: word.s,
    traditional: word.t || null,
    pinyin: word.p,
    attempts: 0,
    correct: 0,
    lastAttempt: null,
    mastery: 0.5,
  };

  existing.wordId = word.id ?? existing.wordId;
  existing.pinyin = word.p;
  existing.traditional = word.t || null;
  existing.attempts += 1;
  if (isCorrect) existing.correct += 1;
  existing.lastAttempt = when;
  // exponential moving average: recent answers matter more than old ones
  existing.mastery = existing.attempts === 1
    ? (isCorrect ? 0.75 : 0.2)
    : existing.mastery * 0.65 + (isCorrect ? 1 : 0) * 0.35;

  state.progress[key] = existing;
  writeJson(KEYS.progress, state.progress);
  return existing;
}

export function getWordProgress(simplified) {
  return getState().progress[simplified] || null;
}

/* ------------------------------------------------------------ sessions --- */

/**
 * Persist a finished session. `session` mirrors TRAINING_SESSION and its
 * `answers` mirror TRAINING_ANSWER. Derived totals are recomputed from the
 * answers whenever the caller did not supply them.
 */
export function saveSession(session) {
  const answers = session.answers || [];
  const total = session.total ?? answers.length;
  const correct = session.correct ?? answers.filter((a) => a.isCorrect).length;
  const finishedAt = session.finishedAt ?? Date.now();
  const durationMs = Math.max(0, finishedAt - (session.startedAt || finishedAt));
  const charsTyped = answers.reduce((sum, a) => sum + (a.word ? a.word.length : 0), 0);

  const record = {
    id: session.id || `s_${Date.now().toString(36)}`,
    startedAt: session.startedAt,
    finishedAt,
    score: session.score ?? (total ? correct / total : 0),
    total,
    correct,
    accuracy: session.accuracy ?? (total ? correct / total : 0),
    avgResponseMs: session.avgResponseMs ?? (total
      ? answers.reduce((sum, a) => sum + (a.responseTimeMs || 0), 0) / total
      : 0),
    charsPerMinute: session.charsPerMinute ?? (durationMs > 0 ? charsTyped / (durationMs / 60000) : 0),
    config: session.config || {},
    answers,
  };

  state.sessions.unshift(record);
  if (state.sessions.length > MAX_SESSIONS) state.sessions.length = MAX_SESSIONS;
  writeJson(KEYS.sessions, state.sessions);

  for (const answer of record.answers) {
    if (!answer.word) continue;
    recordOutcome(
      { s: answer.word, t: answer.traditional, p: answer.expected, id: answer.wordId },
      answer.isCorrect,
      answer.at || record.finishedAt,
    );
  }

  emit();

  // Persist in the background: the caller already has the record, and the
  // authoritative per-word mastery comes back in `progressUpdates`.
  if (isServerMode()) {
    api.sessions.save(record)
      .then((response) => {
        const stored = response?.session;
        if (!stored) return;
        const index = state.sessions.findIndex((session) => session.id === stored.id);
        if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...stored };
        for (const entry of stored.progressUpdates || []) {
          if (entry?.simplified) state.progress[entry.simplified] = entry;
        }
        writeJson(KEYS.sessions, state.sessions);
        writeJson(KEYS.progress, state.progress);
        emit();
      })
      .catch((error) => {
        console.warn('[store] session was not saved to the backend', error);
        notifySyncFailure('This session could not be saved to the backend. It is kept in your browser.');
      });
  }

  return record;
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  writeJson(KEYS.sessions, state.sessions);
  emit();

  if (isServerMode()) {
    api.sessions.remove(id).catch((error) => {
      console.warn('[store] session was not deleted from the backend', error);
      notifySyncFailure('That session could not be deleted from the backend.');
    });
  }
}

/* ------------------------------------------------------------- library --- */

export function addLibraryLookup(query, results) {
  const text = String(query || '').trim();
  if (!text) return;
  const library = getState().library;
  library.history = [
    { query: text, at: Date.now(), results: results || [] },
    ...library.history.filter((item) => item.query !== text),
  ].slice(0, MAX_HISTORY);
  writeJson(KEYS.library, library);
  emit();

  // The API records its own history when /api/lookup is used, so only push the
  // locally-computed lookups (offline fallback) to avoid duplicate round trips.
  if (isServerMode() && results?.local) {
    api.history.add({ query: text, results: results.results || [] }).catch((error) => {
      console.warn('[store] lookup history did not reach the backend', error);
    });
  }
}

export function saveLibraryWord(entry) {
  const library = getState().library;
  if (library.saved.some((item) => item.s === entry.s && item.p === entry.p)) {
    return false;
  }
  library.saved = [{ ...entry, savedAt: Date.now() }, ...library.saved].slice(0, MAX_SAVED);
  writeJson(KEYS.library, library);
  emit();

  if (isServerMode()) {
    api.savedWords.add({ simplified: entry.s, pinyin: entry.p, traditional: entry.t }).catch((error) => {
      console.warn('[store] saved word did not reach the backend', error);
      notifySyncFailure('That word could not be saved to the backend.');
    });
  }
  return true;
}

export function removeSavedWord(simplified, pinyin) {
  const library = getState().library;
  library.saved = library.saved.filter((item) => !(item.s === simplified && (!pinyin || item.p === pinyin)));
  writeJson(KEYS.library, library);
  emit();

  if (isServerMode()) {
    api.savedWords.remove(simplified, pinyin).catch((error) => {
      console.warn('[store] saved word was not removed from the backend', error);
    });
  }
}

export function isWordSaved(simplified, pinyin) {
  return getState().library.saved.some((item) => item.s === simplified && (!pinyin || item.p === pinyin));
}

export function clearLibraryHistory() {
  state.library.history = [];
  writeJson(KEYS.library, state.library);
  emit();

  if (isServerMode()) {
    api.history.clear().catch((error) => {
      console.warn('[store] lookup history was not cleared on the backend', error);
    });
  }
}

/* ---------------------------------------------------------------- data --- */

export function exportData() {
  const current = getState();
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    schema: 'pinyin-trainer/v1',
    settings: current.settings,
    sessions: current.sessions,
    progress: current.progress,
    library: current.library,
  }, null, 2);
}

/** Returns { ok, message } and merges what it can. */
export function importData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'That file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, message: 'That file does not contain a trainer backup.' };
  }
  const { settings, sessions, progress, library } = parsed;
  if (!settings && !sessions && !progress && !library) {
    return { ok: false, message: 'No settings, sessions or progress found in that file.' };
  }

  if (settings && typeof settings === 'object') {
    state.settings = { ...DEFAULT_SETTINGS, ...settings };
    writeJson(KEYS.settings, state.settings);
    applyTheme();
  }
  if (Array.isArray(sessions)) {
    const seen = new Set(state.sessions.map((s) => s.id));
    const merged = [...sessions.filter((s) => s && !seen.has(s.id)), ...state.sessions];
    state.sessions = merged.slice(0, MAX_SESSIONS);
    writeJson(KEYS.sessions, state.sessions);
  }
  if (progress && typeof progress === 'object') {
    state.progress = { ...state.progress, ...progress };
    writeJson(KEYS.progress, state.progress);
  }
  if (library && typeof library === 'object') {
    state.library = {
      history: Array.isArray(library.history) ? library.history.slice(0, MAX_HISTORY) : state.library.history,
      saved: Array.isArray(library.saved) ? library.saved.slice(0, MAX_SAVED) : state.library.saved,
    };
    writeJson(KEYS.library, state.library);
  }
  emit();
  return { ok: true, message: 'Backup imported.' };
}

export function resetProgress() {
  state.progress = {};
  state.sessions = [];
  writeJson(KEYS.progress, state.progress);
  writeJson(KEYS.sessions, state.sessions);
  emit();

  if (isServerMode()) {
    api.progress.reset().catch((error) => {
      console.warn('[store] progress was not reset on the backend', error);
      notifySyncFailure('Progress could not be reset on the backend.');
    });
  }
}

export function resetEverything() {
  state.progress = {};
  state.sessions = [];
  state.library = { history: [], saved: [] };
  state.settings = { ...DEFAULT_SETTINGS };
  writeJson(KEYS.progress, state.progress);
  writeJson(KEYS.sessions, state.sessions);
  writeJson(KEYS.library, state.library);
  writeJson(KEYS.settings, state.settings);
  applyTheme();
  emit();

  if (isServerMode()) {
    Promise.allSettled([
      api.progress.reset(),
      api.history.clear(),
      api.savedWords.list({ limit: 500 }).then((response) => Promise.all(
        (response?.words || []).map((word) => api.savedWords.remove(word.s, word.p)),
      )),
      api.settings.put(state.settings),
    ]).catch((error) => {
      console.warn('[store] some data could not be erased on the backend', error);
    });
  }
}

/** localStorage usage estimate, for the settings screen. */
export function storageFootprint() {
  let bytes = 0;
  for (const key of Object.values(KEYS)) {
    const raw = localStorage.getItem(key);
    if (raw) bytes += raw.length;
  }
  return bytes;
}

/* --------------------------------------------------- in-flight session --- */

/**
 * The active drill lives in memory only: navigating away abandons it, which is
 * also where persistence would move once a backend exists.
 */
let activeSession = null;
export const getActiveSession = () => activeSession;
export const setActiveSession = (value) => { activeSession = value; return activeSession; };
