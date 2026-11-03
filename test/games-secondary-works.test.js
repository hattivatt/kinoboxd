'use strict';

/**
 * Secondary-only works in the UI (U10): the union card, its poster and the
 * drilldown contract — no separate «Вне Steam» widget.
 *
 * Merged from `games-secondary-works.test.js`, `games-secondary-cover.test.js`
 * and `games-secondary-works-dom.test.js`; every assertion is kept. The DOM
 * shim is installed once and the modules are imported lazily inside each test,
 * so one process can drive `games-view.js` and `games.js` in turn.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublicCss } = require('./helpers/css');
const { installDom, textOf } = require('./helpers/dom-shim');

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });
const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

/* ---- was games-secondary-works.test.js ---- */
{const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

function gogWork(overrides = {}) {
  return {
    workKey: 'gog:1999999999',
    source: 'gog',
    name: 'GOG Exclusive Indie',
    sources: ['gog'],
    ownedOn: ['gog'],
    storeIds: { steam: null, gog: '1999999999', epic: null },
    hoursBySource: { steam: null, gog: 12.3, epic: null },
    gog: {
      gogGameId: '1999999999',
      slug: 'gog_exclusive_indie',
      title: 'GOG Exclusive Indie',
      image: '//images.gog.com/indie.jpg',
      releaseDate: '2020-01-01T00:00:00+0000',
    },
    genres: ['Indie', 'RPG'],
    ...overrides,
  };
}

function epicWork(overrides = {}) {
  return {
    workKey: null,
    source: 'epic',
    name: 'Epic Exclusive',
    sources: ['epic'],
    ownedOn: ['epic'],
    storeIds: { steam: null, gog: null, epic: 'epic-catalog-1' },
    hoursBySource: { steam: null, gog: null, epic: 1.5 },
    epic: {
      catalogItemId: 'epic-catalog-1',
      slug: 'epic-exclusive',
      releaseDate: '2018-06-01T00:00:00+0000',
    },
    ...overrides,
  };
}

function payload(works) {
  return {
    sources: {
      connected: ['steam-76561198038369983'],
      selected: ['steam-76561198038369983'],
      profile: { key: 'steam-76561198038369983', personaName: 'player' },
      gog: { configured: true, connected: true, status: 'ok', productCount: 10 },
      epic: { configured: true, connected: true, status: 'ok', productCount: 5 },
    },
    summary: {
      gameCount: 340,
      ownedCount: 340,
      totalHours: 5852.7,
      worksTotal: 360,
      secondaryOnlyWorks: works.length,
      secondaryWorksTotal: works.length,
      hoursBySource: { steam: 5852.7, gog: 120.4, epic: 45 },
      ownedBySource: { steam: 340, gog: 10, epic: 5 },
    },
    secondaryWorks: works,
  };
}

test('M6c «Вне Steam» view models', async (t) => {
  await t.test('no separate «Вне Steam» widget: works live in the charts and drilldowns', () => {
    const html = readPublic('index.html');
    for (const id of [
      'games-secondary-widget',
      'games-secondary-note',
      'games-secondary-list',
      'games-secondary-more',
    ]) {
      assert.equal(html.includes(`id="${id}"`), false, `index.html must not carry #${id}`);
    }
    const gamesJs = readPublic('js/games.js');
    assert.equal(gamesJs.includes('games-secondary-widget'), false);
    assert.equal(gamesJs.includes('secondaryWorksView'), false);

    // The union card (modal) survives: its per-source hours grid stays styled.
    const css = readPublicCss();
    assert.ok(css.includes('.games-secondary-hours'), 'the union card hours grid must stay');
    assert.ok(css.includes('.games-secondary-hour-row'));
    assert.equal(css.includes('.w-games-secondary'), false);
  });

  await t.test('normalizeGamesPayload: GOG/Epic entries keep art, year and per-source hours', async () => {
    const { normalizeGamesPayload } = await import('../public/js/games-view.js');
    const normalized = normalizeGamesPayload(payload([
      gogWork(),
      epicWork(),
    ]));
    const [gog, epic] = normalized.secondaryWorks;

    assert.equal(gog.name, 'GOG Exclusive Indie');
    assert.deepEqual(gog.sources, ['gog']);
    assert.deepEqual(gog.sourceChips, [{ source: 'gog', label: 'GOG' }]);
    assert.equal(gog.hoursBySource.gog, 12.3);
    assert.equal(gog.hours, 12.3);
    assert.equal(gog.hoursText, '12,3 ч');
    assert.equal(gog.releaseYear, 2020);
    assert.deepEqual(gog.genres, ['Indie', 'RPG']);
    // Protocol-relative GOG URLs become https; the raw block stays available.
    assert.equal(gog.image, 'https://images.gog.com/indie.jpg');
    assert.equal(gog.coverUrl, 'https://images.gog.com/indie.jpg');
    assert.equal(gog.storeLinks[0].href, 'https://www.gog.com/game/gog_exclusive_indie');

    assert.equal(epic.name, 'Epic Exclusive');
    assert.deepEqual(epic.sources, ['epic']);
    assert.equal(epic.hoursBySource.epic, 1.5);
    assert.equal(epic.releaseYear, 2018);
    assert.equal(epic.storeLinks[0].href, 'https://store.epicgames.com/p/epic-exclusive');
  });

  await t.test('M6d: the store poster `verticalCover` wins over older spellings and the banner', async () => {
    const { normalizeGamesPayload, secondaryWorkCardView } = await import('../public/js/games-view.js');
    const gogPoster = 'https://images-1.gog-statics.com/box_171x241.jpg';
    const epicPoster = 'https://cdn2.unrealengine.com/egs-witcher/1200x1600.jpg';
    const normalized = normalizeGamesPayload(payload([
      gogWork({ verticalCover: gogPoster }),
      // Both spellings present: the M6d `verticalCover` must win.
      epicWork({ verticalCover: epicPoster, verticalCoverUrl: 'https://img/old-epic.jpg' }),
    ]));
    const [gog, epic] = normalized.secondaryWorks;

    assert.equal(gog.verticalCover, gogPoster);
    assert.equal(gog.coverUrl, gogPoster);
    assert.equal(gog.image, gogPoster);
    assert.equal(epic.verticalCover, epicPoster);
    assert.equal(epic.coverUrl, epicPoster);

    // The union card (chart drilldown → modal) paints the same poster.
    const card = secondaryWorkCardView(gog);
    assert.equal(card.coverUrl, gogPoster);
    assert.equal(card.verticalCover, gogPoster);

    // No store poster: the horizontal library art is the fallback (CSS
    // centre-crops it into the 2:3 frame), and nothing is invented.
    const fallback = normalizeGamesPayload(payload([gogWork()])).secondaryWorks[0];
    assert.equal(fallback.verticalCover, null);
    assert.equal(fallback.coverUrl, 'https://images.gog.com/indie.jpg');

    const noArt = normalizeGamesPayload(payload([
      gogWork({ gog: { gogGameId: '7', slug: 'no-art' } }),
    ])).secondaryWorks[0];
    assert.equal(noArt.verticalCover, null);
    assert.equal(noArt.coverUrl, null);
    assert.equal(noArt.image, null);
  });

  await t.test('normalizeGamesPayload: missing/unknown playtime is not a confident zero', async () => {
    const { normalizeGamesPayload } = await import('../public/js/games-view.js');
    const normalized = normalizeGamesPayload(payload([
      gogWork({
        name: 'Unresolved playtime',
        hoursBySource: { steam: null, gog: 0, epic: null },
        gog: { gogGameId: '1', playtimeKnown: false },
      }),
      gogWork({
        name: 'Never launched',
        hoursBySource: { steam: null, gog: 0, epic: null },
        gog: { gogGameId: '2' },
      }),
      gogWork({
        name: 'No hours field',
        hoursBySource: { steam: null, gog: null, epic: null },
        gog: { gogGameId: '3' },
      }),
    ]));
    const byName = Object.fromEntries(normalized.secondaryWorks.map((work) => [work.name, work]));
    assert.equal(byName['Unresolved playtime'].hoursUnknown, true);
    assert.equal(byName['Unresolved playtime'].hoursKnown, false);
    assert.equal(byName['Never launched'].hoursKnown, true);
    assert.equal(byName['Never launched'].notPlayed, true);
    assert.equal(byName['No hours field'].hoursUnknown, true);

    // The source block tells 0 h apart: a missing playtime snapshot means
    // «часы не получены», a fetched snapshot means «не запущена».
    const unresolved = payload([gogWork({
      name: 'Snapshot missing',
      hoursBySource: { steam: null, gog: 0, epic: null },
    })]);
    unresolved.sources.gog.playtimeFetchedAt = null;
    const unresolvedWork = normalizeGamesPayload(unresolved).secondaryWorks[0];
    assert.equal(unresolvedWork.hoursUnknown, true);
    assert.equal(unresolvedWork.notPlayed, false);

    const resolved = payload([gogWork({
      name: 'Snapshot fetched',
      hoursBySource: { steam: null, gog: 0, epic: null },
    })]);
    resolved.sources.gog.playtimeFetchedAt = '2026-11-01T12:00:00.000Z';
    const resolvedWork = normalizeGamesPayload(resolved).secondaryWorks[0];
    assert.equal(resolvedWork.hoursKnown, true);
    assert.equal(resolvedWork.notPlayed, true);
  });

  await t.test('gamesIndex secondary-only rows join the genre/year drilldowns', async () => {
    const {
      gameRowsFromIndex, gamesByGenre, gamesInYear, yearCountSeries,
    } = await import('../public/js/games-view.js');
    const index = {
      42: {
        appid: 42,
        name: 'Steam RPG',
        type: 'game',
        releaseYear: 2020,
        genres: ['RPG'],
        hours: 10,
        canonicalWorkKey: 'steam:42',
      },
      'gog:7': {
        appid: null,
        workKey: 'gog:7',
        secondaryOnly: true,
        source: 'gog',
        name: 'GOG RPG',
        type: 'game',
        releaseYear: 2020,
        genres: ['RPG'],
        hours: 4,
        canonicalWorkKey: 'gog:7',
        sources: ['gog'],
        storeIds: { steam: null, gog: '7', epic: null },
        hoursBySource: { steam: null, gog: 4, epic: null },
      },
    };
    const rows = gameRowsFromIndex(index);
    assert.deepEqual(rows.map((row) => row.name).sort(), ['GOG RPG', 'Steam RPG']);
    const secondary = rows.find((row) => row.name === 'GOG RPG');
    assert.equal(secondary.appid, null);
    assert.equal(secondary.secondaryOnly, true);
    assert.equal(secondary.workKey, 'gog:7');
    // The list behind a chart bar counts the same rows as the bar.
    assert.deepEqual(
      gamesByGenre(index, 'RPG').map((row) => row.name).sort(),
      ['GOG RPG', 'Steam RPG'],
    );
    assert.deepEqual(
      gamesInYear(index, 2020).map((row) => row.name).sort(),
      ['GOG RPG', 'Steam RPG'],
    );
    assert.equal(yearCountSeries(index).series[0].count, 2);
  });

  await t.test('secondaryWorkCardView: one hours row per source, no combined total', async () => {
    const { secondaryWorkCardView } = await import('../public/js/games-view.js');
    const card = secondaryWorkCardView(gogWork({
      name: 'GOG + Epic',
      sources: ['gog', 'epic'],
      hoursBySource: { steam: null, gog: 12.3, epic: 1.5 },
      epic: { catalogItemId: 'epic-1', slug: 'gog-epic' },
      releaseYear: 2015,
    }));
    assert.equal(card.name, 'GOG + Epic');
    assert.deepEqual(card.sourceLabels, ['GOG', 'Epic']);
    assert.equal(card.releaseYear, 2015);
    assert.deepEqual(card.hourRows.map((row) => row.source), ['steam', 'gog', 'epic']);
    assert.equal(card.hourRows[0].present, false);
    assert.equal(card.hourRows[0].status, 'нет в библиотеке');
    assert.equal(card.hourRows[1].hoursText, '12,3 ч');
    assert.equal(card.hourRows[2].hoursText, '1,5 ч');
    // No row is a sum: 12.3 + 1.5 = 13.8 is never printed.
    assert.equal(JSON.stringify(card.hourRows).includes('13,8'), false);
    assert.deepEqual(card.genres, ['Indie', 'RPG']);
    assert.equal(card.storeLinks.length, 2);
  });

  await t.test('secondaryWorkCardView: empty top-level genres/year fall back to the epic block', async () => {
    const { secondaryWorkCardView } = await import('../public/js/games-view.js');
    const card = secondaryWorkCardView(epicWork({
      genres: [],
      releaseYear: null,
      epic: {
        catalogItemId: 'epic-catalog-1',
        slug: 'epic-exclusive',
        releaseDate: '2023-10-27T00:00:00.000Z',
        genres: ['Action', 'Horror'],
      },
    }));
    // An older payload may leave the union fields empty and carry the store
    // metadata only on the source block — the card must still show it.
    assert.deepEqual(card.genres, ['Action', 'Horror']);
    assert.equal(card.releaseYear, 2023);
    assert.equal(card.releaseDate, '2023-10-27T00:00:00.000Z');
  });

  await t.test('secondaryChartStatus: old payload hides, new payload reports inclusion', async () => {
    const { secondaryChartStatus } = await import('../public/js/games-view.js');
    assert.deepEqual(secondaryChartStatus({ summary: { secondaryOnlyWorks: 7 } }), {
      included: false, count: null, text: '',
    });
    const summaryFlag = secondaryChartStatus({
      summary: { chartsIncludeSecondary: true, secondaryWorksInCharts: 7 },
    });
    assert.equal(summaryFlag.included, true);
    assert.equal(summaryFlag.count, 7);
    assert.match(summaryFlag.text, /включая вне Steam: 7/);
    const bucketFlag = secondaryChartStatus({
      genres: [{ name: 'RPG', count: 12, secondaryCount: 2 }],
    });
    assert.equal(bucketFlag.included, true);
    assert.equal(bucketFlag.count, null);
    assert.match(bucketFlag.text, /включая работы вне Steam/);
    // A real zero is not evidence of inclusion.
    assert.equal(secondaryChartStatus({ genres: [{ name: 'RPG', secondaryCount: 0 }] }).included, false);
    assert.equal(secondaryChartStatus({
      summary: { chartsIncludeSecondary: true, secondaryWorksInCharts: 0 },
    }).included, false);
  });

  await t.test('sources view: union total falls back to Steam + secondary-only', async () => {
    const { gogSourcesView } = await import('../public/js/games-view.js');
    const base = payload([gogWork(), epicWork()]);
    delete base.summary.worksTotal;
    const view = gogSourcesView(base);
    assert.equal(view.secondaryOnly, 2);
    assert.equal(view.worksTotal, 342);
    assert.match(view.unionText, /342 работы в объединённой библиотеке/);
    assert.match(view.unionText, /включая вне Steam: 2/);
    assert.deepEqual(view.secondaryHours.map((row) => row.source), ['gog', 'epic']);
  });

  await t.test('charts stay tolerant: aggregate counts are used as sent, no crash without secondary data', async () => {
    const { normalizeGamesPayload, decadesView, yearsView, genreChartView } = await import('../public/js/games-view.js');
    const withSecondary = normalizeGamesPayload({
      summary: { gameCount: 340, secondaryOnlyWorks: 7, chartsIncludeSecondary: true, secondaryWorksInCharts: 7 },
      genres: [{ name: 'RPG', count: 40, hours: 100, secondaryCount: 3 }],
      decades: [{ decade: 2010, count: 80, hours: 200 }, { decade: 2020, count: 20, hours: 50 }],
      years: [{ year: 2015, count: 30, hours: 70 }, { year: 2020, count: 20, hours: 50 }],
    });
    assert.equal(withSecondary.secondaryChart.included, true);
    assert.equal(withSecondary.secondaryChart.count, 7);
    assert.equal(decadesView(withSecondary.decades).total, 100);
    assert.equal(yearsView(withSecondary.years).total, 50);
    assert.equal(genreChartView(withSecondary.genres).rows[0].count, 40);

    const steamOnly = normalizeGamesPayload({
      summary: { gameCount: 340 },
      genres: [{ name: 'RPG', count: 40, hours: 100 }],
      decades: [{ decade: 2010, count: 80, hours: 200 }],
      years: [{ year: 2015, count: 30, hours: 70 }],
    });
    assert.equal(steamOnly.secondaryChart.included, false);
    assert.equal(decadesView(steamOnly.decades).total, 80);
    assert.equal(yearsView(steamOnly.years).total, 30);
    assert.equal(genreChartView(steamOnly.genres).rows[0].count, 40);
  });
});

}

