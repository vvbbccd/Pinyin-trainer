/* ==========================================================================
   views/settings.js — appearance, marking rules, session defaults, data tools.
   ========================================================================== */

import {
  el, mount, icon, toast, notice, confirmDialog, switchField, segmented, badge,
  formatDate, select,
} from '../ui.js';
import {
  getSettings, updateSettings, resetSettings, exportData, importData,
  resetEverything, storageFootprint, isServerMode, initStore, getBackendStatus,
  migrateLocalToServer, pendingLocalCounts,
} from '../store.js';
import { awaitData, dataFootnote } from './shared.js';
import { getLevelCounts, getMeta, wordCount, charCount } from '../dictionary.js';
import { setTopbarActions } from '../app-shell.js';
import { navigate } from '../router.js';
import { reconnect, api } from '../api.js';

export async function renderSettings(outlet) {
  if (!(await awaitData(outlet))) return undefined;
  setTopbarActions();

  const settings = getSettings();
  const meta = getMeta();

  mount(outlet,
    el('div', { class: 'page-head' },
      el('div', { class: 'page-head__text' },
        el('h1', { text: 'Settings' }),
        el('p', { class: 'page-head__desc' },
          'These options change how the trainer behaves on this device. They are stored in your browser, not on a server.',
        ),
      ),
      el('div', { class: 'page-head__actions' },
        el('button', {
          type: 'button',
          class: 'btn',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Restore default settings?',
              message: 'Progress, sessions and saved words are not touched.',
              confirmLabel: 'Restore defaults',
            });
            if (ok) { resetSettings(); toast('Settings restored', { type: 'success' }); renderSettings(outlet); }
          },
        }, icon('refresh'), el('span', { text: 'Restore defaults' })),
      ),
    ),

    /* appearance ------------------------------------------------------- */
    el('section', { class: 'card settings-block' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: 'Appearance' }),
          el('div', { class: 'card__sub', text: 'Theme, script and how big the drill word is.' }),
        ),
      ),
      el('div', { class: 'settings-grid' },
        el('div', { class: 'field' },
          el('span', { class: 'field__label', text: 'Theme' }),
          segmented('theme', [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ], settings.theme, (value) => { updateSettings({ theme: value }); renderSettings(outlet); }),
        ),
        el('div', { class: 'field' },
          el('span', { class: 'field__label', text: 'Chinese script' }),
          segmented('script', [
            { value: 'simplified', label: '简体' },
            { value: 'traditional', label: '繁體' },
            { value: 'both', label: 'Both' },
          ], settings.script, (value) => { updateSettings({ script: value }); renderSettings(outlet); }),
          el('span', { class: 'field__hint', text: 'Traditional forms come from an OpenCC character mapping in the seed data.' }),
        ),
        el('div', { class: 'field' },
          el('span', { class: 'field__label', text: 'Drill word size' }),
          segmented('fontSize', [
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Medium' },
            { value: 'lg', label: 'Large' },
          ], settings.fontSize, (value) => { updateSettings({ fontSize: value }); renderSettings(outlet); }),
        ),
      ),
    ),

    /* marking ---------------------------------------------------------- */
    el('section', { class: 'card settings-block' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: 'Answer marking' }),
          el('div', { class: 'card__sub', text: 'What counts as a correct answer.' }),
        ),
      ),
      el('div', { class: 'settings-grid' },
        switchField({
          title: 'Require tones',
          desc: 'On: xuéxiào or xue2xiao4. Off: xuexiao is also accepted.',
          checked: settings.requireTones,
          onChange: (value) => { updateSettings({ requireTones: value }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Distinguish ü from u',
          desc: 'On: 绿 must be lü or lv. Off: lu is accepted too.',
          checked: settings.strictU,
          onChange: (value) => { updateSettings({ strictU: value }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Show the pinyin before answering',
          desc: 'On: the answer is visible, so the drill becomes copy practice.',
          checked: settings.revealPinyin === 'always',
          onChange: (value) => { updateSettings({ revealPinyin: value ? 'always' : 'after' }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Hide the answer when wrong',
          desc: 'On: only the result is shown during the drill; the full answer appears on the results screen.',
          checked: settings.revealPinyin === 'never',
          onChange: (value) => { updateSettings({ revealPinyin: value ? 'never' : 'after' }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Show the session timer',
          desc: 'The elapsed clock during a drill.',
          checked: settings.showTimer,
          onChange: (value) => { updateSettings({ showTimer: value }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Sound on answers',
          desc: 'A short tone for correct and incorrect answers.',
          checked: settings.sound,
          onChange: (value) => { updateSettings({ sound: value }); renderSettings(outlet); },
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field__label', text: 'Tone entry' }),
        segmented('toneInput', [
          { value: 'either', label: 'Marks or numbers', sub: 'show the tone keypad' },
          { value: 'numbers', label: 'Numbers only', sub: 'hide the keypad' },
        ], settings.toneInput, (value) => { updateSettings({ toneInput: value }); renderSettings(outlet); }),
        el('span', { class: 'field__hint', text: 'Marking always accepts both forms; this only changes the hint and keypad.' }),
      ),
    ),

    /* session defaults -------------------------------------------------- */
    el('section', { class: 'card settings-block' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: 'Session defaults' }),
          el('div', { class: 'card__sub', text: 'What the training screen starts with.' }),
        ),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field__label', text: 'Length' }),
        segmented('sessionSize', [
          { value: 10, label: '10 words' },
          { value: 20, label: '20 words' },
          { value: 50, label: '50 words' },
          { value: 0, label: 'Endless' },
        ], settings.sessionSize, (value) => { updateSettings({ sessionSize: Number(value) }); renderSettings(outlet); }),
      ),
      el('div', { class: 'settings-grid' },
        switchField({
          title: 'Auto-advance',
          desc: 'Jump to the next word automatically after each answer.',
          checked: settings.autoAdvance,
          onChange: (value) => { updateSettings({ autoAdvance: value }); renderSettings(outlet); },
        }),
        switchField({
          title: 'Focus on weak words',
          desc: 'Bias the word picker toward words you keep missing.',
          checked: settings.focusWeak !== false,
          onChange: (value) => { updateSettings({ focusWeak: value }); renderSettings(outlet); },
        }),
      ),
      el('div', { class: 'field', style: { maxWidth: '280px' } },
        el('span', { class: 'field__label', text: 'Auto-advance delay' }),
        select({
          value: settings.autoAdvanceDelay,
          options: [600, 900, 1100, 1600, 2400, 3500].map((ms) => ({
            value: ms,
            label: `${(ms / 1000).toFixed(1)} s`,
          })),
          onChange: (value) => updateSettings({ autoAdvanceDelay: Number(value) }),
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field__label', text: 'Difficulty levels used by default' }),
        el('div', { class: 'chips' },
          ...getLevelCounts().map((level) => el('label', { class: 'chip' },
            el('input', {
              type: 'checkbox',
              checked: (settings.levels || []).includes(level.id),
              onChange: (event) => {
                const next = event.target.checked
                  ? [...new Set([...(settings.levels || []), level.id])].sort((a, b) => a - b)
                  : (settings.levels || []).filter((id) => id !== level.id);
                updateSettings({ levels: next });
              },
            }),
            el('span', { text: `Level ${level.id} · ${level.name}` }),
            el('span', { class: 'chip__count', text: String(level.count) }),
          )),
        ),
      ),
      el('div', { class: 'row' },
        el('a', { class: 'btn btn--sm', href: '#/training' }, icon('keyboard'), el('span', { text: 'Open training setup' })),
      ),
    ),

    /* library ---------------------------------------------------------- */
    el('section', { class: 'card settings-block' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: 'Library' }),
          el('div', { class: 'card__sub', text: 'How lookups are displayed.' }),
        ),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'field__label', text: 'Default pinyin format' }),
        segmented('libraryToneDisplay', [
          { value: 'marks', label: 'Tone marks' },
          { value: 'numbers', label: 'Tone numbers' },
          { value: 'plain', label: 'No tones' },
        ], settings.libraryToneDisplay, (value) => { updateSettings({ libraryToneDisplay: value }); renderSettings(outlet); }),
      ),
      switchField({
        title: 'Per-character breakdown',
        desc: 'Show every dictionary reading for each character in a lookup.',
        checked: settings.libraryShowPerChar,
        onChange: (value) => { updateSettings({ libraryShowPerChar: value }); renderSettings(outlet); },
      }),
    ),

    /* backend ---------------------------------------------------------- */
    backendSection(outlet),

    /* data ------------------------------------------------------------- */
    el('section', { class: 'card settings-block' },
      el('div', { class: 'card__head' },
        el('div', {},
          el('h2', { class: 'card__title', text: 'Your data' }),
          el('div', { class: 'card__sub', text: 'Back up or clear what the trainer has stored.' }),
        ),
      ),
      el('dl', { class: 'kv' },
        el('dt', { text: 'Storage used' }),
        el('dd', { text: `${(storageFootprint() / 1024).toFixed(1)} KB in localStorage` }),
        el('dt', { text: 'Dictionary' }),
        el('dd', { text: `${wordCount().toLocaleString()} words · ${charCount().toLocaleString()} characters` }),
        el('dt', { text: 'Seed data built' }),
        el('dd', { text: meta?.generated ? formatDate(new Date(meta.generated).getTime()) : 'unknown' }),
        el('dt', { text: 'Data sources' }),
        el('dd', { class: 'small', text: (meta?.sources || []).join(' · ') || 'unknown' }),
      ),
      el('div', { class: 'row' },
        el('button', {
          type: 'button',
          class: 'btn btn--sm',
          onClick: () => downloadBackup(),
        }, icon('download'), el('span', { text: 'Export backup (JSON)' })),
        el('label', { class: 'btn btn--sm', style: { cursor: 'pointer' } },
          icon('upload'),
          el('span', { text: 'Import backup' }),
          el('input', {
            type: 'file',
            accept: 'application/json,.json',
            class: 'sr-only',
            onChange: (event) => handleImport(event, outlet),
          }),
        ),
        el('button', {
          type: 'button',
          class: 'btn btn--danger btn--sm',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Erase everything?',
              message: 'Settings, sessions, progress and saved words are all deleted from this browser.',
              confirmLabel: 'Erase everything',
              danger: true,
            });
            if (ok) { resetEverything(); toast('All local data erased', { type: 'success' }); navigate('/'); }
          },
        }, icon('trash'), el('span', { text: 'Erase all local data' })),
      ),
      notice(
        el('div', {},
          el('strong', { text: 'Storage: ' }),
          isServerMode()
            ? 'sessions, answers, per-word progress and the library are stored in the SQLite database. A local copy is kept as a cache so the app still works if the backend goes away.'
            : 'everything is in this browser\'s localStorage. Start the backend (python -m server) and reload to store data in SQLite instead — Settings will offer to migrate what is already here.',
        ),
        { type: isServerMode() ? 'success' : 'info' },
      ),
      el('div', { class: 'row' },
        badge(isServerMode() ? 'SQLite backend' : 'localStorage only', isServerMode() ? 'success' : 'warning'),
        badge('schema v1', 'outline'),
      ),
    ),

    dataFootnote(),
  );

  return undefined;
}

