'use strict';

/**
 * M4 stats payload: SteamSpy tag wall, the nine review-score buckets, DLC
 * facts and the additive `gamesIndex` fields. Pure `buildGamesStats` calls —
 * no cache, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGamesStats, REVIEW_SCORE_LABELS } = require('../server/games/stats');

function game(appid, minutes, name = `Game ${appid}`) {
  return {
    appid,
    name,
    playtime_forever: minutes,
    playtime_2weeks: 0,
    rtime_last_played: 0,
    img_icon_url: null,
  };
}

function detailsDoc(appid, extra = {}) {
  return {
    success: true,
    type: 'game',
    name: `Game ${appid}`,
    is_free: false,
    genres: [{ id: '1', description: 'Action' }],
    categories: [{ id: '2', description: 'Single-player' }],
    releaseYear: 2015,
    dlc: [],
    dlcCount: 0,
    platforms: { windows: true, mac: false, linux: false },
    ...extra,
  };
}

function spyDoc(tags) {
  return { success: true, tags };
}

function reviewDoc(score, desc) {
  return { success: true, score, desc, positive: 100, negative: 10, total: 110 };
}

function build(overrides = {}) {
  return buildGamesStats({
    steamId64: '76561198000000001',
    profile: { userKey: '76561198000000001', personaName: 'tester' },
    library: { games: [], game_count: 0 },
    details: {},
    achievements: [],
    globals: new Map(),
    ...overrides,
  });
}

const LIBRARY = {
  games: [game(1, 600), game(2, 0), game(3, 120), game(4, 60)],
  game_count: 4,
  fetchedAt: new Date().toISOString(),
};

const DETAILS = {
  1: detailsDoc(1, { dlc: [10, 11, 12], dlcCount: 3 }),
  2: detailsDoc(2, { dlc: [], dlcCount: 0 }),
  3: detailsDoc(3, { dlc: [20], dlcCount: 1 }),
  4: detailsDoc(4, { dlc: [], dlcCount: 0 }),
};

const SPY = {
  1: spyDoc([
    { name: 'RPG', weight: 900 },
    { name: 'Open World', weight: 800 },
    { name: 'Story Rich', weight: 700 },
    { name: 'Fantasy', weight: 600 },
    { name: 'Atmospheric', weight: 500 },
    { name: 'Choices Matter', weight: 400 },
  ]),
  2: spyDoc([
    { name: 'RPG', weight: 300 },
    { name: 'Indie', weight: 200 },
  ]),
  3: spyDoc([
    { name: 'RPG', weight: 100 },
    { name: 'Open World', weight: 50 },
  ]),
};

const REVIEWS = {
  1: reviewDoc(9, 'Overwhelmingly Positive'),
  2: reviewDoc(5, 'Mixed'),
  3: reviewDoc(9, 'Overwhelmingly Positive'),
  4: { success: false, unavailable: true, score: null, desc: null },
};

test('tags: count = games with the tag, hours = their playtime, weight = Σ SteamSpy weights', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY });
  assert.deepEqual(payload.tags, [
    { name: 'RPG', count: 3, hours: 12, weight: 1300 },
    { name: 'Open World', count: 2, hours: 12, weight: 850 },
    { name: 'Story Rich', count: 1, hours: 10, weight: 700 },
    { name: 'Fantasy', count: 1, hours: 10, weight: 600 },
    { name: 'Atmospheric', count: 1, hours: 10, weight: 500 },
    { name: 'Choices Matter', count: 1, hours: 10, weight: 400 },
    { name: 'Indie', count: 1, hours: 0, weight: 200 },
  ]);
  assert.deepEqual(payload.meta.tags, {
    source: 'steamspy',
    gamesWithTags: 3,
    gamesTotal: 4,
    percent: 75,
  });
  assert.ok(!payload.meta.pending.includes('tags'));
});

test('tags: top 50 only, honest empty array without SteamSpy documents', () => {
  const tags = {};
  for (let index = 0; index < 60; index++) tags[`Tag ${String(index).padStart(2, '0')}`] = 1000 - index;
  const payload = build({
    library: { games: [game(1, 60)], game_count: 1 },
    details: { 1: detailsDoc(1) },
    spy: { 1: spyDoc(Object.entries(tags).map(([name, weight]) => ({ name, weight }))) },
  });
  assert.equal(payload.tags.length, 50);
  assert.equal(payload.tags[0].name, 'Tag 00');

  const empty = build({ library: LIBRARY, details: DETAILS });
  assert.deepEqual(empty.tags, []);
  assert.equal(empty.meta.tags.gamesWithTags, 0);
  assert.equal(empty.meta.tags.percent, 0);
  assert.ok(empty.meta.pending.includes('tags'));
});

test('tags follow the visible (filtered) set, not the raw library', () => {
  const library = {
    games: [game(1, 600), game(2, 0)],
    game_count: 2,
  };
  const details = {
    1: detailsDoc(1),
    2: detailsDoc(2, { type: 'dlc' }),
  };
  const spy = {
    1: spyDoc([{ name: 'RPG', weight: 10 }]),
    2: spyDoc([{ name: 'DLC Tag', weight: 99 }]),
  };
  const payload = build({ library, details, spy });
  assert.equal(payload.summary.gameCount, 1);
  assert.deepEqual(payload.tags.map((tag) => tag.name), ['RPG']);
});

test('reviewScore: avg/median over cached summaries, nine Steam buckets', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, reviews: REVIEWS });
  assert.deepEqual(payload.summary.reviewScore, { avg: 7.67, median: 9 });
  assert.equal(payload.scores.length, 9);
  assert.deepEqual(
    payload.scores.map((entry) => [entry.score, entry.bucket, entry.count, entry.hours]),
    [
      [1, REVIEW_SCORE_LABELS[1], 0, 0],
      [2, REVIEW_SCORE_LABELS[2], 0, 0],
      [3, REVIEW_SCORE_LABELS[3], 0, 0],
      [4, REVIEW_SCORE_LABELS[4], 0, 0],
      [5, REVIEW_SCORE_LABELS[5], 1, 0],
      [6, REVIEW_SCORE_LABELS[6], 0, 0],
      [7, REVIEW_SCORE_LABELS[7], 0, 0],
      [8, REVIEW_SCORE_LABELS[8], 0, 0],
      [9, REVIEW_SCORE_LABELS[9], 2, 12],
    ]
  );
  assert.deepEqual(payload.meta.reviews, {
    source: 'steam-reviews',
    gamesWithReviews: 3,
    gamesTotal: 4,
    percent: 75,
  });
  // `success:false` (no summary) is not a 0-score game.
  assert.ok(!payload.meta.pending.includes('reviews'));
});

test('reviewScore: null and [] when nothing is cached — never a fake 0', () => {
  const payload = build({ library: LIBRARY, details: DETAILS });
  assert.equal(payload.summary.reviewScore, null);
  assert.deepEqual(payload.scores, []);
  assert.equal(payload.meta.reviews.gamesWithReviews, 0);
  assert.ok(payload.meta.pending.includes('reviews'));
});

test('dlc: gamesWithDlc/avgCount/max top-10 from dlcCount in details', () => {
  const payload = build({ library: LIBRARY, details: DETAILS });
  assert.equal(payload.summary.dlc.gamesWithDlc, 2);
  assert.equal(payload.summary.dlc.dlcTotal, 4);
  assert.equal(payload.summary.dlc.avgCount, 1);
  assert.deepEqual(payload.summary.dlc.max, [
    { appid: 1, name: 'Game 1', dlcCount: 3 },
    { appid: 3, name: 'Game 3', dlcCount: 1 },
  ]);
  const noDetails = build({ library: LIBRARY });
  assert.equal(noDetails.summary.dlc, null);
});

test('dlc: max is capped at 10 and sorted by count', () => {
  const games = [];
  const details = {};
  for (let index = 0; index < 14; index++) {
    const appid = 100 + index;
    games.push(game(appid, 60));
    details[appid] = detailsDoc(appid, { dlcCount: index });
  }
  const payload = build({ library: { games, game_count: games.length }, details });
  assert.equal(payload.summary.dlc.max.length, 10);
  assert.equal(payload.summary.dlc.max[0].dlcCount, 13);
  assert.equal(payload.summary.dlc.max[9].dlcCount, 4);
});

test('gamesIndex: top-5 tags by weight + review score/desc, additive to M2 fields', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY, reviews: REVIEWS });
  const entry = payload.gamesIndex[1];
  assert.deepEqual(entry.tags, [
    { name: 'RPG', weight: 900 },
    { name: 'Open World', weight: 800 },
    { name: 'Story Rich', weight: 700 },
    { name: 'Fantasy', weight: 600 },
    { name: 'Atmospheric', weight: 500 },
  ]);
  assert.equal(entry.reviewScore, 9);
  assert.equal(entry.reviewDesc, 'Overwhelmingly Positive');
  assert.deepEqual(entry.metadataSources, ['steam-store', 'steamspy', 'steam-reviews']);
  assert.equal(entry.type, 'game');
  assert.equal(entry.dlcCount, 3);

  // A game with no tags/reviews keeps honest nulls and an empty list.
  const unknown = payload.gamesIndex[4];
  assert.deepEqual(unknown.tags, []);
  assert.equal(unknown.reviewScore, null);
  assert.equal(unknown.reviewDesc, null);
  assert.deepEqual(unknown.metadataSources, ['steam-store']);
});

test('payload size: tags carry no appid lists (the card has them), scores only count/hours', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, spy: SPY, reviews: REVIEWS });
  for (const tag of payload.tags) {
    assert.deepEqual(Object.keys(tag).sort(), ['count', 'hours', 'name', 'weight']);
  }
  for (const bucket of payload.scores) {
    assert.deepEqual(Object.keys(bucket).sort(), ['bucket', 'count', 'hours', 'score']);
  }
});

/* ------------------------------------------------------------------ */
/* M4-B integration: Wikidata links in the games index                 */
/* ------------------------------------------------------------------ */

