'use strict';

/**
 * Games «Источники» layout (regression: the widget fell back to an implicit
 * `span 1` of the 12-col dashboard grid, so the whole card was squeezed into a
 * ~60 px content column and «340 игр · 5 852,7 ч» broke into a vertical token
 * stack).
 *
 * Two layers:
 *   1. CSS/markup contract — the widget spans the full row, every source row is
 *      a three-column [label | meta | action] grid, numbers are `nowrap`, the
 *      connect link is right-aligned, and the «не суммируются» note is a quiet
 *      caption on the widget (chart-foot), not inside a source panel.
 *   2. Headless DOM smoke — the real `games.js` paints three horizontal rows
 *      with exactly three cells each (no per-token spans), and the connect
 *      button lives in the action cell.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublicCss } = require('./helpers/css');
const { installDom, textOf } = require('./helpers/dom-shim');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

/** CSS text of one rule block, by selector (first match at/after `from`). */
function ruleBlock(css, selector, from = 0) {
  const index = css.indexOf(selector, from);
  assert.ok(index >= 0, `style.css must carry ${selector}`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const { nodeFor, storage } = installDom({ search: '?tab=games', href: 'http://localhost/?tab=games' });

const KEY = 'steam-76561198038369983';
storage.set('kinoboxd.games.profile.v1', KEY);

const payload = {
  sources: {
    connected: [KEY],
    selected: [KEY],
    profile: {
      key: KEY,
      source: 'steam',
      userKey: '76561198038369983',
      personaName: 'hattivatt',
      gameCount: 340,
      libraryPartial: false,
    },
    steamKeyConfigured: true,
    // Steam-only profile: both secondary libraries offer the «Подключить» link
    // instead of fake zeroes.
    gog: { configured: false, connected: false, status: 'not_connected' },
    epic: { configured: false, connected: false, status: 'not_connected' },
  },
  summary: {
    gameCount: 340,
    ownedCount: 340,
    playedCount: 120,
    unplayedCount: 220,
    totalHours: 5852.7,
    meanHours: 17.24,
    medianHours: 4.1,
    worksTotal: 340,
    secondaryWorksTotal: 0,
    libraryPartial: false,
    steamKeyConfigured: true,
    hoursBySource: { steam: 5852.7, gog: null, epic: null },
    ownedBySource: { steam: 340, gog: null, epic: null },
  },
  hoursHistogram: [],
  topGames: [],
  recentlyPlayed: [],
  backlog: { count: 0, share: 0, items: [] },
  genres: [],
  tags: [],
  scores: [],
  franchises: [],
  decades: [],
  years: [],
  modes: [],
  access: {},
  timeline: [],
  achievementDays: [],
  streaks: [],
  metadata: {},
  gamesIndex: {},
  secondaryWorks: [],
};

globalThis.fetch = async (url) => {
  const target = String(url);
  let body = {};
  if (target.startsWith('/api/games/profiles')) {
    body = {
      profiles: [{ source: 'steam', userKey: '76561198038369983', key: KEY, personaName: 'hattivatt', gameCount: 340 }],
      steamKey: { configured: true, source: 'file' },
    };
  } else if (target.startsWith('/api/games/stats')) {
    body = payload;
  } else if (target.startsWith('/api/games/gog/status')) {
    body = { configured: false, connected: false, status: 'not_connected' };
  } else if (target.startsWith('/api/games/epic/status')) {
    body = { configured: false, connected: false, status: 'not_connected' };
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

test('«Источники» is a full-width widget with a three-column source row', () => {
  const css = readPublicCss();
  const widget = ruleBlock(css, '.w-games-sources {');
  assert.match(widget, /grid-column:\s*span 12/, 'the widget must own a full 12-col row');

  // The base rules live after the games media queries; anchor on the widget
  // rule so the phone re-flow block is not mistaken for the base one.
  const base = css.indexOf('.w-games-sources {');
  const row = ruleBlock(css, '.games-source-row {', base);
  assert.match(
    row,
    /grid-template-columns:\s*minmax\(110px,\s*170px\)\s+minmax\(0,\s*1fr\)\s+auto/,
    'row must be [label | meta | action]',
  );
  assert.doesNotMatch(row, /flex-direction:\s*column/);

  assert.match(ruleBlock(css, '.games-source-numbers {', base), /white-space:\s*nowrap/);
  assert.match(ruleBlock(css, '.games-source-action {', base), /justify-self:\s*end/);
  assert.match(ruleBlock(css, '.games-source-meta {', base), /display:\s*flex/);

  // Phones: name + action on the first line, meta under it — never a stack.
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.games-source-row\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) auto;\s*grid-template-areas:/,
    '760px must re-flow, not stack',
  );

  const html = readPublic('index.html');
  const widgetHtml = html.slice(
    html.indexOf('id="games-sources-widget"'),
    html.indexOf('id="games-recent-widget"'),
  );
  assert.match(widgetHtml, /часы по источникам не суммируются/);
  assert.match(widgetHtml, /class="chart-foot"/, 'the hint is a quiet widget caption');
  assert.doesNotMatch(widgetHtml, /games-source-row/, 'rows are painted by games.js, not hardcoded');
});

test('rendered sources keep label / numbers+status / action on one row', async () => {
  const games = await import('../public/js/games.js');
  games.initGames({ onActivate() {} });
  await games.showGames();
  await wait(50);

  assert.equal(nodeFor('games-sources-widget').hidden, false);
  assert.match(textOf(nodeFor('games-sources-note')), /340 игр в объединённой библиотеке/);

  const rows = nodeFor('games-sources-body').children;
  assert.equal(rows.length, 3, 'Steam + GOG + Epic');
  assert.deepEqual(rows.map((row) => row.className), [
    'games-source-row is-steam is-journal',
    'games-source-row is-gog',
    'games-source-row is-epic',
  ]);

  const [steam, gog, epic] = rows;
  // Exactly three cells: label, meta (numbers + status), action. A fourth cell
  // or a per-token split is the regression this test exists for.
  assert.deepEqual(steam.children.map((child) => child.className), [
    'games-source-name',
    'games-source-meta',
    'games-source-action',
  ]);
  assert.equal(textOf(steam.children[0]).trim(), 'Steam');

  const meta = steam.children[1];
  assert.deepEqual(meta.children.map((child) => child.className), [
    'games-source-numbers',
    'games-source-state',
  ]);
  // One unbreakable string — no '\n', no separate «340» / «игр» nodes. Intl
  // ru-RU separates thousands with NBSP (U+00A0); normalise it for the compare.
  assert.equal(meta.children[0].textContent.replace(/\s/g, ' '), '340 игр · 5 852,7 ч');
  assert.doesNotMatch(meta.children[0].textContent, /\n/);
  assert.equal(meta.children[1].textContent, 'журнал');
  assert.equal(steam.children[2].children.length, 0, 'the Steam journal has no action');

  // Not connected: no fake zeroes, one status token, the link in the action cell.
  for (const [row, name] of [[gog, 'GOG'], [epic, 'Epic Games Store']]) {
    assert.equal(textOf(row.children[0]).trim(), name);
    const rowMeta = row.children[1];
    assert.equal(rowMeta.children.length, 1, 'no numbers cell without data');
    assert.equal(rowMeta.children[0].textContent, 'не подключён');
    const action = row.children[2];
    assert.equal(action.className, 'games-source-action');
    assert.equal(action.children.length, 1, '«Подключить» sits in the action cell');
    assert.equal(action.children[0].textContent, 'Подключить');
    assert.equal(action.children[0].parentNode, action);
  }

  // The link opens the one «Подключения» screen (never an inline form).
  nodeFor('games-connections-screen').hidden = true;
  gog.children[2].children[0].click();
  await wait(10);
  assert.equal(nodeFor('games-connections-screen').hidden, false);
});
