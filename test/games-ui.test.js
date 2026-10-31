'use strict';

/**
 * Games tab (M1): markup contract + headless view-model smoke.
 *
 * There is no browser in `npm test`, so the dashboard is pinned in two layers:
 *
 *   1. `public/index.html` must carry the third tab, the import form (button
 *      never disabled) and the M1 widgets with their ids — the same shape the
 *      books tests pin for the books tab;
 *   2. `public/js/games-view.js` is DOM-free, so it is imported directly and
 *      fed a realistic `/api/games/stats` payload (the contract in
 *      ИГРЫ-АРХИТЕКТУРА §5.1). Every number the user sees is asserted here:
 *      340 games, 5 862.6 h, backlog 124, Pareto 74.6%, median 2.8 h and the
 *      top row (Crusader Kings II, 1054.4 h).
 *
 * The tolerant half is tested too: a payload without a library (no Steam key)
 * must hide widgets instead of rendering zeroes, and must never throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const MOCK_PATH = '/tmp/opencode/gm1-ui/stats-mock.json';
const MOCK_PARTIAL_PATH = '/tmp/opencode/gm1-ui/stats-mock-partial.json';

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function readJs(name) {
  return fs.readFileSync(path.join(JS_DIR, name), 'utf8');
}

/** Intl ru-RU groups digits with a narrow no-break space — normalise for tests. */
function plain(value) {
  return String(value == null ? '' : value).replace(/[\u00a0\u202f]/g, ' ');
}

/** The canonical M1 payload (mirrors /tmp/opencode/gm1-ui/stats-mock.json). */
function statsPayload() {
  return {
    sources: {
      connected: ['steam-76561198038369983'],
      selected: ['steam-76561198038369983'],
      profile: {
        key: 'steam-76561198038369983',
        source: 'steam',
        userKey: '76561198038369983',
        personaName: 'whitefiercewolf',
        privacy: 'public',
        importedAt: '2026-11-01T19:12:04.000Z',
        memberSince: 'February 19, 2011',
        gameCount: 340,
        libraryPartial: false,
      },
      steamKeyConfigured: true,
    },
    summary: {
      gameCount: 340,
      ownedCount: 340,
      playedCount: 216,
      unplayedCount: 124,
      totalHours: 5862.6,
      meanHours: 17.24,
      medianHours: 2.8,
      top10HoursShare: 0.746,
      recent2wHours: 3.3,
      lastPlayedAt: '2026-10-29T17:34:11.000Z',
      libraryPartial: false,
      steamKeyConfigured: true,
      completion: {
        avgPercent: 34.2,
        medianPercent: 22,
        perfectCount: 7,
        gamesWithStats: 180,
        gamesTotal: 340,
      },
    },
    hoursHistogram: [
      { bucket: '0', count: 124 },
      { bucket: '<1', count: 38 },
      { bucket: '1-5', count: 62 },
      { bucket: '5-20', count: 55 },
      { bucket: '20-50', count: 33 },
      { bucket: '50-100', count: 16 },
      { bucket: '100-500', count: 10 },
      { bucket: '500+', count: 2 },
    ],
    topGames: [
      { appid: 203770, name: 'Crusader Kings II', hours: 1054.4, lastPlayed: '2025-11-14T20:02:00.000Z', releaseYear: 2012 },
      { appid: 570940, name: 'DARK SOULS: Prepare To Die Edition', hours: 342.6, lastPlayed: '2024-03-02T18:41:00.000Z', releaseYear: 2012 },
      { appid: 22380, name: 'Fallout: New Vegas', hours: 286.6, lastPlayed: '2023-08-19T21:15:00.000Z', releaseYear: 2010 },
      { appid: 570, name: 'Dota 2', hours: 213.3, lastPlayed: '2026-10-27T15:08:00.000Z', releaseYear: 2013 },
      { appid: 39510, name: 'Gothic II: Gold Edition', hours: 198.3, lastPlayed: '2022-12-28T12:30:00.000Z', releaseYear: 2005 },
      { appid: 292030, name: 'The Witcher 3: Wild Hunt', hours: 107.0, lastPlayed: '2024-09-01T19:00:00.000Z', releaseYear: 2015 },
      { appid: 1091500, name: 'Cyberpunk 2077', hours: 96.5, lastPlayed: '2026-10-29T17:34:11.000Z', releaseYear: 2020 },
      { appid: 236850, name: 'Europa Universalis IV', hours: 92.1, releaseYear: 2013 },
      { appid: 48700, name: 'Mount & Blade: Warband', hours: 88.4, releaseYear: 2010 },
      { appid: 105600, name: 'Terraria', hours: 74.2, releaseYear: 2011 },
      { appid: 400, name: 'Portal', hours: 6.4, releaseYear: 2007 },
    ],
    recentlyPlayed: [
      { appid: 1091500, name: 'Cyberpunk 2077', hours2w: 2.5, hoursTotal: 96.5, lastPlayed: '2026-10-29T17:34:11.000Z' },
      { appid: 570, name: 'Dota 2', hours2w: 0.8, hoursTotal: 213.3, lastPlayed: '2026-10-27T15:08:00.000Z' },
    ],
    backlog: {
      count: 124,
      share: 0.3647,
      items: [
        { appid: 1151640, name: 'Horizon Zero Dawn', releaseYear: 2017, genres: ['Action', 'Adventure'] },
        { appid: 379720, name: 'DOOM', releaseYear: 2016, genres: ['Action'] },
        { appid: 289070, name: "Sid Meier's Civilization VI", releaseYear: 2016, genres: ['Strategy'] },
      ],
    },
  };
}

