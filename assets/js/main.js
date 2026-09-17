/* ==========================================================================
   main.js — bootstrap: state, backend probe, shell, routes.
   ========================================================================== */

import { loadState, initStore, watchSystemTheme, getMode } from './store.js';
import { loadDictionary, isLoaded, getLoadError } from './dictionary.js';
import { renderShell } from './app-shell.js';
import { route, startRouter } from './router.js';
import { toast } from './ui.js';

import { renderDashboard } from './views/dashboard.js';
import { renderTrainingSetup, renderTrainingSession, renderTrainingResults } from './views/training.js';
import { renderLibrary } from './views/library.js';
import { renderProgress } from './views/progress.js';
import { renderSettings } from './views/settings.js';

function registerRoutes() {
  route('/', renderDashboard, { title: 'Dashboard' });
  route('/training', renderTrainingSetup, { title: 'Training' });
  route('/training/session', renderTrainingSession, { title: 'Training session' });
  route('/training/results/:id', renderTrainingResults, { title: 'Session results' });
  route('/library', renderLibrary, { title: 'Library' });
  route('/progress', renderProgress, { title: 'Progress' });
  route('/settings', renderSettings, { title: 'Settings' });
}

async function boot() {
  // 1. local state + shell first, so the page is never blank while we probe
  loadState();
  renderShell();
  registerRoutes();
  watchSystemTheme();

  // 2. probe the backend and hydrate from SQLite when it answers. Views await
  //    the dictionary themselves, so both loads can overlap.
  const loading = loadDictionary();
  const connecting = initStore();

  await startRouter();
  await Promise.all([loading, connecting]);

  if (!isLoaded()) {
    const error = getLoadError();
    toast(`Dictionary failed to load${error ? `: ${error.message}` : ''}`, { type: 'danger', timeout: 8000 });
  }

  // 3. when the backend answered after the hash router already rendered, the
  //    views were built from local data — refresh so they show the database
  if (getMode() === 'server') {
    const { resolve } = await import('./router.js');
    await resolve();
  }
}

boot().catch((error) => {
  console.error('[main] boot failed', error);
  const outlet = document.getElementById('outlet');
  if (outlet) {
    outlet.innerHTML = `<div class="notice notice--danger"><div><strong>The app failed to start.</strong>
      <br><span class="mono small">${String(error?.message || error)}</span></div></div>`;
  }
});

// expose a few helpers for manual poking in devtools
window.__pinyinTrainer = { loadDictionary, initStore };
