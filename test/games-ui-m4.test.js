'use strict';

/**
 * Games UI, M4 widgets: tags / Steam review scores / franchises / DLC.
 *
 * Same two layers as the other games UI tests:
 *
 *   1. markup + layout: four new cards with ids, 6+6 and 6+6 spans (pairs,
 *      so the 12-column grid keeps no holes), the honest «оценки Steam, не
 *      личные» note, and the wiring in `games.js`/`api.js`;
 *   2. DOM-free view models: tag bars (hours/count/SteamSpy weight), the 1–9
 *      score donut (descending), the franchise ranked list, the DLC summary
 *      and the game-card extras (tags strip / review badge / franchise).
 *
 * The payload blocks are DRAFT contracts from the backend rounds; every
 * normaliser is tolerant, and the «missing block» cases are asserted to
 * return null (the widget hides) instead of inventing zeroes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const FIXTURES = path.join(__dirname, 'fixtures', 'games-ui');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function readJs(name) {
  return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function plain(value) {
  return String(value == null ? '' : value).replace(/[\u00a0\u202f]/g, ' ');
}

async function view() {
  return import('../public/js/games-view.js');
}

function miniIndex() {
  return {
    292030: {
      appid: 292030,
      name: 'The Witcher 3',
      hours: 107,
      releaseYear: 2015,
      type: 'game',
      tags: ['RPG', 'Open World'],
      reviewScore: 9,
      franchise: { key: 'witcher', label: 'The Witcher' },
    },
    20900: {
      appid: 20900,
      name: 'The Witcher',
      hours: 60,
      releaseYear: 2007,
      type: 'game',
      tags: ['RPG'],
      reviewDesc: 'Very Positive',
      franchise: { key: 'witcher', label: 'The Witcher' },
    },
    203770: {
      appid: 203770,
      name: 'Crusader Kings II',
      hours: 1054.4,
      releaseYear: 2012,
      type: 'game',
      tags: ['Strategy', 'Open World'],
      reviewScore: 8,
    },
    570: {
      appid: 570,
      name: 'Dota 2',
      hours: 213.3,
      releaseYear: 2013,
      type: 'game',
      tags: [],
      reviewScore: 5,
    },
  };
}

/* =========================================================
   markup + layout
   ========================================================= */

test('index.html carries the four M4 widgets and their ids', () => {
  const html = readPublic('index.html');
  for (const id of [
    'games-tags-widget', 'games-tags-title', 'games-tags-note',
    'games-tags-chart', 'games-tags-more',
    'games-scores-widget', 'games-scores-title', 'games-scores-note',
    'games-scores-donut', 'games-scores-legend', 'games-scores-honest',
    'games-franchises-widget', 'games-franchises-title', 'games-franchises-note',
    'games-franchises-list', 'games-franchises-loading',
    'games-dlc-widget', 'games-dlc-title', 'games-dlc-note',
    'games-dlc-summary', 'games-dlc-list',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }

  // Tags carry their own three-way weight toggle.
  const tagsBlock = /<section class="widget w-games-tags"[\s\S]*?<\/section>/.exec(html);
  assert.ok(tagsBlock, 'нет карточки тегов');
  for (const weight of ['hours', 'count', 'weight']) {
    assert.match(tagsBlock[0], new RegExp(`data-games-tag-weight="${weight}"`));
  }

  // The score widget must never look like a personal rating.
  assert.match(html, /оценки Steam, не личные/);
  assert.match(html, /community score 1–9/);
  assert.match(html, /id="games-scores-donut"/);

  // DLC: summary line + top list, franchise: ranked list.
  assert.match(html, /id="games-dlc-summary"/);
  assert.match(html, /сколько DLC у игр библиотеки/);
  assert.match(html, /игры одной франшизы \(IGDB \/ Wikidata\)/);
});

test('layout: four new cards sit in 6+6 pairs and keep the M1–M3 order', () => {
  const html = readPublic('index.html');
  const at = (id) => html.indexOf(`id="${id}"`);
  const order = [
    'games-yearcount-widget', 'games-tags-widget', 'games-scores-widget',
    'games-genres-widget', 'games-modes-widget', 'games-franchises-widget',
    'games-dlc-widget', 'games-access-widget', 'games-meta-widget',
    'games-achievements-widget', 'games-calendar-widget', 'games-persons-widget',
  ];
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(at(order[index - 1]) < at(order[index]),
      `${order[index - 1]} должен идти до ${order[index]}`);
  }

  const css = readPublic('style.css');
  const span = (selector) => {
    const match = new RegExp(`\\${selector} \\{ grid-column: span (\\d+); \\}`).exec(css);
    assert.ok(match, `нет span для ${selector}`);
    return Number(match[1]);
  };
  assert.equal(span('.w-games-tags'), 6);
  assert.equal(span('.w-games-scores'), 6);
  assert.equal(span('.w-games-franchises'), 6);
  assert.equal(span('.w-games-dlc'), 6);
  // The existing pairs stay untouched.
  assert.equal(span('.w-games-genres'), 8);
  assert.equal(span('.w-games-modes'), 4);
  assert.equal(span('.w-games-access'), 4);
  assert.equal(span('.w-games-meta'), 4);
  assert.equal(span('.w-games-achievements'), 4);
  // Mobile: every new card spans the full row.
  assert.match(css, /\.w-games-tags,[\s\S]{0,400}\.w-games-scores,[\s\S]{0,400}\.w-games-dlc[\s\S]{0,400}grid-column: span 12/);
});

