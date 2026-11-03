'use strict';

/**
 * Games tab (M2/M3): decades/years/genres/modes/access/enrichment, the
 * achievements calendar and the personnel sub-screen.
 *
 * Same two layers as `games-ui.test.js`:
 *
 *   1. `public/index.html` / `style.css` must carry the M2/M3 widgets, the
 *      filters panel and the personnel screen with their ids;
 *   2. `public/js/games-view.js` is DOM-free and is fed the mock payloads in
 *      `test/fixtures/games-ui/` (340 games, 5 862.6 h, 216/124, calendar
 *      from 2011, CD PROJEKT RED + composers).
 *
 * The tolerant half is pinned too: an M1 payload (no M2/M3 blocks) must hide
 * every new widget instead of printing zeroes, and malformed input must never
 * throw.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublicCss } = require('./helpers/css');
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

/** Intl ru-RU groups digits with a narrow no-break space — normalise for tests. */
function plain(value) {
  return String(value == null ? '' : value).replace(/[\u00a0\u202f]/g, ' ');
}

async function view() {
  return import('../public/js/games-view.js');
}

/* =========================================================
   markup + styles
   ========================================================= */

test('style.css ships the M2/M3 games widgets', () => {
  const css = readPublicCss();
  for (const selector of [
    '.w-games-decades', '.w-games-years', '.w-games-genres',
    '.w-games-meta', '.w-games-calendar',
    '.games-genre-chart', '.games-genre-row', '.games-genre-value',
    '.games-genre-more', '.games-weight-toggle', '.games-weight-btn',
    '.games-filter-bar', '.games-filter', '.games-filter-note',
    '.games-hours-stepper', '.games-hours-step', '.games-hours-input',
    '.games-meta-track', '.games-meta-fill',
    '.games-coverage-badge', '.games-role-chip',
    '.games-personnel-row', '.games-personnel-fill', '.games-personnel-games',
    '.games-personnel-empty',
  ]) {
    assert.ok(css.includes(selector), `нет стилей для ${selector}`);
  }
  // Cosmetic round: the DLC and achievements-overview cards (and their styles)
  // are gone from the games dashboard.
  for (const selector of [
    '.w-games-modes', '.w-games-access', '.games-access-item',
    '.w-games-dlc', '.w-games-achievements',
    '.games-achievements', '.games-achievement-metric', '.games-achievement-value',
    '.games-achievement-label', '.games-achievements-note',
    '.games-dlc-summary', '.games-dlc-list', '.games-dlc-row-count',
  ]) {
    assert.equal(css.includes(selector), false, `стили ${selector} должны быть удалены`);
  }
});

test('every new public script parses (node --check)', () => {
  for (const file of ['games.js', 'games-view.js', 'games-charts.js', 'api.js', 'main.js']) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', path.join(JS_DIR, file)], { stdio: 'pipe' }),
      `${file} не парсится`,
    );
  }
});

