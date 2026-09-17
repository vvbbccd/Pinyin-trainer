/**
 * Imports every browser module except main.js to catch syntax errors and
 * typo'd named imports (ESM throws on a missing export).
 * No dependencies.
 *
 * Run:  node tools/tests/test_imports.mjs      (or: npm test)
 */
const modules = [
  '../../assets/js/ui.js',
  '../../assets/js/pinyin.js',
  '../../assets/js/store.js',
  '../../assets/js/dictionary.js',
  '../../assets/js/stats.js',
  '../../assets/js/router.js',
  '../../assets/js/app-shell.js',
  '../../assets/js/views/shared.js',
  '../../assets/js/views/dashboard.js',
  '../../assets/js/views/training.js',
  '../../assets/js/views/library.js',
  '../../assets/js/views/progress.js',
  '../../assets/js/views/settings.js',
];

let failed = 0;
for (const path of modules) {
  try {
    const mod = await import(path);
    const names = Object.keys(mod).sort();
    console.log(`ok   ${path.replace('../../assets/js/', '').padEnd(22)} ${names.length} exports`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${path}\n     ${error.message}`);
  }
}

console.log(failed ? `\n${failed} module(s) failed to import` : '\nall modules import cleanly');
process.exit(failed ? 1 : 0);
