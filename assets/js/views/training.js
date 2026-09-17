/* ==========================================================================
   views/training.js — difficulty setup, the drill itself, and session results.
   ========================================================================== */

import {
  el, mount, icon, toast, formatDuration, formatClock, formatPercent,
  formatDate, badge, progressBar, emptyState, notice, confirmDialog, segmented, switchField, statTile,
} from '../ui.js';
import {
  getSettings, updateSettings, getProgress, getSessions, saveSession,
  getActiveSession, setActiveSession,
} from '../store.js';
import {
  awaitData, displayWord, dataFootnote,
} from './shared.js';
import {
  getLevelCounts, getCategoryCounts, sampleWords, filterWords, wordCount, getWordsForSession,
} from '../dictionary.js';
import { checkAnswer, describeIssue, splitSyllables, encodeSyllable } from '../pinyin.js';
import { summary, scoreLabel, slowestAnswers, WEAK_THRESHOLD } from '../stats.js';
import { navigate } from '../router.js';
import { setTopbarActions } from '../app-shell.js';

const TONE_KEYS = ['ā', 'á', 'ǎ', 'à', 'ē', 'é', 'ě', 'è', 'ī', 'í', 'ǐ', 'ì', 'ō', 'ó', 'ǒ', 'ò', 'ū', 'ú', 'ǔ', 'ù', 'ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü', '·'];
const ENDLESS_POOL = 240;

/* ======================================================================== */
/* 1. Setup screen                                                          */
/* ======================================================================== */

