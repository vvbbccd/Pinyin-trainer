/* ==========================================================================
   views/dashboard.js — home screen: start training, quick links, at-a-glance stats.
   ========================================================================== */

import {
  el, mount, icon, formatPercent, formatDuration, formatRelative, statTile,
  emptyState, notice, badge,
} from '../ui.js';
import { getSettings, getSessions, getProgress, getLibrary } from '../store.js';
import { awaitData, displayWord, dataFootnote } from './shared.js';
import { wordCount, charCount, randomWord, applyScript } from '../dictionary.js';
import { summary, accuracyTrend, weakWordList, dailyActivity, scoreLabel } from '../stats.js';
import { startSession } from './training.js';
import { setTopbarActions } from '../app-shell.js';

export async function renderDashboard(outlet) {
  if (!(await awaitData(outlet))) return undefined;

  const settings = getSettings();
  const sessions = getSessions();
  const progress = getProgress();
  const library = getLibrary();
  const stats = summary(sessions, progress);
  const weak = weakWordList(progress, { limit: 5 });
  const activity = dailyActivity(sessions, 14);
  const trend = accuracyTrend(sessions, 12);
  const sample = randomWord({ levels: settings.levels?.length ? settings.levels : null }) || randomWord({});
  const sampleDisplay = displayWord(sample, settings.script);

  setTopbarActions(
    el('button', {
      type: 'button',
      class: 'btn btn--primary btn--sm',
      onClick: () => startSession({
        levels: settings.levels,
        categories: settings.categories,
        sessionSize: settings.sessionSize,
        requireTones: settings.requireTones,
        strictU: settings.strictU,
        autoAdvance: settings.autoAdvance,
        focusWeak: settings.focusWeak !== false,
      }),
    }, icon('play'), el('span', { text: 'Start training' })),
  );

  const hasHistory = stats.answered > 0;

  mount(outlet,
    /* hero ------------------------------------------------------------- */
    el('section', { class: 'hero' },
      el('div', { class: 'stack stack--lg' },
        el('div', { class: 'stack stack--sm' },
          el('div', { class: 'hero__eyebrow', text: 'Chinese pinyin typing trainer' }),
          el('h1', { class: 'hero__title' },
            'Type the pinyin, ',
            el('span', { class: 'cjk', text: applyScript('练习拼音', settings.script) }),
          ),
          el('p', { class: 'hero__text' },
            'Random words appear one at a time. Type their pinyin with tone marks, tone numbers or plain letters — ',
            'the trainer tells you exactly which syllable or tone went wrong, and remembers every word you struggle with.',
          ),
        ),
        el('div', { class: 'hero__actions' },
          el('button', {
            type: 'button',
            class: 'btn btn--primary btn--lg',
            onClick: () => startSession({
              levels: settings.levels,
              categories: settings.categories,
              sessionSize: settings.sessionSize,
              requireTones: settings.requireTones,
              strictU: settings.strictU,
              autoAdvance: settings.autoAdvance,
              focusWeak: settings.focusWeak !== false,
            }),
          }, icon('play'), el('span', { text: hasHistory ? 'Continue training' : 'Start training' })),
          el('a', { class: 'btn btn--lg', href: '#/library' }, icon('search'), el('span', { text: 'Look up pinyin' })),
        ),
        el('div', { class: 'row small faint' },
          el('span', { text: `${wordCount().toLocaleString()} words ready` }),
          el('span', { text: '·' }),
          el('span', { text: `${charCount().toLocaleString()} characters` }),
          el('span', { text: '·' }),
          el('span', { text: settings.requireTones ? 'tones required' : 'tones optional' }),
          el('span', { text: '·' }),
          el('span', { text: `${(settings.levels || []).length ? `levels ${settings.levels.join(', ')}` : 'all levels'}` }),
        ),
      ),

      sample
        ? el('div', { class: 'hero__demo' },
          el('div', { class: 'hero__demo-hint', text: 'Example prompt' }),
          el('div', { class: 'hero__demo-word', text: sampleDisplay.main }),
          sampleDisplay.sub ? el('div', { class: 'hero__demo-hint', text: sampleDisplay.sub }) : null,
          el('div', { class: 'hero__demo-pinyin', text: settings.revealPinyin === 'always' ? sample.p : '？ ？ ？' }),
          el('div', { class: 'hero__demo-hint', text: settings.requireTones ? 'answer with tones' : 'tones optional' }),
        )
        : null,
    ),

    /* quick links ------------------------------------------------------ */
    el('div', { class: 'quick-links' },
      quickLink('keyboard', 'Pinyin training', 'Random words at your difficulty', '#/training'),
      quickLink('book', 'Pinyin library', 'Turn any Chinese text into pinyin', '#/library'),
      quickLink('chart', 'Progress', 'Accuracy, speed and weak words', '#/progress'),
      quickLink('settings', 'Settings', 'Tones, script and session defaults', '#/settings'),
    ),

    /* stats ------------------------------------------------------------ */
    hasHistory
      ? el('section', { class: 'section' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', text: 'Your practice' }),
          el('a', { class: 'small', href: '#/progress', text: 'Full progress →' }),
        ),
        el('div', { class: 'grid grid--4' },
          statTile({
            label: 'Accuracy',
            value: formatPercent(stats.accuracy, 1),
            iconName: 'target',
            accent: true,
            meta: scoreLabel(stats.accuracy),
          }),
          statTile({
            label: 'Words practised',
            value: stats.practiced.toLocaleString(),
            iconName: 'book2',
            meta: `${stats.mastered} mastered`,
          }),
          statTile({
            label: 'Avg. per word',
            value: formatDuration(stats.avgResponseMs),
            iconName: 'timer',
            meta: `${(stats.charsPerMinute || 0).toFixed(0)} chars/min`,
          }),
          statTile({
            label: 'Streak',
            value: stats.streakDays,
            unit: stats.streakDays === 1 ? 'day' : 'days',
            iconName: 'flame',
            meta: stats.studiedToday ? 'practised today' : 'not yet today',
          }),
        ),

        el('div', { class: 'grid grid--2' },
          el('section', { class: 'card' },
            el('div', { class: 'card__head' },
              el('div', {},
                el('h3', { class: 'card__title', text: 'Last 14 days' }),
                el('div', { class: 'card__sub', text: 'Each bar is one day; taller means more answered.' }),
              ),
            ),
            el('div', { class: 'activity' },
              ...activity.map((day) => {
                const level = day.answered === 0 ? 0 : day.answered < 10 ? 1 : day.answered < 25 ? 2 : 3;
                return el('div', {
                  class: 'activity__day',
                  dataset: { level: String(level) },
                  style: { height: `${18 + level * 26}%` },
                  title: `${day.date.toLocaleDateString()}: ${day.answered} answered, ${day.sessions} session(s)`,
                });
              }),
            ),
            el('div', { class: 'row row--between small faint' },
              el('span', { text: activity[0]?.date.toLocaleDateString() || '' }),
              el('span', { text: 'today' }),
            ),
          ),

          el('section', { class: 'card' },
            el('div', { class: 'card__head' },
              el('div', {},
                el('h3', { class: 'card__title', text: 'Accuracy trend' }),
                el('div', { class: 'card__sub', text: `Last ${trend.length} session${trend.length === 1 ? '' : 's'}` }),
              ),
            ),
            trend.length
              ? trendChart(trend)
              : emptyState({ title: 'No sessions yet', text: 'Finish a training session to see your trend.', iconName: 'chart' }),
          ),
        ),

        weak.length
          ? el('section', { class: 'card' },
            el('div', { class: 'card__head' },
              el('div', {},
                el('h3', { class: 'card__title', text: 'Words to revisit' }),
                el('div', { class: 'card__sub', text: 'Lowest mastery score first.' }),
              ),
              el('button', {
                type: 'button',
                class: 'btn btn--sm',
                onClick: () => {
                  const config = getSettings();
                  startSession({
                    levels: config.levels,
                    categories: config.categories,
                    sessionSize: weak.length,
                    requireTones: config.requireTones,
                    strictU: config.strictU,
                    autoAdvance: config.autoAdvance,
                    focusWeak: false,
                  }, weak.map((item) => item.word).filter((word) => word && word.s));
                },
              }, icon('target'), el('span', { text: 'Practise these' })),
            ),
            el('div', { class: 'stack stack--sm' },
              ...weak.map((item) => {
                const display = displayWord(item.word, settings.script);
                return el('div', { class: 'weak-row' },
                  el('span', { class: 'weak-row__word cjk', text: display.main }),
                  el('span', { class: 'weak-row__pinyin', text: item.record.pinyin }),
                  el('span', { class: 'small faint', text: `${item.record.correct}/${item.record.attempts} correct` }),
                  el('span', { class: 'spacer' }),
                  badge(`${Math.round(item.record.mastery * 100)}% mastery`, item.record.mastery < 0.35 ? 'danger' : 'warning'),
                );
              }),
            ),
          )
          : null,
      )
      : notice(
        el('div', {},
          el('strong', { text: 'Nothing recorded yet. ' }),
          'Once you finish a session, accuracy, speed, weak words and history appear here — all stored locally in your browser.',
        ),
        { type: 'info', iconName: 'sparkle' },
      ),

    /* recent sessions -------------------------------------------------- */
    sessions.length
      ? el('section', { class: 'section' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', text: 'Recent sessions' }),
          el('a', { class: 'small', href: '#/progress', text: 'All sessions →' }),
        ),
        el('div', { class: 'stack stack--sm' },
          ...sessions.slice(0, 4).map((session) => el('a', {
            class: 'session-card',
            href: `#/training/results/${session.id}`,
            style: { textDecoration: 'none', color: 'inherit' },
          },
            el('span', { class: 'session-card__score', text: formatPercent(session.accuracy) }),
            el('span', { class: 'stack stack--sm' },
              el('span', { class: 'small', text: `${session.correct}/${session.total} correct · ${formatDuration(session.avgResponseMs)} per word` }),
              el('span', { class: 'small faint', text: formatRelative(session.finishedAt) }),
            ),
            el('span', { class: 'spacer' }),
            icon('arrowRight'),
          )),
        ),
      )
      : null,

    /* library teaser --------------------------------------------------- */
    library.saved.length
      ? el('section', { class: 'section' },
        el('div', { class: 'section__head' },
          el('h2', { class: 'section__title', text: 'Saved words' }),
          el('a', { class: 'small', href: '#/library', text: 'Open library →' }),
        ),
        el('div', { class: 'token-list' },
          ...library.saved.slice(0, 12).map((item) => el('div', { class: 'token' },
            el('span', { class: 'token__cjk', text: displayWord(item, settings.script).main }),
            el('span', { class: 'token__pinyin', text: item.p }),
          )),
        ),
      )
      : null,

    dataFootnote(),
  );

  return undefined;
}