/* ---- was games-secondary-cover.test.js ---- */
{
const GOG_POSTER = 'https://images-1.gog-statics.com/box_171x241.jpg';
const GOG_BANNER = 'https://images.gog.com/indie-banner.jpg';

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function images(host) {
  const found = [];
  walk(host, (node) => {
    if (node.tagName === 'IMG') found.push(node.getAttribute('src') || '');
  });
  return found;
}

function findByClass(host, className) {
  let hit = null;
  walk(host, (node) => {
    if (!hit && String(node.className || '').split(/\s+/).includes(className)) hit = node;
  });
  return hit;
}

/** One `secondaryWorks[]` entry as `/stats` sends it (M6d shape). */
function secondaryWork(overrides = {}) {
  return {
    workKey: 'gog:1999999999',
    name: 'GOG Exclusive Indie',
    source: 'gog',
    sources: ['gog'],
    ownedOn: ['gog'],
    storeIds: { steam: null, gog: '1999999999', epic: null },
    hoursBySource: { steam: null, gog: 12.3, epic: null },
    hours: 12.3,
    secondaryHours: 12.3,
    displayHours: 12.3,
    releaseYear: 2007,
    genres: ['Indie'],
    gog: {
      gogGameId: '1999999999',
      slug: 'gog_exclusive_indie',
      title: 'GOG Exclusive Indie',
      image: GOG_BANNER,
    },
    epic: null,
    ...overrides,
  };
}

function payload(work) {
  return {
    sources: {
      profile: { key: 'steam-76561198038369983', personaName: 'player' },
      gog: { configured: true, connected: true, status: 'ok', productCount: 4 },
      epic: null,
    },
    summary: { gameCount: 340, ownedCount: 340, totalHours: 5852.7 },
    // The light drilldown row: no poster on purpose (the card needs the full
    // `secondaryWorks` entry, exactly like the real payload).
    gamesIndex: {
      'gog:1999999999': {
        appid: null,
        workKey: 'gog:1999999999',
        secondaryOnly: true,
        source: 'gog',
        name: 'GOG Exclusive Indie',
        hours: 12.3,
        hours2w: 0,
        rtime: 0,
        lastPlayed: null,
        iconUrl: null,
        canonicalWorkKey: 'gog:1999999999',
        primaryAppid: null,
        isPrimary: true,
        editionCount: 1,
        canonicalHours: 12.3,
        sources: ['gog'],
        storeIds: { steam: null, gog: '1999999999', epic: null },
        hoursBySource: { steam: null, gog: 12.3, epic: null },
        type: 'game',
        year: 2007,
        releaseYear: 2007,
        genres: ['Indie'],
        developers: [],
        publishers: [],
        categories: [],
      },
    },
    secondaryWorks: [work],
  };
}

function resetModals() {
  const root = nodeFor('modal-root');
  root.replaceChildren();
  return root;
}

async function openCardFromYearList() {
  const { normalizeGamesPayload, gamesInYear } = await import('../public/js/games-view.js');
  const { configureGamesModals, openGameListModal } = await import('../public/js/games-modal.js');
  const data = normalizeGamesPayload(payload(secondaryWork({ verticalCover: GOG_POSTER })));
  configureGamesModals({
    profile: 'steam-76561198038369983',
    gamesIndex: data.gamesIndex,
    secondaryWorks: data.secondaryWorks,
  });
  const root = resetModals();
  const rows = gamesInYear(data.gamesIndex, 2007);
  assert.equal(rows.length, 1, 'drilldown must carry the secondary-only row');
  openGameListModal({ title: '2007 — 1 игра', games: rows });
  const row = findByClass(root, 'film-row');
  assert.ok(row, 'list row did not render');
  assert.match(textOf(row), /GOG Exclusive Indie/);
  row.click();
  return root;
}

test('union card: a secondary work paints its `verticalCover` store poster', async () => {
  const root = await openCardFromYearList();
  const srcs = images(root);
  assert.ok(srcs.length >= 1, 'карточка без обложки');
  assert.equal(srcs[0], GOG_POSTER);
  assert.equal(srcs.includes(GOG_BANNER), false, 'горизонтальный баннер не должен подменять постер');
  assert.match(textOf(root).replace(/\s+/g, ' '), /GOG Exclusive Indie/);
});

test('union card: no `verticalCover` falls back to the horizontal image, then initials', async () => {
  const { normalizeGamesPayload, secondaryWorkCardView } = await import('../public/js/games-view.js');
  const { openSecondaryWorkCardModal } = await import('../public/js/games-modal.js');

  const bannerOnly = normalizeGamesPayload(payload(secondaryWork())).secondaryWorks[0];
  assert.equal(bannerOnly.verticalCover, null);
  assert.equal(secondaryWorkCardView(bannerOnly).coverUrl, GOG_BANNER);
  let root = resetModals();
  openSecondaryWorkCardModal(bannerOnly);
  assert.deepEqual(images(root), [GOG_BANNER]);

  const noArt = normalizeGamesPayload(payload(secondaryWork({
    gog: { gogGameId: '1999999999', slug: 'gog_exclusive_indie', title: 'GOG Exclusive Indie' },
  }))).secondaryWorks[0];
  assert.equal(noArt.verticalCover, null);
  assert.equal(noArt.coverUrl, null);
  root = resetModals();
  openSecondaryWorkCardModal(noArt);
  assert.deepEqual(images(root), []);
  // The initials block still names the work: no invented URL.
  assert.equal(textOf(findByClass(root, 'modal-game-cover')).trim(), 'G');
});

}

