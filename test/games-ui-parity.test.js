'use strict';

/**
 * Games UI parity with films (round M4).
 *
 * Two layers, like the other games UI tests:
 *
 *   1. markup/layout: the inline persons widget, the permanent years card
 *      (full range by default, decade narrows it) and the 12-column grid
 *      without holes;
 *   2. DOM-free view models: client-side drilldowns (year / decade / genre /
 *      mode / access / hours bucket / backlog / unmatched), the game card and
 *      the person→games join.
 *
 * The live snapshot at `/tmp/opencode/gmInt/` is used for the headless smoke
 * when present (208 952 B, 332 games); the deterministic mini-index below
 * keeps the assertions runnable without it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const LIVE_DIR = '/tmp/opencode/gmInt';

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function readJs(name) {
  return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
}

function live(name) {
  const file = path.join(LIVE_DIR, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function plain(value) {
  return String(value == null ? '' : value).replace(/[\u00a0\u202f]/g, ' ');
}

async function view() {
  return import('../public/js/games-view.js');
}

function miniIndex() {
  return {
    1: {
      appid: 1,
      name: 'Alpha',
      hours: 10,
      hours2w: 2,
      releaseYear: 2013,
      genres: ['RPG'],
      categories: ['Single-player', 'Co-op'],
      type: 'game',
      isFree: false,
      earlyAccess: false,
      completion: 50,
      iconUrl: 'https://cdn.example/1.jpg',
      developers: ['Dev'],
      publishers: ['Pub'],
      achievements: { unlocked: 1, total: 2, percent: 50 },
    },
    2: {
      appid: 2,
      name: 'Beta',
      hours: 0,
      releaseYear: 2012,
      genres: ['Action'],
      categories: ['Multi-player'],
      type: 'game',
      isFree: true,
      earlyAccess: false,
    },
    3: {
      appid: 3,
      name: 'Gamma',
      hours: 7,
      releaseYear: null,
      genres: [],
      categories: [],
      type: null,
    },
    4: {
      appid: 4,
      name: 'Delta',
      hours: 120,
      releaseYear: 2015,
      genres: ['RPG'],
      categories: ['Single-player'],
      type: 'game',
      isFree: false,
      earlyAccess: true,
    },
    5: {
      appid: 5,
      name: 'Epsilon',
      hours: 2.5,
      releaseYear: 2013,
      genres: ['Action'],
      categories: ['Online PvP'],
      type: 'game',
    },
  };
}

/* =========================================================
   markup + layout
   ========================================================= */