test('games.js wires the M4 renderers, api.js exposes the franchise route', () => {
  const games = readJs('games.js');
  for (const fn of ['renderTags(data)', 'renderScores(data)', 'renderFranchises(data)', 'renderDlc(data)']) {
    assert.ok(games.includes(fn), `games.js не вызывает ${fn}`);
  }
  assert.match(games, /tagsChartView\(data\.tags/);
  assert.match(games, /scoresView\(data\.scores, data\.reviewScore\)/);
  assert.match(games, /getGamesFranchises\(\{ profile \}\)/);
  assert.match(games, /dlcView\(data\.dlc\)/);
  assert.match(games, /gamesByTag\(data\.gamesIndex, row\.name\)/);
  assert.match(games, /gamesByReviewBucket\(data\.gamesIndex, seg\.bucket\)/);
  assert.match(games, /openFranchiseModal\(/);
  // An empty-but-successful franchise answer is shown honestly, not hidden.
  assert.match(games, /Франшизы не собраны/);
  // Frontend still does no network of its own.
  assert.doesNotMatch(games, /fetch\(/);

  const api = readJs('api.js');
  assert.match(api, /export function getGamesFranchises\(/);
  assert.match(api, /\/api\/games\/franchises/);

  const modal = readJs('games-modal.js');
  assert.match(modal, /export function openFranchiseModal\(/);
  assert.match(modal, /game\.tags/);
  assert.match(modal, /game\.reviewScore/);
  assert.match(modal, /game\.franchise/);
  assert.doesNotMatch(modal, /fetch\(/);
});

test('every public script still parses', () => {
  for (const file of ['games.js', 'games-view.js', 'games-modal.js', 'api.js']) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path.join(JS_DIR, file)], { stdio: 'pipe' }),
      `${file} не парсится`,
    );
  }
});

/* =========================================================
   payload normalisation
   ========================================================= */

test('normalizeGamesPayload reads tags / scores / reviewScore / dlc / franchises', async () => {
  const { normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload({
    summary: {
      gameCount: 10,
      totalHours: 100,
      reviewScore: { avg: 7.4, median: 8 },
      dlc: {
        gamesWithDlc: 4,
        avgCount: 2.5,
        max: [{ name: 'CK II', dlcCount: 24, appid: 203770 }],
      },
    },
    tags: fixture('stats-m2-mock.json').tags,
    scores: [
      { bucket: 9, count: 3, hours: 30 },
      { bucket: 'Very Positive', count: 4, hours: 40 },
    ],
    franchises: [
      { key: 'witcher', label: 'The Witcher', gamesCount: 3, hoursSum: 250, yearsSpread: 8, appids: [1, 2, 3] },
    ],
    gamesIndex: miniIndex(),
  });

  assert.equal(data.tags.length, 3);
  assert.equal(data.scores.length, 2);
  assert.deepEqual(data.reviewScore, { avg: 7.4, median: 8 });
  assert.equal(data.dlc.gamesWithDlc, 4);
  assert.equal(data.dlc.max[0].dlcCount, 24);
  assert.equal(data.franchises.length, 1);
  assert.equal(data.franchises[0].hoursSum, 250);

  for (const flag of ['tags', 'scores', 'reviewScore', 'dlc', 'franchises']) {
    assert.equal(data.has[flag], true, `флаг has.${flag} должен быть true`);
  }

  // gamesIndex carries the new card/drilldown fields.
  assert.deepEqual(data.gamesIndex[292030].tags, ['RPG', 'Open World']);
  assert.equal(data.gamesIndex[292030].reviewScore, 9);
  assert.equal(data.gamesIndex[20900].reviewScore, 8, 'reviewDesc is resolved to a bucket');
  assert.equal(data.gamesIndex[292030].franchise.label, 'The Witcher');
});

test('a payload without M4 blocks keeps them empty and never throws', async () => {
  const { normalizeGamesPayload, scoresView, franchisesView, dlcView, tagsChartView } = await view();
  const data = normalizeGamesPayload({ summary: { gameCount: 1 } });
  assert.deepEqual(data.tags, []);
  assert.deepEqual(data.scores, []);
  assert.equal(data.reviewScore, null);
  assert.equal(data.dlc, null);
  assert.deepEqual(data.franchises, []);
  assert.equal(data.has.scores, false);
  assert.equal(data.has.franchises, false);

  assert.equal(tagsChartView([]), null);
  assert.equal(scoresView([], null), null);
  assert.equal(franchisesView([]), null);
  assert.equal(dlcView(null), null);
});

/* =========================================================
   tags
   ========================================================= */

test('tags chart: hours by default, count and SteamSpy weight on demand', async () => {
  const { tagsChartView, TAG_CHART_LIMIT, gamesByTag } = await view();
  const tags = fixture('stats-m2-mock.json').tags;

  assert.equal(TAG_CHART_LIMIT, 12);
  const byHours = tagsChartView(tags, { totalHours: 5862.6 });
  assert.equal(byHours.weight, 'hours');
  assert.equal(byHours.rows[0].name, 'Open World');
  assert.equal(byHours.rows[0].widthPercent, 10.2, '600 / 5862.6 = 10.2%');
  assert.equal(plain(byHours.rows[0].primaryText), '600,0 ч');
  assert.match(plain(byHours.rows[0].secondaryText), /40 игр · 10% часов/);
  assert.equal(byHours.note, '3 тега · по часам');
  assert.match(byHours.hint, /SteamSpy/);

  const byCount = tagsChartView(tags, { weight: 'count' });
  assert.equal(byCount.weight, 'count');
  assert.equal(byCount.rows[0].name, 'Open World');
  assert.equal(plain(byCount.rows[0].primaryText), '40 игр');
  assert.match(plain(byCount.rows[0].secondaryText), /600,0 ч · 42% отметок/);
  assert.equal(byCount.note, '3 тега · по числу игр');

  const byWeight = tagsChartView(tags, { weight: 'weight' });
  assert.equal(byWeight.weight, 'weight');
  assert.equal(byWeight.rows[0].name, 'Open World');
  assert.equal(plain(byWeight.rows[0].primaryText), '12 801');
  assert.match(plain(byWeight.rows[0].shareText), /веса/);
  assert.equal(byWeight.rows[0].widthPercent, 40.2, '12801 / (12801+10011+9010)');

  // Folding: > 12 tags hide behind «Показать все (N)».
  const many = Array.from({ length: 15 }, (_, index) => ({
    name: `Tag${index}`, count: 15 - index, hours: (15 - index) * 10, weight: 15 - index,
  }));
  const folded = tagsChartView(many);
  assert.equal(folded.rows.length, 12);
  assert.equal(folded.hidden, 3);
  assert.equal(folded.total, 15);
  const expanded = tagsChartView(many, { limit: 0 });
  assert.equal(expanded.rows.length, 15);
  assert.equal(expanded.hidden, 0);

  // Drilldown: case-insensitive tag match on gamesIndex.
  const games = gamesByTag(miniIndex(), 'rpg');
  assert.deepEqual(games.map((game) => game.appid).sort((a, b) => a - b), [20900, 292030]);
  assert.equal(gamesByTag(miniIndex(), 'nope').length, 0);
  assert.equal(gamesByTag(miniIndex(), '').length, 0);
});

/* =========================================================
   Steam review scores
   ========================================================= */

test('scores: 9-bucket donut desc, avg/median and honest «не личные» label', async () => {
  const { scoresView, gamesByReviewBucket } = await view();
  const viewModel = scoresView([
    { bucket: 9, count: 12, hours: 300 },
    { bucket: 'Very Positive', count: 40, hours: 900 },
    { bucket: 5, count: 8, hours: 50 },
    { bucket: 'mixed', count: 4, hours: 10 },
  ], { avg: 7.4, median: 8 });

  assert.ok(viewModel);
  assert.equal(viewModel.total, 64);
  assert.deepEqual(viewModel.segments.map((seg) => seg.bucket), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const veryPositive = viewModel.segments.find((seg) => seg.bucket === 8);
  assert.equal(veryPositive.label, 'Очень положительные');
  assert.equal(veryPositive.desc, 'Very Positive');
  assert.equal(veryPositive.value, 40);
  const mixed = viewModel.segments.find((seg) => seg.bucket === 5);
  assert.equal(mixed.value, 12, 'numeric and textual Mixed buckets merge');
  assert.equal(viewModel.segments.find((seg) => seg.bucket === 7).value, 0);

  assert.equal(plain(viewModel.avgText), '7,4/9');
  assert.equal(viewModel.medianText, '8');
  assert.equal(viewModel.honestNote, 'оценки Steam, не личные');
  assert.match(plain(viewModel.note), /64 игры с оценкой Steam/);
  // Colours run from red (1) to green (9) — the widget prints a legend too.
  assert.equal(new Set(viewModel.segments.map((seg) => seg.color)).size, 9);

  // Drilldown matches both the numeric bucket and the textual desc.
  const nine = gamesByReviewBucket(miniIndex(), 9);
  assert.deepEqual(nine.map((game) => game.appid), [292030]);
  const eight = gamesByReviewBucket(miniIndex(), 'Very Positive');
  assert.deepEqual(eight.map((game) => game.appid), [20900, 203770]);
  assert.equal(gamesByReviewBucket(miniIndex(), 'nonsense').length, 0);
  assert.equal(gamesByReviewBucket(miniIndex(), 1).length, 0);
});

test('summary strip shows the Steam score as community data', async () => {
  const { summaryMetrics } = await view();
  const metrics = summaryMetrics({
    gameCount: 10,
    totalHours: 100,
    reviewScore: { avg: 7.4, median: 8 },
  });
  const review = metrics.find((metric) => metric.key === 'review');
  assert.ok(review, 'нет плитки «оценка Steam»');
  assert.equal(review.label, 'оценка Steam');
  assert.equal(plain(review.value), '7,4/9');
  assert.match(plain(review.sub), /медиана 8/);
  assert.match(review.title, /не ваши личные/);
});

/* =========================================================
   franchises
   ========================================================= */

test('franchises: ranked by hours, games/hours in the row, year-sorted drilldown', async () => {
  const { franchisesView, gamesInFranchise } = await view();
  const viewModel = franchisesView([
    { key: 'witcher', label: 'The Witcher', gamesCount: 3, hoursSum: 250, yearsSpread: 8, appids: [292030, 20900, 20920] },
    { key: 'ck', label: 'Crusader Kings', gamesCount: 2, hoursSum: 1100, yearsSpread: 12, appids: [203770, 394360] },
    { key: 'x', label: 'No hours', gamesCount: 1, hoursSum: null, appids: [1] },
  ]);
  assert.ok(viewModel);
  assert.deepEqual(viewModel.rows.map((row) => row.label), ['Crusader Kings', 'The Witcher', 'No hours']);
  assert.equal(viewModel.rows[0].widthPercent, 100);
  assert.equal(plain(viewModel.rows[0].primaryText), '1 100,0 ч');
  assert.equal(plain(viewModel.rows[1].primaryText), '250,0 ч');
  assert.match(plain(viewModel.rows[1].secondaryText), /3 игры · 8 лет/);
  assert.equal(viewModel.rows[2].widthPercent, 2);
  assert.equal(viewModel.note, '3 франшизы · по часам');

  // Explicit appids first.
  const explicit = gamesInFranchise(miniIndex(), { key: 'witcher', label: 'The Witcher', appids: [292030] });
  assert.deepEqual(explicit.map((game) => game.appid), [292030]);
  // Then the index label (game without an appid in the franchise payload).
  const byLabel = gamesInFranchise(miniIndex(), { key: 'witcher', label: 'The Witcher', appids: [] });
  assert.deepEqual(byLabel.map((game) => game.appid).sort((a, b) => a - b), [20900, 292030]);
  assert.equal(gamesInFranchise(miniIndex(), null).length, 0);
});

/* =========================================================
   DLC
   ========================================================= */

test('DLC: summary line «N игр (avg X)» and a top-10 list', async () => {
  const { dlcView } = await view();
  const viewModel = dlcView({
    gamesWithDlc: 120,
    avgCount: 3.25,
    max: [
      { name: 'Crusader Kings II', dlcCount: 24, appid: 203770 },
      { name: 'The Witcher 3', dlcCount: 18 },
      ...Array.from({ length: 12 }, (_, index) => ({ name: `Game ${index}`, dlcCount: index })),
    ],
  });
  assert.ok(viewModel);
  assert.equal(viewModel.gamesWithDlc, 120);
  assert.equal(viewModel.rows.length, 10, 'top-10 only');
  assert.equal(viewModel.rows[0].name, 'Crusader Kings II');
  assert.equal(viewModel.rows[0].dlcCount, 24);
  assert.equal(viewModel.rows[0].appid, 203770);
  assert.equal(viewModel.rows[1].appid, null);
  assert.equal(plain(viewModel.summaryText), 'Игры с DLC: 120 игр (в среднем 3,25)');
  assert.equal(viewModel.note, '120 игр с DLC');

  // A summary-only block still renders the line, with no invented list.
  const summaryOnly = dlcView({ gamesWithDlc: 5, avgCount: 2, max: [] });
  assert.ok(summaryOnly);
  assert.equal(summaryOnly.rows.length, 0);
  assert.equal(plain(summaryOnly.summaryText), 'Игры с DLC: 5 игр (в среднем 2)');
});

/* =========================================================
   game card extras
   ========================================================= */

test('game card keeps tags, the Steam review badge and the franchise', async () => {
  const { normalizeGameCard } = await view();
  const card = normalizeGameCard({
    appid: 292030,
    name: 'The Witcher 3: Wild Hunt',
    details: {
      type: 'game',
      tags: ['RPG', 'Story Rich', 'Open World', 'Fantasy'],
      reviewScore: { score: 9, desc: 'Overwhelmingly Positive' },
      franchise: { key: 'witcher', label: 'The Witcher' },
    },
  });
  assert.deepEqual(card.tags, ['RPG', 'Story Rich', 'Open World', 'Fantasy']);
  assert.equal(card.reviewScore.score, 9);
  assert.equal(card.reviewScore.label, 'Крайне положительные');
  assert.equal(card.reviewScore.desc, 'Overwhelmingly Positive');
  assert.ok(card.reviewScore.color);
  assert.equal(card.franchise.label, 'The Witcher');

  // Top-level aliases and a string-only franchise are accepted too.
  const alias = normalizeGameCard({
    appid: 1,
    name: 'Alpha',
    tags: { RPG: 1, Indie: 2 },
    reviewScore: 'Very Positive',
    franchise: 'Alpha Series',
  });
  assert.deepEqual(alias.tags, ['RPG', 'Indie']);
  assert.equal(alias.reviewScore.score, 8);
  assert.equal(alias.franchise.label, 'Alpha Series');

  // Missing M4 fields stay null/empty — the card simply omits the strip.
  const bare = normalizeGameCard({ appid: 2, name: 'Beta', details: { type: 'game' } });
  assert.deepEqual(bare.tags, []);
  assert.equal(bare.reviewScore, null);
  assert.equal(bare.franchise, null);
});
