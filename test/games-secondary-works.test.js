'use strict';

/**
 * M6c «Вне Steam» (frontend): a real list of secondary-only works.
 *
 * The list is DOM-free in `games-view.js`, so these tests pin the contract
 * without a browser:
 *   - `secondaryWorks[]` entries from GOG and Epic normalise into one shape
 *     (poster, year, genres, per-source hours) with no invented numbers;
 *   - the list sorts by its own hours, keeps unknown/zero hours visible and
 *     caps at 15 with a «Показать все (N)» counter;
 *   - the client-side card renders one hours row per source (never a sum) and
 *     needs no `/api/games/game/:appid` request;
 *   - chart inclusion is read tolerantly: an old payload hides the hint, a
 *     new payload can say «включая вне Steam: N».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

function gogWork(overrides = {}) {
  return {
    workKey: 'gog:1999999999',
    source: 'gog',
    name: 'GOG Exclusive Indie',
    sources: ['gog'],
    ownedOn: ['gog'],
    storeIds: { steam: null, gog: '1999999999', epic: null },
    hoursBySource: { steam: null, gog: 738, epic: null },
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
    hoursBySource: { steam: null, gog: null, epic: 90 },
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
  await t.test('markup: a full list widget with a poster row and a «show all» host', () => {
    const html = readPublic('index.html');
    for (const id of [
      'games-secondary-widget',
      'games-secondary-title',
      'games-secondary-note',
      'games-secondary-list',
      'games-secondary-more',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html must carry #${id}`);
    }
    assert.match(html, /Вне Steam/);
    assert.match(html, /работы только в GOG\/Epic/);

    const css = readPublic('style.css');
    for (const selector of [
      '.w-games-secondary',
      '.games-secondary-row',
      '.games-secondary-poster',
      '.games-secondary-hours',
      '.games-secondary-hour-row',
    ]) {
      assert.ok(css.includes(selector), `style.css must carry ${selector}`);
    }
    // Horizontal GOG/Epic art is centre-cropped into the same 2:3 frame.
    assert.match(
      css,
      /\.games-secondary-poster \{[^}]*object-fit:\s*cover/,
      'the poster must crop horizontal art into the vertical frame',
    );
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

  await t.test('secondaryWorksView: hours desc, unknown last, 15-row cap, show-all counter', async () => {
    const { secondaryWorksView } = await import('../public/js/games-view.js');
    const works = [
      gogWork({ name: 'Ten', hoursBySource: { gog: 600 } }),
      gogWork({ name: 'Zero', hoursBySource: { gog: 0 } }),
      gogWork({ name: 'Unknown', hoursBySource: { gog: null }, gog: { gogGameId: '9' } }),
      ...Array.from({ length: 17 }, (_, index) => gogWork({
        name: `Work ${index}`,
        hoursBySource: { gog: (index + 1) * 60 },
        gog: { gogGameId: `w${index}` },
      })),
    ];
    const view = secondaryWorksView(works, { limit: 15 });
    assert.equal(view.total, 20);
    assert.equal(view.visible.length, 15);
    assert.equal(view.hidden, 5);
    assert.equal(view.unknownHours, 1);
    assert.equal(view.unplayed, 1);
    assert.equal(view.visible[0].name, 'Work 16');
    // Unknown hours never sort above a real number, even a zero.
    assert.equal(view.rows[view.rows.length - 1].name, 'Unknown');
    assert.match(view.note, /20 работ вне Steam/);
    assert.match(view.note, /без часов: 1/);

    const expanded = secondaryWorksView(works, { limit: 0 });
    assert.equal(expanded.visible.length, 20);
    assert.equal(expanded.hidden, 0);
  });

  await t.test('secondaryWorkCardView: one hours row per source, no combined total', async () => {
    const { secondaryWorkCardView } = await import('../public/js/games-view.js');
    const card = secondaryWorkCardView(gogWork({
      name: 'GOG + Epic',
      sources: ['gog', 'epic'],
      hoursBySource: { steam: null, gog: 738, epic: 90 },
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
