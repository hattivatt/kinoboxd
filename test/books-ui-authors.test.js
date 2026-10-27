'use strict';

/**
 * Books dashboard: authors ("Персоналии · авторы") contract.
 *
 * Two things are pinned here, because both have already caused a
 * "виджета не видно" report:
 *
 *   1. The payload really exposes `authors` (name/count/works) and
 *      `summary.authorsCount` — the backend side of the widget.
 *   2. public/index.html keeps the authors widget *and* labels it the way the
 *      films tab labels its people widget ("Персоналии"), so the user can
 *      find it by the same name. books.js must keep reading `data.authors`
 *      (the field name in the payload).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-authors-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

async function details(workId, doc) {
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), {
    schemaVersion: 2,
    workId,
    ...doc,
  });
}

function hcEvent(bookId, title, authors, finishedAt) {
  return {
    id: `hc:read:${bookId}`,
    source: 'hardcover',
    sourceBookId: String(bookId),
    workId: `hc:${bookId}`,
    title,
    authors,
    status: 'read',
    statusId: 3,
    finishedAt,
    edition: {},
  };
}

test.before(async () => {
  await details('hc:11', {
    title: 'The Anubis Gates',
    authors: [{ name: 'Tim Powers' }],
    genres: ['Fantasy'],
    metadataSources: ['hardcover'],
    mangaComics: false,
  });
  await details('hc:12', {
    title: 'The Stress of Her Regard',
    authors: [{ name: 'Tim Powers' }, { name: 'James Blaylock' }],
    genres: ['Fantasy'],
    metadataSources: ['hardcover'],
    mangaComics: false,
  });
  await bookCache.saveProfile('hardcover', 'authors-test', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: 'authors-test',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      hcEvent('11', 'The Anubis Gates', ['Tim Powers'], '2024-01-02'),
      hcEvent('12', 'The Stress of Her Regard', ['Tim Powers'], '2024-02-03'),
    ],
  });
});

test('payload exposes authors with counts, works and summary.authorsCount', () => {
  const stats = buildBooksStats({});

  assert.ok(Array.isArray(stats.authors), 'authors must be an array');
  assert.equal(stats.authors.length, 2);
  assert.equal(stats.summary.authorsCount, 2);

  const tim = stats.authors.find((entry) => entry.name === 'Tim Powers');
  assert.ok(tim, 'Tim Powers must be present');
  assert.equal(tim.count, 2);
  assert.deepEqual(tim.works.map((work) => work.workId).sort(), ['hc:11', 'hc:12']);
  assert.ok(tim.works.every((work) => typeof work.title === 'string' && work.title.length > 0));

  const james = stats.authors.find((entry) => entry.name === 'James Blaylock');
  assert.equal(james.count, 1);

  // Stable order: count desc inside the same payload.
  assert.deepEqual(stats.authors.map((entry) => entry.name), ['Tim Powers', 'James Blaylock']);

  // booksIndex carries the same author names as plain strings (modal + cards).
  assert.deepEqual(stats.booksIndex['hc:11'].authors, ['Tim Powers']);
  assert.deepEqual(stats.booksIndex['hc:12'].authors, ['Tim Powers', 'James Blaylock']);
});

test('books markup keeps the authors widget under the films label', () => {
  const html = readPublic('index.html');

  assert.match(html, /id="books-authors-widget"/);
  assert.match(
    html,
    /id="books-authors-title"[^>]*>[^<]*<span[^>]*><\/span>Персоналии · авторы</,
    'authors widget must be titled "Персоналии · авторы"'
  );
  assert.match(
    html,
    /id="books-authors-widget"[^>]*aria-label="Персоналии · авторы"/,
    'authors widget must expose the same aria-label'
  );
  // The films widget keeps its own label: the books rename must not leak.
  assert.match(html, /id="w-persons-title"[^>]*>[^<]*<span[^>]*><\/span>Персоналии</);
});

test('books.js renders the payload field the backend actually sends', () => {
  const js = readPublic('js/books.js');
  assert.match(js, /function renderAuthors\(data\)/);
  assert.match(js, /const all = data\.authors\.slice\(\)/, 'renderAuthors must read data.authors');
  assert.match(js, /renderAuthors\(data\);/, 'renderAuthors must be wired into the dashboard');
  assert.match(js, /\$\('books-authors-list'\)/, 'renderAuthors must target the markup host');
});