/* ---- was games-secondary-works-dom.test.js ---- */
{
function work(index) {
  const epic = index % 3 === 0;
  const both = index === 1;
  const sources = both ? ['gog', 'epic'] : epic ? ['epic'] : ['gog'];
  const hoursBySource = both
    ? { steam: null, gog: 12.3, epic: 1.5 }
    : epic
      ? { steam: null, gog: null, epic: index + 1 }
      : { steam: null, gog: index + 1, epic: null };
  return {
    workKey: both ? 'gog:1' : epic ? null : `gog:${index}`,
    source: epic ? 'epic' : 'gog',
    name: index === 0 ? 'GOG Zero Hours' : index === 2 ? 'GOG Unknown Hours' : `Work ${index}`,
    sources,
    ownedOn: sources,
    storeIds: {
      steam: null,
      gog: epic ? null : String(index),
      epic: epic ? `epic-${index}` : null,
    },
    hoursBySource: index === 0
      ? { steam: null, gog: 0, epic: null }
      : index === 2
        ? { steam: null, gog: null, epic: null }
        : hoursBySource,
    gog: epic ? null : {
      gogGameId: String(index),
      slug: `work-${index}`,
      title: `Work ${index}`,
      image: '//images.gog.com/work.jpg',
      releaseDate: '2015-05-18T00:00:00+0000',
    },
    epic: epic ? {
      catalogItemId: `epic-${index}`,
      slug: `work-${index}`,
      releaseDate: '2018-06-01T00:00:00+0000',
    } : {},
    genres: index === 1 ? ['RPG', 'Action'] : [],
  };
}

const WORKS = Array.from({ length: 20 }, (_, index) => work(index));

// The server puts secondary-only works into `gamesIndex` under their own
// `workKey` (`appid: null`); the drilldown list must count them exactly like
// the chart bucket does.
const SECONDARY_INDEX_ROW = {
  appid: null,
  workKey: 'gog:1',
  secondaryOnly: true,
  source: 'gog',
  name: 'Work 1',
  hours: 13.8,
  hours2w: 0,
  rtime: 0,
  lastPlayed: null,
  iconUrl: null,
  canonicalWorkKey: 'gog:1',
  primaryAppid: null,
  isPrimary: true,
  editionCount: 1,
  canonicalHours: 13.8,
  sources: ['gog', 'epic'],
  storeIds: { steam: null, gog: '1', epic: 'epic-1' },
  hoursBySource: { steam: null, gog: 12.3, epic: 1.5 },
  hoursUnknown: false,
  hoursStatus: { gog: 'ok', epic: 'ok' },
  type: 'game',
  year: 2015,
  releaseYear: 2015,
  genres: ['RPG', 'Action'],
  developers: [],
  publishers: [],
  categories: [],
  tags: [],
  metadataSources: [],
};

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: { key: KEY, source: 'steam', personaName: 'player', gameCount: 340 },
    steam: { configured: true, status: 'ok', gameCount: 340 },
    gog: { configured: true, connected: true, status: 'ok', productCount: 10 },
    epic: { configured: true, connected: true, status: 'ok', productCount: 5 },
  },
  summary: {
    gameCount: 340,
    ownedCount: 340,
    totalHours: 5852.7,
    worksTotal: 360,
    secondaryOnlyWorks: 20,
    secondaryWorksTotal: 20,
    hoursBySource: { steam: 5852.7, gog: 120.4, epic: 45 },
    ownedBySource: { steam: 340, gog: 10, epic: 5 },
    // M6c backend contract: charts counted secondary-only works.
    chartsIncludeSecondary: true,
    secondaryWorksInCharts: 20,
  },
  genres: [{ name: 'RPG', count: 40, hours: 100, secondaryCount: 2 }],
  decades: [{ decade: 2010, count: 80, hours: 200 }],
  years: [{ year: 2015, count: 30, hours: 70 }],
  secondaryWorks: WORKS,
  topGames: [],
  recentlyPlayed: [],
  gamesIndex: { 'gog:1': SECONDARY_INDEX_ROW },
  timeline: [],
  achievementDays: [],
  streaks: [],
  tags: [],
  scores: [],
  franchises: [],
};

