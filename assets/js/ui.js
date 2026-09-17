/* ==========================================================================
   ui.js — tiny DOM helpers, icons, formatters, toasts and modals.
   No framework: everything is plain DOM so the markup stays inspectable.
   ========================================================================== */

/* --------------------------------------------------------------- DOM ----- */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

function applyProps(node, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') node[key] = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(container, ...children) {
  clear(container);
  append(container, children);
  return container;
}

export const qs = (selector, scope = document) => scope.querySelector(selector);
export const qsa = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

/* ------------------------------------------------------------- icons ----- */

const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 13.5h9"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5z"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H19v-3"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.1 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0A1.7 1.7 0 0 0 16.9 5.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.9 11a2 2 0 1 1 0 4z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 21h14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 3 1-6.1L3.2 9.5l6.1-.9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  play: '<path d="m7 4 12 8-12 8z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  flame: '<path d="M12 3c3 4 6 5.5 6 9.5A6 6 0 0 1 6 13c0-2 1-3.5 2-4.5"/><path d="M12 21a3 3 0 0 0 3-3c0-2-3-3.5-3-6-2 2-3 3.5-3 5.5A3.5 3.5 0 0 0 12 21z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  book2: '<path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2z"/><path d="M12 6.5v14"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4.5l3 2"/>',
  award: '<circle cx="12" cy="9" r="5.5"/><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7"/>',
  pencil: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  sparkle: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5"/><path d="m6.5 6.5 3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3"/>',
};

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.info;
  return svg;
}

/* ---------------------------------------------------------- formatters --- */

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatPercent(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function formatRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* -------------------------------------------------------------- toasts --- */

const TOAST_ICON = { success: 'check', danger: 'x', warning: 'alert', info: 'info' };

export function toast(message, { type = 'info', timeout = 2800 } = {}) {
  const host = qs('#toasts');
  if (!host) return () => {};
  const node = el('div', { class: `toast toast--${type}`, role: 'status' },
    icon(TOAST_ICON[type] || 'info', 'toast__icon'),
    el('span', { class: 'toast__text', text: message }),
  );
  host.append(node);
  const remove = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 180);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return remove;
}

/* -------------------------------------------------------------- modals --- */

export function openModal({ title, body, actions = [], onClose }) {
  const root = qs('#modal-root');
  const close = () => {
    document.removeEventListener('keydown', onKey);
    clear(root);
    if (onClose) onClose();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

  const actionNodes = actions.map((action) => el('button', {
    type: 'button',
    class: `btn ${action.class || ''}`.trim(),
    text: action.label,
    onClick: () => {
      if (action.onClick) action.onClick(close);
      if (action.close !== false) close();
    },
  }));

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? el('h2', { class: 'modal__title', text: title }) : null,
    typeof body === 'string' ? el('p', { class: 'modal__text', text: body }) : body,
    actionNodes.length ? el('div', { class: 'modal__actions' }, ...actionNodes) : null,
  );

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onClick: (event) => { if (event.target === backdrop) close(); },
  }, modal);

  clear(root).append(backdrop);
  document.addEventListener('keydown', onKey);
  const focusable = modal.querySelector('input, textarea, button, select, a[href]');
  if (focusable) focusable.focus();
  return { close, modal };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    openModal({
      title,
      body: message,
      onClose: () => done(false),
      actions: [
        { label: cancelLabel, class: 'btn--ghost', onClick: () => done(false) },
        { label: confirmLabel, class: danger ? 'btn--danger' : 'btn--primary', onClick: () => done(true) },
      ],
    });
  });
}

/* ------------------------------------------------------------ snippets --- */

export function statTile({ label, value, unit, meta, iconName, accent = false }) {
  return el('div', { class: `tile ${accent ? 'tile--accent' : ''}` },
    el('div', { class: 'tile__label' }, iconName ? icon(iconName, 'icon') : null, el('span', { text: label })),
    el('div', { class: 'tile__value' }, String(value), unit ? el('small', { text: unit }) : null),
    meta ? el('div', { class: 'tile__meta', text: meta }) : null,
  );
}

export function emptyState({ title, text, iconName = 'info', action }) {
  return el('div', { class: 'empty' },
    icon(iconName, 'empty__icon'),
    el('div', { class: 'empty__title', text: title }),
    text ? el('p', { class: 'empty__text', text }) : null,
    action || null,
  );
}

export function notice(message, { type = 'info', iconName } = {}) {
  const fallback = { info: 'info', warning: 'alert', danger: 'alert', success: 'check' }[type] || 'info';
  return el('div', { class: `notice notice--${type}` },
    icon(iconName || fallback, 'notice__icon'),
    el('div', {}, typeof message === 'string' ? el('span', { text: message }) : message),
  );
}

export function badge(text, variant = '') {
  return el('span', { class: `badge ${variant ? `badge--${variant}` : ''}`, text });
}

export function progressBar(value, { variant = '', large = false, label } = {}) {
  const percent = clamp(value * 100, 0, 100);
  return el('div', { class: 'bar-row' },
    el('div', { class: `bar ${large ? 'bar--lg' : ''}`, role: 'progressbar', 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      el('div', { class: `bar__fill ${variant ? `bar__fill--${variant}` : ''}`, style: { width: `${percent}%` } }),
    ),
    el('span', { class: 'bar-row__value', text: label ?? `${Math.round(percent)}%` }),
  );
}

export function segmented(name, options, value, onChange) {
  return el('div', { class: 'segmented', role: 'radiogroup' },
    ...options.map((option) => el('label', { class: 'segmented__opt', title: option.hint || '' },
      el('input', {
        type: 'radio',
        name,
        value: option.value,
        checked: String(value) === String(option.value),
        onChange: () => onChange(option.value),
      }),
      el('span', {}, option.label, option.sub ? el('small', { text: option.sub }) : null),
    )),
  );
}

/**
 * Select element. `value` is applied after the options are attached so the
 * browser actually selects it (a detached <option selected> is unreliable).
 */
export function select({ options = [], value, onChange, className = 'select', name, ariaLabel } = {}) {
  const node = el('select', {
    class: className,
    name,
    'aria-label': ariaLabel,
    onChange: (event) => onChange?.(event.target.value, event),
  });
  for (const option of options) {
    node.append(el('option', { value: option.value, text: option.label }));
  }
  if (value != null) node.value = String(value);
  return node;
}

export function switchField({ title, desc, checked, onChange, name }) {
  return el('label', { class: 'switch' },
    el('input', { type: 'checkbox', name, checked, onChange: (event) => onChange(event.target.checked) }),
    el('span', { class: 'switch__track' }),
    el('span', { class: 'switch__text' },
      el('span', { class: 'switch__title', text: title }),
      desc ? el('span', { class: 'switch__desc', text: desc }) : null,
    ),
  );
}
