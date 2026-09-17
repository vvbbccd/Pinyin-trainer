/**
 * Server-mode integration test.
 *
 * Boots the real browser app in jsdom with a REAL fetch pointed at a running
 * backend, then verifies that words, lookups, sessions and progress all travel
 * through the REST API into SQLite.
 *
 * Requires a running backend:
 *   python -m server --port 8000 --db .tmp/it/trainer.db
 * Run:
 *   node tools/tests/test_integration.mjs            (or: npm run test:integration)
 *   TRAINER_URL=http://127.0.0.1:9000 node tools/tests/test_integration.mjs
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const BASE = (process.env.TRAINER_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const nativeFetch = globalThis.fetch;

/* ------------------------------------------------------------- setup ---- */

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/#/`, pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.localStorage = window.localStorage;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;

window.matchMedia = window.matchMedia || (() => ({
  matches: false, media: '', addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
}));
globalThis.matchMedia = window.matchMedia;
window.Element.prototype.scrollIntoView = function scrollIntoView() {};

// Relative asset requests (data/words.json) resolve against the page; absolute
// API calls pass straight through to the backend.
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' && !/^https?:/i.test(input)
    ? new URL(input, `${BASE}/`).toString()
    : input;
  return nativeFetch(url, init);
};

// tell api.js where the backend is
localStorage.setItem('pinyin-trainer:v1:api-base', BASE);

/* ----------------------------------------------------------- harness ---- */

const errors = [];
window.addEventListener('error', (event) => errors.push(`window error: ${event.message}`));
const originalError = console.error;
console.error = (...args) => {
  errors.push(`console.error: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}`);
};

let passed = 0;
const failures = [];
const check = (condition, label) => {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); return true; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
  return false;
};

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const outlet = () => document.getElementById('outlet');
const outletText = () => (outlet()?.textContent || '').replace(/\s+/g, ' ');