export async function renderTrainingSetup(outlet) {
  setTopbarActions();
  if (!(await awaitData(outlet))) return undefined;

  const settings = getSettings();
  const draft = {
    levels: [...(settings.levels || [1, 2])],
    categories: [...(settings.categories || [])],
    sessionSize: settings.sessionSize,
    requireTones: settings.requireTones,
    strictU: settings.strictU,
    autoAdvance: settings.autoAdvance,
    focusWeak: settings.focusWeak !== false,
  };

  const levelCounts = getLevelCounts();
  const categoryCounts = getCategoryCounts();
  const progress = getProgress();
  const stats = summary(getSessions(), progress);
  const previewHost = el('div', { class: 'card__body' });

  function filteredCount() {
    return filterWords({ levels: draft.levels, categories: draft.categories }).length;
  }

  function updatePreview() {
    const available = filteredCount();
    const size = draft.sessionSize === 0 ? ENDLESS_POOL : draft.sessionSize;
    const weak = Object.values(progress).filter(
      (p) => p.attempts >= 2 && p.mastery < WEAK_THRESHOLD,
    ).length;

    mount(previewHost,
      el('div', { class: 'row row--between' },
        el('div', {},
          el('div', { class: 'tile__value', text: available.toLocaleString() }),
          el('div', { class: 'tile__meta', text: 'words match these filters' }),
        ),
        el('div', {},
          el('div', { class: 'tile__value', text: draft.sessionSize === 0 ? '∞' : String(draft.sessionSize) }),
          el('div', { class: 'tile__meta', text: draft.sessionSize === 0 ? 'endless session' : 'words in this session' }),
        ),
      ),
      draft.focusWeak && weak > 0
        ? notice(`${weak} weak ${weak === 1 ? 'word is' : 'words are'} mixed in more often while focus mode is on.`, { type: 'info', iconName: 'target' })
        : null,
      available === 0
        ? notice('No words match these filters. Raise the number of levels or clear some categories.', { type: 'warning' })
        : null,
      available > 0 && available < size
        ? notice(`Only ${available} words are available, so the session will be shorter than requested.`, { type: 'warning' })
        : null,
    );
    startButton.disabled = available === 0;
  }

  function toggleLevel(level, checked) {
    draft.levels = checked
      ? [...new Set([...draft.levels, level])].sort((a, b) => a - b)
      : draft.levels.filter((l) => l !== level);
    updatePreview();
  }

  function toggleCategory(id, checked) {
    draft.categories = checked
      ? [...new Set([...draft.categories, id])]
      : draft.categories.filter((c) => c !== id);
    updatePreview();
  }

  const startButton = el('button', {
    type: 'button',
    class: 'btn btn--primary btn--lg',
    onClick: () => startSession(draft),
  }, icon('play'), el('span', { text: 'Start training' }));

  const levelOptions = el('div', { class: 'settings-grid' },
    ...levelCounts.map((level) => el('label', { class: 'level-option' },
      el('input', {
        type: 'checkbox',
        checked: draft.levels.includes(level.id),
        onChange: (event) => toggleLevel(level.id, event.target.checked),
      }),
      el('span', { class: 'level-option__check' }, icon('check')),
      el('span', { class: 'level-option__body' },
        el('span', { class: 'level-option__title' },
          el('span', { text: `Level ${level.id} · ${level.name}` }),
          badge(`${level.count}`, 'outline'),
        ),
        el('span', { class: 'level-option__desc', text: level.desc }),
      ),
    )),
  );

  const categoryChips = el('div', { class: 'chips' },
    el('label', { class: 'chip' },
      el('input', {
        type: 'checkbox',
        checked: draft.categories.length === 0,
        onChange: () => { draft.categories = []; mountCategoryChips(); updatePreview(); },
      }),
      el('span', { text: 'All categories' }),
    ),
    ...categoryCounts.map((category) => el('label', { class: 'chip' },
      el('input', {
        type: 'checkbox',
        checked: draft.categories.includes(category.id),
        onChange: (event) => { toggleCategory(category.id, event.target.checked); mountCategoryChips(); },
      }),
      el('span', { text: category.label }),
      el('span', { class: 'chip__count', text: String(category.count) }),
    )),
  );

  function mountCategoryChips() {
    const first = categoryChips.querySelector('input');
    if (first) first.checked = draft.categories.length === 0;
    categoryChips.querySelectorAll('.chip').forEach((chip, index) => {
      if (index === 0) return;
      const input = chip.querySelector('input');
      const category = categoryCounts[index - 1];
      if (input && category) input.checked = draft.categories.includes(category.id);
    });
  }

  mount(outlet,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Pinyin training' }),
        el('p', { class: 'page-head__desc' },
          'A random Chinese word appears; type its pinyin and press Enter. Tone marks, tone numbers and plain letters are all accepted — ',
          'whether tones are required is your choice below.',
        ),
      ),
      el('div', { class: 'page-head__actions' },
        el('button', {
          type: 'button',
          class: 'btn',
          onClick: () => startSession({ ...draft, levels: [], categories: [], sessionSize: 10, focusWeak: true }),
        }, icon('sparkle'), el('span', { text: 'Quick 10' })),
      ),
    ),

    stats.answered > 0
      ? el('div', { class: 'grid grid--4' },
        statTile({ label: 'Accuracy so far', value: formatPercent(stats.accuracy), iconName: 'target', accent: true }),
        statTile({ label: 'Words practised', value: stats.practiced.toLocaleString(), iconName: 'book2' }),
        statTile({ label: 'Weak words', value: stats.weak, iconName: 'alert', meta: 'worth drilling' }),
        statTile({ label: 'Sessions', value: stats.sessions, iconName: 'history', meta: stats.streakDays > 1 ? `${stats.streakDays}-day streak` : undefined }),
      )
      : null,

    el('div', { class: 'grid grid--2' },
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: '1 · Difficulty' }),
            el('div', { class: 'card__sub', text: 'Words are grouped by corpus frequency plus a curated beginner list.' }),
          ),
        ),
        levelOptions,
      ),

      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: '2 · Word types' }),
            el('div', { class: 'card__sub', text: 'Optional: restrict the drill to particular parts of speech.' }),
          ),
        ),
        categoryChips,
      ),
    ),

    el('div', { class: 'grid grid--2' },
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: '3 · Session' }),
            el('div', { class: 'card__sub', text: 'How long the drill runs and how strict it is.' }),
          ),
        ),
        el('div', { class: 'field' },
          el('span', { class: 'field__label', text: 'Length' }),
          segmented('session-size', [
            { value: 10, label: '10' },
            { value: 20, label: '20' },
            { value: 50, label: '50' },
            { value: 0, label: 'Endless', hint: 'Keep going until you stop' },
          ], draft.sessionSize, (value) => { draft.sessionSize = Number(value); updatePreview(); }),
        ),
        el('div', { class: 'field' },
          el('span', { class: 'field__label', text: 'Marking' }),
          el('div', { class: 'stack stack--sm' },
            switchField({
              title: 'Require tones',
              desc: 'xuéxiào must be typed with tones. Turn off to accept xuexiao.',
              checked: draft.requireTones,
              onChange: (value) => { draft.requireTones = value; updatePreview(); },
            }),
            switchField({
              title: 'Require ü (as v)',
              desc: 'Off: lu and lü are treated the same. On: 绿 must be typed lü or lv.',
              checked: draft.strictU,
              onChange: (value) => { draft.strictU = value; },
            }),
            switchField({
              title: 'Focus on weak words',
              desc: 'Words you keep missing come up more often.',
              checked: draft.focusWeak,
              onChange: (value) => { draft.focusWeak = value; updatePreview(); },
            }),
            switchField({
              title: 'Auto-advance',
              desc: 'Move to the next word automatically after each answer.',
              checked: draft.autoAdvance,
              onChange: (value) => { draft.autoAdvance = value; },
            }),
          ),
        ),
      ),

      el('section', { class: 'card card--accent' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: '4 · Ready' }),
            el('div', { class: 'card__sub', text: 'Your choices are remembered for the next session.' }),
          ),
        ),
        previewHost,
        el('div', { class: 'card__foot' }, startButton),
        dataFootnote(),
      ),
    ),
  );

  updatePreview();

  if (wordCount() === 0) {
    mount(outlet, notice('The dictionary is empty, so training cannot start.', { type: 'danger' }));
  }

  return undefined;
}