const LINKS = {
  1: {
    qid: 'Q1',
    franchise: { qid: 'Q18935909', labelEn: 'The Witcher', labelRu: 'Ведьмак' },
    releaseYear: 2015,
    releasePrecision: 'day',
    franchiseKey: 'wd:Q18935909',
    resolved: true,
    fetchedAt: '2026-11-01T00:00:00.000Z',
  },
  2: { qid: 'Q2', franchise: null, releaseYear: null, franchiseKey: null, resolved: true },
};

test('gamesIndex: franchise + P577 year are additive, null when WD has not answered', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, links: LINKS });
  const witcher = payload.gamesIndex[1];
  assert.deepEqual(witcher.franchise, {
    key: 'wd:Q18935909',
    label: 'The Witcher',
    labelRu: 'Ведьмак',
  });
  assert.equal(witcher.releaseYearWikidata, 2015);
  assert.deepEqual(witcher.metadataSources, ['steam-store', 'wikidata']);

  // WD answered «no series / no year»: still null, never invented.
  const answered = payload.gamesIndex[2];
  assert.equal(answered.franchise, null);
  assert.equal(answered.releaseYearWikidata, null);
  assert.deepEqual(answered.metadataSources, ['steam-store', 'wikidata']);

  // No links document at all: nulls and no `wikidata` in the sources.
  const missing = payload.gamesIndex[3];
  assert.equal(missing.franchise, null);
  assert.equal(missing.releaseYearWikidata, null);
  assert.deepEqual(missing.metadataSources, ['steam-store']);
});

test('meta.franchises: Wikidata-only math, heuristic lives in /franchises', () => {
  const payload = build({ library: LIBRARY, details: DETAILS, links: LINKS });
  assert.deepEqual(payload.meta.franchises, {
    source: 'wikidata',
    includesHeuristic: false,
    gamesWithFranchise: 1,
    gamesAnswered: 2,
    gamesTotal: 4,
    percent: 25,
  });
  // Two documents answered → the WD pass is no longer «pending».
  assert.ok(!payload.meta.pending.includes('franchises'));
});

test('meta.pending keeps "franchises" until the WD pass has written links', () => {
  const payload = build({ library: LIBRARY, details: DETAILS });
  assert.ok(payload.meta.pending.includes('franchises'));
  assert.deepEqual(payload.meta.franchises, {
    source: 'wikidata',
    includesHeuristic: false,
    gamesWithFranchise: 0,
    gamesAnswered: 0,
    gamesTotal: 4,
    percent: 0,
  });
});
