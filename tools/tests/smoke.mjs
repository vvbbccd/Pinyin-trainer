/**
 * Headless end-to-end smoke test.
 *
 * Boots the real app inside jsdom (the very same modules the browser loads),
 * walks every route, plays a full training session and checks that the results
 * are persisted. Catches runtime errors that the import check cannot.
 *
 * Needs jsdom (dev-only):  npm install
 * Run:  node tools/tests/smoke.mjs           (or: npm run test:smoke)
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:8123/#/', pretendToBeVisual: true });
const { window } = dom;

/* ------------------------------------------------------- globals shim --- */

globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.history = window.history;
globalThis.localStorage = window.localStorage;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;

window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
}));
globalThis.matchMedia = window.matchMedia;

// jsdom does not implement scrolling; the router calls it on navigation.
window.Element.prototype.scrollIntoView = function scrollIntoView() {};

// serve data/*.json straight off disk
globalThis.fetch = async (url) => {
  const clean = String(url).replace(/^\.?\//, '').split('?')[0];
  const file = path.join(root, clean);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const text = fs.readFileSync(file, 'utf8');
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
};

/* ------------------------------------------------------------ harness --- */

const errors = [];
window.addEventListener('error', (event) => errors.push(`window error: ${event.message}`));
const originalError = console.error;
console.error = (...args) => {
  errors.push(`console.error: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}`);
};
const originalWarn = console.warn;
console.warn = (...args) => { errors.push(`console.warn: ${args.join(' ')}`); };

let passed = 0;
const failures = [];

function check(condition, label) {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL ${label}`);
}

const settle = (ms = 24) => new Promise((resolve) => setTimeout(resolve, ms));

const outlet = () => document.getElementById('outlet');
const outletText = () => (outlet()?.textContent || '').replace(/\s+/g, ' ');
const outletHtml = () => outlet()?.innerHTML || '';

async function go(hash) {
  window.location.hash = hash;
  const { resolve } = await import('../../assets/js/router.js');
  await resolve();
  await settle(40);
}

/* --------------------------------------------------------------- boot --- */

console.log('\n[1] boot');
const { loadDictionary, isLoaded, wordCount } = await import('../../assets/js/dictionary.js');
await import('../../assets/js/main.js');
for (let i = 0; i < 60 && !isLoaded(); i += 1) await settle(30);
await settle(60);

check(isLoaded(), `dictionary loaded (${wordCount()} words)`);
check(outletHtml().length > 400, 'dashboard rendered markup');
check(outletText().includes('Type the pinyin'), 'dashboard hero copy present');

if (errors.length) {
  console.log('  --- captured during boot ---');
  for (const error of errors.slice(0, 8)) console.log(`      ${error.slice(0, 400)}`);
  console.log(`  --- outlet (first 400 chars) ---\n      ${outletHtml().slice(0, 400)}`);
}

/* ------------------------------------------------------------ routes ---- */

console.log('\n[2] routes');
await go('#/library');
check(outletHtml().includes('library-input'), 'library view rendered');
check(outletText().includes('Saved words'), 'library saved-words panel present');

await go('#/progress');
check(outletText().includes('Progress') || outletText().includes('No practice'), 'progress view rendered');

await go('#/settings');
check(outletHtml().includes('settings') || outletText().includes('Appearance'), 'settings view rendered');
check(outletText().includes('Answer marking'), 'settings marking section present');

await go('#/training');
check(outletText().includes('Difficulty'), 'training setup rendered');
check(outletHtml().includes('level-option'), 'training level options rendered');

await go('#/nope');
check(outletText().includes('Page not found'), 'unknown route shows 404 view');

/* ------------------------------------------------------------ library --- */

console.log('\n[3] library lookup');
await go('#/library');
const area = document.getElementById('library-input');
const lookupBtn = [...outlet().querySelectorAll('button')].find((b) => b.textContent.includes('Look up'));
area.value = '我喜欢学习汉语';
lookupBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(60);
const libText = outletText();
check(libText.includes('wǒ'), 'lookup produced tone-marked pinyin (wǒ)');
check(outletHtml().includes('lookup-seg'), 'lookup produced segments');
check(libText.includes('Per-character readings'), 'per-character breakdown rendered');
const libraryStore = await import('../../assets/js/store.js');
check(libraryStore.getLibrary().history.length === 1, 'lookup recorded in history');

/* ------------------------------------------------------------- drill ---- */

console.log('\n[4] training drill (all correct)');
const training = await import('../../assets/js/views/training.js');
const store = await import('../../assets/js/store.js');
store.resetProgress();

const config = {
  levels: [1], categories: [], sessionSize: 4,
  requireTones: true, strictU: false, autoAdvance: false, focusWeak: false,
};
training.startSession(config);
await settle(80);

check(outletHtml().includes('drill-input'), 'drill input rendered');
check(document.getElementById('drill-word') !== null || outletHtml().includes('drill__word'), 'drill word rendered');

function currentAnswer() {
  const session = store.getActiveSession();
  return session?.queue[session.cursor];
}

let answered = 0;
for (let i = 0; i < 4; i += 1) {
  const word = currentAnswer();
  if (!word) break;
  const input = document.getElementById('drill-input');
  // type the tone-number form of the correct answer
  const { toToneNumbers } = await import('../../assets/js/pinyin.js');
  input.value = toToneNumbers(word.p);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(50);
  const feedback = document.getElementById('drill-feedback')?.textContent || '';
  if (feedback.includes('Correct')) answered += 1;
  else console.log(`     (word ${word.s} -> ${toToneNumbers(word.p)} gave: ${feedback.replace(/\s+/g, ' ').slice(0, 90)})`);
  // move on: the button reads "Next word" except on the final word ("See results")
  const next = [...outlet().querySelectorAll('button')]
    .find((b) => b.textContent.includes('Next word') || b.textContent.includes('See results'));
  if (next) next.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(60);
}

check(answered === 4, `all 4 words graded correct (got ${answered})`);
await settle(80);
check(outletText().includes('Session results'), 'results screen rendered');
check(outletText().includes('100%'), 'results show 100% score');
check(store.getSessions().length === 1, 'session persisted to store');
check(store.getSessions()[0].total === 4, 'session total is 4');
check(store.getSessions()[0].correct === 4, 'session correct is 4');
check(Object.keys(store.getProgress()).length === 4, 'four words recorded in progress');

/* --------------------------------------------------- wrong answer ------ */

console.log('\n[5] wrong answer path');
training.startSession({ ...config, sessionSize: 2 });
await settle(80);
const word = currentAnswer();
const input = document.getElementById('drill-input');
input.value = 'definitely-wrong';
input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await settle(60);
check((document.getElementById('drill-feedback')?.textContent || '').includes('Not quite'), 'wrong answer shows "Not quite"');
check(outletText().includes('syllable') || outletHtml().includes('syllable-strip'), 'syllable diagnosis rendered');
const skipBtn = [...outlet().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip');
skipBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(60);
const endBtn = [...outlet().querySelectorAll('button')].find((b) => b.textContent.includes('End session'));
endBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(60);
const confirmBtn = document.querySelector('.modal .btn--primary, .modal .btn--danger');
check(Boolean(confirmBtn), 'end-session confirmation appeared');
if (confirmBtn) confirmBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(120);
check(outletText().includes('Session results'), 'session with a miss reached results');
check(store.getSessions().length === 2, 'second session saved');
check(store.getProgress()[word.s]?.attempts >= 1, 'missed word recorded in progress');

/* ---------------------------------------------------------- progress ---- */

console.log('\n[6] progress screen with data');
await go('#/progress');
const progText = outletText();
check(progText.includes('Typing speed'), 'progress shows speed tile');
check(progText.includes('Training history'), 'progress shows history section');
check(progText.includes('Mastery by difficulty'), 'progress shows level mastery');
check(progText.includes('Weak words'), 'progress shows weak words section');

/* ---------------------------------------------------------- settings ---- */

console.log('\n[7] settings persistence');
await go('#/settings');
const requireTonesSwitch = [...outlet().querySelectorAll('.switch')]
  .find((node) => node.textContent.includes('Require tones'));
check(Boolean(requireTonesSwitch), 'require-tones switch rendered');
const toggle = requireTonesSwitch.querySelector('input');
const before = store.getSettings().requireTones;
toggle.checked = !before;
toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
await settle(40);
check(store.getSettings().requireTones === !before, 'toggling require-tones updated the store');
check(JSON.parse(localStorage.getItem('pinyin-trainer:v1:settings')).requireTones === !before, 'setting persisted to localStorage');

// theme switching
await go('#/');
const themeBtn = document.querySelector('.topbar__actions button');
themeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(40);
check(['dark', 'light'].includes(document.documentElement.dataset.theme), `theme applied (${document.documentElement.dataset.theme})`);

/* ------------------------------------------- nav highlight + script mode -- */

console.log('\n[8] navigation highlight and script switching');

// regression: the highlighted nav item used to lag one navigation behind,
// because the shell listened to raw "hashchange" before the router committed.
await go('#/training');
await go('#/library');
let currentNav = document.querySelector('.nav__item[aria-current="page"]');
check((currentNav?.textContent || '').includes('Library'),
  `nav highlights the current route after training -> library (got "${(currentNav?.textContent || '').trim()}")`);
check((document.getElementById('topbar-title')?.textContent || '') === 'Pinyin Library',
  'top bar follows the current route');

await go('#/progress');
currentNav = document.querySelector('.nav__item[aria-current="page"]');
check((currentNav?.textContent || '').includes('Progress'),
  `nav highlights Progress after library -> progress (got "${(currentNav?.textContent || '').trim()}")`);
check(document.querySelectorAll('.nav__item[aria-current="page"]').length === 1,
  'exactly one nav item is highlighted');

// regression: interface chrome (examples, placeholder, brand) ignored the script setting
store.updateSettings({ script: 'traditional' });
await go('#/library');
const ghostText = [...outlet().querySelectorAll('.btn--ghost')].map((b) => b.textContent).join(' ');
const placeholder = document.getElementById('library-input')?.placeholder || '';
check(ghostText.includes('學校'), `library example chips switch to traditional (${ghostText.slice(0, 40)})`);
check(!ghostText.includes('学校'), 'no simplified example chips remain');
check(placeholder.includes('圖書館在哪裡') || placeholder.includes('輸入中文'),
  `library placeholder switches to traditional ("${placeholder.slice(0, 24)}")`);
check((document.querySelector('.brand__title')?.textContent || '').includes('練習場'),
  'sidebar brand switches to traditional');

// traditional text must still resolve to pinyin
const tradArea = document.getElementById('library-input');
tradArea.value = '學校';
[...outlet().querySelectorAll('button')].find((b) => b.textContent.includes('Look up'))
  .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await settle(60);
check((outlet().textContent || '').includes('xué'), 'traditional input still resolves to pinyin');

await go('#/');
check((outlet().textContent || '').includes('練習拼音'), 'dashboard hero switches to traditional');

store.updateSettings({ script: 'simplified' });
await go('#/library');
const ghostTextBack = [...outlet().querySelectorAll('.btn--ghost')].map((b) => b.textContent).join(' ');
check(ghostTextBack.includes('学校'), 'chips return to simplified when the setting is switched back');

/* -------------------------------------------------------------- done ---- */

console.log('\n[9] runtime errors');
const realErrors = errors.filter((e) => !e.includes('Could not parse CSS') && !e.includes('Not implemented'));
check(realErrors.length === 0, `no runtime errors/warnings (${realErrors.length})`);
for (const error of realErrors.slice(0, 10)) console.log(`     ! ${error.slice(0, 200)}`);

console.error = originalError;
console.warn = originalWarn;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('smoke test: all good');
// jsdom keeps timers and a rAF loop alive, so exit explicitly
process.exit(0);