/* ======================================================================== */
/* 2. Drill                                                                 */
/* ======================================================================== */

function buildQueue(filters, size, focusWeak) {
  const progress = getProgress();
  const count = size === 0 ? ENDLESS_POOL : size;
  return sampleWords(count, filters, { progress, focusWeak });
}
/**
 * Start a new drill. `wordList` overrides sampling (used by "practise missed").
 * The word source is the database when the backend is connected, otherwise the
 * in-browser seed list.
 */
export async function startSession(config, wordList = null) {
  const settings = getSettings();
  const filters = { levels: config.levels, categories: config.categories };
  const focusWeak = config.focusWeak !== false;

  let queue;
  let wordSource;
  if (wordList && wordList.length) {
    queue = [...wordList];
    wordSource = 'given';
  } else {
    const result = await getWordsForSession(
      filters,
      config.sessionSize ?? settings.sessionSize,
      { focusWeak, progress: getProgress() },
    );
    queue = result.words;
    wordSource = result.source;
    if (result.error) {
      toast('Backend word list unavailable — using the local seed list.', { type: 'warning' });
    }
  }

  if (!queue.length) {
    toast('No words match those filters.', { type: 'danger' });
    return;
  }

  // remember the choices as the new defaults
  updateSettings({
    levels: config.levels,
    categories: config.categories,
    sessionSize: config.sessionSize,
    requireTones: config.requireTones,
    strictU: config.strictU,
    autoAdvance: config.autoAdvance,
    focusWeak: config.focusWeak,
  });

  setActiveSession({
    id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    startedAt: Date.now(),
    config: {
      levels: config.levels,
      categories: config.categories,
      size: config.sessionSize,
      requireTones: config.requireTones,
      strictU: config.strictU,
      focusWeak,
      script: settings.script,
      endless: config.sessionSize === 0,
      wordSource,
    },
    queue,
    cursor: 0,
    answers: [],
    current: queue[0],
    shownAt: Date.now(),
    hintUsed: false,
    submitted: null,
    filters,
  });

  navigate('/training/session');
}

