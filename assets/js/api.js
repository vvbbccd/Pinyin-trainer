/* ==========================================================================
   api.js — client for the backend REST API.

   The app runs in two modes:
     'server'  the API answered /api/health, so words, sessions and progress come
               from SQLite
     'local'   no backend reachable, so the app falls back to the static seed data
               and localStorage (the original prototype behaviour)

   Base URL resolution, in order:
     1. ?api=http://host:port  (also persisted for later visits)
     2. localStorage override
     3. the page's own origin  (the backend serves the client too, so this is the
        normal case and needs no configuration)
   ========================================================================== */

const BASE_KEY = 'pinyin-trainer:v1:api-base';
const PROBE_TIMEOUT = 2500;

let state = {
  base: '',
  mode: 'checking',   // checking | server | local
  online: false,
  version: null,
  health: null,
  meta: null,
  error: null,
};

/* -------------------------------------------------------------- errors --- */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.path = path;
  }
}

/* ----------------------------------------------------------- base URL ---- */

export function resolveBase() {
  try {
    const fromQuery = new URLSearchParams(location.search).get('api');
    if (fromQuery !== null) {
      const clean = fromQuery.replace(/\/+$/, '');
      localStorage.setItem(BASE_KEY, clean);
      return clean;
    }
    return localStorage.getItem(BASE_KEY) || '';
  } catch {
    return '';
  }
}

export function setBase(url) {
  state.base = String(url || '').replace(/\/+$/, '');
  try {
    localStorage.setItem(BASE_KEY, state.base);
  } catch { /* private mode: keep it in memory only */ }
  return state.base;
}

export const getBase = () => state.base;
export const getStatus = () => ({ ...state });
export const isOnline = () => state.online;
export const mode = () => state.mode;
export const getMeta = () => state.meta;

/* ------------------------------------------------------------ request ---- */

async function request(method, path, { body, signal, timeout = 15000 } = {}) {
  const url = `${state.base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error?.name === 'AbortError';
    throw new ApiError(
      aborted ? `Request timed out after ${timeout} ms` : `Cannot reach the backend (${error?.message || error})`,
      { status: 0, code: aborted ? 'timeout' : 'network', path },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error || `${method} ${path} failed with HTTP ${response.status}`,
      { status: response.status, code: payload?.code || 'http_error', path },
    );
  }
  return payload;
}

/* -------------------------------------------------------------- probe ---- */

/**
 * Ask the backend whether it is there. Never throws: a failure simply means the
 * app stays in local mode.
 */
export async function probe({ timeout = PROBE_TIMEOUT } = {}) {
  state.base = resolveBase();
  try {
    const health = await request('GET', '/api/health', { timeout });
    state.mode = 'server';
    state.online = true;
    state.version = health?.version ?? null;
    state.health = health ?? null;
    state.error = null;
    try {
      state.meta = await request('GET', '/api/meta', { timeout: 8000 });
    } catch {
      state.meta = null;   // health is enough to work; meta is a bonus
    }
    return true;
  } catch (error) {
    state.mode = 'local';
    state.online = false;
    state.version = null;
    state.health = null;
    state.meta = null;
    state.error = error;
    return false;
  }
}

/** Re-probe after the user changes the base URL. */
export async function reconnect(base) {
  if (base !== undefined) setBase(base);
  return probe();
}

/* ----------------------------------------------------------- endpoints --- */

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request('GET', '/api/health'),
  meta: () => request('GET', '/api/meta'),

  words: {
    list: (params) => request('GET', `/api/words${query(params)}`),
    random: (params) => request('GET', `/api/words/random${query(params)}`),
    get: (id) => request('GET', `/api/words/${encodeURIComponent(id)}`),
  },

  lookup: (text, { record = true } = {}) =>
    request('POST', '/api/lookup', { body: { text, record } }),

  sessions: {
    list: (params) => request('GET', `/api/sessions${query(params)}`),
    save: (session) => request('POST', '/api/sessions', { body: session }),
    get: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}`),
    remove: (id) => request('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  },

  progress: {
    get: (params) => request('GET', `/api/progress${query(params)}`),
    map: () => request('GET', '/api/progress/map'),
    words: (params) => request('GET', `/api/progress/words${query(params)}`),
    reset: () => request('DELETE', '/api/progress'),
  },

  savedWords: {
    list: (params) => request('GET', `/api/library/saved${query(params)}`),
    add: (entry) => request('POST', '/api/library/saved', { body: entry }),
    remove: (simplified, pinyin) => request('DELETE', `/api/library/saved${query({ simplified, pinyin })}`),
  },

  history: {
    list: (params) => request('GET', `/api/library/history${query(params)}`),
    add: (entry) => request('POST', '/api/library/history', { body: entry }),
    clear: () => request('DELETE', '/api/library/history'),
  },

  settings: {
    get: () => request('GET', '/api/settings'),
    put: (settings) => request('PUT', '/api/settings', { body: { settings } }),
  },

  me: () => request('GET', '/api/users/me'),
};

export default api;
