'use strict';

/**
 * Books dashboard: the pruned widget set and the even grid.
 *
 * The 04.11.2026 cosmetic round removed two widgets that only stretched the
 * page — «Календарь чтения» (its day heatmap never matched the film calendar)
 * and «Издательства» (publishers are metadata, not a reading statistic).
 * The server payload keeps both sections byte-for-byte; this test only pins
 * the browser side, so a future round cannot re-introduce the dead markup or
 * leave a hole in the 12-column grid.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

test('books markup no longer mounts the calendar or the publishers widget', () => {
  const html = readPublic('index.html');

  for (const id of [
    'books-calendar-widget', 'books-calendar-host', 'books-calendar-title',
    'books-publishers-widget', 'books-publishers-list', 'books-publishers-title',
    'books-streak-card',
  ]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id} must stay removed`);
  }
  // The wrapper only existed to stack series above publishers.
  assert.doesNotMatch(html, /books-side-stack/);
});

test('books controller drops the calendar/publishers render paths and view models', () => {
  const js = readPublic('js/books.js');

  assert.doesNotMatch(js, /renderCalendar\(/);
  assert.doesNotMatch(js, /renderPublishers\(/);
  assert.doesNotMatch(js, /normalizeStreaks/);
  assert.doesNotMatch(js, /data\.publishers/);
  // The per-work publisher field stays: book cards still show the imprint.
  assert.match(js, /publisher: text\(entry\.publisher\)/);
  // The monthly timeline still owns the day counts of its drilldown.
  assert.match(js, /state\.data\.readDays\.filter/);
});

test('remaining books widgets keep their mounts', () => {
  const html = readPublic('index.html');

  for (const id of [
    'books-recent-widget', 'books-ratings-title', 'books-genres-list',
    'books-series-widget', 'books-authors-widget', 'books-decades-donut',
    'books-years-donut', 'books-yearbars-chart', 'books-timeline-chart',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} must stay mounted`);
  }
});

test('books grid pairs every row and stretches cards to one height', () => {
  const css = readPublic('books.css');

  // Cards in a row share the same top/bottom edge again.
  assert.match(css, /\.books-dash \.widgets \{ align-items: stretch; \}/);
  // Ratings + genres are an even 6+6 pair (the old 7+5 left uneven widths).
  assert.match(css, /\.books-dash \.w-ratings,\s*\n\.books-dash \.w-genres,/);
  assert.match(css, /\.w-books-series,\s*\n\.w-books-authors \{ grid-column: span 6; \}/);
  // An empty series card is hidden, so authors widen instead of leaving a hole.
  assert.match(css, /\.books-dash \.w-books-authors\.is-wide \{ grid-column: span 12; \}/);
  assert.match(readPublic('js/books.js'), /authors\.classList\.toggle\('is-wide', items\.length === 0\)/);
  assert.match(css, /\.w-books-yearbars \{ grid-column: span 12; \}/);
  // No orphan rules for the removed widgets.
  assert.doesNotMatch(css, /books-side-stack/);
  assert.doesNotMatch(css, /w-books-publishers/);
});