export async function renderTrainingSession(outlet) {
  const session = getActiveSession();
  if (!session) {
    mount(outlet, notice('No session is running.', { type: 'info' }));
    navigate('/training');
    return undefined;
  }
  if (!(await awaitData(outlet))) return undefined;

  const settings = getSettings();
  const total = session.config.endless ? 0 : session.queue.length;

  let input;
  let stage;
  let feedbackHost;
  let timerHandle = null;
  let advanceHandle = null;
  let finished = false;

  const stageWord = el('div', { class: 'drill__word' });
  const stageTraditional = el('div', { class: 'drill__traditional hidden' });
  const stageMeta = el('div', { class: 'drill__meta' });
  const stageReveal = el('div', { class: 'drill__revealed hidden' });
  const answerRow = el('div', { class: 'drill__answer' });
  const keypad = el('div', { class: 'keypad' });
  const progressLabel = el('span', { class: 'small muted' });
  const accuracyLabel = el('strong', { text: '—' });
  const streakLabel = el('strong', { text: '0' });
  const timeLabel = el('strong', { text: '00:00' });
  const barHost = el('div', { style: { flex: '1', minWidth: '120px' } });

  const submitButton = el('button', {
    type: 'button',
    class: 'btn btn--primary',
    onClick: () => onSubmit(),
  }, el('span', { text: 'Submit' }), el('kbd', { class: 'kbd', text: 'Enter' }));

  const nextButton = el('button', {
    type: 'button',
    class: 'btn btn--primary hidden',
    onClick: () => nextWord(),
  }, el('span', { text: 'Next word' }), icon('arrowRight'));

  const hintButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost',
    title: 'Reveal the pinyin (counts as a miss)',
    onClick: () => useHint(),
  }, icon('eye'), el('span', { text: 'Hint' }));

  const skipButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost',
    onClick: () => recordAnswer({ skipped: true }),
  }, el('span', { text: 'Skip' }));

  const endButton = el('button', {
    type: 'button',
    class: 'btn btn--outline',
    onClick: () => endSession(),
  }, el('span', { text: 'End session' }));

  const soundButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    title: 'Toggle answer sounds',
    onClick: () => {
      const next = !getSettings().sound;
      updateSettings({ sound: next });
      toast(next ? 'Sound on' : 'Sound off', { type: 'info', timeout: 1200 });
    },
  }, icon(getSettings().sound ? 'sparkle' : 'x'));

  /* ------------------------------------------------------------ render -- */

  function currentWord() {
    return session.queue[session.cursor] || null;
  }

  function renderStage() {
    const word = currentWord();
    if (!word) return;
    const display = displayWord(word, session.config.script);
    stageWord.textContent = display.main;
    stageTraditional.textContent = display.sub;
    stageTraditional.classList.toggle('hidden', !display.sub);

    mount(stageMeta,
      badge(`Level ${word.lv}`, 'accent'),
      badge(`${word.s.length} ${word.s.length === 1 ? 'character' : 'characters'}`, 'outline'),
      badge(word.c, 'outline'),
      session.config.wordSource === 'server'
        ? badge('database', 'success')
        : null,
    );

    const revealNow = settings.revealPinyin === 'always';
    stageReveal.textContent = revealNow ? word.p : '';
    stageReveal.classList.toggle('hidden', !revealNow);
  }

  function renderProgress() {
    const answered = session.answers.length;
    progressLabel.textContent = total
      ? `Word ${Math.min(session.cursor + 1, total)} of ${total}`
      : `Word ${session.cursor + 1} · endless`;
    mount(barHost, total
      ? progressBar(answered / total, { label: `${answered}/${total}` })
      : el('div', { class: 'small faint', text: `${answered} answered` }));

    const correct = session.answers.filter((a) => a.isCorrect).length;
    accuracyLabel.textContent = answered ? formatPercent(correct / answered) : '—';
    let streak = 0;
    for (let i = session.answers.length - 1; i >= 0; i -= 1) {
      if (!session.answers[i].isCorrect) break;
      streak += 1;
    }
    streakLabel.textContent = String(streak);
  }

  function renderAnswerRow() {
    const toneHint = settings.toneInput;
    mount(answerRow,
      el('div', { class: 'drill__inputrow' },
        input,
        submitButton,
        nextButton,
      ),
      toneHint === 'numbers'
        ? el('div', { class: 'small faint', text: 'Type tone numbers after each syllable, e.g. xue2xiao4. Neutral tone can be left off or written 5.' })
        : keypad,
      el('div', { class: 'row row--between' },
        el('div', { class: 'row' }, hintButton, skipButton),
        el('div', { class: 'row' }, soundButton),
      ),
    );
  }

  mount(keypad,
    ...TONE_KEYS.map((key) => el('button', {
      type: 'button',
      class: 'keypad__key',
      text: key,
      title: 'Insert into the answer',
      onClick: () => insertAtCursor(key),
    })),
  );

  input = el('input', {
    type: 'text',
    class: 'input drill__input',
    id: 'drill-input',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'pīnyīn…',
    'aria-label': 'Type the pinyin',
    onKeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (session.submitted) nextWord();
        else onSubmit();
        return;
      }
      if (event.key === 'Tab' && !event.shiftKey && getSettings().toneInput === 'numbers') return;
      if (event.key === 'Escape') endSession();
    },
    onInput: () => {
      input.dataset.state = '';
    },
  });

  stage = el('div', { class: 'drill__stage', id: 'drill-stage' }, stageWord, stageTraditional, stageReveal, stageMeta);
  feedbackHost = el('div', { id: 'drill-feedback' });

  mount(outlet,
    el('div', { class: 'drill' },
      el('div', { class: 'drill__bar' },
        el('div', { class: 'drill__stats' },
          el('span', { class: 'drill__stat' }, el('span', { class: 'muted', text: 'Accuracy ' }), accuracyLabel),
          el('span', { class: 'drill__stat' }, el('span', { class: 'muted', text: 'Streak ' }), streakLabel),
          session.config.endless || getSettings().showTimer
            ? el('span', { class: 'drill__stat' }, el('span', { class: 'muted', text: 'Time ' }), timeLabel)
            : null,
        ),
        el('div', { class: 'spacer' }),
        progressLabel,
        endButton,
      ),
      barHost,
      stage,
      answerRow,
      feedbackHost,
      el('p', { class: 'faint small center' },
        'Press Enter to check · Esc to end the session · tones may be typed as marks (ǎ) or numbers (a3)',
      ),
    ),
  );

  renderStage();
  renderProgress();
  renderAnswerRow();
  renderFeedback(null);
  input.focus();

  /* ------------------------------------------------------------ timing -- */

  const startedAt = Date.now();
  timerHandle = setInterval(() => {
    timeLabel.textContent = formatClock(Date.now() - startedAt);
  }, 500);
  timeLabel.textContent = '00:00';
  session.shownAt = Date.now();

  /* ------------------------------------------------------------- logic -- */

  function insertAtCursor(text) {
    if (session.submitted) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.focus();
  }

  function renderFeedback(result, answer) {
    if (!result) {
      mount(feedbackHost, el('div', { class: 'feedback' },
        icon('info', 'feedback__icon'),
        el('div', { class: 'feedback__body' },
          el('span', { class: 'feedback__detail', text: 'Tone marks (ā á ǎ à) may be typed with the keys above, or as numbers: xue2xiao4.' }),
        ),
      ));
      return;
    }

    const word = currentWord();
    const correct = result.correct;
    const syllables = splitSyllables(word?.p || '');
    const issues = new Map((result.issues || []).map((issue) => [issue.index, issue]));
    // A skipped or hinted answer has no per-syllable diagnosis, so mark every
    // syllable as missed rather than showing a misleading all-clear strip.
    const nothingDiagnosed = issues.size === 0;

    const strip = syllables.length
      ? el('div', { class: 'syllable-strip' },
        ...syllables.map((syllable, index) => {
          const issue = issues.get(index);
          const bad = !correct && (issue || nothingDiagnosed);
          return el('div', { class: `syllable ${bad ? 'syllable--bad' : 'syllable--ok'}` },
            el('span', { class: 'syllable__index', text: String(index + 1) }),
            el('span', { text: syllable.display || encodeSyllable(syllable.base, syllable.tone) }),
            issue ? el('span', { class: 'syllable__index', text: issue.kind === 'tone' || issue.kind === 'missing-tones' ? 'tone' : 'letters' }) : null,
          );
        }),
      )
      : null;

    const detailParts = [];
    if (answer?.hintUsed) detailParts.push('You revealed the answer.');
    if (answer?.skipped) detailParts.push('Skipped.');
    if (result.noTonesTyped) detailParts.push('No tones were given, and this drill requires them.');
    else if (result.issues?.length) detailParts.push(describeIssue(result.issues[0], syllables));

    mount(feedbackHost,
      el('div', { class: `feedback ${correct ? 'feedback--correct' : 'feedback--incorrect'}` },
        icon(correct ? 'check' : 'x', 'feedback__icon'),
        el('div', { class: 'feedback__body' },
          el('span', { class: 'feedback__title', text: correct ? 'Correct' : 'Not quite' }),
          el('span', { class: 'feedback__answer' },
            correct
              ? word.p
              : el('span', {},
                answer?.userAnswer ? el('del', { text: answer.userAnswer }) : el('span', { class: 'muted', text: '(blank)' }),
                el('span', { text: '  →  ' }),
                el('strong', { text: word.p }),
              ),
          ),
          detailParts.length ? el('span', { class: 'feedback__detail', text: detailParts.join(' ') }) : null,
          strip,
        ),
      ),
    );
  }

  function onSubmit() {
    if (finished) return;
    if (session.submitted) { nextWord(); return; }
    const value = input.value.trim();
    if (!value) {
      input.classList.add('input--invalid');
      toast('Type the pinyin first, or press Skip.', { type: 'warning', timeout: 1600 });
      input.focus();
      return;
    }
    recordAnswer({ userAnswer: value });
  }

  function useHint() {
    if (session.submitted) return;
    const word = currentWord();
    session.hintUsed = true;
    stageReveal.textContent = word.p;
    stageReveal.classList.remove('hidden');
    hintButton.disabled = true;
    toast('Hint shown — this counts as a miss.', { type: 'warning', timeout: 1800 });
  }

  function recordAnswer({ userAnswer = '', skipped = false } = {}) {
    if (finished || session.submitted) return;
    const word = currentWord();
    if (!word) return;

    const hintUsed = session.hintUsed;
    const result = skipped || hintUsed
      ? { correct: false, issues: [], expected: word.p }
      : checkAnswer(userAnswer, word.p, {
        alternatives: word.a || '',
        requireTones: session.config.requireTones,
        strictU: session.config.strictU,
      });

    const isCorrect = Boolean(result.correct) && !skipped && !hintUsed;
    const responseTimeMs = Date.now() - session.shownAt;

    const answer = {
      wordId: word.id,
      word: word.s,
      traditional: word.t || null,
      expected: word.p,
      userAnswer: userAnswer || (skipped ? '' : input.value.trim()),
      isCorrect,
      skipped,
      hintUsed,
      responseTimeMs,
      at: Date.now(),
      level: word.lv,
      category: word.c,
    };

    session.answers.push(answer);
    session.submitted = { answer, result };

    stage.dataset.state = isCorrect ? 'correct' : 'incorrect';
    input.dataset.state = isCorrect ? 'correct' : 'incorrect';
    input.disabled = true;
    submitButton.classList.add('hidden');
    nextButton.classList.remove('hidden');
    nextButton.focus({ preventScroll: true });
    hintButton.disabled = true;
    skipButton.disabled = true;

    renderFeedback(result, answer);
    renderProgress();
    playFeedbackSound(isCorrect);

    const isLast = !session.config.endless && session.cursor + 1 >= session.queue.length;
    if (getSettings().autoAdvance) {
      advanceHandle = setTimeout(() => {
        if (isLast) finishSession();
        else nextWord();
      }, getSettings().autoAdvanceDelay);
    } else if (isLast) {
      nextButton.querySelector('span').textContent = 'See results';
    }
  }

  function nextWord() {
    if (advanceHandle) { clearTimeout(advanceHandle); advanceHandle = null; }
    if (!session.config.endless && session.cursor + 1 >= session.queue.length) {
      finishSession();
      return;
    }
    session.cursor += 1;
    session.submitted = null;
    session.hintUsed = false;
    session.shownAt = Date.now();

    if (session.config.endless && session.cursor >= session.queue.length - 8) {
      // Top up an endless session so the learner never runs out. Fetched in the
      // background; running low is impossible because we stay 8 words ahead.
      getWordsForSession(session.filters, 60, { focusWeak: session.config.focusWeak })
        .then(({ words }) => {
          const recent = new Set(session.queue.slice(-40).map((word) => word.s));
          session.queue.push(...words.filter((word) => !recent.has(word.s)));
        })
        .catch((error) => console.warn('[training] could not top up the queue', error));
    }

    stage.dataset.state = '';
    input.value = '';
    input.dataset.state = '';
    input.disabled = false;
    input.classList.remove('input--invalid');
    submitButton.classList.remove('hidden');
    nextButton.classList.add('hidden');
    hintButton.disabled = false;
    skipButton.disabled = false;

    renderStage();
    renderProgress();
    renderFeedback(null);
    input.focus();
  }

  async function endSession() {
    if (finished) return;
    if (session.answers.length === 0) {
      const quit = await confirmDialog({
        title: 'Leave the session?',
        message: 'You have not answered any words yet, so nothing will be recorded.',
        confirmLabel: 'Leave',
        danger: true,
      });
      if (!quit) return;
      setActiveSession(null);
      navigate('/training');
      return;
    }
    const quit = await confirmDialog({
      title: 'End this session?',
      message: `You have answered ${session.answers.length} ${session.answers.length === 1 ? 'word' : 'words'}. The session will be saved with the results so far.`,
      confirmLabel: 'End and save',
    });
    if (!quit) return;
    finishSession();
  }

  function finishSession() {
    if (finished) return;
    finished = true;
    if (advanceHandle) clearTimeout(advanceHandle);
    if (timerHandle) clearInterval(timerHandle);
    session.finishedAt = Date.now();
    const record = saveSession({ ...session, id: session.id, startedAt: session.startedAt });
    setActiveSession(null);
    navigate(`/training/results/${record.id}`);
  }

  function playFeedbackSound(isCorrect) {
    if (!getSettings().sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = isCorrect ? 740 : 240;
      gain.gain.value = 0.045;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (isCorrect ? 0.11 : 0.2));
      setTimeout(() => ctx.close().catch(() => {}), 400);
    } catch { /* audio is a nicety, never fatal */ }
  }

  /* ----------------------------------------------------------- cleanup -- */

  return () => {
    if (timerHandle) clearInterval(timerHandle);
    if (advanceHandle) clearTimeout(advanceHandle);
  };
}