function quickLink(iconName, title, desc, href) {
  return el('a', { class: 'quick-link', href },
    el('span', { class: 'quick-link__icon' }, icon(iconName)),
    el('span', { class: 'stack stack--sm' },
      el('span', { class: 'quick-link__title', text: title }),
      el('span', { class: 'quick-link__desc', text: desc }),
    ),
  );
}

/** Small dependency-free SVG line chart. */
export function trendChart(points, { height = 120 } = {}) {
  const width = 560;
  const padX = 34;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = points.map((point, index) => ({
    x: padX + index * step,
    y: padY + innerH * (1 - point.accuracy),
    ...point,
  }));

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${padY + innerH} L${coords[0].x.toFixed(1)},${padY + innerH} Z`;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Accuracy trend across ${points.length} sessions`);

  const mk = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };

  for (const fraction of [0, 0.5, 1]) {
    const y = padY + innerH * (1 - fraction);
    svg.append(mk('line', { class: 'grid-line', x1: padX, x2: width - padX, y1: y, y2: y }));
    const label = mk('text', { class: 'axis-label', x: 4, y: y + 3 });
    label.textContent = `${Math.round(fraction * 100)}%`;
    svg.append(label);
  }

  svg.append(mk('path', { class: 'series-area', d: area, opacity: '0.35' }));
  svg.append(mk('path', { class: 'series', d: line }));
  for (const c of coords) {
    svg.append(mk('circle', {
      class: `dot ${c.accuracy < 0.7 ? 'dot--miss' : ''}`,
      cx: c.x, cy: c.y, r: 3,
    }));
  }

  return el('div', { class: 'stack stack--sm' },
    svg,
    el('div', { class: 'chart-legend' },
      el('span', {}, el('i'), 'session accuracy'),
      el('span', {}, el('i', { class: 'miss' }), 'below 70%'),
    ),
  );
}