/* =========================================================
   markup: the third tab, the import form, the M1 widgets
   ========================================================= */

test('index.html carries the third «Игры» tab in every topbar', () => {
  const html = readPublic('index.html');
  const gamesTabs = html.match(/data-tab="games"/g) || [];
  // Films, books and games views each render the shared tab bar.
  assert.equal(gamesTabs.length, 3, 'каждый таб-бар (films, books, games) должен иметь третий таб');
  assert.equal((html.match(/data-tab="films"/g) || []).length, 3);
  assert.equal((html.match(/data-tab="books"/g) || []).length, 3);
  assert.match(html, /<span class="tab-label">Игры<\/span>/);
  // The games view itself is a first-class view with the active tab.
  assert.match(html, /<section class="view" data-view="games" hidden>/);
  assert.match(html, /class="tab-btn is-active" data-tab="games" role="tab" aria-selected="true"/);
});

test('empty state: vanity/steamid64 form with an always-active import button', () => {
  const html = readPublic('index.html');
  assert.match(html, /id="games-import"/);
  assert.match(html, /<form[^>]+id="games-import-form"[^>]*novalidate>/);
  assert.match(html, /id="games-import-account"[^>]*placeholder="76561198038369983 или hattivatt"/);
  assert.match(html, /id="games-import-label"/);
  // «Импортировать» is enabled from the start: the no-key path still imports
  // the profile, achievements and the last games (ИГРЫ-АРХИТЕКТУРА §8.2).
  const submit = /<button[^>]+id="games-import-submit"[^>]*>/.exec(html);
  assert.ok(submit, 'кнопка импорта должна существовать');
  assert.doesNotMatch(submit[0], /\sdisabled\b/, 'кнопка импорта всегда активна');
  assert.match(html, /Профиль должен быть публичным/);
  assert.match(html, /ключ Steam Web API/);
  assert.match(html, /id="games-key-state"/);
});