test('games.js requests personnel and keeps the games URL addressable', () => {
  const games = readJs('games.js');
  assert.match(games, /getGamesPersonnel/);
  // `developer` is the split role; an older server that only knows `studio`
  // is retried inside fetchPersonnel instead of blanking the widget.
  assert.match(games, /getGamesPersonnel\(\{ profile: profileKey, role \}\)/);
  // P2: the profile is captured when the request starts, so an answer that
  // arrives after a switch cannot paint another owner's credits.
  assert.match(games, /const requestProfile = state\.profileKey;/);
  assert.match(games, /const sameOwner = \(\) => state\.profileKey === requestProfile;/);
  assert.match(games, /role: 'studio'/);
  assert.match(games, /error\.code === 'invalid_role'/);
  assert.match(games, /writeViewParam\('personnel'\)/);
  assert.match(games, /readViewParam\(\) === 'personnel'/);
  // The genre widget is a bar chart: one renderer, one host, weight toggle.
  assert.match(games, /renderGenreChart\(data\)/);
  assert.match(games, /genreChartView\(data\.genres/);
  assert.match(games, /data-games-genre-weight/);
  assert.doesNotMatch(games, /genreCloudView|games-genres-cloud/);
  // Filters are appended only when they differ from the server defaults.
  assert.match(games, /if \(state\.filters\.includeFree === false\) query\.includeFree = false;/);
  assert.match(games, /if \(state\.filters\.includeDlc === true\) query\.includeDlc = true;/);
  // Enrichment progress: the poll is driven by summary.metadata.running.
  assert.match(games, /scheduleEnrichPoll/);
  assert.match(games, /metadata\.running === true/);
  assert.doesNotMatch(games, /fetch\(/);

  const main = readJs('main.js');
  // Leaving the games tab must not keep `?view=personnel` in the URL.
  assert.match(main, /if \(next !== 'games'\) url\.searchParams\.delete\('view'\);/);
  // Back/forward between dashboard and personnel repaints the games view.
  assert.match(main, /if \(tab === 'games' && activeTab === 'games'\) \{[\s\S]*?showGames\(\);/);

  const api = readJs('api.js');
  for (const fn of ['getGamesPersonnel', 'getGamesEnrichStatus']) {
    assert.match(api, new RegExp(`export function ${fn}\\(`), `api.js не экспортирует ${fn}`);
  }
  assert.match(api, /\/api\/games\/personnel/);
  assert.match(api, /\/api\/games\/enrich\/status/);
});

/* =========================================================
   full M2/M3 payload
   ========================================================= */

test('normalizeGamesPayload reads the M2/M3 blocks', async () => {
  const { normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));

  assert.equal(data.summary.gameCount, 340);
  assert.equal(data.summary.totalHours, 5862.6);
  assert.equal(data.summary.playedCount, 216);
  assert.equal(data.summary.unplayedCount, 124);

  assert.equal(data.summary.modes.single.count, 300);
  assert.equal(data.summary.modes.onlinePvp.count, 55);
  assert.equal(data.summary.earlyAccess.count, 18);
  assert.equal(data.summary.freeToPlay.count, 60);
  assert.equal(data.summary.metadata.detailsResolved, 312);
  assert.equal(data.summary.metadata.detailsPercent, 91.8);
  assert.equal(data.summary.metadata.creditsPercent, 55);
  assert.equal(data.summary.metadata.running, true);

  assert.equal(data.genres.length, 8);
  assert.equal(data.genres[0].name, 'Action');
  assert.equal(data.genres[0].hours, 1200);
  assert.equal(data.tags.length, 3);
  assert.equal(data.decades.length, 5);
  assert.equal(data.years.length, 16);
  // The fixture carries «год неизвестен» only in decades[], so there is no
  // years bucket to keep aside. The live payload does (29 games / 361.8 h) and
  // the years card prints it — see the yearsView test below.
  assert.equal(data.unknownYear, null);
  const withUnknownYear = normalizeGamesPayload({
    summary: { gameCount: 3 },
    years: [{ year: 2012, count: 2, hours: 5 }, { year: null, key: 'unknown', unknown: true, count: 1, hours: 0.5 }],
  });
  assert.deepEqual(withUnknownYear.unknownYear, { count: 1, hours: 0.5 });
  assert.equal(withUnknownYear.years.length, 1, 'null-year bucket is not a year');
  assert.equal(data.studios.length, 3);
  assert.equal(data.personnelTop.composer.length, 2);
  assert.equal(data.achievementDays.length, 17);
  assert.equal(data.achievementDays[0].date, '2011-02-19');
  assert.equal(data.timeline.length, 6);
  assert.equal(data.streaks.best, 3);
  assert.equal(data.filters.includeFree.applied, true);
  assert.equal(data.filters.includeDlc.requested, false);

  for (const flag of [
    'profile', 'games', 'hours', 'topGames', 'backlog', 'recently', 'histogram',
    'completion', 'genres', 'tags', 'decades', 'years', 'modes', 'access',
    'metadata', 'filters', 'studios', 'personnelTop', 'calendar', 'streaks',
  ]) {
    assert.equal(data.has[flag], true, `флаг has.${flag} должен быть true`);
  }
});

test('decades: release decades with the unknown bucket last', async () => {
  const { decadesView } = await view();
  const data = decadesView(fixture('stats-m2-mock.json').decades);

  assert.deepEqual(data.rows.map((row) => row.label), ['1990-е', '2000-е', '2010-е', '2020-е']);
  assert.equal(data.total, 340);
  assert.equal(data.rows[2].count, 180);
  assert.equal(plain(data.rows[2].hoursText), '3 100,0 ч');
  assert.equal(data.rows[2].widthPercent, 100);
  assert.equal(data.note, '1990-е — 2020-е');

  // The honest «год неизвестен» bucket is last, never merged into a decade.
  const withUnknown = decadesView([
    { decade: 2010, count: 10, hours: 20 },
    { decade: null, key: 'unknown', label: 'год неизвестен', count: 4, hours: 1.5 },
  ]);
  assert.deepEqual(withUnknown.rows.map((row) => row.label), ['2010-е', 'год неизвестен']);
  assert.equal(withUnknown.rows[1].unknown, true);
  assert.equal(withUnknown.note, '2010-е · 4 без года');
  assert.equal(decadesView([]), null);
  assert.equal(decadesView([{ decade: 2010, count: 0 }]), null, 'пустые бакеты не рисуются');
});

test('years: release-year bars keep the range in the note', async () => {
  const { yearsView } = await view();
  const data = yearsView(fixture('stats-m2-mock.json').years);
  assert.equal(data.minYear, 2004);
  assert.equal(data.maxYear, 2025);
  assert.equal(data.total, 340);
  assert.equal(data.years.length, 16);
  assert.equal(data.note, '2004 — 2025 · 340 игр');
  assert.match(data.hint, /Год релиза игры/);
  assert.equal(data.unknownCount, 0, 'в фикстуре нет бакета «год неизвестен»');

  // «Год неизвестен» is reported apart: never a bar on the year axis, but the
  // note can say how many games are missing a release year (live 01.11.2026:
  // 303 known + 29 unknown = 332). The card must not vanish because of it.
  const withUnknown = yearsView([
    { year: 2010, count: 3, hours: 10 },
    { year: 2012, count: 2, hours: 5 },
    { year: null, key: 'unknown', label: 'год неизвестен', unknown: true, count: 29, hours: 361.8 },
  ]);
  assert.equal(withUnknown.years.length, 2);
  assert.equal(withUnknown.total, 5);
  assert.equal(withUnknown.unknownCount, 29);
  assert.equal(withUnknown.unknownHours, 361.8);
  assert.equal(withUnknown.note, '2010 — 2012 · 5 игр');

  // Only unknown entries → still a view, so the widget shows an empty state
  // («Годы релиза неизвестны — N игр») instead of disappearing.
  const unknownOnly = yearsView([{ year: null, key: 'unknown', unknown: true, count: 5, hours: 1 }]);
  assert.equal(unknownOnly.years.length, 0);
  assert.equal(unknownOnly.unknownCount, 5);
  assert.equal(unknownOnly.minYear, null);
  assert.equal(unknownOnly.note, '');

  assert.equal(yearsView([]), null);
  assert.equal(yearsView([{ year: 0, count: 4 }]), null, 'нулевой год — не год');
});

test('genre chart: horizontal bars by share of hours, count on demand', async () => {
  const { genreChartView, GENRE_CHART_LIMIT } = await view();
  const byHours = genreChartView(fixture('stats-m2-mock.json').genres);
  assert.equal(byHours.weight, 'hours');
  assert.equal(GENRE_CHART_LIMIT, 12);
  assert.deepEqual(byHours.rows.slice(0, 3).map((row) => row.name), ['Action', 'Shooter', 'RPG']);
  assert.equal(byHours.rows[0].countText, '96');
  assert.match(plain(byHours.rows[0].title), /96 игр · 1 200,0 ч/);
  // The payload's `share` (0.283) is the bar length and the printed share.
  assert.equal(byHours.rows[0].widthPercent, 28.3);
  assert.equal(plain(byHours.rows[0].primaryText), '1 200,0 ч');
  assert.equal(plain(byHours.rows[0].secondaryText), '96 игр · 28% часов');
  assert.equal(byHours.note, '8 жанров · по часам');
  assert.equal(byHours.hidden, 0);

  // Without `share` the fallback denominator is `totalHours` (the library).
  const derived = genreChartView([{ name: 'RPG', count: 2, hours: 68 }], { totalHours: 100 });
  assert.equal(derived.rows[0].widthPercent, 68);
  assert.equal(plain(derived.rows[0].secondaryText), '2 игры · 68% часов');

  const byCount = genreChartView(fixture('stats-m2-mock.json').genres, { weight: 'count' });
  assert.equal(byCount.weight, 'count');
  assert.deepEqual(byCount.rows.slice(0, 3).map((row) => row.name), ['Action', 'RPG', 'Indie']);
  assert.equal(byCount.rows[0].widthPercent, 22);
  assert.equal(plain(byCount.rows[0].primaryText), '96 игр');
  assert.equal(plain(byCount.rows[0].secondaryText), '1 200,0 ч · 22% отметок');
  assert.equal(byCount.note, '8 жанров · по числу игр');

  // More than 12 genres fold behind «Показать все (N)»; limit 0 is the expanded state.
  const many = Array.from({ length: 15 }, (_, index) => ({
    name: `G${index}`, count: 15 - index, hours: (15 - index) * 10,
  }));
  const folded = genreChartView(many);
  assert.equal(folded.rows.length, 12);
  assert.equal(folded.hidden, 3);
  assert.equal(folded.total, 15);
  const expanded = genreChartView(many, { limit: 0 });
  assert.equal(expanded.rows.length, 15);
  assert.equal(expanded.hidden, 0);

  // Hours missing → an honest «часы неизвестны» instead of a confident zero.
  const noHours = genreChartView([{ name: 'Action', count: 4 }]);
  assert.equal(noHours.rows[0].primaryText, '—');
  assert.match(noHours.rows[0].secondaryText, /часы неизвестны/);

  assert.equal(genreChartView([]), null);
});

test('enrichment progress: «детали N/M» and «кредиты N/M», hidden at 100%', async () => {
  const { metadataProgressView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  const progress = metadataProgressView(data.summary.metadata);

  assert.equal(progress.details.text, 'детали 312/340');
  assert.equal(progress.details.percentText, '92%');
  assert.equal(progress.details.visible, true);
  assert.equal(progress.credits.text, 'кредиты 187/340');
  assert.equal(progress.credits.percentText, '55%');
  assert.equal(progress.running, true);
  assert.equal(progress.note, 'обогащение идёт…');
  assert.match(progress.hint, /Steam Store/);

  // §8.3: a 100% badge is noise.
  assert.equal(metadataProgressView({ detailsResolved: 340, detailsTotal: 340 }), null);
  const complete = metadataProgressView({ detailsResolved: 340, detailsTotal: 340, creditsResolved: 340, creditsTotal: 340 });
  assert.equal(complete, null);
  assert.equal(metadataProgressView(null), null);
  assert.equal(metadataProgressView({}), null);
});

test('filters: requested ≠ applied is printed honestly', async () => {
  const { filtersView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  const applied = filtersView(data.filters);
  assert.equal(applied.includeFree.status, 'applied');
  assert.equal(applied.includeFree.text, 'бесплатные игры: включены (без фильтра)');
  assert.equal(applied.includeDlc.status, 'applied');
  assert.equal(applied.includeDlc.text, 'DLC: исключены (без фильтра)');
  assert.equal(applied.honest, false);
  assert.deepEqual(applied.state, { includeFree: true, includeDlc: false });

  const pending = filtersView({
    includeFree: { requested: false, applied: false, reason: 'details_not_imported' },
    includeDlc: { requested: false, applied: false, reason: 'dlc_not_in_library' },
  });
  assert.equal(pending.includeFree.status, 'pending');
  assert.match(pending.includeFree.text, /запрошено «исключить», но не применено — детали игр ещё не собраны/);
  assert.equal(pending.honest, true);
  assert.match(pending.note, /фильтр запрошен, но пока не применён/);

  // No `meta.filters` at all: the UI says so instead of pretending.
  const unknown = filtersView(null);
  assert.equal(unknown.includeFree.status, 'unknown');
  assert.match(unknown.note, /не передал состояние фильтров/);
});

/* =========================================================
   achievements calendar
   ========================================================= */

test('calendar: 17 days / 70 achievements, first year 2011', async () => {
  const { calendarView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  const calendar = calendarView(data.achievementDays, data.timeline);

  assert.equal(calendar.activeDays, 17);
  assert.equal(calendar.total, 70);
  assert.equal(calendar.first, '2011-02-19');
  assert.equal(calendar.last, '2026-10-04');
  assert.equal(calendar.fromYear, 2011);
  assert.equal(calendar.toYear, 2026);
  assert.equal(calendar.years.length, 13, 'уникальные годы с достижениями');
  assert.equal(calendar.months.length, 6);
  assert.equal(calendar.note, '17 дней · 70 достижений');
  assert.match(calendar.hint, /unlockTimestamp/);
  assert.match(calendar.hint, /не по игровому времени/);
  assert.equal(calendarView([]), null);
  assert.equal(calendarView([{ date: 'not-a-date', count: 3 }]), null);
});

test('streaks: server values, then a local fallback from the days', async () => {
  const { achievementStreaksView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  const streaks = achievementStreaksView(data.streaks, data.achievementDays);

  assert.equal(streaks.current, 0);
  assert.equal(streaks.best, 3);
  assert.equal(streaks.lastText, '4 окт. 2026');
  assert.equal(streaks.bestRangeText, '2 окт. 2026 — 4 окт. 2026');
  assert.match(streaks.metaText, /Рекорд: 3 \(2 окт\. 2026 — 4 окт\. 2026\)/);
  assert.match(streaks.metaText, /Последняя разблокировка: 4 окт\. 2026/);
  assert.match(streaks.hint, /дни подряд с хотя бы одним достижением/);

  const fallback = achievementStreaksView(null, data.achievementDays);
  assert.equal(fallback.best, 3);
  assert.equal(fallback.current, 3);
  assert.equal(fallback.lastUnlockDate, '2026-10-04');

  assert.equal(achievementStreaksView(null, []), null);
});

test('achievements calendar keeps streaks: the overview card is gone', async () => {
  const { achievementStreaksView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  // The achievements-overview widget was removed from the dashboard; the
  // calendar + streak card stay and keep their numbers.
  assert.equal(typeof data.summary.completion, 'object');
  assert.equal(achievementStreaksView(data.streaks, data.achievementDays).best, 3);
  assert.equal(achievementStreaksView(null, []), null);
});

/* =========================================================
   personnel (M3)
   ========================================================= */

test('personnel: studios normalized with QID, aliases, games and coverage', async () => {
  const { normalizePersonnel } = await view();
  const data = normalizePersonnel(fixture('personnel-studio-mock.json'), 'studio');

  assert.equal(data.role, 'studio');
  // `studio` is the pre-split key: it is shown as «Разработчики», publishers
  // having their own category now.
  assert.equal(data.roleKey, 'developer');
  assert.equal(data.roleLabel, 'Разработчики');
  assert.equal(data.hasItems, true);
  assert.equal(data.items.length, 3);
  const cdpr = data.items.find((item) => item.name === 'CD PROJEKT RED');
  assert.equal(cdpr.qid, 'Q1151645');
  assert.equal(cdpr.aliasesText, 'CD Projekt RED, CDPR');
  assert.equal(cdpr.rolesText, 'разработчик · издатель');
  assert.equal(cdpr.count, 3);
  assert.equal(cdpr.hours, 203.5);
  assert.deepEqual(cdpr.games.map((game) => game.name), [
    'The Witcher 3: Wild Hunt',
    'The Witcher: Enhanced Edition',
    'The Witcher 2: Assassins of Kings',
  ]);
  assert.equal(data.coverage.percent, 55);
  assert.equal(data.coverage.gamesWithCredits, 187);
});

test('role labels: studio/developer → «Разработчики», role list follows the payload', async () => {
  const {
    normalizePersonnel, normalizePersonnelRole, personnelRoleLabel,
    personnelRoleOptions, personnelRoleCountText, PERSONNEL_ROLES,
  } = await view();

  // The split key and the old alias resolve to one UI role.
  assert.equal(normalizePersonnelRole('developer'), 'developer');
  assert.equal(normalizePersonnelRole('studio'), 'developer');
  assert.equal(normalizePersonnelRole('STUDIO'), 'developer');
  assert.equal(normalizePersonnelRole('composer'), 'composer');
  assert.equal(normalizePersonnelRole('nonsense'), '');
  assert.equal(personnelRoleLabel('developer'), 'Разработчики');
  assert.equal(personnelRoleLabel('studio'), 'Разработчики');
  assert.equal(personnelRoleLabel('publisher'), 'Издатели');
  assert.equal(PERSONNEL_ROLES[0].key, 'developer', 'разработчики — первыми');

  // Payload with byRole: only roles that actually have games, developers first.
  const payload = {
    role: 'studio',
    items: [{ name: 'Valve' }],
    coverage: {
      gamesWithCredits: 10,
      gamesTotal: 20,
      percent: 50,
      gamesWithStudios: 18,
      byRole: { composer: 4, designer: 0, writer: 2, artist: 0, programmer: 0 },
    },
  };
  const options = personnelRoleOptions(payload);
  assert.deepEqual(options.map((option) => option.key), ['developer', 'publisher', 'composer', 'writer']);
  assert.equal(options[0].label, 'Разработчики');

  // No studios at all → publishers are not offered.
  const noStudios = personnelRoleOptions({
    role: 'composer', items: [], coverage: { gamesWithStudios: 0, byRole: { composer: 3 } },
  });
  assert.deepEqual(noStudios.map((option) => option.key), ['developer', 'composer']);

  // Old payload without byRole keeps the full list (never one option).
  assert.deepEqual(
    personnelRoleOptions({ items: [] }).map((option) => option.key),
    PERSONNEL_ROLES.map((role) => role.key),
  );

  // The selected role stays selectable even when its block is empty.
  const emptySelected = personnelRoleOptions({
    role: 'artist', items: [], coverage: { gamesWithStudios: 0, byRole: { composer: 2 } },
  });
  assert.deepEqual(emptySelected.map((option) => option.key), ['developer', 'artist', 'composer']);

  // Coverage.byRole survives normalization (it feeds the select).
  const normalized = normalizePersonnel(payload, 'studio');
  assert.equal(normalized.coverage.byRole.composer, 4);
  assert.equal(normalized.coverage.gamesWithStudios, 18);

  // Role-aware plural for the widget note (the weight toggle keeps its wording).
  assert.equal(personnelRoleCountText(399, 'developer'), '399 разработчиков');
  assert.equal(personnelRoleCountText(3, 'studio'), '3 разработчика');
  assert.equal(personnelRoleCountText(1, 'developer'), '1 разработчик');
  assert.equal(personnelRoleCountText(12, 'publisher'), '12 издателей');
});

test('personnel rows: weights hours/count and the games dropdown data', async () => {
  const { personnelRows } = await view();
  const payload = fixture('personnel-studio-mock.json');

  const byHours = personnelRows(payload, { weight: 'hours' });
  assert.deepEqual(byHours.map((row) => row.name), [
    'Valve', 'Blizzard Entertainment', 'CD PROJEKT RED',
  ]);
  assert.equal(plain(byHours[0].hoursText), '420,2 ч');
  assert.equal(byHours[0].countText, '12');
  assert.equal(byHours[0].widthPercent, 100);

  const byCount = personnelRows(payload, { weight: 'count' });
  assert.deepEqual(byCount.map((row) => row.name), [
    'Valve', 'Blizzard Entertainment', 'CD PROJEKT RED',
  ]);
  assert.equal(byCount[0].countText, '12');

  // Empty roles are a valid answer, not a crash.
  assert.deepEqual(personnelRows({ items: [] }), []);
});

test('personnel: composers from Wikidata with aliases', async () => {
  const { normalizePersonnel, personnelRows } = await view();
  const payload = {
    role: 'composer',
    items: [
      {
        id: 'wd:Q18223638',
        name: 'Marcin Przybyłowicz',
        aliases: ['Марчин Пшибылович'],
        qid: 'Q18223638',
        roles: ['composer'],
        count: 3,
        hours: 203.5,
        hoursShare: 0.0347,
        games: [{ appid: 292030, name: 'The Witcher 3: Wild Hunt', hours: 107 }],
        sources: ['wikidata', 'mobygames'],
      },
      {
        id: 'wd:Q11781148',
        name: 'Mikolai Stroinski',
        roles: ['composer'],
        count: 1,
        hours: 107,
        games: [{ appid: 292030, name: 'The Witcher 3: Wild Hunt', hours: 107 }],
        sources: ['wikidata'],
      },
    ],
    coverage: { gamesWithCredits: 187, gamesTotal: 340, percent: 55 },
  };
  const data = normalizePersonnel(payload, 'composer');
  assert.equal(data.roleLabel, 'Композиторы');
  const rows = personnelRows(data, { weight: 'hours' });
  assert.equal(rows[0].name, 'Marcin Przybyłowicz');
  assert.equal(rows[0].aliasesText, 'Марчин Пшибылович');
  assert.match(rows[0].hint, /также: Марчин Пшибылович/);
  assert.match(rows[0].hint, /источник: wikidata, mobygames/);
  assert.equal(plain(rows[0].hoursText), '203,5 ч');
  assert.equal(rows[1].name, 'Mikolai Stroinski');
});

test('studios strip from the stats payload (same weights)', async () => {
  const { studiosView, normalizeGamesPayload } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));
  const strip = studiosView(data.studios);
  assert.equal(strip.rows.length, 3);
  assert.equal(strip.rows[0].name, 'Valve');
  assert.equal(strip.note, '3 разработчика · по часам');
  assert.equal(strip.rows[0].rolesText, 'разработчик · издатель');

  const byCount = studiosView(data.studios, { weight: 'count', limit: 2 });
  assert.equal(byCount.rows.length, 2);
  assert.equal(byCount.note, '3 разработчика · по числу игр');
  assert.equal(studiosView([]), null);
});

test('coverage badge: visible below 100%, hidden at 100%', async () => {
  const { coverageBadge } = await view();
  assert.equal(coverageBadge(55).text, 'кредиты: 55%');
  assert.equal(coverageBadge(55).visible, true);
  assert.equal(coverageBadge(0.55).text, 'кредиты: 55%');
  assert.equal(coverageBadge(100).visible, false);
  assert.equal(coverageBadge(null), null);
});

/* =========================================================
   tolerance: an M1 server keeps a clean dashboard
   ========================================================= */

test('an M1 payload hides every M2/M3 widget instead of printing zeroes', async () => {
  const {
    normalizeGamesPayload, decadesView, yearsView, genreChartView,
    metadataProgressView, filtersView, calendarView, achievementStreaksView,
    studiosView, normalizePersonnel,
  } = await view();

  const data = normalizeGamesPayload({
    sources: { profile: { key: 'steam-1', userKey: '1', personaName: 'player' } },
    summary: { gameCount: 340, ownedCount: 340, playedCount: 216, unplayedCount: 124, totalHours: 5862.6 },
    genres: [],
    tags: [],
    decades: [],
    years: [],
    studios: [],
    timeline: [],
    achievementDays: [],
    streaks: null,
    meta: { filters: null, pending: ['genres', 'years', 'studios', 'personnelTop'] },
  });

  assert.equal(data.has.genres, false);
  assert.equal(data.has.decades, false);
  assert.equal(data.has.modes, false);
  assert.equal(data.has.metadata, false);
  assert.equal(data.has.calendar, false);
  assert.equal(data.has.streaks, false);
  assert.equal(decadesView(data.decades), null);
  assert.equal(yearsView(data.years), null);
  assert.equal(genreChartView(data.genres), null);
  assert.equal(metadataProgressView(data.summary.metadata), null);
  assert.equal(calendarView(data.achievementDays, data.timeline), null);
  assert.equal(achievementStreaksView(data.streaks, data.achievementDays), null);
  assert.equal(studiosView(data.studios), null);
  assert.equal(normalizePersonnel({ items: [] }).hasItems, false);
  // The filters block still renders its honest «сервер не сообщил».
  assert.equal(filtersView(data.filters).includeFree.status, 'unknown');
});

test('malformed M2/M3 input never throws', async () => {
  const {
    decadesView, yearsView, genreChartView, metadataProgressView,
    filtersView, calendarView, achievementStreaksView,
    personnelRows, studiosView, coverageBadge, normalizePersonnel,
  } = await view();

  for (const raw of [null, undefined, {}, [], 'nonsense', 42, { items: 'no' }]) {
    assert.doesNotThrow(() => decadesView(raw));
    assert.doesNotThrow(() => yearsView(raw));
    assert.doesNotThrow(() => genreChartView(raw));
    assert.doesNotThrow(() => metadataProgressView(raw));
    assert.doesNotThrow(() => filtersView(raw));
    assert.doesNotThrow(() => calendarView(raw));
    assert.doesNotThrow(() => achievementStreaksView(raw, raw));
    assert.doesNotThrow(() => personnelRows(raw));
    assert.doesNotThrow(() => studiosView(raw));
    assert.doesNotThrow(() => normalizePersonnel(raw));
    assert.equal(decadesView(raw), null);
    assert.equal(yearsView(raw), null);
    assert.equal(genreChartView(raw), null);
    assert.equal(metadataProgressView(raw), null);
    assert.equal(calendarView(raw), null);
    assert.equal(achievementStreaksView(raw, raw), null);
    assert.equal(studiosView(raw), null);
    assert.deepEqual(personnelRows(raw), []);
  }
  // A number is a valid percent (42 → «кредиты: 42%»); only a non-number is null.
  assert.equal(coverageBadge(null), null);
  assert.equal(coverageBadge('nonsense'), null);
  assert.equal(coverageBadge(42).text, 'кредиты: 42%');
});

test('alternate M2 spellings (minutes, array modes, kebab roles) are accepted', async () => {
  const { normalizeGamesPayload, decadesView } = await view();
  const data = normalizeGamesPayload({
    summary: {
      gameCount: 2,
      totalHours: 3,
      modes: [{ key: 'single-player', count: 2 }, { key: 'online_pvp', count: 1 }],
      earlyAccess: { count: 1 },
    },
    decades: [{ decade: 1970, count: 2, hours: 3 }],
  });
  assert.equal(data.summary.modes.single.count, 2);
  assert.equal(data.summary.modes.onlinePvp.count, 1);
  assert.equal(data.summary.earlyAccess.share, 0.5, 'доля выводится из числа игр, если её нет');
  assert.equal(decadesView(data.decades).rows[0].label, '1970-е');
});

/* =========================================================
   smoke: the on-disk mock payloads
   ========================================================= */

test('mock payloads render the same numbers end to end', async () => {
  const {
    normalizeGamesPayload, decadesView, yearsView, genreChartView,
    metadataProgressView, filtersView, calendarView, achievementStreaksView,
    normalizePersonnel, personnelRows, coverageBadge,
  } = await view();
  const data = normalizeGamesPayload(fixture('stats-m2-mock.json'));

  assert.equal(data.summary.gameCount, 340);
  assert.equal(data.summary.totalHours, 5862.6);
  assert.equal(decadesView(data.decades).total, 340);
  assert.equal(yearsView(data.years).note, '2004 — 2025 · 340 игр');
  assert.equal(genreChartView(data.genres).rows[0].name, 'Action');
  assert.equal(metadataProgressView(data.summary.metadata).details.text, 'детали 312/340');
  assert.equal(filtersView(data.filters).includeFree.status, 'applied');
  assert.equal(calendarView(data.achievementDays, data.timeline).total, 70);
  assert.equal(achievementStreaksView(data.streaks, data.achievementDays).best, 3);

  const personnel = normalizePersonnel(fixture('personnel-studio-mock.json'), 'studio');
  assert.equal(personnel.items.length, 3);
  assert.equal(personnelRows(personnel)[0].name, 'Valve');
  assert.equal(coverageBadge(personnel.coverage.percent).text, 'кредиты: 55%');
});