const fetched = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  fetched.push(target);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = {
      profiles: [{ source: 'steam', userKey: '76561198038369983', key: KEY, personaName: 'player', gameCount: 340 }],
      steamKey: { configured: true, source: 'file' },
    };
  } else if (target.startsWith('/api/games/stats')) {
    body = payload;
  } else if (target.startsWith('/api/games/gog/status')) {
    body = { configured: true, connected: true, status: 'ok', productCount: 10 };
  } else if (target.startsWith('/api/games/epic/status')) {
    body = { configured: true, connected: true, status: 'ok', productCount: 5 };
  } else if (target.startsWith('/api/games/enrich')) {
    body = { running: false };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
};

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function lastModal() {
  const root = nodeFor('modal-root');
  if (!root || !root.children.length) return null;
  return root.children[root.children.length - 1];
}

function lastModalText() {
  const modal = lastModal();
  return modal ? norm(textOf(modal)) : '';
}

function findByClass(root, className) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const classes = String(node.className || '').split(/\s+/);
    if (classes.includes(className)) out.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

function findSlices(hostId) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const key = node.attributes && node.attributes['data-key'];
    if (key) out.push({ key, node });
    for (const child of node.children || []) walk(child);
  };
  walk(nodeFor(hostId));
  return out;
}

test('secondary works live in the charts and open the union card from a drilldown', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(60);

  // There is no standalone «Вне Steam» widget any more.
  assert.equal(payload.gamesIndex['gog:1'].secondaryOnly, true);
  assert.equal(
    (nodeFor('games-secondary-widget').children || []).length,
    0,
    'the removed widget must never be painted',
  );

  // Sources widget: union headline + per-source hour totals + chart status.
  assert.equal(nodeFor('games-sources-widget').hidden, false);
  assert.match(norm(textOf(nodeFor('games-sources-note'))), /360 работ в объединённой библиотеке \(включая вне Steam: 20\)/);
  const secondary = norm(textOf(nodeFor('games-sources-secondary')));
  assert.match(secondary, /Часы вне Steam: GOG 120,4 ч · Epic 45,0 ч/);
  assert.match(secondary, /Графики жанров, годов и десятилетий включают работы вне Steam: 20/);

  // Each secondary source row prints its own hours next to the game count.
  const sourceRows = nodeFor('games-sources-body').children;
  assert.match(norm(textOf(sourceRows[1])), /10 игр · 120,4 ч/);
  assert.match(norm(textOf(sourceRows[2])), /5 игр · 45,0 ч/);

  // Chart notes are tolerant and report the inclusion status.
  assert.match(norm(textOf(nodeFor('games-decades-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-years-note'))), /включая вне Steam: 20/);
  assert.match(norm(textOf(nodeFor('games-genres-note'))), /включая вне Steam: 20/);

  // Genre drilldown: the RPG bar counts the secondary-only work, and its list
  // contains the same row (no second widget, no separate screen).
  const rpgRow = nodeFor('games-genres-chart').children
    .find((row) => norm(textOf(row)).includes('RPG'));
  assert.ok(rpgRow, 'the RPG genre row must be painted');
  rpgRow.click();
  await wait(20);
  assert.match(lastModalText(), /RPG/);
  assert.match(lastModalText(), /Work 1/);

  const listRow = findByClass(lastModal(), 'film-row')
    .find((row) => norm(textOf(row)).includes('Work 1'));
  assert.ok(listRow, 'the secondary-only work must be a row in the genre modal');
  // Per-source hours in the row: a GOG+Epic work never prints 13,8 ч.
  assert.match(norm(textOf(listRow)), /GOG 12,3 ч · Epic 1,5 ч/);
  assert.equal(norm(textOf(listRow)).includes('13,8'), false);

  // The row opens the client-side union card: no appid, no details request.
  const before = fetched.filter((url) => url.includes('/api/games/game/')).length;
  listRow.click();
  await wait(20);
  const modal = lastModalText();
  assert.match(modal, /Работа вне Steam/);
  assert.match(modal, /Work 1/);
  assert.match(modal, /Часы по источникам/);
  assert.match(modal, /Steam/);
  assert.match(modal, /GOG/);
  assert.match(modal, /Epic/);
  assert.match(modal, /12,3 ч/);
  assert.match(modal, /1,5 ч/);
  assert.match(modal, /год релиза 2015/);
  assert.match(modal, /RPG/);
  const after = fetched.filter((url) => url.includes('/api/games/game/')).length;
  assert.equal(after, before, 'a secondary card must never call /api/games/game/:appid');

  // Year drilldown counts the same secondary-only work (release year 2015).
  nodeFor('modal-root').children = [];
  const yearSlice = findSlices('games-years-donut')
    .find((slice) => slice.key === 'year-2015');
  assert.ok(yearSlice, 'the 2015 year slice must be painted');
  yearSlice.node.click();
  await wait(20);
  assert.match(lastModalText(), /Work 1/);
});

}