/* ======================================================================== */
/* 3. Results                                                               */
/* ======================================================================== */

export async function renderTrainingResults(outlet, params) {
  if (!(await awaitData(outlet))) return undefined;

  const session = getSessions().find((s) => s.id === params.id);
  if (!session) {
    mount(outlet, emptyState({
      title: 'Session not found',
      text: 'That session is not in local storage. It may have been cleared.',
      iconName: 'alert',
      action: el('a', { class: 'btn btn--primary', href: '#/training', text: 'Start a new session' }),
    }));
    return undefined;
  }

  const answers = session.answers || [];
  const missed = answers.filter((a) => !a.isCorrect);
  const duration = Math.max(0, (session.finishedAt || 0) - (session.startedAt || 0));
  const accuracy = session.total ? session.correct / session.total : 0;
  const toneMisses = missed.filter((a) => {
    const graded = checkAnswer(a.userAnswer || '', a.expected, { requireTones: true, alternatives: '' });
    return !graded.correct && graded.issues?.some((i) => i.kind === 'tone' || i.kind === 'missing-tones');
  }).length;

  const misconception = [];
  if (toneMisses > 0) misconception.push(`${toneMisses} of the misses were tone errors rather than wrong letters`);
  if (answers.some((a) => a.hintUsed)) misconception.push('at least one answer used a hint');
  if (answers.some((a) => a.skipped)) misconception.push('some words were skipped');

  setTopbarActions(
    el('button', {
      type: 'button',
      class: 'btn btn--sm',
      onClick: () => {
        const config = getSettings();
        startSession({
          levels: config.levels,
          categories: config.categories,
          sessionSize: config.sessionSize,
          requireTones: config.requireTones,
          strictU: config.strictU,
          autoAdvance: config.autoAdvance,
          focusWeak: config.focusWeak,
        });
      },
    }, icon('refresh'), el('span', { text: 'New session' })),
  );

  const missedWords = missed
    .map((a) => ({ word: { s: a.word, t: a.traditional, p: a.expected, id: a.wordId }, answer: a }))
    .filter((item) => item.word.s);

  mount(outlet,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Session results' }),
        el('p', { class: 'page-head__desc' },
          `${formatDate(session.finishedAt)} · ${formatDuration(duration)} · levels ${(session.config.levels || []).join(', ') || 'all'}`,
        ),
      ),
    ),

    el('div', { class: 'grid grid--4' },
      statTile({ label: 'Score', value: formatPercent(accuracy), iconName: 'award', accent: true, meta: scoreLabel(accuracy) }),
      statTile({ label: 'Correct', value: `${session.correct}/${session.total}`, iconName: 'check', meta: `${missed.length} missed` }),
      statTile({ label: 'Avg. per word', value: formatDuration(session.avgResponseMs || 0), iconName: 'timer' }),
      statTile({ label: 'Typing speed', value: (session.charsPerMinute || 0).toFixed(0), unit: 'chars/min', iconName: 'keyboard' }),
    ),

    misconception.length
      ? notice(`What to work on: ${misconception.join('; ')}.`, { type: 'info', iconName: 'target' })
      : null,

    el('div', { class: 'row' },
      missedWords.length
        ? el('button', {
          type: 'button',
          class: 'btn btn--primary',
          onClick: () => {
            const config = getSettings();
            startSession({
              levels: config.levels,
              categories: config.categories,
              sessionSize: missedWords.length,
              requireTones: config.requireTones,
              strictU: config.strictU,
              autoAdvance: config.autoAdvance,
              focusWeak: false,
            }, missedWords.map((item) => item.word));
          },
        }, icon('target'), el('span', { text: `Practise the ${missedWords.length} missed ${missedWords.length === 1 ? 'word' : 'words'}` }))
        : null,
      el('a', { class: 'btn', href: '#/progress' }, icon('chart'), el('span', { text: 'View progress' })),
      el('a', { class: 'btn btn--ghost', href: '#/training' }, el('span', { text: 'Back to training' })),
    ),

    el('section', { class: 'section' },
      el('div', { class: 'section__head' },
        el('h2', { class: 'section__title', text: 'Every answer' }),
        el('span', { class: 'section__hint', text: 'Missed words are listed first' }),
      ),
      el('div', { class: 'card card--flush' },
        el('div', { class: 'table-wrap' },
          el('table', { class: 'table' },
            el('thead', {},
              el('tr', {},
                el('th', { text: '#' }),
                el('th', { text: 'Word' }),
                el('th', { text: 'Your answer' }),
                el('th', { text: 'Correct pinyin' }),
                el('th', { text: 'Result' }),
                el('th', { text: 'Time' }),
              ),
            ),
            el('tbody', {},
              ...[...answers].sort((a, b) => Number(a.isCorrect) - Number(b.isCorrect)).map((answer, index) => {
                const display = displayWord({ s: answer.word, t: answer.traditional });
                return el('tr', {},
                  el('td', { class: 'faint', text: String(index + 1) }),
                  el('td', {},
                    el('span', { class: 'cjk', text: display.main }),
                    display.sub ? el('span', { class: 'small muted', text: ` ${display.sub}` }) : null,
                  ),
                  el('td', { class: 'pinyin', text: answer.userAnswer || '—' }),
                  el('td', { class: 'pinyin text-accent', text: answer.expected }),
                  el('td', {},
                    answer.isCorrect
                      ? badge('correct', 'success')
                      : badge(answer.skipped ? 'skipped' : answer.hintUsed ? 'hint' : 'wrong', 'danger'),
                  ),
                  el('td', { class: 'num faint', text: formatDuration(answer.responseTimeMs) }),
                );
              }),
            ),
          ),
        ),
      ),
    ),

    slowestAnswers(session, 5).length > 1
      ? el('section', { class: 'section' },
        el('h2', { class: 'section__title', text: 'Slowest words' }),
        el('div', { class: 'row' },
          ...slowestAnswers(session, 6).map((answer) => el('div', { class: 'token' },
            el('span', { class: 'token__cjk', text: answer.word }),
            el('span', { class: 'token__pinyin', text: answer.expected }),
            el('span', { class: 'small faint', text: formatDuration(answer.responseTimeMs) }),
          )),
        ),
      )
      : null,
  );

  return undefined;
}
