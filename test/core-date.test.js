'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('dateParts: unanchored (default) accepts a date prefix in a timestamp', async () => {
  const { dateParts } = await import('../public/js/core/date.js');
  assert.deepEqual(dateParts('2024-05-06'), { year: 2024, month: 5, day: 6 });
  assert.deepEqual(dateParts('2024-05-06T10:00:00Z'), { year: 2024, month: 5, day: 6 });
  assert.equal(dateParts(''), null);
  assert.equal(dateParts(null), null);
  assert.equal(dateParts('garbage'), null);
});

test('dateParts: anchored mode rejects trailing characters', async () => {
  const { dateParts } = await import('../public/js/core/date.js');
  assert.deepEqual(dateParts('2024-05-06', true), { year: 2024, month: 5, day: 6 });
  assert.deepEqual(dateParts('2024-05-06', { anchored: true }), { year: 2024, month: 5, day: 6 });
  assert.equal(dateParts('2024-05-06T10:00:00Z', true), null);
  assert.equal(dateParts('2024-05-06T10:00:00Z', { anchored: true }), null);
  assert.equal(dateParts('', true), null);
  assert.equal(dateParts(null, true), null);
  assert.equal(dateParts('garbage', true), null);
});

test('fmtDayRu / fmtDayShortRu follow anchoring', async () => {
  const { fmtDayRu, fmtDayShortRu } = await import('../public/js/core/date.js');
  assert.equal(fmtDayRu('2024-05-06'), '6 мая 2024');
  assert.equal(fmtDayRu('2024-05-06T10:00:00Z'), '6 мая 2024');
  assert.equal(fmtDayRu('2024-05-06T10:00:00Z', true), '2024-05-06T10:00:00Z');
  assert.equal(fmtDayShortRu('2024-05-06'), '6 мая 2024');
  assert.equal(fmtDayShortRu('garbage'), 'garbage');
});

test('dayIndex and dayNumber numeric values', async () => {
  const { dayIndex, dayNumber } = await import('../public/js/core/date.js');
  assert.equal(dayIndex('2024-05-06'), 19849);
  assert.equal(dayNumber('2024-05-06'), 19849);
  assert.equal(dayNumber('2024-05-06T10:00:00Z'), 19849);
  assert.equal(dayIndex('2024-05-06T10:00:00Z'), null);
});

test('normalizeFilmStreaks: empty input', async () => {
  const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
  assert.deepEqual(normalizeFilmStreaks(null, []), { current: 0, best: 0, lastWatchDate: null, bestDates: [] });
  assert.deepEqual(normalizeFilmStreaks({}, []), { current: 0, best: 0, lastWatchDate: null, bestDates: [] });
});

test('normalizeFilmStreaks: single streak', async () => {
  const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
  const r = normalizeFilmStreaks(null, [{ date: '2024-05-06' }]);
  assert.equal(r.current, 1);
  assert.equal(r.best, 1);
  assert.equal(r.lastWatchDate, '2024-05-06');
});

test('normalizeFilmStreaks: gaps', async () => {
  const { normalizeFilmStreaks } = await import('../public/js/core/streaks.js');
  const r = normalizeFilmStreaks(null, [{ date: '2024-05-06' }, { date: '2024-05-07' }, { date: '2024-05-10' }]);
  assert.equal(r.best, 2);
  assert.equal(r.current, 1);
});

test('normalizeGameStreaks: empty input returns null', async () => {
  const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
  assert.equal(normalizeGameStreaks(null, []), null);
  assert.equal(normalizeGameStreaks(null, null), null);
});

test('normalizeGameStreaks: single streak', async () => {
  const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
  const r = normalizeGameStreaks(null, [{ date: '2024-05-06' }]);
  assert.equal(r.current, 1);
  assert.equal(r.best, 1);
  assert.equal(r.lastUnlockDate, '2024-05-06');
});

test('normalizeGameStreaks: gaps', async () => {
  const { normalizeGameStreaks } = await import('../public/js/core/streaks.js');
  const r = normalizeGameStreaks(null, [{ date: '2024-05-06' }, { date: '2024-05-07' }, { date: '2024-05-10' }]);
  assert.equal(r.best, 2);
  assert.equal(r.current, 1);
});
