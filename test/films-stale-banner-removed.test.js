'use strict';

/**
 * Films dashboard: no "Обновите профиль / данные устарели" nag after a
 * server restart.
 *
 * A restarted server forgets every `uploadId`, so the boot path falls back to
 * the IndexedDB payload (`handleUnknownUpload`). That fallback used to raise a
 * sticky topbar banner plus an info toast on every restart, even though the
 * topbar already carries a permanent «↻ Обновить профиль» action. The nag was
 * removed; these assertions keep it gone:
 *
 *   1. index.html has no `#stale-banner` markup (and no stale-* id at all);
 *   2. main.js has no banner logic (`showStaleBanner`/`hideStaleBanner`/
 *      `staleProfileId`) and no `#stale-refresh` binding;
 *   3. the restart fallback still renders the cached payload and stays quiet —
 *      no toast, no banner call — while the manual refresh button survives;
 *   4. style.css dropped the dead banner rules.
 *
 * The date formatter lives on in switcher.js (`formatSavedAt` there renders
 * profile timestamps and is unrelated to the banner).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/** Extract the body of `function <name>(...) { ... }` by brace counting. */
function functionBody(js, name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `main.js still defines ${name}()`);
  const open = js.indexOf('{', js.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < js.length; i += 1) {
    if (js[i] === '{') depth += 1;
    else if (js[i] === '}') {
      depth -= 1;
      if (depth === 0) return js.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

test('index.html no longer carries the stale-data banner markup', () => {
  const html = readPublic('index.html');

  assert.doesNotMatch(html, /id="stale-banner"/, 'the banner element must be gone');
  assert.doesNotMatch(html, /id="stale-refresh"/);
  assert.doesNotMatch(html, /id="stale-(?:title|meta)"/);
  assert.doesNotMatch(html, /Данные устарели/);
  assert.doesNotMatch(html, /Показаны сохранённые данные/);
  assert.doesNotMatch(html, /Обновите профиль/);

  // The permanent manual refresh affordance is what replaced the banner.
  assert.match(html, /id="profile-refresh"/, 'topbar «Обновить профиль» must stay');
});

test('main.js has no stale-banner logic left', () => {
  const js = readPublic('js/main.js');

  assert.doesNotMatch(js, /stale-banner/);
  assert.doesNotMatch(js, /stale-refresh/);
  assert.doesNotMatch(js, /stale-title/);
  assert.doesNotMatch(js, /stale-meta/);
  assert.doesNotMatch(js, /staleProfileId/);
  assert.doesNotMatch(js, /showStaleBanner|hideStaleBanner/);
  // formatSavedAt() lived only for the banner copy; switcher.js keeps its own.
  assert.doesNotMatch(js, /function formatSavedAt/);
});

test('restart fallback draws the cache silently, without banner or toast', () => {
  const js = readPublic('js/main.js');
  const body = functionBody(js, 'handleUnknownUpload');

  // The cached branch keeps rendering the local payload ...
  assert.match(body, /const cached = await getStatsCache\(profile\.id\)/);
  assert.match(body, /applyStats\(cached\.stats, \{ fromCache: true, profile \}\)/);
  assert.match(body, /return;/, 'the cached branch must return without recovery');

  // ... and says nothing about it: no toast, no banner helper call.
  assert.doesNotMatch(body, /toast\(/, 'no restart toast in the cache fallback');
  assert.doesNotMatch(body, /Banner/, 'no banner helper in the cache fallback');
  assert.doesNotMatch(body, /устарел|перезапустился|Обновите/i);

  // The no-cache path still replays the import instead of nagging.
  assert.match(body, /await recoverProfile\(profile, \{ flow: current \}\)/);
});

test('the unrecoverable-profile toast is not a restart nag', () => {
  const js = readPublic('js/main.js');
  // Only the "cache + no link -> import again" hard failure may speak up.
  const unrecoverable = functionBody(js, 'showUnrecoverableProfile');
  assert.match(unrecoverable, /toast\(/);
  assert.doesNotMatch(unrecoverable, /Banner/);
});

test('style.css dropped the dead banner rules', () => {
  const css = readPublic('style.css');

  assert.doesNotMatch(css, /\.topbar-banner/);
  assert.doesNotMatch(css, /\.stale-icon/);
  assert.doesNotMatch(css, /\.stale-copy/);
  assert.doesNotMatch(css, /\.btn-stale/);
});
