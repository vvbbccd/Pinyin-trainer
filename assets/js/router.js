/* ==========================================================================
   router.js — hash routing with async views and per-route cleanup.
   Hash routing keeps the prototype working from any static host with no
   server-side rewrite rules.
   ========================================================================== */

const routes = [];
let currentCleanup = null;
// The shell renders before the first resolve(), so the current path must never
// be null: nav highlighting and the top bar both read it.
let currentPath = '/';
const listeners = new Set();

/**
 * Register a view.
 * @param {string} pattern e.g. '/training/results/:id'
 * @param {(outlet: HTMLElement, params: object, context: object) => any} handler
 *        may be async and may return a cleanup function
 */
export function route(pattern, handler, meta = {}) {
  const keys = [];
  const regex = new RegExp(`^${pattern
    .replace(/\/$/, '')
    .replace(/:[A-Za-z0-9_]+/g, (match) => { keys.push(match.slice(1)); return '([^/]+)'; })}/?$`);
  routes.push({ pattern, handler, meta, regex, keys });
  return () => {
    const index = routes.findIndex((r) => r.regex === regex);
    if (index >= 0) routes.splice(index, 1);
  };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === target) {
    resolve();
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) resolve();
}

export function currentRoute() {
  return currentPath;
}

export function onRouteChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: path.replace(/\/+$/, '') || '/', query };
}

export async function resolve() {
  const { path, query } = parseHash();
  const match = routes
    .map((r) => ({ r, m: r.regex.exec(path) }))
    .find((entry) => entry.m);

  const previousPath = currentPath;
  currentPath = path;

  if (typeof currentCleanup === 'function') {
    try {
      currentCleanup();
    } catch (error) {
      console.error('[router] cleanup failed', error);
    }
    currentCleanup = null;
  }

  if (!match) {
    renderNotFound(path);
    notify(path, null, previousPath);
    return;
  }

  const params = {};
  match.r.keys.forEach((key, index) => { params[key] = decodeURIComponent(match.m[index + 1]); });

  const outlet = document.getElementById('outlet');
  if (outlet) outlet.innerHTML = '';

  try {
    // views are called as (outlet, params, context)
    const result = await match.r.handler(outlet, params, { path, query, meta: match.r.meta });
    if (typeof result === 'function') currentCleanup = result;
  } catch (error) {
    console.error('[router] view failed', error);
    renderError(error);
  }

  notify(path, match.r.meta, previousPath);
  if (outlet && previousPath !== path) outlet.scrollIntoView({ block: 'start' });
  if (outlet) outlet.focus({ preventScroll: true });
}

function notify(path, meta, previousPath) {
  for (const listener of listeners) listener({ path, meta, previousPath });
}

function renderNotFound(path) {
  const outlet = document.getElementById('outlet');
  if (!outlet) return;
  outlet.innerHTML = `
    <div class="empty">
      <div class="empty__title">Page not found</div>
      <p class="empty__text">No view is registered for <code>${path.replace(/[<>&]/g, '')}</code>.</p>
      <a class="btn btn--primary" href="#/">Back to dashboard</a>
    </div>`;
}

function renderError(error) {
  const outlet = document.getElementById('outlet');
  if (!outlet) return;
  outlet.innerHTML = `
    <div class="notice notice--danger">
      <div>
        <strong>This view failed to render.</strong><br>
        <span class="mono small">${String(error && error.message ? error.message : error).replace(/[<>&]/g, '')}</span>
      </div>
    </div>`;
}

export function startRouter() {
  window.addEventListener('hashchange', resolve);
  if (!location.hash) history.replaceState(null, '', '#/');
  return resolve();
}