/* ------------------------------------------------------------- backend --- */

/** Connection state, endpoint override, and local -> SQLite migration. */
function backendSection(outlet) {
  const status = getBackendStatus();
  const online = isServerMode();
  const pending = pendingLocalCounts();
  const backendMeta = status.meta;

  const baseInput = el('input', {
    type: 'text',
    class: 'input mono',
    placeholder: 'http://127.0.0.1:8000  (blank = same origin)',
    value: status.base || '',
    spellcheck: 'false',
  });

  const resultHost = el('div', { class: 'stack stack--sm' });

  const connectButton = el('button', {
    type: 'button',
    class: 'btn btn--sm',
    onClick: async () => {
      connectButton.disabled = true;
      resultHost.replaceChildren(el('span', { class: 'small muted', text: 'Connecting…' }));
      const ok = await reconnect(baseInput.value.trim());
      connectButton.disabled = false;
      if (ok) {
        toast('Connected to the backend', { type: 'success' });
        await initStore({ silent: true });
        renderSettings(outlet);
      } else {
        const error = getBackendStatus().error;
        resultHost.replaceChildren(notice(
          `No backend answered at ${baseInput.value.trim() || 'this origin'}. ${error?.message || ''}`,
          { type: 'warning' },
        ));
      }
    },
  }, icon('refresh'), el('span', { text: online ? 'Reconnect' : 'Connect' }));

  mount(resultHost,
    online
      ? notice('Connected. Sessions and progress are written to SQLite as you practise.', { type: 'success' })
      : notice(
        'No backend answered. Start it with  python -m server  and reload, or point the app at a different address below.',
        { type: 'warning' },
      ),
  );

  return el('section', { class: 'card settings-block' },
    el('div', { class: 'card__head' },
      el('div', {},
        el('h2', { class: 'card__title', text: 'Backend' }),
        el('div', { class: 'card__sub', text: 'Where words and progress are stored.' }),
      ),
      el('span', { class: 'row small' },
        el('span', { class: `status-dot status-dot--${getModeSafe()}` }),
        el('span', { class: 'muted', text: online ? 'connected' : 'offline' }),
      ),
    ),

    el('dl', { class: 'kv' },
      el('dt', { text: 'Mode' }),
      el('dd', { text: online ? `server (v${status.version || '?'})` : 'local (browser storage)' }),
      el('dt', { text: 'API base' }),
      el('dd', { class: 'mono small', text: status.base || `${location.origin} (same origin)` }),
      el('dt', { text: 'Lookup engine' }),
      el('dd', { text: online ? (backendMeta?.lookupEngine || 'unknown') : 'built-in browser segmenter' }),
      el('dt', { text: 'Dictionary in database' }),
      el('dd', {
        text: online && backendMeta
          ? `${(backendMeta.words ?? 0).toLocaleString()} words · ${(backendMeta.phrases ?? 0).toLocaleString()} phrases · ${(backendMeta.characters ?? 0).toLocaleString()} characters`
          : 'not connected',
      }),
    ),

    resultHost,

    el('div', { class: 'field' },
      el('span', { class: 'field__label', text: 'Backend address' }),
      baseInput,
      el('span', { class: 'field__hint' },
        'Leave blank when the backend serves this page. Use a full URL such as http://127.0.0.1:8000 when the frontend is served separately.',
      ),
    ),

    pending.sessions > 0
      ? el('div', { class: 'stack stack--sm' },
        notice(
          `${pending.sessions} session${pending.sessions === 1 ? '' : 's'} in this browser ${pending.sessions === 1 ? 'has' : 'have'} not been sent to the database yet.`,
          { type: 'info' },
        ),
        el('button', {
          type: 'button',
          class: 'btn btn--primary btn--sm',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Send local data to the backend?',
              message: `${pending.sessions} session(s) and ${pending.saved} saved word(s) will be uploaded. Nothing is deleted locally.`,
              confirmLabel: 'Upload',
            });
            if (!ok) return;
            const result = await migrateLocalToServer();
            toast(
              result.ok
                ? `Uploaded ${result.sessions} session(s)${result.failed ? `, ${result.failed} failed` : ''}.`
                : result.message,
              { type: result.ok ? 'success' : 'danger' },
            );
            renderSettings(outlet);
          },
        }, icon('upload'), el('span', { text: 'Upload local data to the database' })),
      )
      : null,

    el('div', { class: 'row' },
      baseInput ? connectButton : null,
      el('button', {
        type: 'button',
        class: 'btn btn--sm',
        onClick: async () => {
          if (!isServerMode()) { toast('No backend is connected.', { type: 'warning' }); return; }
          const summary = await api.progress.get().catch(() => null);
          const text = summary
            ? `${summary.summary.attempted} words practised · ${summary.summary.attempts} answers · ${summary.summary.mastered} mastered · ${summary.summary.weak} weak`
            : 'Could not read the summary.';
          toast(text, { type: 'info', timeout: 6000 });
        },
      }, icon('target'), el('span', { text: 'Check database summary' })),
    ),
  );
}

function getModeSafe() {
  try {
    return isServerMode() ? 'server' : 'local';
  } catch {
    return 'local';
  }
}

function downloadBackup() {  const blob = new Blob([exportData()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `pinyin-trainer-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Backup downloaded', { type: 'success' });
}

async function handleImport(event, outlet) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const result = importData(text);
    toast(result.message, { type: result.ok ? 'success' : 'danger' });
    if (result.ok) renderSettings(outlet);
  } catch (error) {
    toast(`Could not read that file: ${error.message}`, { type: 'danger' });
  }
  event.target.value = '';
}
