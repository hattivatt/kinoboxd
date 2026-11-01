'use strict';

/**
 * Films: a finished KinoPoisk import becomes the active profile immediately.
 *
 * The registry write is asynchronous, so before this round the dashboard was
 * rendered with `profileId = null` and the topbar switcher said «Профиль»
 * until `/api/profiles` answered (and stayed that way if the request was slow).
 * The activation point is the stats payload: its `summary.source.kpUserId`
 * names the profile, so `applyStats()` now marks that record active and paints
 * the switcher before the registry refresh.
 *
 * The smoke drives the real `main.js` in the headless DOM shim: submit the
 * upload form, answer the job as done, then inspect the switcher. A second
 * import of the same account must reuse the same row (idempotent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textById } = require('./helpers/dom-shim');

const { nodeFor, storage, document } = installDom();

const statsPayload = {
  summary: {
    source: {
      type: 'kinopoisk',
      kpUserId: '15702206',
      kpNick: 'tester',
      fetchedAt: '2026-11-01T00:00:00.000Z',
    },
    filmCount: 12,
    ratedCount: 12,
    viewCount: 12,
    ratedFilms: 12,
    dateFrom: '2001-01-01',
    dateTo: '2026-01-01',
    attachedLb: null,
  },
  ratings: [],
  genres: [],
  franchises: [],
  runtimeHistogram: [],
  decades: [],
  years: [],
  decadeMatrix: [],
  auteurs: [],
  origins: [],
  periods: [],
  yearBars: [],
  timeline: [],
  recentlyWatched: [],
  watchCalendar: [],
  persons: { directors: [], actors: [] },
  films: [],
  events: [],
};

let profileCalls = 0;
const routes = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};
  let status = 200;

  if (target.startsWith('/api/auth/session')) payload = { authRequired: false, authed: true };
  else if (target.startsWith('/api/profiles')) {
    // The first catalogue read is empty (fresh browser); every later one hangs
    // on purpose: activation must not depend on the registry refresh.
    profileCalls += 1;
    if (profileCalls > 1) return new Promise(() => {});
    payload = [];
  } else if (target.startsWith('/api/import/kinopoisk/status')) {
    payload = { done: true, stage: 'done', matched: 12, total: 12, failed: 0 };
  } else if (target.startsWith('/api/import/kinopoisk')) {
    status = 201;
    payload = { uploadId: 'up-1', userId: '15702206', stage: 'scrape' };
  } else if (target.startsWith('/api/stats')) payload = statsPayload;
  else if (target.startsWith('/api/tmdb')) payload = { results: [] };

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
};

function rows() {
  return nodeFor('profile-list').children
    .filter((node) => node.classList && node.classList.contains('profile-item'));
}
function activeRows() {
  return rows().filter((node) => node.classList.contains('is-active'));
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('films import: the new KinoPoisk profile is active before /api/profiles answers', async () => {
  await import('../public/js/main.js');
  await wait(80);

  assert.equal(document.body.dataset.view, 'upload', 'a fresh browser opens the upload screen');

  nodeFor('kp-url').value = 'https://www.kinopoisk.ru/user/15702206/';
  nodeFor('kp-form').dispatch('submit');
  await wait(400);

  assert.equal(document.body.dataset.view, 'dashboard');
  assert.ok(routes.some((route) => route === 'POST /api/import/kinopoisk'), 'the import was started');
  assert.ok(routes.some((route) => route.startsWith('GET /api/stats?uploadId=up-1')), 'the payload was read');

  const session = JSON.parse(storage.get('kinoboxd.session.v1') || 'null');
  assert.equal(session.profileId, 'kp:15702206', 'the session remembers the imported profile');
  assert.equal(session.uploadId, 'up-1');

  assert.equal(rows().length, 1, 'exactly one switcher row');
  assert.equal(activeRows().length, 1, 'the imported profile is highlighted');
  assert.equal(nodeFor('profile-btn-label').textContent, 'Кинопоиск · tester');
  assert.match(textById(nodeFor, 'profile-list'), /Кинопоиск · tester/);
});

test('films re-import: the same account updates the row instead of duplicating it', async () => {
  // Open the upload screen from the switcher and import the same user again.
  nodeFor('profile-add').click();
  nodeFor('kp-url').value = 'https://www.kinopoisk.ru/user/15702206/';
  nodeFor('kp-form').dispatch('submit');
  await wait(400);

  assert.equal(document.body.dataset.view, 'dashboard');
  assert.equal(rows().length, 1, 'a re-import must not add a second row');
  assert.equal(activeRows().length, 1);
  assert.equal(JSON.parse(storage.get('kinoboxd.session.v1') || 'null').profileId, 'kp:15702206');
});