test('dashboard markup keeps the M1 widgets and their honest labels', () => {
  const html = readPublic('index.html');
  for (const id of [
    'games-dash',
    'games-summary',
    'games-profile-widget',
    'games-top-widget',
    'games-pareto-widget',
    'games-histogram-widget',
    'games-backlog-widget',
    'games-recent-widget',
    'games-profile-bar',
    'games-progress',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /Топ по часам/);
  assert.match(html, /Топ-10% и остальные/);
  assert.match(html, /Backlog/);
  assert.match(html, /За 2 недели/);
  assert.match(html, /Профиль Steam/);
  // Honest wording that must not be lost: hours are Steam's, last played is a
  // launch stamp, the calendar is not "time in game".
  assert.match(html, /дата запуска, а не игровая сессия/);
  assert.match(html, /это время с запущенным клиентом, а не хронометраж/);
});

test('games.js + games-view.js exist and the router knows ?tab=games', () => {
  const main = readJs('main.js');
  assert.match(main, /import \{ initGames, showGames, hideGames, resetGames \} from '\.\/games\.js'/);
  assert.match(main, /const TABS = \['films', 'books', 'games'\]/);
  assert.match(main, /if \(next === 'games'\) \{[\s\S]*?await showGames\(\);/);
  assert.match(main, /if \(activeTab === 'games'\) \{[\s\S]*?await showGames\(\);/);
  assert.match(main, /url\.searchParams\.set\('tab', next\)/);
  assert.match(main, /initGames\(\{ onActivate: \(\) => showView\('games'\) \}\)/);

  const games = readJs('games.js');
  for (const fn of ['initGames', 'showGames', 'hideGames', 'resetGames']) {
    assert.match(games, new RegExp(`export (async )?function ${fn}\\(`), `games.js не экспортирует ${fn}`);
  }
  assert.match(games, /getGamesStats\(\{ profile: state\.profileKey \}\)/);
  assert.match(games, /startGamesImportSteam\(/);
  assert.match(games, /withPreservedScroll\(/, 'тихий re-render должен сохранять скролл');
  // No other network calls: only api.js endpoints of the games contract.
  assert.doesNotMatch(games, /fetch\(/);
  assert.doesNotMatch(games, /https?:\/\/api\.steampowered\.com/);
});

test('api.js games methods are additive next to films/books', () => {
  const api = readJs('api.js');
  for (const fn of [
    'getGamesStats', 'getGamesProfiles', 'startGamesImportSteam',
    'getGamesImportStatus', 'startGamesRefresh', 'getGameDetails',
  ]) {
    assert.match(api, new RegExp(`export function ${fn}\\(`), `api.js не экспортирует ${fn}`);
  }
  // The games section must not have removed or renamed the older clients.
  for (const fn of ['getStats', 'getKpProfiles', 'getBooksStats', 'getBooksProfiles', 'startBooksImportLivelib']) {
    assert.match(api, new RegExp(`export (async )?function ${fn}\\(`), `пропал прежний метод ${fn}`);
  }
  assert.match(api, /\/api\/games\/stats/);
  assert.match(api, /\/api\/games\/import\/steam/);
  assert.match(api, /\/api\/games\/import\/status/);
  // Unknown query params are a 400 on the stats route: only the three allowed
  // keys may be appended there.
  const statsFn = /export function getGamesStats\([\s\S]*?\n\}/.exec(api)[0];
  const params = [...statsFn.matchAll(/params\.set\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(params, ['profile', 'includeFree', 'includeDlc']);
});

test('every DOM id games.js asks for exists in index.html', () => {
  const html = readPublic('index.html');
  const games = readJs('games.js');
  const ids = new Set([...games.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1]));
  assert.ok(ids.size > 10, 'games.js должен обращаться к узлам по id');
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), `games.js ищет #${id}, которого нет в index.html`);
  }
});

test('style.css ships the games widgets', () => {
  const css = readPublic('style.css');
  for (const selector of [
    '.w-games-profile', '.w-games-top', '.w-games-pareto',
    '.w-games-histogram', '.w-games-backlog', '.w-games-recent',
    '.games-pareto-track', '.games-pareto-fill', '.games-profile-chip',
    '.games-key-state', '.games-import-grid',
  ]) {
    assert.ok(css.includes(selector), `нет стилей для ${selector}`);
  }
});

test('every public script parses (node --check)', () => {
  const files = ['games.js', 'games-view.js', 'api.js', 'main.js', 'auth.js'];
  for (const file of files) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path.join(JS_DIR, file)], { stdio: 'pipe' }),
      `${file} не парсится`,
    );
  }
});

