'use strict';

/**
 * Books stats: Hardcover journal status filter at the aggregation level.
 *
 * Profiles imported before the import-time status filter (commit ca6efc1)
 * persisted wish/reading/paused events. Those events must not count in any
 * widget — bookCount, series, timeline — even though the file on disk still
 * contains them. New profiles carry `statusId`; legacy ones fall back to the
 * `status` label.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-status-'));

const bookCache = require('../server/books/book-cache');
const { buildBooksStats, keepHardcoverProfileEvent } = require('../server/books/stats');

function hcEvent(id, bookId, extra = {}) {
  return {
    id: `hc:read:${id}`,
    source: 'hardcover',
    sourceBookId: String(bookId),
    workId: `hc:${bookId}`,
    title: `Book ${bookId}`,
    authors: ['Jim Butcher'],
    rating: 4,
    ratingScale: 5,
    rating10: 8,
    status: 'read',
    statusId: 3,
    finishedAt: '2025-01-02',
    edition: {},
    ...extra,
  };
}

test.before(async () => {
  for (let position = 1; position <= 9; position++) {
    const bookId = 1000 + position;
    await bookCache.saveDetails(bookCache.detailsKeyForWork(`hc:${bookId}`), {
      schemaVersion: 2,
      workId: `hc:${bookId}`,
      title: `Dresden ${position}`,
      authors: [{ name: 'Jim Butcher' }],
      genres: ['Fantasy'],
      series: [{ hcId: 990, name: 'The Dresden Files', position }],
      mangaComics: false,
    });
  }

  const read = [];
  for (let position = 1; position <= 9; position++) {
    read.push(hcEvent(position, 1000 + position));
  }
  await bookCache.saveProfile('hardcover', '34748', {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: '34748',
    importedAt: '2026-10-27T13:03:47.585Z',
    events: [
      ...read,
      // Currently reading + wishlist: leaked by the pre-filter import.
      hcEvent(90, 2001, { status: 'reading', statusId: 2, finishedAt: '2025-02-01', rating: null, rating10: null }),
      hcEvent(91, 2002, { status: 'wish', statusId: 1, finishedAt: null, rating: null, rating10: null }),
      hcEvent(92, 2003, { status: 'wish', statusId: 1, finishedAt: null, rating: null, rating10: null }),
      // dnf (5) stays in the profile but never dates a book.
      hcEvent(93, 2004, { status: 'dnf', statusId: 5, finishedAt: null }),
      // Legacy schema (no statusId): the label is the only available signal.
      hcEvent(94, 2005, { statusId: undefined }),
      hcEvent(95, 2006, {
        status: 'wish',
        statusId: undefined,
        finishedAt: '2025-03-03',
        rating: null,
        rating10: null,
      }),
      // Unknown schema: neither key, must survive (no silent data loss).
      hcEvent(96, 2007, { status: undefined, statusId: undefined }),
    ],
  });

  await bookCache.saveProfile('livelib', 'tester', {
    schemaVersion: 1,
    source: 'livelib',
    userKey: 'tester',
    importedAt: '2026-10-27T00:00:00.000Z',
    events: [
      {
        id: 'll:7001',
        source: 'livelib',
        sourceBookId: '7001',
        title: 'Любимая книга',
        authors: ['Иван Петров'],
        rating: 9,
        ratingScale: 10,
        rating10: 9,
        status: 'read',
        finishedAt: '2024-05-01',
        edition: {},
      },
    ],
  });
  bookCache.flushLinks();
});

test('keepHardcoverProfileEvent prefers statusId, falls back to the label', () => {
  assert.equal(keepHardcoverProfileEvent({ statusId: 3, status: 'read' }), true);
  assert.equal(keepHardcoverProfileEvent({ statusId: 5, status: 'dnf' }), true);
  assert.equal(keepHardcoverProfileEvent({ statusId: 1, status: 'wish' }), false);
  assert.equal(keepHardcoverProfileEvent({ statusId: 2, status: 'reading' }), false);
  assert.equal(keepHardcoverProfileEvent({ statusId: 4, status: 'paused' }), false);
  // statusId wins over a contradictory label.
  assert.equal(keepHardcoverProfileEvent({ statusId: 1, status: 'read' }), false);
  // Legacy labels.
  assert.equal(keepHardcoverProfileEvent({ status: 'read' }), true);
  assert.equal(keepHardcoverProfileEvent({ status: 'dnf' }), true);
  assert.equal(keepHardcoverProfileEvent({ status: 'wish' }), false);
  assert.equal(keepHardcoverProfileEvent({ status: 'paused' }), false);
  // Unknown schema survives.
  assert.equal(keepHardcoverProfileEvent({}), true);
});

test('stale wish/reading events are dropped from every aggregate', () => {
  const stats = buildBooksStats({ profile: 'hardcover-34748' });
  const summary = stats.summary;

  // 9 read + dnf(5) + legacy read + unknown-schema = 12 Hardcover events.
  // Wish/reading never enter; the LiveLib profile is a different profile and
  // its event is not part of this payload.
  assert.equal(summary.hardcoverStatusExcluded, 4);
  assert.equal(summary.eventCount, 12);
  assert.equal(summary.bookCount, 12);
  assert.equal(summary.finishedCount, 11); // 9 read + legacy read + unknown
  assert.equal(summary.undatedEventCount, 1); // dnf only
  assert.equal(stats.meta.statusFilter.excluded, 4);
  assert.deepEqual(stats.meta.statusFilter.keepStatusIds, [3, 5]);
  assert.equal(stats.meta.statusFilter.byStatus['1:wish'], 2);
  assert.equal(stats.meta.statusFilter.byStatus['2:reading'], 1);
  assert.equal(stats.meta.statusFilter.byStatus['legacy:wish'], 1);

  // Dresden replay: 17 journal rows on disk, 9 read in the payload.
  assert.equal(stats.meta.profiles.find((profile) => profile.source === 'hardcover').events, 16);
  const dresden = stats.series.find((entry) => entry.name === 'The Dresden Files');
  assert.ok(dresden);
  assert.equal(dresden.count, 9);

  // Timeline/calendar: stale events with a fabricated date are gone.
  assert.equal(stats.readDays.some((day) => day.date === '2025-02-01'), false);
  assert.equal(stats.readDays.some((day) => day.date === '2025-03-03'), false);
  assert.ok(stats.readDays.some((day) => day.date === '2025-01-02'));

  // dnf keeps a book but no date; legacy/unknown-schema events stay.
  assert.ok(stats.booksIndex['hc:2004']);
  assert.ok(stats.booksIndex['hc:2005']);
  assert.ok(stats.booksIndex['hc:2007']);
  assert.equal(stats.booksIndex['hc:2001'], undefined);
  assert.equal(stats.booksIndex['hc:2002'], undefined);
  assert.equal(stats.booksIndex['hc:2006'], undefined);
  // The LiveLib profile's event does not leak into the Hardcover payload.
  assert.equal(stats.booksIndex['ll:7001'], undefined);
  assert.equal(stats.meta.profiles.length, 1);

  const hardcover = stats.meta.profiles.find((profile) => profile.source === 'hardcover');
  assert.equal(hardcover.keptEvents, 12);
  assert.equal(hardcover.statusExcluded, 4);
  assert.equal(hardcover.missingStatusId, 3); // legacy read + legacy wish + unknown
  assert.equal(hardcover.needsReimport, true);
});

test('LiveLib profile: no Hardcover status filter, own counters only', () => {
  const stats = buildBooksStats({ profile: 'livelib-tester' });
  assert.equal(stats.summary.hardcoverStatusExcluded, 0);
  assert.equal(stats.summary.eventCount, 1);
  assert.ok(stats.booksIndex['ll:7001']);
  const livelib = stats.meta.profiles.find((profile) => profile.source === 'livelib');
  assert.equal(livelib.statusExcluded, 0);
  assert.equal(livelib.needsReimport, false);
});

test('summary counters stay consistent with the dropped events', () => {
  const stats = buildBooksStats({ profile: 'hardcover-34748' });
  // No double counting: the work-level and event-level totals agree.
  assert.equal(Object.keys(stats.booksIndex).length, stats.summary.bookCount);
  assert.equal(stats.summary.finishedCount + stats.summary.undatedEventCount, stats.summary.eventCount);
  assert.equal(
    stats.timeline.reduce((sum, entry) => sum + entry.finished, 0),
    stats.summary.finishedCount
  );
});
