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
const { readPublicCss } = require('./helpers/css');
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

  const css = readPublicCss();
  assert.match(css, /\.w-games-persons \{ grid-column: span 12; \}/);
  assert.match(css, /\.summary-strip\.games-summary/);
});

test('year-count chart: span 12, own ids, counts above bars, genre filter', () => {
  const html = readPublic('index.html');
  for (const id of [
    'games-yearcount-widget', 'games-yearcount-title', 'games-yearcount-note',
    'games-yearcount-chart', 'games-yearcount-genre', 'games-yearcount-hint',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /Количество игр по году выхода/);
  // The card is about games, not playtime — say it in the footer.
  assert.match(html, /игры, а не время/);
  assert.match(html, /наведи на столбик — счётчик и часы/);
  // Own select, distinct from the persons role select and the weight toggles.
  assert.match(html, /id="games-yearcount-genre"[^>]*aria-label="Фильтр по жанру Steam Store"/);

  // Order: decades + years pair, then the full-width count chart, then tags.
  const years = html.indexOf('id="games-years-widget"');
  const count = html.indexOf('id="games-yearcount-widget"');
  const tags = html.indexOf('id="games-tags-widget"');
  assert.ok(years > 0 && years < count && count < tags,
    'count chart must sit right after the years pair (no grid holes)');
  // The existing decade-gated card keeps its own title — no duplicate wording.
  assert.match(html, /id="games-years-title"[^>]*>[\s\S]{0,120}Годы релиза/);

  const css = readPublicCss();
  assert.match(css, /\.w-games-yearcount \{ grid-column: span 12; \}/);
  assert.match(css, /\.tl-bar-count \{/);

  const games = readJs('games.js');
  assert.match(games, /renderYearCount\(data\)/);
  assert.match(games, /yearCountView\(data\.years, data\.gamesIndex/);
  assert.match(games, /barLabels: true/);
  assert.match(games, /openYearModal\(data, year, \{ genre: view\.genre \}\)/);
  assert.match(games, /yearCountGenreOptions\(data\.genres\)/);
  // This card never reads the decade selection: the pair above owns it.
  assert.doesNotMatch(games, /function renderYearCount\(data\)[\s\S]{0,3000}selectedDecade/);

  const charts = readJs('charts.js');
  assert.match(charts, /barLabels = false/);
  assert.match(charts, /class: 'tl-bar-count'/);
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
  // default and a year slice opens that year's games. The empty state is a
  // placeholder inside the widget, never a hidden card.
  assert.doesNotMatch(games, /Выберите десятилетие слева/);
  assert.match(games, /function renderYears\(data\)[\s\S]{0,900}widget\.hidden = false;/);
  // U6: both cards are donuts (films/books parity), a year slice opens the
  // year list and a decade slice is a selection, not a list.
  assert.match(games, /function renderDecades\(data\)[\s\S]{0,2200}renderDonut\(donutHost/);
  assert.match(games, /function renderYears\(data\)[\s\S]{0,3000}renderDonut\(donutHost/);
  assert.match(games, /function renderYears\(data\)[\s\S]{0,3600}openYearModal\(data, year\)/);
  assert.doesNotMatch(games, /games-decades-list/);
  assert.match(games, /Нет данных по годам релиза/);
  // `onYearClick` now belongs to the full-width count chart only: the years
  // donut uses the donut `onSelect`.
  assert.match(games, /function renderYearCount\(data\)[\s\S]{0,4200}onYearClick/);
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

test('drilldowns from gamesIndex: year, decade, unknown year, genre, recent', async () => {
  const {
    gamesInYear, gamesInDecade, gamesWithoutYear, gamesWithoutType, gamesByGenre,
    gamesWithRecentHours, yearsInDecade,
  } = await view();
  const index = miniIndex();

  assert.deepEqual(gamesInYear(index, 2013).map((game) => game.name).sort(), ['Alpha', 'Epsilon']);
  assert.equal(gamesInDecade(index, 2010).length, 4);
  assert.equal(gamesInDecade(index, 2020).length, 0);
  assert.deepEqual(gamesWithoutYear(index).map((game) => game.name), ['Gamma']);
  assert.deepEqual(gamesWithoutType(index).map((game) => game.name), ['Gamma']);

  assert.deepEqual(gamesByGenre(index, 'RPG').map((game) => game.name).sort(), ['Alpha', 'Delta']);
  assert.deepEqual(gamesByGenre(index, 'rpg').map((game) => game.name).sort(), ['Alpha', 'Delta']);

  // U5: mode/access/hours-bucket drilldowns died with their widgets; the
  // «за 2 недели» summary tile still drills into this helper.
  assert.deepEqual(gamesWithRecentHours(index).map((game) => game.name), ['Alpha']);

  const years = yearsInDecade([
    { year: 2009, count: 1 },
    { year: 2010, count: 2 },
    { year: 2013, count: 4 },
    { year: 2020, count: 8 },
  ], 2010);
  assert.deepEqual(years.map((item) => item.year), [2010, 2013]);
});

test('year-count view: payload counts, unknown bucket, RPG filter from gamesIndex', async () => {
  const { normalizeGamesPayload, yearCountView, yearCountSeries, yearCountGenreOptions, gamesInYearGenre } = await view();
  const data = normalizeGamesPayload({
    summary: { gameCount: 5 },
    years: [
      { year: 2012, count: 1, hours: 0 },
      { year: 2013, count: 2, hours: 17 },
      { year: 2015, count: 1, hours: 120 },
      { year: null, unknown: true, count: 1, hours: 7 },
    ],
    genres: [
      { name: 'Action', count: 2, hours: 2.5 },
      { name: 'RPG', count: 2, hours: 130 },
      { name: 'Empty', count: 0 },
    ],
    gamesIndex: miniIndex(),
  });

  // Unfiltered: the server counts win (they are the payload contract), and the
  // unknown bucket is reported apart — never parked on a fake year.
  const all = yearCountView(data.years, data.gamesIndex, { unknownYear: data.unknownYear });
  assert.deepEqual(all.series.map((item) => [item.year, item.count]), [[2012, 1], [2013, 2], [2015, 1]]);
  assert.equal(all.total, 4);
  assert.equal(all.unknown, 1);
  assert.equal(plain(all.note), '2012 — 2015 · 4 игры · и ещё 1 игра без года');
  assert.equal(all.filtered, false);

  // Genre filter: recomputed client-side from gamesIndex (Alpha 2013, Delta 2015).
  const rpg = yearCountView(data.years, data.gamesIndex, { genre: 'RPG' });
  assert.deepEqual(rpg.series.map((item) => [item.year, item.count]), [[2013, 1], [2015, 1]]);
  assert.equal(rpg.total, 2);
  assert.equal(rpg.unknown, 0);
  assert.equal(rpg.filtered, true);
  assert.equal(rpg.genre, 'RPG');
  assert.equal(plain(rpg.note), '2 игры · жанр: RPG');

  // Case-insensitive, and a genre nobody has yields an honest empty series.
  assert.equal(yearCountView(data.years, data.gamesIndex, { genre: 'rpg' }).total, 2);
  assert.equal(yearCountView(data.years, data.gamesIndex, { genre: 'Nope' }).series.length, 0);

  // No `years[]` at all (M1 server): recount from the index instead of hiding.
  const fallback = yearCountView([], data.gamesIndex);
  assert.equal(fallback.total, 4);
  assert.equal(fallback.unknown, 1);

  // The raw aggregation agrees with the payload (no silent drift).
  const local = yearCountSeries(data.gamesIndex);
  assert.deepEqual(local.series.map((item) => [item.year, item.count]), all.series.map((item) => [item.year, item.count]));

  assert.deepEqual(gamesInYearGenre(data.gamesIndex, 2013, 'rpg').map((game) => game.name), ['Alpha']);
  assert.deepEqual(gamesInYearGenre(data.gamesIndex, 2013, null).map((game) => game.name).sort(), ['Alpha', 'Epsilon']);

  assert.deepEqual(yearCountGenreOptions(data.genres).map((item) => item.name), ['Action', 'RPG']);
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
    normalizeGamesPayload, gamesInYear, gamesByGenre, gamesWithoutType,
    decadesView, summaryMetrics,
  } = await view();
  const data = normalizeGamesPayload(raw);

  assert.equal(data.summary.gameCount, 332);
  assert.equal(data.summary.ownedCount, 340);
  assert.equal(data.summary.totalHours, 5852.7);
  assert.equal(Object.keys(data.gamesIndex).length, 332);
  assert.equal(gamesInYear(data.gamesIndex, 2013).length, 34);
  assert.equal(gamesByGenre(data.gamesIndex, 'RPG').length, 97);
  assert.equal(gamesWithoutType(data.gamesIndex).length, 21);
  assert.deepEqual(decadesView(data.decades).rows.map((row) => row.label), [
    '1990-е', '2000-е', '2010-е', '2020-е', 'год неизвестен',
  ]);
  const metrics = new Map(summaryMetrics(data.summary).map((metric) => [metric.key, metric]));
  assert.equal(metrics.get('unmatched').value, '21');
  assert.equal(plain(metrics.get('unmatched').sub), '8 записей — не игры');
});

test('live snapshot: year-count chart 1997–2026, 2013 = 34, RPG 2013 = 10', async (t) => {
  const raw = live('stats-live.json') || live('stats2.json');
  if (!raw) {
    t.skip(`нет ${LIVE_DIR}/stats-live.json`);
    return;
  }
  const { normalizeGamesPayload, yearCountView, yearCountSeries } = await view();
  const data = normalizeGamesPayload(raw);

  const all = yearCountView(data.years, data.gamesIndex, { unknownYear: data.unknownYear });
  assert.equal(all.series.length, 26, '26 лет с известным годом в снимке');
  assert.equal(all.series[0].year, 1997);
  assert.equal(all.series.at(-1).year, 2026);
  assert.equal(all.total, 303);
  assert.equal(all.unknown, 29);
  assert.equal(all.series.find((item) => item.year === 2013).count, 34);
  assert.match(plain(all.note), /1997 — 2026 · 303 игры · и ещё 29 игр без года/);

  // The client-side recount (what the genre filter uses) matches the payload
  // year by year — no drift between `years[]` and `gamesIndex`.
  const local = yearCountSeries(data.gamesIndex);
  assert.deepEqual(
    local.series.map((item) => [item.year, item.count]),
    all.series.map((item) => [item.year, item.count]),
  );

  const rpg = yearCountView(data.years, data.gamesIndex, { genre: 'RPG' });
  assert.equal(rpg.total, 96);
  assert.equal(rpg.unknown, 1);
  assert.equal(rpg.series.find((item) => item.year === 2013).count, 10);
  assert.match(plain(rpg.note), /96 игр · жанр: RPG · и ещё 1 игра без года/);
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