/* =========================================================
   view model: the numbers the dashboard prints
   ========================================================= */

test('normalizeGamesPayload keeps the contract numbers', async () => {
  const { normalizeGamesPayload } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());

  assert.equal(data.summary.gameCount, 340);
  assert.equal(data.summary.ownedCount, 340);
  assert.equal(data.summary.playedCount, 216);
  assert.equal(data.summary.unplayedCount, 124);
  assert.equal(data.summary.totalHours, 5862.6);
  assert.equal(data.summary.medianHours, 2.8);
  assert.equal(data.summary.top10HoursShare, 0.746);
  assert.equal(data.summary.recent2wHours, 3.3);
  assert.equal(data.summary.libraryPartial, false);
  assert.equal(data.summary.steamKeyConfigured, true);
  assert.equal(data.profile.personaName, 'whitefiercewolf');

  // Sorted by hours, best first — the widget must not depend on server order.
  assert.equal(data.topGames[0].name, 'Crusader Kings II');
  assert.equal(data.topGames[0].hours, 1054.4);
  assert.equal(data.topGames.length, 11);

  assert.equal(data.backlog.count, 124);
  assert.equal(data.backlog.items.length, 3);
  assert.equal(data.recentlyPlayed.length, 2);
  assert.equal(data.histogram.length, 8);
  assert.equal(data.histogram[0].bucket, '0');
  assert.equal(data.histogram[0].count, 124);

  for (const flag of ['profile', 'games', 'hours', 'topGames', 'backlog', 'recently', 'histogram', 'completion']) {
    assert.equal(data.has[flag], true, `флаг has.${flag} должен быть true`);
  }
});

test('normalizeGamesPayload reads the real backend shape (meta.keyConfigured, top-level libraryPartial)', async () => {
  const { normalizeGamesPayload } = await import('../public/js/games-view.js');
  // Exactly what `GET /api/games/stats` returned for the live 340-game profile
  // (trimmed): `libraryPartial` sits at the top level, the key flag lives in
  // `meta.keyConfigured` — not in `summary`.
  const data = normalizeGamesPayload({
    sources: { profile: { key: 'steam-1', userKey: '1', personaName: 'player' } },
    libraryPartial: true,
    summary: {
      gameCount: 3,
      ownedCount: 3,
      playedCount: 1,
      unplayedCount: 2,
      totalHours: 2,
    },
    meta: { keyConfigured: false, keySource: null },
    gamesIndex: { 70: { appid: 70, name: 'Half-Life', hours: 1.5 } },
  });
  assert.equal(data.summary.libraryPartial, true, 'top-level libraryPartial доезжает до summary');
  assert.equal(data.summary.steamKeyConfigured, false, 'meta.keyConfigured доезжает до summary');
  assert.equal(data.gamesIndex[70].hours, 1.5);
  // A partial library hides the library metrics instead of printing zeroes.
  const { summaryMetrics } = await import('../public/js/games-view.js');
  const keys = summaryMetrics(data.summary).map((m) => m.key);
  assert.deepEqual(keys, []);
});

test('normalizeGamesPayload accepts the steamKey.configured alias', async () => {
  const { normalizeGamesPayload } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload({
    sources: { profile: { key: 'steam-1', personaName: 'player' } },
    summary: { gameCount: 1, ownedCount: 1, totalHours: 1 },
    steamKey: { configured: true, source: 'file' },
  });
  assert.equal(data.summary.steamKeyConfigured, true);
});