test('inline persons widget: span 12, developers first, search + «показать всех»', () => {
  const html = readPublic('index.html');
  for (const id of [
    'games-persons-widget', 'games-person-list', 'games-persons-more',
    'games-persons-note', 'games-persons-coverage', 'games-persons-loading',
    'games-persons-error', 'games-persons-search-wrap', 'games-persons-search',
    'games-persons-role', 'games-persons-all',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  const select = /<select id="games-persons-role"[\s\S]*?<\/select>/.exec(html);
  assert.ok(select, 'нет select роли персоналий');
  const roles = [...select[0].matchAll(/value="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(roles[0], 'developer', 'разработчики — первыми: это самые надёжные кредиты Steam');
  assert.deepEqual(roles, [
    'developer', 'publisher', 'composer', 'designer',
    'writer', 'artist', 'programmer', 'producer',
  ]);
  // Publishers have their own category: the studio label is «Разработчики».
  assert.match(select[0], /value="developer" selected>Разработчики</);
  assert.match(select[0], /value="publisher">Издатели</);
  assert.doesNotMatch(select[0], /value="studio"/);
  assert.match(html, /id="games-persons-search"[^>]+placeholder="Поиск по имени"/);
  assert.match(html, /data-games-weight="hours"/);
  assert.match(html, /data-games-weight="count"/);
  assert.match(html, /id="games-persons-all"/);

  const css = readPublic('style.css');
  assert.match(css, /\.w-games-persons \{ grid-column: span 12; \}/);
  assert.match(css, /\.summary-strip\.games-summary/);
});

test('layout: decades + years are adjacent (no 6-column holes)', () => {
  const html = readPublic('index.html');
  const decades = html.indexOf('id="games-decades-widget"');
  const years = html.indexOf('id="games-years-widget"');
  const genres = html.indexOf('id="games-genres-widget"');
  const modes = html.indexOf('id="games-modes-widget"');
  const access = html.indexOf('id="games-access-widget"');
  const meta = html.indexOf('id="games-meta-widget"');
  const achievements = html.indexOf('id="games-achievements-widget"');
  const calendar = html.indexOf('id="games-calendar-widget"');
  const persons = html.indexOf('id="games-persons-widget"');
  assert.ok(decades > 0 && decades < years && years < genres, 'годы должны идти сразу за десятилетиями');
  assert.ok(genres < modes && modes < access && access < meta && meta < achievements);
  assert.ok(achievements < calendar && calendar < persons);

  const css = readPublic('style.css');
  const span = (selector) => {
    const match = new RegExp(`\\${selector} \\{ grid-column: span (\\d+); \\}`).exec(css);
    assert.ok(match, `нет span для ${selector}`);
    return Number(match[1]);
  };
  assert.equal(span('.w-games-decades'), 6);
  assert.equal(span('.w-games-years'), 6);
  assert.equal(span('.w-games-genres'), 8);
  assert.equal(span('.w-games-modes'), 4);
  assert.equal(span('.w-games-access'), 4);
  assert.equal(span('.w-games-meta'), 4);
  assert.equal(span('.w-games-achievements'), 4);
  assert.equal(span('.w-games-calendar'), 12);
  assert.equal(span('.w-games-persons'), 12);
});

test('topbar switcher wording: «Загрузить новый»', () => {
  const html = readPublic('index.html');
  assert.match(html, /id="games-reimport"[\s\S]*?<span>Загрузить новый<\/span>/);
  assert.doesNotMatch(html, /id="games-reimport"[\s\S]{0,400}<span>Импорт<\/span>/);
});

test('games.js wires the new modals and no extra network calls', () => {
  const games = readJs('games.js');
  for (const fn of [
    'openGameCardModal', 'openGameListModal', 'openPersonModal',
    'configureGamesModals', 'personAvatarEl',
  ]) {
    assert.match(games, new RegExp(`${fn}\\(`), `games.js не использует ${fn}`);
  }
  assert.match(games, /renderPersonsWidget\(data\)/);
  assert.match(games, /renderYears\(data\)/);
  assert.match(games, /state\.selectedDecade/);
  // The years card is permanent: no decade gate, the full range renders by
  // default and a bar click opens that year's games. The empty state is a
  // placeholder inside the widget, never a hidden card.
  assert.doesNotMatch(games, /Выберите десятилетие слева/);
  assert.match(games, /function renderYears\(data\)[\s\S]{0,900}widget\.hidden = false;/);
  assert.match(games, /function renderYears\(data\)[\s\S]{0,2600}onYearClick: \(year\) => openYearModal\(data, year\)/);
  assert.match(games, /Нет данных по годам релиза/);
  assert.match(games, /onYearClick/);
  assert.doesNotMatch(games, /fetch\(/);
  assert.doesNotMatch(games, /https?:\/\/api\.steampowered\.com/);

  const modal = readJs('games-modal.js');
  assert.match(modal, /getGameDetails/);
  assert.match(modal, /kinoboxd\.games\.modalSort\./);
  assert.match(modal, /game\.links\.community/);
  assert.match(modal, /game\.links\.steamdb/);
  assert.doesNotMatch(modal, /fetch\(/);

  const viewModel = readJs('games-view.js');
  assert.match(viewModel, /steamcommunity\.com\/app\//);
  assert.match(viewModel, /steamdb\.info\/app\//);

  const api = readJs('api.js');
  assert.match(api, /limit = 50/);
  assert.match(api, /params\.set\('limit'/);
});

test('every public script parses (node --check), including games-modal.js', () => {
  for (const file of ['games.js', 'games-view.js', 'games-modal.js', 'api.js', 'main.js']) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path.join(JS_DIR, file)], { stdio: 'pipe' }),
      `${file} не парсится`,
    );
  }
});

/* =========================================================
   gamesIndex normalisation (drilldowns need the fields)
   ========================================================= */

test('normalizeGamesPayload keeps type/year/genres/developers/categories/access/icon', async () => {
  const { normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload({
    sources: { profile: { key: 'steam-1', userKey: '1', personaName: 'player' } },
    summary: { gameCount: 5, ownedCount: 5, totalHours: 139.5 },
    unmatchedCount: 1,
    meta: { excluded: { dlc: 0, otherType: 8, free: 0, unknownType: 1 } },
    gamesIndex: miniIndex(),
  });
  const alpha = data.gamesIndex[1];
  assert.equal(alpha.type, 'game');
  assert.equal(alpha.releaseYear, 2013);
  assert.deepEqual(alpha.genres, ['RPG']);
  assert.deepEqual(alpha.developers, ['Dev']);
  assert.deepEqual(alpha.publishers, ['Pub']);
  assert.deepEqual(alpha.categories, ['Single-player', 'Co-op']);
  assert.equal(alpha.isFree, false);
  assert.equal(alpha.earlyAccess, false);
  assert.equal(alpha.iconUrl, 'https://cdn.example/1.jpg');
  assert.deepEqual(alpha.achievements, { unlocked: 1, total: 2, percent: 50 });
  assert.equal(data.gamesIndex[3].type, '');
  assert.equal(data.summary.unmatchedCount, 1);
  assert.equal(data.summary.excluded.otherType, 8);
  assert.equal(data.has.unmatched, true);
});

test('summary metrics add the 7th «не типизированы» tile', async () => {
  const { normalizeGamesPayload, summaryMetrics } = await view();
  const data = normalizeGamesPayload({
    summary: { gameCount: 332, ownedCount: 340, playedCount: 213, unplayedCount: 119, totalHours: 5852.7 },
    unmatchedCount: 21,
    meta: { excluded: { otherType: 8, unknownType: 21 } },
  });
  const metrics = summaryMetrics(data.summary);
  const tile = metrics.find((metric) => metric.key === 'unmatched');
  assert.ok(tile, 'нет плитки «не типизированы»');
  assert.equal(tile.value, '21');
  assert.equal(plain(tile.sub), '8 записей — не игры');
  assert.match(tile.title, /appdetails/);
  // No unmatched counter = no tile, so an M1 server stays clean.
  const clean = normalizeGamesPayload({ summary: { gameCount: 1 } });
  assert.equal(summaryMetrics(clean.summary).some((metric) => metric.key === 'unmatched'), false);
});

/* =========================================================
   client-side drilldowns
   ========================================================= */

test('drilldowns from gamesIndex: year, decade, unknown year, genre, mode, access, bucket', async () => {
  const {
    gamesInYear, gamesInDecade, gamesWithoutYear, gamesWithoutType, gamesByGenre,
    gamesByMode, gamesByAccess, gamesInHoursBucket, gamesWithRecentHours,
    backlogGames, hoursBucketOf, yearsInDecade,
  } = await view();
  const index = miniIndex();

  assert.deepEqual(gamesInYear(index, 2013).map((game) => game.name).sort(), ['Alpha', 'Epsilon']);
  assert.equal(gamesInDecade(index, 2010).length, 4);
  assert.equal(gamesInDecade(index, 2020).length, 0);
  assert.deepEqual(gamesWithoutYear(index).map((game) => game.name), ['Gamma']);
  assert.deepEqual(gamesWithoutType(index).map((game) => game.name), ['Gamma']);

  assert.deepEqual(gamesByGenre(index, 'RPG').map((game) => game.name).sort(), ['Alpha', 'Delta']);
  assert.deepEqual(gamesByGenre(index, 'rpg').map((game) => game.name).sort(), ['Alpha', 'Delta']);

  assert.deepEqual(gamesByMode(index, 'single').map((game) => game.name).sort(), ['Alpha', 'Delta']);
  assert.deepEqual(gamesByMode(index, 'multi').map((game) => game.name), ['Beta']);
  assert.deepEqual(gamesByMode(index, 'onlinePvp').map((game) => game.name), ['Epsilon']);
  assert.deepEqual(gamesByMode(index, 'nonsense'), []);

  assert.deepEqual(gamesByAccess(index, 'freeToPlay').map((game) => game.name), ['Beta']);
  assert.deepEqual(gamesByAccess(index, 'earlyAccess').map((game) => game.name), ['Delta']);

  assert.deepEqual(gamesInHoursBucket(index, '0').map((game) => game.name), ['Beta']);
  assert.deepEqual(gamesInHoursBucket(index, '5-20').map((game) => game.name).sort(), ['Alpha', 'Gamma']);
  assert.deepEqual(gamesInHoursBucket(index, '100-500').map((game) => game.name), ['Delta']);
  assert.deepEqual(gamesInHoursBucket(index, 'nope'), []);
  assert.equal(hoursBucketOf(0), '0');
  assert.equal(hoursBucketOf(0.5), '<1');
  assert.equal(hoursBucketOf(5), '5-20');
  assert.equal(hoursBucketOf(500), '500+');
  assert.equal(hoursBucketOf(null), null);

  assert.deepEqual(gamesWithRecentHours(index).map((game) => game.name), ['Alpha']);
  assert.deepEqual(backlogGames(index).map((game) => game.name), ['Beta']);

  const years = yearsInDecade([
    { year: 2009, count: 1 },
    { year: 2010, count: 2 },
    { year: 2013, count: 4 },
    { year: 2020, count: 8 },
  ], 2010);
  assert.deepEqual(years.map((item) => item.year), [2010, 2013]);
});

test('game list sorting: hours / completion / year / name', async () => {
  const { sortGameRows } = await view();
  const rows = Object.values(miniIndex());

  assert.deepEqual(sortGameRows(rows, 'hours').map((row) => row.name), ['Delta', 'Alpha', 'Gamma', 'Epsilon', 'Beta']);
  assert.deepEqual(sortGameRows(rows, 'name').map((row) => row.name), ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma']);
  assert.deepEqual(sortGameRows(rows, 'completion').map((row) => row.name)[0], 'Alpha');
  assert.deepEqual(sortGameRows(rows, 'year').map((row) => row.name)[0], 'Delta');
  assert.equal(sortGameRows(rows, 'year').at(-1).name, 'Gamma', 'без года — в конце');
  assert.deepEqual(sortGameRows(null), []);
});

test('personGames joins the personnel row with gamesIndex (completion/icon)', async () => {
  const { personGames } = await view();
  const person = {
    name: 'Dev',
    games: [
      { appid: 1, name: 'Alpha', hours: 10 },
      { appid: 3, name: 'Gamma', hours: 7 },
      { appid: 999, name: 'Not indexed', hours: 1 },
    ],
  };
  const rows = personGames(person, miniIndex());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].completion, 50);
  assert.equal(rows[0].iconUrl, 'https://cdn.example/1.jpg');
  assert.equal(rows[1].releaseYear, null);
  assert.equal(rows[2].name, 'Not indexed');
});

/* =========================================================
   game card
   ========================================================= */

test('normalizeGameCard: details, achievements, credits and safe links', async () => {
  const { normalizeGameCard } = await view();
  const card = normalizeGameCard({
    appid: 203770,
    name: 'Crusader Kings II',
    hours: 1054.4,
    hours2w: 0,
    lastPlayed: null,
    iconUrl: null,
    achievements: {
      unlocked: 53,
      total: 161,
      percent: 32.9,
      items: [
        { apiname: 'ACH_1', name: 'First', description: 'Desc', achieved: true, unlockTimestamp: 1330000000 },
      ],
    },
    details: {
      type: 'game',
      name: 'Crusader Kings II',
      isFree: true,
      developers: ['Paradox Development Studio'],
      publishers: ['Paradox Interactive'],
      genres: ['RPG', 'Strategy'],
      categories: ['Single-player', 'Multi-player'],
      releaseDate: '14 Feb, 2012',
      releaseYear: 2012,
      earlyAccess: false,
      metacritic: 82,
      dlcCount: 32,
      platforms: { windows: true, mac: true, linux: true },
    },
    personnel: {
      studios: [
        { name: 'Paradox Development Studio', roles: ['developer'], sources: ['steam-store'] },
        { name: 'Paradox Interactive', roles: ['publisher'], qid: 'Q217493', sources: ['steam-store', 'wikidata'] },
        { name: 'Development Studio', roles: ['developer'], qid: 'Q3539040', sources: ['wikidata'] },
      ],
      people: [],
      coverage: { people: 0, studios: 3, roles: [] },
    },
    links: { steam: 'https://store.steampowered.com/app/203770', steamdb: 'https://steamdb.info/app/203770/' },
    meta: { achievementsCached: true, detailsCached: true, personnelCached: true, pending: ['links.wikidata'] },
  });

  assert.equal(card.name, 'Crusader Kings II');
  assert.equal(card.type, 'game');
  assert.equal(card.typeLabel, 'игра');
  assert.equal(card.releaseYear, 2012);
  assert.equal(card.completion, 32.9);
  assert.equal(card.achievements.total, 161);
  assert.equal(card.achievements.unlocked, 53);
  assert.equal(card.achievements.items.length, 1);
  assert.equal(card.personnel.studios.length, 3);
  assert.equal(card.details.genres[0], 'RPG');
  assert.equal(card.links.steam, 'https://store.steampowered.com/app/203770');
  assert.equal(card.links.community, 'https://steamcommunity.com/app/203770');
  assert.equal(card.links.steamdb, 'https://steamdb.info/app/203770/');

  // No cached links: the client still builds the canonical URLs.
  const bare = normalizeGameCard({ appid: 570, name: 'Dota 2' });
  assert.equal(bare.links.steam, 'https://store.steampowered.com/app/570');
  assert.equal(bare.links.community, 'https://steamcommunity.com/app/570');
  assert.equal(bare.links.steamdb, 'https://steamdb.info/app/570/');
  assert.equal(bare.details, null);
  assert.equal(bare.achievements, null);
});

test('game type labels are honest about non-games', async () => {
  const { gameTypeLabel } = await view();
  assert.equal(gameTypeLabel('game'), 'игра');
  assert.equal(gameTypeLabel('dlc'), 'DLC');
  assert.equal(gameTypeLabel('demo'), 'демо');
  assert.equal(gameTypeLabel('music'), 'саундтрек');
  assert.equal(gameTypeLabel(null), '');
});

/* =========================================================
   modal sort persistence (same scopes idea as films)
   ========================================================= */

test('games modal sort is persisted per scope and validated', async () => {
  const store = new Map();
  global.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
  try {
    const modal = await import('../public/js/games-modal.js');
    assert.equal(modal.getGameSort('person'), 'hours');
    modal.setGameSort('person', 'completion');
    assert.equal(modal.getGameSort('person'), 'completion');
    assert.equal(modal.getGameSort('year'), 'hours', 'scopes are independent');
    modal.setGameSort('year', 'nonsense');
    assert.equal(modal.getGameSort('year'), 'hours', 'unknown keys are ignored');
  } finally {
    delete global.window;
  }
});

/* =========================================================
   headless smoke on the real 208 952 B snapshot
   ========================================================= */

test('live snapshot: 332 games, year 2013 = 34, RPG = 97, untyped = 21', async (t) => {
  const raw = live('stats2.json');
  if (!raw) {
    t.skip(`нет ${LIVE_DIR}/stats2.json`);
    return;
  }
  const {
    normalizeGamesPayload, gamesInYear, gamesByGenre, gamesWithoutType, backlogGames,
    gamesByMode, gamesInHoursBucket, decadesView, summaryMetrics,
  } = await view();
  const data = normalizeGamesPayload(raw);

  assert.equal(data.summary.gameCount, 332);
  assert.equal(data.summary.ownedCount, 340);
  assert.equal(data.summary.totalHours, 5852.7);
  assert.equal(Object.keys(data.gamesIndex).length, 332);
  assert.equal(gamesInYear(data.gamesIndex, 2013).length, 34);
  assert.equal(gamesByGenre(data.gamesIndex, 'RPG').length, 97);
  assert.equal(gamesWithoutType(data.gamesIndex).length, 21);
  assert.equal(backlogGames(data.gamesIndex).length, 119);
  assert.equal(gamesByMode(data.gamesIndex, 'single').length, 292);
  assert.equal(gamesInHoursBucket(data.gamesIndex, '5-20').length, 68);
  assert.deepEqual(decadesView(data.decades).rows.map((row) => row.label), [
    '1990-е', '2000-е', '2010-е', '2020-е', 'год неизвестен',
  ]);
  const metrics = new Map(summaryMetrics(data.summary).map((metric) => [metric.key, metric]));
  assert.equal(metrics.get('unmatched').value, '21');
  assert.equal(plain(metrics.get('unmatched').sub), '8 записей — не игры');
});

test('live snapshot: CK II card has 3 studios / 161 achievements / safe links', async (t) => {
  const raw = live('card.json');
  if (!raw) {
    t.skip(`нет ${LIVE_DIR}/card.json`);
    return;
  }
  const { normalizeGameCard } = await view();
  const card = normalizeGameCard(raw);
  assert.equal(card.name, 'Crusader Kings II');
  assert.equal(card.personnel.studios.length, 3);
  assert.equal(card.achievements.total, 161);
  assert.equal(card.achievements.unlocked, 53);
  assert.equal(card.links.steam, 'https://store.steampowered.com/app/203770');
  assert.equal(card.links.steamdb, 'https://steamdb.info/app/203770/');
});

test('live snapshot: personnel returns the whole studio role (399), not a 50 cap', async (t) => {
  const raw = live('personnel.json');
  if (!raw) {
    t.skip(`нет ${LIVE_DIR}/personnel.json`);
    return;
  }
  const { normalizePersonnel, personnelRows } = await view();
  const data = normalizePersonnel(raw, 'studio');
  assert.equal(data.items.length, 399);
  assert.equal(data.coverage.percent, 36);
  const rows = personnelRows(data, { weight: 'hours' });
  assert.equal(rows[0].name, 'Paradox Interactive');
  assert.equal(rows[0].count, 12);
  assert.equal(plain(rows[0].hoursText), '1 118,9 ч');
});
