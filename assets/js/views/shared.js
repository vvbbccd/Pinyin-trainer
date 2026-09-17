/* ==========================================================================
   views/shared.js — helpers every view shares.
   ========================================================================== */

import { el, mount, notice, icon } from '../ui.js';
import {
  loadDictionary, isLoaded, getLoadError, wordCount, charCount, getMeta, toTraditional,
} from '../dictionary.js';
import { getSettings } from '../store.js';

/** Wait for the seed dictionary; render a helpful panel if it is unavailable. */
export async function awaitData(outlet) {
  if (!isLoaded()) {
    mount(outlet, el('div', { class: 'boot' },
      el('div', { class: 'spinner' }),
      el('span', { text: 'Loading the word list…' }),
    ));
  }
  await loadDictionary();
  if (!isLoaded()) {
    const error = getLoadError();
    mount(outlet,
      notice(
        el('div', {},
          el('strong', { text: 'The word list could not be loaded.' }),
          el('br'),
          el('span', { text: 'The prototype reads data/words.json. Serve the folder over HTTP (npm-free: ' }),
          el('code', { text: 'python -m http.server' }),
          el('span', { text: ') instead of opening index.html directly from the file system.' }),
          error ? el('div', { class: 'small mono', text: String(error.message || error) }) : null,
        ),
        { type: 'danger' },
      ),
    );
    return false;
  }
  return true;
}

/** "学校" -> { main, sub } honouring the script setting. */
export function displayWord(word, script = getSettings().script) {
  if (!word) return { main: '', sub: '' };
  const simplified = word.s;
  // fall back to the character map when the entry carries no traditional form
  const traditional = word.t || (script === 'simplified' ? null : toTraditional(simplified)) || null;
  const differs = Boolean(traditional) && traditional !== simplified;

  if (script === 'traditional') {
    return { main: traditional || simplified, sub: differs ? simplified : '' };
  }
  if (script === 'both' && differs) {
    return { main: simplified, sub: traditional };
  }
  return { main: simplified, sub: '' };
}

export function scriptLabel(script) {
  return { simplified: 'Simplified', traditional: 'Traditional', both: 'Simplified + traditional' }[script] || script;
}

export function dataFootnote() {
  const meta = getMeta();
  return el('p', { class: 'faint small' },
    `${wordCount().toLocaleString()} words and ${charCount().toLocaleString()} characters in the seed dictionary`,
    meta?.generated ? ` · generated ${meta.generated}` : '',
    ' · the real backend will serve this from the database.',
  );
}

export function loadingBlock(label = 'Loading…') {
  return el('div', { class: 'boot' }, el('div', { class: 'spinner' }), el('span', { text: label }));
}

export function linkButton(label, href, { variant = '', iconName } = {}) {
  return el('a', { class: `btn ${variant}`.trim(), href },
    iconName ? icon(iconName) : null,
    el('span', { text: label }),
  );
}