test('summary metrics: games / hours / backlog / median / Pareto / 2 weeks', async () => {
  const { normalizeGamesPayload, summaryMetrics } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());
  const metrics = summaryMetrics(data.summary, { profile: data.profile });
  const byKey = new Map(metrics.map((m) => [m.key, m]));

  assert.equal(byKey.get('games').value, '340');
  assert.match(plain(byKey.get('games').sub), /216 с часами/);
  assert.match(plain(byKey.get('games').sub), /124 без часов/);

  assert.equal(plain(byKey.get('hours').value), '5 863 ч', 'суммарные часы округляются до целого');
  assert.match(plain(byKey.get('hours').sub), /в среднем 17,2 ч/);

  assert.equal(byKey.get('backlog').value, '124');
  assert.equal(plain(byKey.get('backlog').sub), '36,5% библиотеки');

  assert.equal(plain(byKey.get('median').value), '2,8 ч');
  assert.equal(plain(byKey.get('pareto').value), '74,6%');

  assert.equal(plain(byKey.get('recent').value), '3,3 ч');
  assert.match(plain(byKey.get('recent').sub), /последний запуск 29 окт\. 2026/);

  assert.equal(byKey.get('completion').value, '34%');
  assert.match(plain(byKey.get('completion').sub), /180 играм с достижениями/);

  // Every metric carries the honest tooltip, not just a number.
  assert.match(plain(byKey.get('hours').title), /playtime_forever/);
  assert.match(plain(byKey.get('backlog').title), /playtime_forever = 0/);
  assert.match(plain(byKey.get('pareto').title), /10%/);
});

test('top-by-hours rows: ranks, widths and share of all hours', async () => {
  const { normalizeGamesPayload, topHoursRows } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());
  const rows = topHoursRows(data.topGames, { limit: 10, totalHours: data.summary.totalHours });

  assert.equal(rows.length, 10, 'виджет показывает топ-10, хотя в payload 11 игр');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].name, 'Crusader Kings II');
  assert.equal(plain(rows[0].hoursText), '1 054,4 ч');
  assert.equal(rows[0].widthPercent, 100);
  assert.ok(Math.abs(rows[0].sharePercent - (1054.4 / 5862.6) * 100) < 0.01);
  assert.match(plain(rows[0].hint), /18,0% всех часов библиотеки/);
  assert.match(plain(rows[0].hint), /последний запуск 14 нояб\. 2025/);
  assert.equal(rows[4].name, 'Gothic II: Gold Edition');
  assert.equal(rows[9].name, 'Terraria', 'одиннадцатая игра (Portal) в топ-10 не попадает');
});

test('Pareto lane explains the top-10% share in Russian', async () => {
  const { normalizeGamesPayload, paretoView } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());
  const view = paretoView(data.summary);

  assert.ok(Math.abs(view.sharePercent - 74.6) < 0.001);
  assert.ok(Math.abs(view.restPercent - 25.4) < 0.001);
  assert.equal(view.topCount, 34, '10% от 340 игр = 34');
  assert.equal(plain(view.text), 'Топ-10% игр (34 из 340) дают 74,6% всех часов');
  assert.match(plain(view.hint), /остальные 90%/);

  // Both spellings of the share are accepted (fraction and percent).
  assert.equal(paretoView({ top10HoursShare: 74.6, gameCount: 340 }).topCount, 34);
  assert.equal(paretoView({ gameCount: 340 }), null, 'без доли Pareto скрывается');
});

test('backlog view: counter, share and the known items', async () => {
  const { normalizeGamesPayload, backlogView } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());
  const view = backlogView(data.backlog, data.summary);

  assert.equal(view.count, 124);
  assert.equal(view.countText, '124');
  assert.equal(plain(view.shareText), '36,5%');
  assert.equal(view.items.length, 3);
  assert.equal(view.items[0].name, 'Horizon Zero Dawn');
  assert.equal(view.items[0].yearText, '2017');
  assert.equal(view.items[0].genresText, 'Action, Adventure');

  // Counter-only payload: the list is honestly empty, not invented.
  const counterOnly = backlogView({ count: 12, share: 0.5 }, { gameCount: 24 });
  assert.equal(counterOnly.hasItems, false);
  assert.match(counterOnly.note, /сервер не передал/);
});

