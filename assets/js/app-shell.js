/* ==========================================================================
   app-shell.js — sidebar navigation and the top bar.
   Kept separate from the router so views stay unaware of the chrome.
   ========================================================================== */

import { el, mount, icon, qs } from './ui.js';
import { navigate, currentRoute, onRouteChange } from './router.js';
import { getSessions, getProgress, getSettings, subscribe, updateSettings, getMode, describeMode } from './store.js';
import { summary } from './stats.js';
import { applyScript } from './dictionary.js';
import { getStatus } from './api.js';
const NAV = [
  { group: 'Overview', items: [
    { path: '/', label: 'Dashboard', icon: 'home' },
  ] },
  { group: 'Practise', items: [
    { path: '/training', label: 'Training', icon: 'keyboard' },
    { path: '/library', label: 'Library', icon: 'book' },
  ] },
  { group: 'Track', items: [
    { path: '/progress', label: 'Progress', icon: 'chart' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];

let topbarSlot = null;

export function renderShell() {
  renderSidebar();
  renderTopbarBase();
  subscribe(() => {
    renderSidebar();
    updateTopbarMeta();
  });
  // Use the router's own notification rather than a raw "hashchange" listener:
  // this one fires *after* the router has committed the new path, so the
  // highlighted nav item and the top bar never lag one navigation behind.
  onRouteChange(() => {
    renderSidebar();
    updateTopbarMeta();
  });
}

/* ------------------------------------------------------------- sidebar --- */

function renderSidebar() {
  const host = qs('#sidebar');
  if (!host) return;

  const progress = getProgress();
  const sessions = getSessions();
  const stats = summary(sessions, progress);
  const active = currentRoute() || '/';
  const brand = applyScript('拼音练习场', getSettings().script);

  mount(host,
    el('a', { class: 'brand', href: '#/' },
      el('span', { class: 'brand__mark', text: '拼' }),
      el('span', { class: 'brand__text' },
        el('span', { class: 'brand__title cjk', text: brand }),
        el('span', { class: 'brand__sub', text: 'Pinyin Trainer' }),
      ),
    ),
    el('nav', { class: 'nav' },
      ...NAV.flatMap((group) => [
        el('div', { class: 'nav__group', text: group.group }),
        ...group.items.map((item) => navItem(item, active, stats)),
      ]),
    ),
    el('div', { class: 'sidebar__foot' },
      el('div', { class: `sidebar__note sidebar__note--${getMode()}` },
        el('span', { class: 'sidebar__status' },
          el('span', { class: `status-dot status-dot--${getMode()}` }),
          el('strong', { text: getMode() === 'server' ? 'Backend connected' : 'Local mode' }),
        ),
        el('br'),
        getMode() === 'server'
          ? `Words and progress come from the SQLite database at ${getStatus().base || 'this origin'}.`
          : 'No backend reachable, so words come from the seed list and progress is stored in this browser.',
      ),
    ),
  );
}

function navItem(item, active, stats) {
  const here = active || '/';
  const isActive = item.path === '/'
    ? here === '/'
    : here === item.path || here.startsWith(`${item.path}/`);

  let badgeText = null;
  if (item.path === '/progress' && stats.weak > 0) badgeText = String(stats.weak);
  if (item.path === '/library' && stats.sessions === 0) badgeText = null;

  const node = el('a', {
    class: 'nav__item',
    href: `#${item.path}`,
    'aria-current': isActive ? 'page' : null,
    onClick: (event) => {
      event.preventDefault();
      navigate(item.path);
    },
  },
    icon(item.icon, 'nav__icon'),
    el('span', { class: 'nav__label', text: item.label }),
    badgeText ? el('span', { class: 'nav__badge', text: badgeText, title: `${badgeText} weak words` }) : null,
  );
  return node;
}

/* ------------------------------------------------------------- topbar ---- */

function renderTopbarBase() {
  const host = qs('#topbar');
  if (!host) return;

  topbarSlot = el('div', { class: 'topbar__actions' }, themeToggle());
  mount(host,
    el('div', { class: 'topbar__text' },
      el('div', { class: 'topbar__title', id: 'topbar-title', text: 'Dashboard' }),
      el('div', { class: 'topbar__crumbs', id: 'topbar-sub', text: '' }),
    ),
    el('div', { class: 'topbar__spacer' }),
    topbarSlot,
  );
  updateTopbarMeta();
}

/** Views may inject their own action buttons; the theme toggle stays last. */
export function setTopbarActions(...nodes) {
  if (!topbarSlot) return;
  const toggle = themeToggle();
  mount(topbarSlot, ...nodes.filter(Boolean), toggle);
}

export function setTopbar({ title, subtitle }) {
  const titleNode = qs('#topbar-title');
  const subNode = qs('#topbar-sub');
  if (titleNode && title) titleNode.textContent = title;
  if (subNode) subNode.textContent = subtitle || '';
  if (title) document.title = `${title} · ${applyScript('拼音练习场', getSettings().script)}`;
}

function updateTopbarMeta() {
  const map = {
    '/': { title: 'Dashboard', subtitle: 'Overview of your practice' },
    '/training': { title: 'Pinyin Training', subtitle: 'Type the pinyin for random words' },
    '/library': { title: 'Pinyin Library', subtitle: 'Look up the pinyin of any Chinese text' },
    '/progress': { title: 'Progress', subtitle: 'Accuracy, speed and weak words' },
    '/settings': { title: 'Settings', subtitle: 'How the trainer behaves' },
  };
  const active = currentRoute() || '/';
  const key = Object.keys(map).find((path) => (path === '/' ? active === '/' : active.startsWith(path)));
  const meta = map[key] || { title: 'Not found', subtitle: '' };
  setTopbar({ title: meta.title, subtitle: meta.subtitle });
}

function themeToggle() {
  const setting = getSettings().theme;
  const resolved = document.documentElement.dataset.theme;
  const next = resolved === 'dark' ? 'light' : 'dark';
  return el('button', {
    type: 'button',
    class: 'btn btn--ghost btn--sm',
    title: setting === 'system'
      ? `Following your system theme (${resolved}). Click to force ${next}.`
      : `Switch to ${next} theme`,
    'aria-label': `Switch to ${next} theme`,
    onClick: () => updateSettings({ theme: next }),
  }, icon(resolved === 'dark' ? 'sun' : 'moon'));
}