async function api(pathname, options) {
  const response = await nativeFetch(`${BASE}${pathname}`, options);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function go(hash) {
  window.location.hash = hash;
  const { resolve } = await import('../../assets/js/router.js');
  await resolve();
  await settle(60);
}

/* --------------------------------------------------------------- run ---- */

console.log(`\nbackend: ${BASE}`);

console.log('\n[1] backend reachable');
const health = await api('/api/health');
if (!check(health.status === 200, `GET /api/health -> ${health.status}`)) {
  console.error('\nThe backend is not running. Start it first:\n  python -m server --port 8000\n');
  process.exit(1);
}
check(health.body.counts.chinese_words > 1000, `database holds ${health.body.counts.chinese_words} words`);

console.log('\n[2] app boots in server mode');
const store = await import('../../assets/js/store.js');
const { loadDictionary, isLoaded } = await import('../../assets/js/dictionary.js');
await import('../../assets/js/main.js');
for (let i = 0; i < 80 && !isLoaded(); i += 1) await settle(30);
await settle(300);

check(isLoaded(), 'seed dictionary loaded (offline fallback)');
check(store.getMode() === 'server', `store mode is "${store.getMode()}"`);
check(store.isServerMode(), 'isServerMode() is true');
check(store.getBackendStatus().version !== null, `backend version ${store.getBackendStatus().version}`);
check(document.querySelector('.sidebar__note')?.textContent.includes('Backend connected'),
  'sidebar reports the backend connection');
check(outletText().includes('Type the pinyin'), 'dashboard rendered');

console.log('\n[3] drill sources words from the database');
const training = await import('../../assets/js/views/training.js');
await training.startSession({
  levels: [1], categories: [], sessionSize: 3,
  requireTones: true, strictU: false, autoAdvance: false, focusWeak: false,
});
await settle(200);
const session = store.getActiveSession();
check(Boolean(session), 'session started');
check(session.config.wordSource === 'server', `word source is "${session.config.wordSource}"`);
check(session.queue.length === 3, `queue holds ${session.queue.length} words`);

// answer every word correctly, using the tone-number spelling
const { toToneNumbers } = await import('../../assets/js/pinyin.js');
let graded = 0;
for (let i = 0; i < 3; i += 1) {
  const word = store.getActiveSession()?.queue[store.getActiveSession()?.cursor];
  if (!word) break;
  const input = document.getElementById('drill-input');
  input.value = toToneNumbers(word.p);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(60);
  if ((document.getElementById('drill-feedback')?.textContent || '').includes('Correct')) graded += 1;
  const next = [...outlet().querySelectorAll('button')]
    .find((b) => b.textContent.includes('Next word') || b.textContent.includes('See results'));
  if (next) next.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(80);
}
check(graded === 3, `all 3 words graded correct (got ${graded})`);
await settle(400);
const sessionId = store.getSessions()[0]?.id;

console.log('\n[4] the session reached SQLite');
const stored = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
check(stored.status === 200, `GET /api/sessions/${sessionId} -> ${stored.status}`);
check(stored.body?.session?.total === 3, `stored total is ${stored.body?.session?.total}`);
check(stored.body?.session?.correct === 3, `stored correct is ${stored.body?.session?.correct}`);
check(Array.isArray(stored.body?.session?.answers) && stored.body.session.answers.length === 3,
  'three answers stored in training_answers');

const progressMap = await api('/api/progress/map');
const practiced = Object.keys(progressMap.body.progress);
check(practiced.length >= 3, `${practiced.length} words tracked in user_word_progress`);

console.log('\n[5] library lookup uses the server engine');
await go('#/library');
const box = document.getElementById('library-input');
box.value = '银行';
[...outlet().querySelectorAll('button')].find((b) => b.textContent.includes('Look up'))
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(400);
check((outlet().textContent || '').includes('háng'),
  'polyphone resolved by the phrase table (银行 -> yín háng)');
// the chosen reading must be háng; xíng may still legitimately appear in the
// per-character breakdown, which lists every reading of 行
const chosenLine = outlet().querySelector('.lookup-plain')?.textContent || '';
check(chosenLine.includes('háng') && !chosenLine.includes('xíng'),
  `chosen reading is correct ("${chosenLine.trim()}")`);
const history = await api('/api/library/history');
check(history.body.history.some((item) => item.query === '银行'),
  'the server recorded the lookup in lookup_history');

console.log('\n[6] saved words go to the database');
const libraryStore = await import('../../assets/js/store.js');
libraryStore.saveLibraryWord({ s: '银行', t: '銀行', p: 'yín háng' });
await settle(300);
const saved = await api('/api/library/saved');
check(saved.body.words.some((word) => word.s === '银行'), 'saved word present in saved_words');

console.log('\n[7] settings sync to the database');
store.updateSettings({ theme: 'light', sessionSize: 7 });
await settle(700);
const remoteSettings = await api('/api/settings');
check(remoteSettings.body.settings?.theme === 'light',
  `settings.theme persisted as "${remoteSettings.body.settings?.theme}"`);
check(remoteSettings.body.settings?.sessionSize === 7, 'settings.sessionSize persisted');
store.updateSettings({ theme: 'dark' });

console.log('\n[8] progress screen reads database state');
await go('#/progress');
const progressText = outletText();
check(progressText.includes('Typing speed'), 'progress tiles rendered');
check(progressText.includes('Training history'), 'session history rendered from the database');
check(progressText.includes('Accuracy'), 'accuracy from real sessions');

console.log('\n[9] cleanup');
const removed = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
check(removed.status === 200, 'test session deleted from the database');
await api('/api/library/saved?simplified=%E9%93%B6%E8%A1%8C', { method: 'DELETE' });
await api('/api/library/history', { method: 'DELETE' });

console.log('\n[10] runtime errors');
const real = errors.filter((e) => !e.includes('Could not parse CSS'));
check(real.length === 0, `no runtime errors/warnings (${real.length})`);
for (const error of real.slice(0, 8)) console.log(`     ! ${error.slice(0, 250)}`);

console.error = originalError;
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('integration test: all good');
process.exit(0);