test('«За 2 недели»: hours and the launch-stamp tooltip', async () => {
  const { normalizeGamesPayload, recentlyView, lastPlayedInfo } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(statsPayload());
  const view = recentlyView(data.recentlyPlayed);

  assert.equal(view.visible, true);
  assert.equal(view.items.length, 2);
  assert.equal(plain(view.total2wText), '3,3 ч');
  assert.equal(plain(view.items[0].hours2wText), '2,5 ч');
  assert.equal(plain(view.items[0].hoursTotalText), '96,5 ч');
  assert.equal(view.items[0].lastPlayedText, '29 окт. 2026');
  assert.match(view.items[0].lastPlayedTitle, /не игровая сессия/);

  // rtime_last_played = 0 means «never launched», not 1970-01-01.
  const never = lastPlayedInfo(0);
  assert.equal(never.unknown, true);
  assert.equal(never.text, 'не запускал');
  // Unix seconds are accepted as well as ISO strings.
  assert.equal(lastPlayedInfo(1793295251).text, '29 окт. 2026');
});

test('hours histogram is a long-tail bar list', async () => {
  const { histogramView } = await import('../public/js/games-view.js');
  const view = histogramView(statsPayload().hoursHistogram);
  assert.equal(view.rows.length, 8);
  assert.equal(view.total, 340);
  assert.equal(view.rows[0].bucket, '0');
  assert.equal(view.rows[0].countText, '124');
  assert.equal(view.rows[0].widthPercent, 100);
  assert.equal(view.rows[7].bucket, '500+');
  assert.equal(histogramView([]), null);
});

/* =========================================================
   tolerant normalisation (backend contract may drift)
   ========================================================= */

test('a payload without a library hides blocks instead of rendering zeroes', async () => {
  const {
    normalizeGamesPayload, summaryMetrics, paretoView, topHoursRows, backlogView, profileCardView,
  } = await import('../public/js/games-view.js');

  const data = normalizeGamesPayload({
    sources: {
      profile: {
        key: 'steam-76561198038369983',
        userKey: '76561198038369983',
        personaName: 'whitefiercewolf',
        privacy: 'public',
        libraryPartial: true,
        memberSince: 'February 19, 2011',
      },
      steamKeyConfigured: false,
    },
    summary: { libraryPartial: true, steamKeyConfigured: false, unplayedCount: 0 },
    topGames: [{ appid: 570, name: 'Dota 2', hours: null, lastPlayed: 0 }],
  });

  assert.equal(data.summary.libraryPartial, true);
  assert.equal(data.summary.steamKeyConfigured, false);
  assert.equal(data.summary.totalHours, null);
  assert.equal(data.has.topGames, true, 'запись есть — но с неизвестными часами');
  assert.equal(topHoursRows(data.topGames, { limit: 10 }).length, 0, 'строка без часов не рисуется');
  assert.equal(paretoView(data.summary), null);
  assert.equal(backlogView(data.backlog, data.summary), null);
  assert.equal(data.has.histogram, false);

  const metrics = summaryMetrics(data.summary).map((m) => m.key);
  assert.deepEqual(metrics, [], 'частичная библиотека не рисует «0 игр / 0 ч»');
  assert.ok(profileCardView(data.profile), 'карточка профиля строится и без библиотеки');
});

test('malformed payloads never throw and never invent numbers', async () => {
  const {
    normalizeGamesPayload, summaryMetrics, paretoView, topHoursRows, backlogView,
    recentlyView, histogramView, profileCardView, normalizeProfilesList,
  } = await import('../public/js/games-view.js');

  for (const raw of [null, undefined, {}, [], 'nonsense', { summary: 'no' }, { topGames: 'no' }]) {
    assert.doesNotThrow(() => normalizeGamesPayload(raw));
    const data = normalizeGamesPayload(raw);
    assert.equal(data.has.profile, false);
    assert.equal(data.has.topGames, false);
    assert.deepEqual(summaryMetrics(data.summary), []);
    assert.equal(paretoView(data.summary), null);
    assert.deepEqual(topHoursRows(data.topGames), []);
    assert.equal(backlogView(null, null), null);
    assert.equal(recentlyView(null).visible, false);
    assert.equal(histogramView(null), null);
    assert.equal(profileCardView(null), null);
  }
  assert.deepEqual(normalizeProfilesList(null), []);
  assert.deepEqual(normalizeProfilesList({ profiles: [null, 3, 'x'] }), []);
});

