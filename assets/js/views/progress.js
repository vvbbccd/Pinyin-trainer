/* ==========================================================================
   views/progress.js — accuracy, speed, weak words, level mastery, history.
   ========================================================================== */

import {
  el, mount, icon, formatPercent, formatDuration, formatDate, formatRelative,
  statTile, badge, progressBar, emptyState, notice, confirmDialog, segmented,
} from '../ui.js';
import { getSettings, getSessions, getProgress, deleteSession, resetProgress } from '../store.js';
import { awaitData, displayWord, dataFootnote } from './shared.js';
import { wordCount, lookupWord } from '../dictionary.js';
import {
  summary, accuracyTrend, weakWordList, strongWordList, levelMastery, coverage,
  dailyActivity, scoreLabel, MASTERED_THRESHOLD,
} from '../stats.js';
import { trendChart } from './dashboard.js';
import { startSession } from './training.js';
import { setTopbarActions } from '../app-shell.js';

let rangeFilter = 'all';

export async function renderProgress(outlet) {
  if (!(await awaitData(outlet))) return undefined;

  const settings = getSettings();
  const allSessions = getSessions();
  const progress = getProgress();

  const sessions = filterByRange(allSessions, rangeFilter);
  const stats = summary(sessions, progress);
  const weak = weakWordList(progress, { limit: 12 });
  const strong = strongWordList(progress, { limit: 6 });
  const levels = levelMastery(progress);
  const cover = coverage(progress, wordCount());
  const trend = accuracyTrend(sessions, 20);

  setTopbarActions(
    el('button', {
      type: 'button',
      class: 'btn btn--sm',
      onClick: () => startSession({
        levels: settings.levels,
        categories: settings.categories,
        sessionSize: settings.sessionSize,
        requireTones: settings.requireTones,
        strictU: settings.strictU,
        autoAdvance: settings.autoAdvance,
        focusWeak: true,
      }),
    }, icon('play'), el('span', { text: 'Practise weak words' })),
  );

  if (!allSessions.length && !Object.keys(progress).length) {
    mount(outlet,
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head__text' },
          el('h1', { text: 'Progress' }),
          el('p', { class: 'page-head__desc', text: 'Accuracy, typing speed, weak words and training history.' }),
        ),
      ),
      el('section', { class: 'card' },
        emptyState({
          title: 'No practice recorded yet',
          text: 'Finish a training session and this screen fills up: accuracy, speed, weak words, level mastery and a full session history.',
          iconName: 'chart',
          action: el('a', { class: 'btn btn--primary', href: '#/training' }, icon('play'), el('span', { text: 'Start training' })),
        }),
      ),
    );
    return undefined;
  }

  mount(outlet,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Progress' }),
        el('p', { class: 'page-head__desc' },
          'Everything here is computed from your saved sessions. ',
          `${cover.practiced} of ${cover.total.toLocaleString()} dictionary words have been attempted so far.`,
        ),
      ),
      el('div', { class: 'page-head__actions' },
        segmented('progress-range', [
          { value: '7', label: '7 days' },
          { value: '30', label: '30 days' },
          { value: 'all', label: 'All time' },
        ], rangeFilter, (value) => { rangeFilter = value; renderProgress(outlet); }),
      ),
    ),

    el('div', { class: 'grid grid--4' },
      statTile({
        label: 'Accuracy',
        value: formatPercent(stats.accuracy, 1),
        iconName: 'target',
        accent: true,
        meta: `${stats.correct}/${stats.answered} answers · ${scoreLabel(stats.accuracy)}`,
      }),
      statTile({
        label: 'Typing speed',
        value: (stats.charsPerMinute || 0).toFixed(0),
        unit: 'chars/min',
        iconName: 'keyboard',
        meta: `${formatDuration(stats.avgResponseMs)} per word`,
      }),
      statTile({
        label: 'Words practised',
        value: stats.practiced.toLocaleString(),
        iconName: 'book2',
        meta: `${stats.mastered} mastered · ${formatPercent(cover.rate, 1)} of the dictionary`,
      }),
      statTile({
        label: 'Weak words',
        value: stats.weak,
        iconName: 'alert',
        meta: stats.weak ? 'below 55% mastery' : 'nothing flagged',
      }),
    ),

    el('div', { class: 'grid grid--2' },
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: 'Accuracy over time' }),
            el('div', { class: 'card__sub', text: `${trend.length} session${trend.length === 1 ? '' : 's'} in this range` }),
          ),
        ),
        trend.length >= 1
          ? trendChart(trend)
          : emptyState({ title: 'Not enough sessions', text: 'Finish a session in this range to see a trend.', iconName: 'chart' }),
      ),

      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: 'Mastery by difficulty' }),
            el('div', { class: 'card__sub', text: `A word counts as mastered at ${Math.round(MASTERED_THRESHOLD * 100)}% mastery.` }),
          ),
        ),
        el('div', { class: 'stack' },
          ...levels.map((level) => el('div', { class: 'stack stack--sm' },
            el('div', { class: 'row row--between' },
              el('div', { class: 'row' },
                badge(`Level ${level.level}`, 'outline'),
                el('span', { class: 'small', text: level.name }),
              ),
              el('span', { class: 'small faint', text: level.attempted ? `${level.mastered}/${level.attempted} mastered` : 'not practised' }),
            ),
            progressBar(level.attempted ? level.masteryRate : 0, {
              variant: level.masteryRate > 0.7 ? 'success' : level.masteryRate > 0.35 ? '' : 'warning',
              label: level.attempted ? formatPercent(level.masteryRate) : '—',
            }),
          )),
        ),
      ),
    ),

    el('section', { class: 'section' },
      el('div', { class: 'section__head' },
        el('h2', { class: 'section__title', text: 'Weak words' }),
        el('span', { class: 'section__hint', text: 'Attempted at least twice and still under 55% mastery' }),
      ),
      weak.length
        ? el('div', { class: 'card card--flush' },
          el('div', { class: 'table-wrap' },
            el('table', { class: 'table' },
              el('thead', {},
                el('tr', {},
                  el('th', { text: 'Word' }),
                  el('th', { text: 'Pinyin' }),
                  el('th', { text: 'Level' }),
                  el('th', { text: 'Correct' }),
                  el('th', { text: 'Mastery' }),
                  el('th', { text: 'Last attempt' }),
                ),
              ),
              el('tbody', {},
                ...weak.map((item) => el('tr', {},
                  el('td', { class: 'cjk', text: displayWord(item.word, settings.script).main }),
                  el('td', { class: 'pinyin text-accent', text: item.record.pinyin }),
                  el('td', { text: item.level ? `L${item.level}` : '—' }),
                  el('td', { class: 'num', text: `${item.record.correct}/${item.record.attempts}` }),
                  el('td', {},
                    el('div', { style: { minWidth: '120px' } },
                      progressBar(item.record.mastery, { variant: item.record.mastery < 0.3 ? 'danger' : 'warning' }),
                    ),
                  ),
                  el('td', { class: 'faint small', text: formatRelative(item.record.lastAttempt) }),
                )),
              ),
            ),
          ),
          el('div', { class: 'card__foot' },
            el('button', {
              type: 'button',
              class: 'btn btn--primary btn--sm',
              onClick: () => startSession({
                levels: [], categories: [], sessionSize: weak.length,
                requireTones: settings.requireTones, strictU: settings.strictU,
                autoAdvance: settings.autoAdvance, focusWeak: false,
              }, weak.map((item) => item.word).filter((word) => word && word.s)),
            }, icon('target'), el('span', { text: 'Drill these words' })),
          ),
        )
        : el('div', { class: 'card' }, emptyState({
          title: 'No weak words',
          text: 'Words get flagged here after two attempts with low mastery. Keep going and this stays empty.',
          iconName: 'check',
        })),
    ),

    strong.length
      ? el('section', { class: 'section' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', text: 'Well mastered' }),
        ),
        el('div', { class: 'token-list' },
          ...strong.map((item) => el('div', { class: 'token', title: `${item.record.attempts} attempts` },
            el('span', { class: 'token__cjk', text: displayWord(item.word, settings.script).main }),
            el('span', { class: 'token__pinyin', text: item.record.pinyin }),
            el('span', { class: 'small faint', text: formatPercent(item.record.mastery) }),
          )),
        ),
      )
      : null,

    el('section', { class: 'section' },
      el('div', { class: 'section__head' },
        el('h2', { class: 'section__title', text: 'Training history' }),
        el('span', { class: 'section__hint', text: `${sessions.length} session${sessions.length === 1 ? '' : 's'} shown` }),
      ),
      sessions.length
        ? el('div', { class: 'card card--flush' },
          el('div', { class: 'table-wrap' },
            el('table', { class: 'table' },
              el('thead', {},
                el('tr', {},
                  el('th', { text: 'When' }),
                  el('th', { text: 'Score' }),
                  el('th', { text: 'Correct' }),
                  el('th', { text: 'Avg. word' }),
                  el('th', { text: 'Speed' }),
                  el('th', { text: 'Levels' }),
                  el('th', { text: '' }),
                ),
              ),
              el('tbody', {},
                ...sessions.map((session) => el('tr', {},
                  el('td', {},
                    el('a', { href: `#/training/results/${session.id}`, text: formatRelative(session.finishedAt) }),
                    el('div', { class: 'small faint', text: formatDate(session.finishedAt) }),
                  ),
                  el('td', {}, badge(formatPercent(session.accuracy), session.accuracy >= 0.8 ? 'success' : session.accuracy >= 0.6 ? 'warning' : 'danger')),
                  el('td', { class: 'num', text: `${session.correct}/${session.total}` }),
                  el('td', { class: 'num faint', text: formatDuration(session.avgResponseMs) }),
                  el('td', { class: 'num faint', text: `${(session.charsPerMinute || 0).toFixed(0)} c/m` }),
                  el('td', { class: 'small faint', text: (session.config?.levels || []).join(', ') || 'all' }),
                  el('td', {},
                    el('button', {
                      type: 'button',
                      class: 'btn btn--ghost btn--sm',
                      title: 'Delete this session',
                      onClick: async () => {
                        const ok = await confirmDialog({
                          title: 'Delete this session?',
                          message: 'The answers are removed from your history. Per-word mastery is not recalculated.',
                          confirmLabel: 'Delete',
                          danger: true,
                        });
                        if (ok) { deleteSession(session.id); toast('Session deleted', { type: 'info' }); renderProgress(outlet); }
                      },
                    }, icon('trash')),
                  ),
                )),
              ),
            ),
          ),
        )
        : el('div', { class: 'card' }, emptyState({ title: 'No sessions in this range', iconName: 'history' })),
    ),

    el('section', { class: 'section' },
      el('div', { class: 'section__head' },
        el('h2', { class: 'section__title', text: 'Danger zone' }),
      ),
      el('div', { class: 'card card--quiet' },
        notice('Resetting clears every session and per-word mastery score. Your settings and saved library words are kept.', { type: 'warning' }),
        el('div', { class: 'row' },
          el('button', {
            type: 'button',
            class: 'btn btn--danger btn--sm',
            onClick: async () => {
              const ok = await confirmDialog({
                title: 'Reset all progress?',
                message: 'This deletes every session, answer and mastery score. It cannot be undone.',
                confirmLabel: 'Reset progress',
                danger: true,
              });
              if (ok) { resetProgress(); toast('Progress reset', { type: 'success' }); renderProgress(outlet); }
            },
          }, icon('trash'), el('span', { text: 'Reset progress' })),
        ),
      ),
    ),

    dataFootnote(),
  );

  return undefined;
}

function filterByRange(sessions, range) {
  if (range === 'all') return sessions;
  const days = Number(range);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter((session) => (session.finishedAt || session.startedAt || 0) >= cutoff);
}
