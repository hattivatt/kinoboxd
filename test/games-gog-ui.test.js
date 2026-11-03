'use strict';

/**
 * Games UI (M6a): the «Источники» view model and the connect-card markup.
 * DOM-free: `games-view.js` is imported directly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublicCss } = require('./helpers/css');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function payload({ withGog = true } = {}) {
  return {
    sources: {
      connected: ['steam-76561198038369983'],
      selected: ['steam-76561198038369983'],
      profile: { key: 'steam-76561198038369983', personaName: 'player' },
      steam: { configured: true, status: 'ok', lastImportAt: '2026-11-01T10:00:00.000Z', gameCount: 340 },
      gog: withGog
        ? {
            configured: true,
            connected: true,
            status: 'ok',
            userKey: '1234567890',
            key: 'gog-1234567890',
            username: 'gog_tester',
            ownerProfile: 'steam-76561198038369983',
            libraryFetchedAt: '2026-11-01T12:00:00.000Z',
            productCount: 87,
            hours: 120.4,
          }
        : { configured: false, connected: false, status: 'not_connected' },
    },
    summary: {
      gameCount: 340,
      ownedCount: 340,
      totalHours: 5862.6,
      hoursBySource: withGog
        ? { steam: 5862.6, gog: 120.4, epic: null }
        : { steam: 5862.6, gog: null, epic: null },
      ownedBySource: withGog
        ? { steam: 340, gog: 87, epic: null }
        : { steam: 340, gog: null, epic: null },
      worksTotal: withGog ? 512 : 340,
      secondaryOnlyWorks: withGog ? 96 : 0,
    },
    secondaryWorks: withGog
      ? [
          {
            workKey: 'gog:1999999999',
            name: 'GOG Exclusive Indie',
            storeIds: { steam: null, gog: '1999999999', epic: null },
            hoursBySource: { steam: null, gog: 1.5, epic: null },
            gog: { gogGameId: '1999999999', slug: 'gog_exclusive_indie' },
          },
        ]
      : [],
  };
}

test('GOG UI', async (t) => {
  await t.test('markup: connect card + «Источники» widget + header button', () => {
    const html = readPublic('index.html');
    for (const id of [
      'games-connections',
      'games-gog-card',
      'games-gog-status',
      'games-gog-login',
      'games-gog-code',
      'games-gog-connect',
      'games-gog-import',
      'games-gog-logout',
      'games-gog-error',
      'games-sources-widget',
      'games-sources-body',
      'games-sources-secondary',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `index.html must carry #${id}`);
    }
    assert.match(html, /Войти через GOG/);
    assert.match(html, /embed\.gog\.com\/on_login_success/);
    const css = readPublicCss();
    assert.ok(css.includes('.games-source-row'));
    assert.ok(css.includes('.book-source-card[data-source="gog"]'));
  });

  await t.test('api.js exposes the GOG endpoints', () => {
    const api = readPublic('js/api.js');
    for (const fn of [
      'getGamesGogAuthUrl',
      'connectGamesGog',
      'getGamesGogStatus',
      'startGamesGogImport',
      'getGamesGogImportStatus',
      'logoutGamesGog',
    ]) {
      assert.match(api, new RegExp(`export function ${fn}\\b`), `api.js must export ${fn}`);
    }
    assert.match(api, /\/api\/games\/gog\/auth/);
    assert.match(api, /\/api\/games\/gog\/import/);
  });

  await t.test('normalizeGamesPayload keeps per-source numbers and secondary works', async () => {
    const { normalizeGamesPayload } = await import('../public/js/games-view.js');
    const normalized = normalizeGamesPayload(payload());
    assert.deepEqual(normalized.summary.hoursBySource, { steam: 5862.6, gog: 120.4, epic: null });
    assert.deepEqual(normalized.summary.ownedBySource, { steam: 340, gog: 87, epic: null });
    assert.equal(normalized.summary.worksTotal, 512);
    assert.equal(normalized.summary.secondaryOnlyWorks, 96);
    assert.equal(normalized.sources.gog.username, 'gog_tester');
    assert.equal(normalized.secondaryWorks.length, 1);
    assert.equal(normalized.secondaryWorks[0].hours, 1.5);
  });

  await t.test('sources view: Steam journal, GOG secondary, Epic «скоро» — never summed', async () => {
    const { gogSourcesView } = await import('../public/js/games-view.js');
    const view = gogSourcesView(payload());
    assert.deepEqual(view.rows.map((row) => row.key), ['steam', 'gog', 'epic']);
    const steam = view.rows[0];
    const gog = view.rows[1];
    const epic = view.rows[2];
    assert.equal(steam.games, 340);
    assert.equal(steam.hours, 5862.6);
    assert.equal(steam.journal, true);
    assert.equal(gog.games, 87);
    assert.equal(gog.hours, 120.4);
    assert.equal(gog.canConnect, false);
    assert.equal(gog.statusText, 'данные от 1 нояб. 2026');
    assert.equal(epic.status, 'not_connected');
    assert.equal(epic.games, null);
    assert.equal(epic.hours, null);
    assert.equal(view.secondaryOnly, 96);
    assert.equal(view.worksTotal, 512);
    // The view model never produces a combined 5983 h row.
    assert.equal(view.rows.some((row) => row.hours === 5983), false);
    assert.equal(view.rows.reduce((sum, row) => sum + (row.hours || 0), 0), 5983);
  });

  await t.test('a Steam-only profile offers the connect link instead of zeroes', async () => {
    const { gogSourcesView } = await import('../public/js/games-view.js');
    const view = gogSourcesView(payload({ withGog: false }));
    const gog = view.rows.find((row) => row.key === 'gog');
    assert.equal(gog.games, null);
    assert.equal(gog.hours, null);
    assert.equal(gog.status, 'not_connected');
    assert.equal(gog.canConnect, true);
    assert.equal(view.secondaryOnly, 0);
    assert.equal(view.gogConnected, false);
  });

  await t.test('a disconnected snapshot shows the date and asks to reconnect', async () => {
    const { gogSourcesView, gogStatusText } = await import('../public/js/games-view.js');
    const base = payload();
    base.sources.gog = {
      ...base.sources.gog,
      connected: false,
      configured: false,
      status: 'snapshot_only',
      productCount: 87,
      hours: 120.4,
    };
    const view = gogSourcesView(base);
    const gog = view.rows.find((row) => row.key === 'gog');
    assert.equal(gog.games, 87);
    assert.equal(gog.hours, 120.4);
    assert.equal(gog.canConnect, true);
    assert.match(gog.statusText, /снимок от/);
    assert.match(gogStatusText('auth_expired'), /переподключение/);
  });

  await t.test('malformed payload never throws', async () => {
    const { gogSourcesView } = await import('../public/js/games-view.js');
    for (const value of [null, undefined, {}, { summary: null }, { sources: { gog: null } }]) {
      const view = gogSourcesView(value);
      assert.equal(view.rows.length, 3);
      assert.equal(view.secondaryOnly, 0);
    }
  });
});