test('alternate field spellings (minutes, job/profile shapes) are accepted', async () => {
  const { normalizeGamesPayload, gamesJobId, normalizeProfilesList } = await import('../public/js/games-view.js');

  const data = normalizeGamesPayload({
    summary: { gameCount: 2, totalHours: 4 },
    topGames: [{ appid: 1, name: 'A', playtime_forever: 120 }],
    recentlyPlayed: [{ appid: 1, name: 'A', playtime_2weeks: 60, playtime_forever: 120 }],
  });
  assert.equal(data.topGames[0].hours, 2, 'минуты из Web API → часы');
  assert.equal(data.recentlyPlayed[0].hours2w, 1);
  assert.equal(data.recentlyPlayed[0].hoursTotal, 2);

  // `job: "games-import"` in the contract is the job TYPE, not an id.
  assert.equal(gamesJobId({ job: 'games-import', profile: 'steam-1', status: 'running' }), '');
  assert.equal(gamesJobId({ jobId: 'abc' }), 'abc');
  assert.equal(gamesJobId({ id: 'def' }), 'def');
  assert.equal(gamesJobId({ job: { id: 'ghi' } }), 'ghi');
  assert.equal(gamesJobId(null), '');

  const profiles = normalizeProfilesList({
    profiles: [{ userKey: '76561198038369983', personaName: 'whitefiercewolf', gameCount: 340 }],
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].key, 'steam-76561198038369983');
  assert.equal(profiles[0].personaName, 'whitefiercewolf');
  assert.equal(profiles[0].gameCount, 340);
});

/* =========================================================
   import flow helpers
   ========================================================= */

test('account input accepts steamid64, vanity and steam URLs', async () => {
  const { accountFromInput } = await import('../public/js/games-view.js');

  assert.deepEqual(accountFromInput('76561198038369983'), { steamid64: '76561198038369983' });
  assert.deepEqual(
    accountFromInput('https://steamcommunity.com/profiles/76561198038369983/'),
    { steamid64: '76561198038369983' },
  );
  assert.deepEqual(accountFromInput('hattivatt'), { vanityUrl: 'hattivatt' });
  assert.deepEqual(accountFromInput('https://steamcommunity.com/id/hattivatt/'), { vanityUrl: 'hattivatt' });
  assert.deepEqual(accountFromInput(' id/hattivatt '), { vanityUrl: 'hattivatt' });

  assert.match(accountFromInput('').error, /steamid64/);
  assert.match(accountFromInput('12345').error, /17 цифр/);
  assert.match(accountFromInput('не имя!').error, /не похоже/);
});

test('dates: Steam «February 19, 2011» is a calendar day, not local midnight', async () => {
  const { formatDateRu, profileCardView } = await import('../public/js/games-view.js');

  // Date.parse would shift this to 18 Feb in any timezone west of UTC.
  assert.equal(formatDateRu('February 19, 2011'), '19 февр. 2011');
  assert.equal(formatDateRu('19 February 2011'), '19 февр. 2011');
  assert.equal(formatDateRu('2026-11-01T19:12:04.000Z'), '1 нояб. 2026');
  assert.equal(formatDateRu('2026-11'), '1 нояб. 2026');
  assert.equal(formatDateRu(''), '');

  const card = profileCardView({ personaName: 'whitefiercewolf', memberSince: 'February 19, 2011' });
  assert.equal(card.memberSince, '19 февр. 2011');
  assert.ok(card.facts.some((fact) => fact.value === '19 февр. 2011'));
});

