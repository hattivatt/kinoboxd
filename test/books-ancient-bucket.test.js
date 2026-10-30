'use strict';

/**
 * The ancient bucket «до 1000 г.» is a first-class, clickable slot.
 *
 * User report (30.10.2026): the decade donut had the slice, but it was dead —
 * a click did nothing — and the year chart did not show the bucket at all
 * (`years[]` carried only real years ≥ 1000). The live profile had exactly one
 * such work (Kama Sutra, ~300 AD), so the bucket was invisible everywhere.
 *
 * Pinned here:
 *   - `decades[]` and `years[]` carry the same stable key (`before-1000`) and
 *     the same bound (`beforeYear: 1000`), and the same count — the one that
 *     `summary.ancientBookCount` reports;
 *   - the year bucket has no `year`: the x axis stays linear over real years,
 *     one ancient work never stretches it;
 *   - no double counting: the bucket is not a second copy of any year, so
 *     `years` sum + `yearUnknownCount` = `bookCount`;
 *   - a manual year correction moves the work out of the bucket into its real
 *     decade/year (the UI keeps «…» → «Исправить год» on every row);
 *   - both charts route the click by `ancient`/`beforeYear`, never by the
 *     label, and the bar chart paints the slot outside the year axis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-ancient-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats } = require('../server/books/stats');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function event(id, title, extra = {}) {
  return {
    id,
    source: 'livelib',
    sourceBookId: String(id).replace(/^ll:/, ''),
    title,
    authors: [],
    rating: null,
    ratingScale: 10,
    rating10: null,
    status: 'read',
    finishedAt: '2026-05-05',
    ...extra,
  };
}

function profile(userKey, events) {
  return {
    schemaVersion: 1,
    source: 'livelib',
    userKey,
    sourceUserId: null,
    importedAt: '2026-10-30T00:00:00.000Z',
    events,
    warnings: [],
  };
}

async function linkedWork({ hcId, title, firstPublishedYear, publicationYear = null, yearSource = 'openlibrary' }) {
  await bookCache.saveDetails(hcId, {
    schemaVersion: 2,
    hcWorkId: hcId,
    title,
    authors: [{ name: 'Автор' }],
    publicationYear,
    firstPublishedYear,
    metadataSources: [yearSource],
  });
  await bookCache.saveLink(String(hcId), {
    schemaVersion: 2,
    livelibBookId: String(hcId),
    workId: `hc:${hcId}`,
    method: 'isbn',
    score: 1,
  });
}

test('payload: the ancient bucket is one slot on both charts, counted once', async () => {
  const userKey = 'AncientBucket';
  // Kama Sutra-ish work: the year is the work's own, not the print run's.
  await linkedWork({ hcId: 45230, title: 'The Kama Sutra of Vatsyayana', firstPublishedYear: 300, publicationYear: 2016 });
  await linkedWork({ hcId: 45231, title: 'Гамлет', firstPublishedYear: 1603, publicationYear: 2005 });
  await linkedWork({ hcId: 45232, title: 'Мартин Иден', firstPublishedYear: 1909 });
  await bookCache.saveProfile(
    'livelib',
    userKey,
    profile(userKey, [
      event('ll:45230', 'The Kama Sutra of Vatsyayana', { raw: { sourceBookId: '45230' } }),
      event('ll:45231', 'Гамлет', { raw: { sourceBookId: '45231' } }),
      event('ll:45232', 'Мартин Иден', { raw: { sourceBookId: '45232' } }),
    ])
  );

  const stats = buildBooksStats({ profile: `livelib-${userKey}` });
  const decadeBucket = stats.decades.find((entry) => entry.ancient);
  const yearBucket = stats.years.find((entry) => entry.ancient);

  assert.ok(decadeBucket, 'decades[] carries the ancient bucket');
  assert.ok(yearBucket, 'years[] carries the ancient bucket');
  assert.equal(decadeBucket.label, 'до 1000 г.');
  assert.equal(yearBucket.label, 'до 1000 г.');
  // Stable drilldown key + shared bound: the UI must not guess from the label.
  for (const bucket of [decadeBucket, yearBucket]) {
    assert.equal(bucket.key, 'before-1000');
    assert.equal(bucket.beforeYear, 1000);
    assert.equal(bucket.count, 1);
  }
  // One counter for all three places.
  assert.equal(decadeBucket.count, stats.summary.ancientBookCount);
  assert.equal(yearBucket.count, stats.summary.ancientBookCount);

  // The year bucket is not a year: no `year` that would land on the axis.
  assert.equal(yearBucket.year, undefined);
  // …and it is the first element, left of the real years.
  assert.equal(stats.years[0].ancient, true);
  assert.deepEqual(stats.years.filter((entry) => !entry.ancient).map((entry) => entry.year), [1603, 1909]);

  // No double counting: bucket + real years + unknown = all works.
  const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(known, 3);
  assert.equal(known + stats.summary.yearUnknownCount, stats.summary.bookCount);
  assert.equal(stats.summary.yearsSpan.from, 1603);
});

test('manual year correction moves the work out of the ancient bucket', async () => {
  const userKey = 'AncientMove';
  await linkedWork({ hcId: 46001, title: 'The Kama Sutra of Vatsyayana', firstPublishedYear: 300, publicationYear: 2016 });
  await linkedWork({ hcId: 46002, title: 'Гамлет', firstPublishedYear: 1603 });
  await bookCache.saveProfile(
    'livelib',
    userKey,
    profile(userKey, [
      event('ll:46001', 'The Kama Sutra of Vatsyayana', { raw: { sourceBookId: '46001' } }),
      event('ll:46002', 'Гамлет', { raw: { sourceBookId: '46002' } }),
    ])
  );

  let stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.decades.find((entry) => entry.ancient).count, 1);
  assert.equal(stats.years.find((entry) => entry.ancient).count, 1);
  assert.equal(stats.summary.ancientBookCount, 1);

  // The user's own correction (menu «…» → «Исправить год») outranks providers.
  await bookCache.setYearOverride('livelib', userKey, 'hc:46001', 1850);
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  const work = stats.booksIndex['hc:46001'];
  assert.equal(work.year, 1850);
  assert.equal(work.yearSource, 'manual');
  // The bucket is gone (not an empty leftover) and the work sits in 1850.
  assert.equal(stats.decades.some((entry) => entry.ancient), false);
  assert.equal(stats.years.some((entry) => entry.ancient), false);
  assert.equal(stats.summary.ancientBookCount, 0);
  assert.equal(stats.decades.find((entry) => entry.decade === 1850).count, 1);
  assert.equal(stats.years.find((entry) => entry.year === 1850).count, 1);
  assert.equal(stats.summary.yearManualCount, 1);
  const known = stats.years.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(known + stats.summary.yearUnknownCount, stats.summary.bookCount);

  // Reset brings the bucket back exactly as it was.
  await bookCache.clearYearOverride('livelib', userKey, 'hc:46001');
  stats = buildBooksStats({ profile: `livelib-${userKey}` });
  assert.equal(stats.years.find((entry) => entry.ancient).count, 1);
  assert.equal(stats.summary.ancientBookCount, 1);
});

test('a profile of nothing but ancient works keeps a valid (empty) year axis', async () => {
  const userKey = 'AncientOnly';
  await linkedWork({ hcId: 47001, title: 'Искусство войны', firstPublishedYear: -500 });
  await bookCache.saveProfile(
    'livelib',
    userKey,
    profile(userKey, [event('ll:47001', 'Искусство войны', { raw: { sourceBookId: '47001' } })])
  );

  const stats = buildBooksStats({ profile: `livelib-${userKey}` });
  // Only the bucket: the chart must not invent a year (an axis from -500).
  assert.deepEqual(stats.years.map((entry) => entry.ancient), [true]);
  assert.equal(stats.years[0].count, 1);
  assert.equal(stats.years[0].beforeYear, 1000);
  assert.equal(stats.summary.ancientBookCount, 1);
  assert.equal(stats.summary.yearUnknownCount, 0);
  assert.equal(stats.summary.yearsSpan, null);
});

test('UI: both charts open the same list and the bar slot stays off the year axis', () => {
  const booksSource = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'books.js'), 'utf8');
  const chartsSource = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'charts.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');

  // One drilldown for the decade slice and the year column.
  assert.match(booksSource, /function openAncientYearModal\(bucket\)/);
  assert.match(booksSource, /entry\.year < beforeYear/);
  assert.match(booksSource, /меню «…» у книги → «Исправить год»/);
  // The decade slice routes by data (`ancient`), not by `start === 0`.
  assert.match(booksSource, /if \(seg\.ancient\) \{/);
  assert.match(booksSource, /openAncientYearModal\(seg\)/);
  // The year bars receive the same handler and keep the bucket out of the
  // real-year range/total in the note.
  assert.match(booksSource, /onAncientClick: \(bucket\) => openAncientYearModal\(bucket\)/);
  assert.match(booksSource, /const realYears = years\.filter\(\(item\) => !item\.ancient\)/);

  // charts.js: the bucket is a separate slot with its own hit area.
  assert.match(chartsSource, /const ANCIENT_SLOT_W/);
  assert.match(chartsSource, /onAncientClick/);
  assert.match(chartsSource, /class: 'tl-bar is-ancient'/);
  assert.match(chartsSource, /tl-slot-ancient/);
  assert.match(chartsSource, /tl-separator/);
  // The year axis starts after the slot, so the slot never becomes a year.
  assert.match(chartsSource, /const axisLeft = pad\.left \+ slotW \+ slotGap/);
  // CSS separates it visually.
  assert.match(cssSource, /\.tl-bar\.is-ancient/);
  assert.match(cssSource, /\.tl-slot-ancient/);
  assert.match(cssSource, /\.tl-separator/);
});
