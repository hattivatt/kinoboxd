'use strict';

/**
 * S1 «распил god-функции»: micro-tests for the pure section builders of
 * `/api/games/stats`. No cache, no network, no production directories — the
 * builders take plain objects in and return plain objects out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVisible } = require('../server/games/stats/visible');
const { buildTimeline } = require('../server/games/stats/timeline');
const { buildWorkMeta } = require('../server/games/stats/work-meta');

function steamWork(appid, minutes) {
  return {
    workKey: `steam:${appid}`,
    primary: { appid, name: `Game ${appid}` },
    games: [
      {
        appid,
        name: `Game ${appid}`,
        playtime_forever: minutes,
        playtime_2weeks: 0,
        rtime_last_played: 0,
      },
    ],
    minutes,
    minutes2w: 0,
    rtime: 0,
  };
}

function secondaryOnly(workKey, minutes, hoursUnknown = false) {
  return {
    workKey,
    name: `Secondary ${workKey}`,
    sources: ['gog'],
    storeIds: { gog: workKey.slice(4) },
    secondaryMinutes: minutes,
    displayMinutes: minutes,
    hoursUnknown,
    hoursStatus: { gog: hoursUnknown ? 'pending' : 'ok' },
    genres: [],
    developers: [],
    publishers: [],
    metadataSources: ['gog'],
  };
}

test('buildVisible: display hours drive minHours, unknown-hours works are kept', () => {
  const work = steamWork(1, 60);
  const union = {
    byWorkKey: new Map([['steam:1', { displayMinutes: 120 }]]),
    secondaryOnly: [
      secondaryOnly('gog:9', 0),
      secondaryOnly('gog:10', 0, true),
    ],
    summary: {},
  };
  const allWorks = [work];

  const all = buildVisible({ union, allWorks, minHours: -1, games: work.games });
  assert.equal(all.gameCount, 3, 'every work is visible at minHours=-1');
  assert.equal(all.totalHoursAll, 2, 'display total is the union minutes, not the Steam row');
  assert.equal(all.secondaryVisible.length, 2);

  const played = buildVisible({ union, allWorks, minHours: 0, games: work.games });
  assert.equal(played.gameCount, 2, '0-hour secondary work is dropped, unknown-hours work is kept');
  assert.equal(played.playedCount, 1);
  assert.equal(played.unplayedCount, 0);
  assert.equal(played.hoursUnknownCount, 1);
});

test('buildTimeline: months, achievement days and the best streak', () => {
  const ts = (iso) => Date.parse(`${iso}T10:00:00Z`) / 1000;
  const docs = [
    {
      appid: 1,
      achievements: [
        { achieved: true, unlockTimestamp: ts('2020-01-01') },
        { achieved: true, unlockTimestamp: ts('2020-01-02') },
        { achieved: false, unlockTimestamp: null },
      ],
    },
    {
      appid: 2,
      achievements: [{ achieved: true, unlockTimestamp: ts('2020-02-01') }],
    },
  ];
  const canonicalOf = (appid) => ({ workKey: `steam:${appid}` });
  const { timeline, achievementDays, streaks } = buildTimeline({ achievementDocs: docs, canonicalOf });

  assert.deepEqual(timeline, [
    { month: '2020-01', unlocked: 2, games: 1 },
    { month: '2020-02', unlocked: 1, games: 1 },
  ]);
  assert.equal(achievementDays.length, 3);
  assert.deepEqual(achievementDays[0], { date: '2020-01-01', count: 1, appids: [1] });
  assert.equal(streaks.best, 2);
  assert.deepEqual(streaks.bestDates, ['2020-01-01', '2020-01-02']);
  assert.equal(streaks.lastUnlockDate, '2020-02-01');
});

test('buildWorkMeta: own year → Wikidata P577 → base version → secondary store', () => {
  const meta = buildWorkMeta({
    details: { 1: { success: true, releaseYear: 2011 } },
    detailsBase: { 99: { success: true, releaseYear: 2001, genres: [{ description: 'Action' }] } },
    linkDocs: {
      2: { releaseYear: 2012 },
      4: { baseAppid: 99 },
    },
    spyDocs: {},
    reviewDocs: {},
    unionOf: () => null,
    workByAppid: new Map(),
  });

  assert.equal(meta.workYear({ games: [{ appid: 1 }] }), 2011, 'own appdetails year wins');
  assert.equal(meta.workYear({ games: [{ appid: 2 }] }), 2012, 'Wikidata P577 is the fallback');
  assert.equal(meta.workYear({ games: [{ appid: 4 }] }), 2001, 'base-version card is the last resort');
  assert.equal(
    meta.workYear({ games: [{ appid: 3 }], union: { releaseYear: 2015 } }),
    2015,
    'a secondary-only work takes its store release year'
  );
  assert.deepEqual(
    meta.workGenres({ games: [{ appid: 3 }], union: { genres: ['RPG'] } }),
    ['RPG']
  );
});