test('import errors are honest and actionable', async () => {
  const { importErrorText } = await import('../public/js/games-view.js');

  const priv = importErrorText({ code: 'profile_private', status: 400 });
  assert.match(priv.title, /закрыт/);
  assert.match(priv.message, /Приватность/);

  const key = importErrorText({ code: 'steam_key_missing', status: 400 });
  assert.match(key.message, /steamcommunity\.com\/dev\/apikey/);

  const net = importErrorText({ code: 'steam_unreachable', status: 502 });
  assert.match(net.message, /резолвер/);
  assert.match(net.message, /не «источник мёртв»/);

  const invalid = importErrorText({ code: 'invalid_steamid', status: 400 });
  assert.match(invalid.title, /не найден/);

  const network = importErrorText({ code: 'network' });
  assert.match(network.title, /Нет связи/);

  // Unknown code keeps the server sentence instead of hiding it.
  const other = importErrorText({ code: 'weird', message: 'Сервер сказал нет', status: 500 });
  assert.equal(other.message, 'Сервер сказал нет');
});

test('job stage text and progress percentages', async () => {
  const { jobStageText, jobProgress } = await import('../public/js/games-view.js');

  assert.match(jobStageText({ stage: 'library' }), /библиотеку/);
  assert.equal(jobStageText({ stage: 'profile', message: 'Свой текст' }), 'Свой текст');
  assert.equal(jobStageText(null), 'Готовим импорт…');

  assert.equal(jobProgress({ percent: 42 }), 42);
  assert.equal(jobProgress({ stage: 'done' }), 100);
  assert.equal(jobProgress({ stage: 'library' }), 52);
  assert.equal(jobProgress(null), 0);
});

/* =========================================================
   headless smoke of the on-disk mock payload
   ========================================================= */

test('mock payload /tmp/opencode/gm1-ui/stats-mock.json renders the same numbers', async (t) => {
  if (!fs.existsSync(MOCK_PATH)) {
    t.skip(`нет файла ${MOCK_PATH} (создаётся вручную для smoke-прогона)`);
    return;
  }
  const { normalizeGamesPayload, summaryMetrics, topHoursRows, paretoView } = await import('../public/js/games-view.js');
  const raw = JSON.parse(fs.readFileSync(MOCK_PATH, 'utf8'));
  const data = normalizeGamesPayload(raw);

  assert.equal(data.summary.gameCount, 340);
  assert.equal(data.summary.totalHours, 5862.6);
  assert.equal(data.summary.unplayedCount, 124);
  assert.equal(data.summary.medianHours, 2.8);
  assert.equal(data.summary.top10HoursShare, 0.746);
  assert.equal(data.profile.personaName, 'whitefiercewolf');
  assert.equal(data.profile.memberSince, 'February 19, 2011');

  const rows = topHoursRows(data.topGames, { limit: 10, totalHours: data.summary.totalHours });
  assert.equal(rows[0].name, 'Crusader Kings II');
  assert.equal(plain(rows[0].hoursText), '1 054,4 ч');
  assert.deepEqual(rows.slice(1, 5).map((row) => row.name), [
    'DARK SOULS: Prepare To Die Edition',
    'Fallout: New Vegas',
    'Dota 2',
    'Gothic II: Gold Edition',
  ]);

  const metrics = new Map(summaryMetrics(data.summary).map((m) => [m.key, m]));
  assert.equal(plain(metrics.get('hours').value), '5 863 ч');
  assert.equal(plain(metrics.get('pareto').value), '74,6%');
  assert.equal(plain(paretoView(data.summary).text), 'Топ-10% игр (34 из 340) дают 74,6% всех часов');
});

test('partial mock (no Steam key) hides the library widgets', async (t) => {
  if (!fs.existsSync(MOCK_PARTIAL_PATH)) {
    t.skip(`нет файла ${MOCK_PARTIAL_PATH}`);
    return;
  }
  const { normalizeGamesPayload, paretoView, backlogView, summaryMetrics } = await import('../public/js/games-view.js');
  const data = normalizeGamesPayload(JSON.parse(fs.readFileSync(MOCK_PARTIAL_PATH, 'utf8')));

  assert.equal(data.summary.libraryPartial, true);
  assert.equal(data.summary.steamKeyConfigured, false);
  assert.equal(data.summary.totalHours, null);
  assert.equal(paretoView(data.summary), null);
  assert.equal(backlogView(data.backlog, data.summary), null);
  assert.deepEqual(summaryMetrics(data.summary).map((m) => m.key), [], 'без библиотеки сводка не выдумывает нули');
});
