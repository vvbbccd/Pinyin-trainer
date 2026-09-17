/* ==========================================================================
   views/library.js — look up the pinyin of any Chinese text, save words and
   re-run past searches.
   ========================================================================== */

import {
  el, mount, icon, toast, badge, emptyState, notice, confirmDialog, formatRelative, select,
} from '../ui.js';
import {
  getSettings, updateSettings, getLibrary, addLibraryLookup, saveLibraryWord,
  removeSavedWord, isWordSaved, clearLibraryHistory, isServerMode,
} from '../store.js';
import { api } from '../api.js';
import { awaitData, displayWord, dataFootnote } from './shared.js';
import { segmentText, unknownChars, wordsInText, lookupWord, charReadings, applyScript } from '../dictionary.js';
import { toToneNumbers, toToneMarks, splitSyllables } from '../pinyin.js';
import { setTopbarActions } from '../app-shell.js';
import { startSession } from './training.js';

// Stored in simplified; rendered through applyScript so they follow the script setting.
const EXAMPLES = ['你好', '学校', '我喜欢学习汉语', '图书馆在哪里', '天安门广场', '谢谢你的帮助'];

export async function renderLibrary(outlet) {
  if (!(await awaitData(outlet))) return undefined;

  const settings = getSettings();
  let lastResult = null;

  setTopbarActions();

  const input = el('textarea', {
    class: 'textarea input--cjk',
    id: 'library-input',
    rows: '2',
    placeholder: `${applyScript('输入中文', settings.script)}…  e.g. ${applyScript('我喜欢学习汉语', settings.script)}`,
    spellcheck: 'false',
    onKeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        runLookup();
      }
    },
    onInput: () => { clearButton.classList.toggle('hidden', !input.value.trim()); },
  });

  const clearButton = el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm hidden',
    onClick: () => { input.value = ''; clearButton.classList.add('hidden'); input.focus(); },
  }, icon('x'), el('span', { text: 'Clear' }));

  const lookupButton = el('button', {
    type: 'button',
    class: 'btn btn--primary',
    onClick: () => runLookup(),
  }, icon('search'), el('span', { text: 'Look up' }));

  const outputHost = el('div', { class: 'lookup-output', id: 'library-output' });
  const historyHost = el('div', { class: 'stack stack--sm', id: 'library-history' });
  const savedHost = el('div', { class: 'stack stack--sm', id: 'library-saved' });

  mount(outlet,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Pinyin library' }),
        el('p', { class: 'page-head__desc' },
          'Enter Chinese text and get its pinyin. Multi-character words are matched against the dictionary first, ',
          'then anything left over is looked up character by character.',
        ),
      ),
    ),

    el('section', { class: 'card' },
      el('div', { class: 'field' },
        el('label', { class: 'field__label', for: 'library-input', text: 'Chinese text' }),
        input,
        el('div', { class: 'row row--between' },
          el('div', { class: 'row' },
            ...EXAMPLES.map((example) => {
              const shown = applyScript(example, settings.script);
              return el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm cjk',
                text: shown,
                onClick: () => { input.value = shown; clearButton.classList.remove('hidden'); runLookup(); },
              });
            }),
          ),
          el('div', { class: 'row' }, clearButton, lookupButton),
        ),
      ),
      el('div', { class: 'row' },
        el('div', { class: 'field', style: { minWidth: '190px' } },
          el('span', { class: 'field__label', text: 'Pinyin display' }),
          select({
            value: settings.libraryToneDisplay,
            options: [
              { value: 'marks', label: 'Tone marks (xuéxiào)' },
              { value: 'numbers', label: 'Tone numbers (xue2xiao4)' },
              { value: 'plain', label: 'No tones (xue xiao)' },
            ],
            onChange: (value) => {
              updateSettings({ libraryToneDisplay: value });
              if (lastResult) renderResult(lastResult);
            },
          }),
        ),
        el('label', { class: 'chip', style: { alignSelf: 'flex-end' } },
          el('input', {
            type: 'checkbox',
            checked: settings.libraryShowPerChar,
            onChange: (event) => {
              updateSettings({ libraryShowPerChar: event.target.checked });
              if (lastResult) renderResult(lastResult);
            },
          }),
          el('span', { text: 'Show per-character breakdown' }),
        ),
      ),
    ),

    outputHost,

    el('div', { class: 'grid grid--2' },
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: 'Saved words' }),
            el('div', { class: 'card__sub', text: 'Kept in this browser only.' }),
          ),
        ),
        savedHost,
      ),
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: 'Search history' }),
            el('div', { class: 'card__sub', text: 'Your last 60 lookups.' }),
          ),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            onClick: async () => {
              if (!getLibrary().history.length) return;
              const ok = await confirmDialog({
                title: 'Clear search history?',
                message: 'Saved words are kept.',
                confirmLabel: 'Clear history',
                danger: true,
              });
              if (ok) { clearLibraryHistory(); renderHistory(); toast('History cleared', { type: 'success' }); }
            },
          }, icon('trash'), el('span', { text: 'Clear' })),
        ),
        historyHost,
      ),
    ),

    dataFootnote(),
  );

  renderHistory();
  renderSaved();
  input.focus();

  /* --------------------------------------------------------- lookup ---- */

  function runLookup() {
    const text = input.value.trim();
    if (!text) {
      toast('Type some Chinese text first.', { type: 'warning', timeout: 1600 });
      input.focus();
      return;
    }
    lookupWithBackend(text);
  }

  /**
   * Prefer the backend lookup: it segments against ~412k dictionary phrases and
   * resolves polyphones from context. The in-browser segmenter is the fallback.
   */
  async function lookupWithBackend(text) {
    if (isServerMode()) {
      lookupButton.disabled = true;
      try {
        const response = await api.lookup(text, { record: true });
        const result = adaptServerResult(response);
        lastResult = result;
        renderResult(result);
        refreshFromStore();
        return;
      } catch (error) {
        console.warn('[library] server lookup failed, falling back to the local segmenter', error);
        toast('Backend lookup unavailable — using the local dictionary.', { type: 'warning' });
      } finally {
        lookupButton.disabled = false;
      }
    }

    const result = segmentText(text);
    lastResult = { text, ...result };
    addLibraryLookup(text, {
      local: true,
      results: result.segments.map((segment) => ({
        text: segment.text, pinyin: segment.pinyin, source: segment.source,
      })),
    });
    renderResult(lastResult);
    refreshFromStore();
  }

  /** The API already returns the client's segment shape; add what views expect. */
  function adaptServerResult(response) {
    const segments = (response.segments || []).map((segment) => ({
      ...segment,
      // 'word' is a dictionary entry (has a level), 'phrase' is a phrase-table
      // match that is not a curated word — both can be saved to the library.
      entry: (segment.source === 'word' || segment.source === 'phrase')
        ? {
          id: segment.wordId || null,
          s: segment.text,
          t: segment.traditional || null,
          p: segment.pinyin,
          lv: segment.level,
          c: segment.category,
        }
        : null,
    }));
    return {
      text: response.query || input.value.trim(),
      segments,
      hasFallback: Boolean(response.hasFallback),
      hasUnknown: Boolean(response.hasUnknown),
      server: true,
    };
  }

  function refreshFromStore() {
    renderHistory();
    renderSaved();
  }

  /* --------------------------------------------------------- render ---- */

  function currentDisplayPinyin(pinyin) {
    const mode = getSettings().libraryToneDisplay;
    if (mode === 'numbers') return toToneNumbers(pinyin);
    if (mode === 'plain') {
      // keep syllable boundaries readable: xue xiao rather than xuexiao
      return splitSyllables(pinyin).map((syllable) => syllable.letter).join(' ');
    }
    return toToneMarks(pinyin);
  }

  function joinedPinyin(segments, { separator = ' ' } = {}) {
    return segments
      .filter((segment) => segment.pinyin)
      .map((segment) => currentDisplayPinyin(segment.pinyin))
      .join(separator);
  }

  function renderResult(result) {
    const { segments, hasFallback, hasUnknown } = result;
    const pinyinSegments = segments.filter((segment) => segment.pinyin);
    const found = wordsInText(result.text, 10);
    const unknowns = unknownChars(result.text);

    const segmentedRow = el('div', { class: 'lookup-line' },
      ...segments.map((segment) => {
        if (segment.source === 'literal') {
          return el('span', { class: 'lookup-seg lookup-seg--literal' },
            el('span', { class: 'lookup-seg__cjk', text: segment.text }),
          );
        }
        const saved = segment.entry ? isWordSaved(segment.entry.s, segment.entry.p) : false;
        const tag = {
          word: segment.level ? `L${segment.level}` : 'word',
          phrase: 'phrase',
          char: 'char',
          unknown: 'unknown',
        }[segment.source] || segment.source;
        const node = el('div', {
          class: `lookup-seg lookup-seg--${segment.source}`,
          title: segment.entry
            ? (segment.source === 'word'
              ? `Dictionary word · level ${segment.level}`
              : 'Matched in the phrase dictionary')
            : (segment.source === 'char' ? 'Character lookup' : ''),
        },
          el('span', { class: 'lookup-seg__pinyin', text: currentDisplayPinyin(segment.pinyin) }),
          el('span', { class: 'lookup-seg__cjk', text: segment.text }),
          el('span', { class: 'lookup-seg__tag', text: tag }),
        );
        if (segment.entry) {
          node.style.cursor = 'pointer';
          node.addEventListener('click', () => {
            if (isWordSaved(segment.entry.s, segment.entry.p)) {
              removeSavedWord(segment.entry.s, segment.entry.p);
              toast(`Removed ${segment.entry.s}`, { type: 'info', timeout: 1400 });
            } else {
              saveLibraryWord({ s: segment.entry.s, t: segment.entry.t || null, p: segment.entry.p });
              toast(`Saved ${segment.entry.s}`, { type: 'success', timeout: 1400 });
            }
            renderSaved();
            renderResult(result);
          });
          node.title = saved ? 'Click to remove from saved words' : 'Click to save this word';
        }
        return node;
      }),
    );

    mount(outputHost,
      el('section', { class: 'card' },
        el('div', { class: 'card__head' },
          el('div', {},
            el('h2', { class: 'card__title', text: result.text }),
            el('div', { class: 'card__sub', text: `${segments.length} segment${segments.length === 1 ? '' : 's'} · ${pinyinSegments.length} with pinyin` }),
          ),
          el('div', { class: 'row' },
            el('button', {
              type: 'button',
              class: 'btn btn--sm',
              onClick: () => copy(joinedPinyin(segments), `Copied pinyin for “${result.text}”`),
            }, icon('copy'), el('span', { text: 'Copy pinyin' })),
            el('button', {
              type: 'button',
              class: 'btn btn--sm',
              onClick: () => copy(
                segments.map((segment) => `${segment.text}\t${segment.pinyin ? currentDisplayPinyin(segment.pinyin) : ''}`).join('\n'),
                'Copied aligned text',
              ),
            }, icon('copy'), el('span', { text: 'Copy aligned' })),
          ),
        ),

        segmentedRow,

        el('div', { class: 'lookup-plain' },
          joinedPinyin(segments) || '—',
        ),

        el('div', { class: 'row' },
          el('span', { class: 'field__label', text: 'Tone numbers' }),
          el('code', { class: 'lookup-code', text: segments.filter((s) => s.pinyin).map((s) => toToneNumbers(s.pinyin)).join(' ' ) || '—' }),
        ),

        hasFallback
          ? notice('Some characters were not part of a known word, so they use their most common reading. Context-dependent readings (多音字) need the real backend.', { type: 'warning' })
          : null,
        hasUnknown && unknowns.length
          ? notice(`Not in the dictionary: ${unknowns.join(' ')}`, { type: 'warning' })
          : null,
        !hasFallback && !hasUnknown && pinyinSegments.length
          ? notice('Every segment matched a dictionary word, so these readings are context-checked.', { type: 'info', iconName: 'check' })
          : null,

        found.length
          ? el('div', { class: 'stack stack--sm' },
            el('div', { class: 'field__label', text: 'Dictionary words found' }),
            el('div', { class: 'token-list' },
              ...found.map((word) => el('button', {
                type: 'button',
                class: 'token',
                title: isWordSaved(word.s, word.p) ? 'Saved' : 'Click to save',
                onClick: () => {
                  if (isWordSaved(word.s, word.p)) {
                    removeSavedWord(word.s, word.p);
                    toast(`Removed ${word.s}`, { type: 'info', timeout: 1400 });
                  } else {
                    saveLibraryWord({ s: word.s, t: word.t || null, p: word.p });
                    toast(`Saved ${word.s}`, { type: 'success', timeout: 1400 });
                  }
                  renderSaved();
                  renderResult(result);
                },
              },
                el('span', { class: 'token__cjk', text: displayWord(word).main }),
                el('span', { class: 'token__pinyin', text: word.p }),
                el('span', { class: 'small faint', text: `L${word.lv}` }),
              )),
            ),
            el('div', { class: 'row' },
              el('button', {
                type: 'button',
                class: 'btn btn--sm',
                onClick: () => startSession({
                  levels: [], categories: [], sessionSize: found.length, requireTones: getSettings().requireTones,
                  strictU: getSettings().strictU, autoAdvance: getSettings().autoAdvance, focusWeak: false,
                }, found),
              }, icon('keyboard'), el('span', { text: `Practise these ${found.length} words` })),
            ),
          )
          : null,

        getSettings().libraryShowPerChar
          ? perCharTable(segments)
          : null,
      ),
    );
  }

  function perCharTable(segments) {
    const rows = segments
      .filter((segment) => segment.source !== 'literal')
      .flatMap((segment) => [...segment.text].map((char) => ({ char, segment })));

    if (!rows.length) return null;

    return el('div', { class: 'stack stack--sm' },
      el('div', { class: 'field__label', text: 'Per-character readings' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {},
            el('tr', {},
              el('th', { text: 'Character' }),
              el('th', { text: 'In context' }),
              el('th', { class: 'wrap', text: 'All dictionary readings' }),
            ),
          ),
          el('tbody', {},
            ...rows.map(({ char, segment }) => {
              const readings = charReadings(char) || [];
              const inContext = segment.pinyin && segment.text.length === 1
                ? segment.pinyin
                : null;
              return el('tr', {},
                el('td', { class: 'cjk', text: char }),
                el('td', { class: 'pinyin text-accent', text: inContext ? currentDisplayPinyin(inContext) : '—' }),
                el('td', { class: 'pinyin', text: readings.join('  ') || '—' }),
              );
            }),
          ),
        ),
      ),
    );
  }

  function renderHistory() {
    const history = getLibrary().history;
    if (!history.length) {
      mount(historyHost, emptyState({ title: 'No lookups yet', text: 'Your searches will be listed here.', iconName: 'history' }));
      return;
    }
    mount(historyHost,
      ...history.slice(0, 8).map((item) => el('button', {
        type: 'button',
        class: 'history-item',
        onClick: () => { input.value = item.query; clearButton.classList.remove('hidden'); runLookup(); },
      },
        icon('history'),
        el('span', { class: 'history-item__text', text: item.query }),
        el('span', { class: 'history-item__meta', text: formatRelative(item.at) }),
      )),
    );
  }

  function renderSaved() {
    const saved = getLibrary().saved;
    if (!saved.length) {
      mount(savedHost, emptyState({
        title: 'Nothing saved',
        text: 'Click any word in the result to save it for later.',
        iconName: 'star',
      }));
      return;
    }
    mount(savedHost,
      ...saved.slice(0, 12).map((item) => el('div', { class: 'row row--between', style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
        el('div', { class: 'row' },
          el('span', { class: 'cjk', style: { fontSize: 'var(--fs-lg)' }, text: displayWord(item).main }),
          el('span', { class: 'pinyin text-accent', text: item.p }),
        ),
        el('div', { class: 'row' },
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            title: 'Practise this word',
            onClick: () => startSession({
              levels: [], categories: [], sessionSize: 1, requireTones: getSettings().requireTones,
              strictU: getSettings().strictU, autoAdvance: getSettings().autoAdvance, focusWeak: false,
            }, [lookupWord(item.s) || { s: item.s, t: item.t, p: item.p }]),
          }, icon('play')),
          el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            title: 'Remove',
            onClick: () => { removeSavedWord(item.s, item.p); renderSaved(); toast('Removed', { type: 'info', timeout: 1200 }); },
          }, icon('trash')),
        ),
      )),
      el('button', {
        type: 'button',
        class: 'btn btn--sm',
        onClick: () => startSession({
          levels: [], categories: [], sessionSize: saved.length, requireTones: getSettings().requireTones,
          strictU: getSettings().strictU, autoAdvance: getSettings().autoAdvance, focusWeak: false,
        }, saved.map((item) => lookupWord(item.s) || { s: item.s, t: item.t, p: item.p })),
      }, icon('keyboard'), el('span', { text: `Practise all ${saved.length}` })),
    );
  }
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, { type: 'success', timeout: 1600 });
  } catch {
    // clipboard API needs a secure context; fall back to a temporary selection
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast(message, { type: 'success', timeout: 1600 });
    } catch {
      toast('Copying is blocked in this browser.', { type: 'danger' });
    }
    area.remove();
  }
}
