'use strict';

/**
 * Books: a `livelib-backup` file import (201) activates `livelib-<user>`.
 *
 * `submitFileImport()` calls `ensureProfileForImport('livelib', username)`
 * after the server accepts the file. That helper creates the local profile on
 * the first import and must keep an already-active one active on a repeat
 * upload (idempotent) — the bug this test pins is the early return that left
 * the switcher unhighlighted when the active id had been cleared.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installDom, textById } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=books', href: 'http://localhost/?tab=books' });

const routes = [];
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  routes.push(`${options.method || 'GET'} ${target}`);
  let payload = {};
  let status = 200;

  if (target.startsWith('/api/books/profiles')) payload = { profiles: [] };
  else if (target.startsWith('/api/books/import/livelib-file')) {
    status = 201;
    payload = {
      imported: 12,
      added: 12,
      enriched: 0,
      skipped: 0,
      events: 12,
      format: 'json',
      shelf: 'read',
      shelves: { read: 12 },
      resolve: null,
    };
  } else if (target.startsWith('/api/books/stats')) {
    // The payload is irrelevant here: the import screen is fine after 201.
    status = 404;
    payload = { error: 'profile_not_found' };
  } else if (target.startsWith('/api/books/import/status')) {
    payload = { done: true, stage: 'done' };
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  };
};

function rows() {
  return nodeFor('books-profile-list').children
    .filter((node) => node.classList && node.classList.contains('profile-item'));
}
function activeRows() {
  return rows().filter((node) => node.classList.contains('is-active'));
}
async function wait(ms = 0) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function submitExportFile() {
  nodeFor('books-livelib-file-user').value = 'Margaret';
  nodeFor('books-livelib-file').files = [
    new File([JSON.stringify({ books: [] })], 'livelib-backup.json', { type: 'application/json' }),
  ];
  nodeFor('books-livelib-file-form').dispatch('submit');
}

test('books file import: 201 makes livelib-Margaret the active profile', async () => {
  const books = await import('../public/js/books.js');
  books.initBooks({ onActivate() {} });
  await books.showBooks();
  await wait(40);

  assert.equal(rows().length, 0, 'a fresh browser has no book profiles');

  submitExportFile();
  await wait(200);

  assert.ok(routes.some((route) => route === 'POST /api/books/import/livelib-file'));
  assert.ok(
    routes.some((route) => route.startsWith('GET /api/books/stats?profile=livelib-Margaret')),
    'the stats request is scoped to the imported profile',
  );
  assert.ok(storage.get('kinoboxd.books.profile.v1'), 'the active id is persisted');
  assert.ok(nodeFor('books-profile-switcher').classList.contains('has-active'));
  assert.equal(rows().length, 1);
  assert.equal(activeRows().length, 1, 'the imported profile is highlighted');
  assert.match(textById(nodeFor, 'books-profile-list'), /LiveLib @Margaret/);
});

test('books re-import of the same account stays on one active row', async () => {
  // A cleared active-id key (privacy cleanup / manual localStorage edit) must
  // not leave the repeat import attached to an unhighlighted profile: the
  // idempotent path re-asserts the active id and repaints the switcher.
  storage.delete('kinoboxd.books.profile.v1');
  submitExportFile();
  await wait(200);

  assert.equal(rows().length, 1, 'no duplicate profile row');
  assert.equal(activeRows().length, 1);
  assert.ok(storage.get('kinoboxd.books.profile.v1'), 'the active id is restored');
});
