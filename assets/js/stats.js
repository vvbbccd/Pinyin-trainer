/* ==========================================================================
   stats.js — turns the stored sessions and per-word progress into the numbers
   shown on the dashboard and the progress screen.
   ========================================================================== */

import { lookupWord, LEVELS } from './dictionary.js';

export const MASTERED_THRESHOLD = 0.8;
export const WEAK_THRESHOLD = 0.55;

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @returns {object} headline numbers for the dashboard */
export function summary(sessions = [], progress = {}) {
  const answered = sessions.reduce((sum, s) => sum + (s.total || 0), 0);
  const correct = sessions.reduce((sum, s) => sum + (s.correct || 0), 0);
  const timeMs = sessions.reduce((sum, s) => sum + Math.max(0, (s.finishedAt || 0) - (s.startedAt || 0)), 0);

  const progressValues = Object.values(progress);
  const practiced = progressValues.length;
  const mastered = progressValues.filter((p) => p.mastery >= MASTERED_THRESHOLD && p.attempts >= 1).length;
  const weak = progressValues.filter((p) => p.attempts >= 2 && p.mastery < WEAK_THRESHOLD).length;

  const charsTyped = sessions.reduce(
    (sum, s) => sum + (s.answers || []).reduce((inner, a) => inner + (a.word ? a.word.length : 0), 0),
    0,
  );

  return {
    sessions: sessions.length,
    answered,
    correct,
    accuracy: answered ? correct / answered : NaN,
    avgResponseMs: answered
      ? sessions.reduce((sum, s) => sum + (s.avgResponseMs || 0) * (s.total || 0), 0) / answered
      : NaN,
    charsPerMinute: timeMs > 0 ? charsTyped / (timeMs / 60000) : NaN,
    timeMs,
    practiced,
    mastered,
    weak,
    streakDays: streak(sessions),
    studiedToday: studiedToday(sessions),
    bestSession: sessions.reduce((best, s) => (best == null || (s.accuracy || 0) > (best.accuracy || 0) ? s : best), null),
  };
}

/** Consecutive calendar days with at least one finished session. */
export function streak(sessions = []) {
  if (!sessions.length) return 0;
  const days = new Set(sessions.map((s) => dayKey(s.finishedAt || s.startedAt || Date.now())));
  let count = 0;
  const cursor = new Date();
  // a streak stays alive if the learner practised today or yesterday
  if (!days.has(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(dayKey(cursor))) return 0;
  }
  while (days.has(dayKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

export function studiedToday(sessions = []) {
  const today = dayKey(Date.now());
  return sessions.some((s) => dayKey(s.finishedAt || s.startedAt || 0) === today);
}

/** Accuracy per session, oldest first, for the trend chart. */
export function accuracyTrend(sessions = [], limit = 20) {
  return [...sessions]
    .slice(0, limit)
    .reverse()
    .map((s) => ({
      id: s.id,
      at: s.finishedAt || s.startedAt,
      accuracy: s.total ? (s.correct || 0) / s.total : 0,
      total: s.total || 0,
    }));
}

/** Sessions per day for the last `days` days (activity strip). */
export function dailyActivity(sessions = [], days = 14) {
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    buckets.set(dayKey(d), { key: dayKey(d), date: d, sessions: 0, answered: 0, correct: 0 });
  }
  for (const session of sessions) {
    const key = dayKey(session.finishedAt || session.startedAt || 0);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.sessions += 1;
    bucket.answered += session.total || 0;
    bucket.correct += session.correct || 0;
  }
  return [...buckets.values()];
}

/**
 * Words the learner keeps getting wrong, worst first.
 * @returns {Array<{record, word, level, category, accuracy}>}
 */
export function weakWordList(progress = {}, { limit = 15, minAttempts = 2, threshold = WEAK_THRESHOLD } = {}) {
  return Object.values(progress)
    .filter((record) => record.attempts >= minAttempts && record.mastery < threshold)
    .sort((a, b) => a.mastery - b.mastery || b.attempts - a.attempts)
    .slice(0, limit)
    .map((record) => decorate(record));
}

/** Best-known words, for the "strongest" list. */
export function strongWordList(progress = {}, { limit = 10, minAttempts = 3 } = {}) {
  return Object.values(progress)
    .filter((record) => record.attempts >= minAttempts && record.mastery >= MASTERED_THRESHOLD)
    .sort((a, b) => b.mastery - a.mastery || b.attempts - a.attempts)
    .slice(0, limit)
    .map((record) => decorate(record));
}

export function decorate(record) {
  const word = lookupWord(record.simplified) || {};
  return {
    record,
    word,
    level: word.lv ?? null,
    category: word.c ?? null,
    accuracy: record.attempts ? record.correct / record.attempts : 0,
  };
}

/** Per-level mastery, using the difficulty levels from the dictionary. */
export function levelMastery(progress = {}) {
  const buckets = new Map(LEVELS.map((level) => [level.id, {
    level: level.id,
    name: level.name,
    attempted: 0,
    mastered: 0,
    correct: 0,
    attempts: 0,
  }]));

  for (const record of Object.values(progress)) {
    const word = lookupWord(record.simplified);
    if (!word) continue;
    const bucket = buckets.get(word.lv);
    if (!bucket) continue;
    bucket.attempted += 1;
    bucket.attempts += record.attempts;
    bucket.correct += record.correct;
    if (record.mastery >= MASTERED_THRESHOLD) bucket.mastered += 1;
  }

  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    masteryRate: bucket.attempted ? bucket.mastered / bucket.attempted : 0,
    accuracy: bucket.attempts ? bucket.correct / bucket.attempts : NaN,
  }));
}

/** How coverage is going: practiced vs. the whole dictionary. */
export function coverage(progress = {}, totalWords = 0) {
  const practiced = Object.keys(progress).length;
  return {
    practiced,
    total: totalWords,
    rate: totalWords ? practiced / totalWords : 0,
  };
}

export function averageResponseMs(sessions = []) {
  const answered = sessions.reduce((sum, s) => sum + (s.total || 0), 0);
  if (!answered) return NaN;
  return sessions.reduce((sum, s) => sum + (s.avgResponseMs || 0) * (s.total || 0), 0) / answered;
}

/** Per-word speed leaderboard from a session's answers. */
export function slowestAnswers(session, limit = 8) {
  if (!session?.answers) return [];
  return [...session.answers]
    .filter((a) => Number.isFinite(a.responseTimeMs))
    .sort((a, b) => b.responseTimeMs - a.responseTimeMs)
    .slice(0, limit);
}

export function scoreLabel(accuracy) {
  if (!Number.isFinite(accuracy)) return '—';
  if (accuracy >= 0.95) return 'Excellent';
  if (accuracy >= 0.85) return 'Great';
  if (accuracy >= 0.7) return 'Good';
  if (accuracy >= 0.5) return 'Getting there';
  return 'Keep practising';
}
