'use strict';

/**
 * One shell contract for the three tabs (U15, P8).
 *
 * Before P8 the UI half of the suite pinned three copies of the same markup:
 * «index.html carries ...» in `games-ui.test.js`, `games-ui-m2.test.js`,
 * `games-ui-m4.test.js` and the `layout:` order checks. Those checks encoded
 * *where* a widget sat, not what the app does, and they broke every time a
 * tab was moved into the shared shell.
 *
 * This file replaces them with one contract:
 *   1. `core/shell.js` is domain-free and exports one renderer per component;
 *   2. every tab declares the same descriptor `{ domain, title, sources[],
 *      journal{} }` with exactly one journal source;
 *   3. every tab has the same shell anchors in `index.html` — profile chips,
 *      source cards (`book-source-card`), the journal/progress panel and the
 *      control panel — plus its dashboard mounts (the widget ids stay pinned,
 *      just in one place instead of four);
 *   4. the renderers themselves paint a model: chips (row + flat), cards
 *      (create from descriptor / adopt existing markup), the connections
 *      screen chrome and the progress rows.
 *
 * Behavioural DOM tests (profile switching, import, progress, GOG/Epic) are
 * untouched and live in their domain files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installDom, textOf } = require('./helpers/dom-shim');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
const html = readPublic('index.html');

/* =========================================================
   1. the module is domain-free
   ========================================================= */

test('core/shell.js is one domain-free module with one renderer per component', () => {
  const source = readPublic('js/core/shell.js');
  // Core must never import a tab controller (it is the tabs that import core).
  for (const forbidden of ['./books', './games', './main', './switcher', './widgets', './shell-descriptors']) {
    assert.equal(source.includes(`from '${forbidden}`), false, `shell.js must not import ${forbidden}`);
  }
  for (const exported of [
    'export function defineShellDomain',
    'export function renderProfileBar',
    'export function renderSourceCards',
    'export function mountConnectionsScreen',
    'export function renderJobRows',
  ]) {
    assert.ok(source.includes(exported), `shell.js must export ${exported.replace('export function ', '')}`);
  }
  // The three old render paths must be gone from the controllers: chips are
  // painted by the shell, not by a per-tab loop.
  const switcher = readPublic('js/switcher.js');
  assert.match(switcher, /renderProfileBar\(\{/);
  assert.doesNotMatch(switcher, /class: 'profile-item/);
  const books = readPublic('js/books.js');
  assert.match(books, /renderProfileBar\(\{/);
  assert.doesNotMatch(books, /class: `profile-item/);
  const games = readPublic('js/games.js');
  assert.match(games, /renderProfileBar\(\{/);
  assert.doesNotMatch(games, /class: `games-profile-chip/);
  // One progress renderer for both journals.
  assert.match(books, /renderJobRows\(\{/);
  assert.match(games, /renderJobRows\(\{/);
});

/* =========================================================
   2. descriptors: one shape, one journal per owner
   ========================================================= */

test('every tab declares the same descriptor with exactly one journal source', async () => {
  const { SHELL_DESCRIPTORS } = await import('../public/js/shell-descriptors.js');
  assert.deepEqual(Object.keys(SHELL_DESCRIPTORS).sort(), ['books', 'films', 'games']);

  for (const [domain, descriptor] of Object.entries(SHELL_DESCRIPTORS)) {
    assert.equal(descriptor.domain, domain);
    assert.ok(descriptor.title, `${domain}: descriptor needs a title`);
    assert.ok(Array.isArray(descriptor.sources) && descriptor.sources.length, `${domain}: sources[]`);
    const journals = descriptor.sources.filter((source) => source.role === 'journal');
    assert.equal(journals.length, 1, `${domain}: exactly one journal (one owner, AGENTS §6)`);
    assert.ok(descriptor.journal && typeof descriptor.journal === 'object', `${domain}: journal{}`);
    assert.ok(['rows', 'bar'].includes(descriptor.journal.mode), `${domain}: journal.mode`);
    assert.ok(descriptor.journal.hostId, `${domain}: journal.hostId`);
    for (const source of descriptor.sources) {
      assert.ok(source.id && source.name && source.role, `${domain}: source ${source.id || '?'} shape`);
      assert.ok(['journal', 'enricher', 'archive', 'reference'].includes(source.role), `${domain}: role ${source.role}`);
      assert.ok(['rows', 'bar'].includes(descriptor.journal.mode));
    }
  }

  // The domain truth from AGENTS §6: LiveLib and Steam are journals, GOG/Epic
  // and Hardcover are same-owner enrichers, Letterboxd is an archive.
  const { books, games, films } = SHELL_DESCRIPTORS;
  assert.deepEqual(books.sources.map((source) => [source.id, source.role]), [
    ['livelib', 'journal'], ['hardcover', 'enricher'],
  ]);
  assert.deepEqual(games.sources.map((source) => [source.id, source.role]), [
    ['steam', 'journal'], ['gog', 'enricher'], ['epic', 'enricher'],
  ]);
  assert.deepEqual(films.sources.map((source) => [source.id, source.role]), [
    ['kinopoisk', 'journal'], ['letterboxd', 'archive'],
  ]);
  // Epic paints its own slot, so the descriptor must not ask for a second card.
  assert.equal(games.sources.find((source) => source.id === 'epic').card, false);
});

/* =========================================================
   3. shell anchors per tab (replaces the old «index.html carries» checks)
   ========================================================= */

test('one app topbar and per-tab action groups (was games-ui.test.js)', () => {
  assert.equal((html.match(/<header class="topbar" id="app-topbar">/g) || []).length, 1);
  for (const tab of ['films', 'books', 'games']) {
    assert.equal((html.match(new RegExp(`data-tab="${tab}"`, 'g')) || []).length, 1, `таб ${tab}`);
    assert.equal(
      (html.match(new RegExp(`data-actions="${tab}"`, 'g') || [])).length,
      1,
      `группа действий ${tab}`,
    );
  }
  // Screen headers are one component: the app topbar plus two screen topbars.
  assert.equal((html.match(/class="topbar topbar-screen"/g) || []).length, 2);
  for (const screen of ['films-connections', 'compare']) {
    assert.equal(
      (html.match(new RegExp(`data-shell-header="${screen}"`, 'g')) || []).length,
      1,
      `экранная шапка ${screen}`,
    );
  }
});

test('films: profile chips, the archive card and the journal panel', () => {
  assert.match(html, /id="profile-switcher"[^>]*role="group"/);
  assert.match(html, /id="profile-list"[^>]*role="list"/);
  assert.match(html, /id="profile-add"/);
  assert.match(html, /id="films-connections-btn"[\s\S]*?Подключения/);
  const screen = html.slice(
    html.indexOf('<section class="view" data-view="films-connections" hidden>'),
    html.indexOf('<section class="view" data-view="dashboard" hidden>'),
  );
  assert.ok(screen.length > 0, 'экран подключений должен существовать');
  assert.match(screen, /id="films-connections-grid"/);
  assert.match(screen, /data-source="letterboxd"/);
  assert.match(screen, /id="attach-lb"/);
  assert.match(screen, /id="films-attach-status"/);
  assert.match(screen, /id="films-connections-back"/);
  // The archive card is not in the topbar: it is a connection of the profile.
  const topbarStart = html.indexOf('<header class="topbar" id="app-topbar">');
  const topbarEnd = html.indexOf('</header>', topbarStart);
  assert.doesNotMatch(html.slice(topbarStart, topbarEnd), /id="attach-lb"/);
  // Journal (enrich) panel: the films journal is the KinoPoisk import.
  for (const id of ['enrich-progressbar', 'enrich-fill', 'enrich-pct', 'enrich-status', 'enrich-restart']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
});

test('books: profile chips, both source cards and the progress panel', () => {
  for (const id of ['books-profile-bar', 'books-profile-switcher', 'books-profile-list', 'books-profile-add']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /id="books-sources-grid"/);
  const grid = html.slice(html.indexOf('id="books-sources-grid"'), html.indexOf('id="books-progress"'));
  assert.match(grid, /data-source="livelib"/);
  assert.match(grid, /data-source="hardcover"/);
  assert.match(grid, /id="books-livelib-file-form"/);
  assert.match(grid, /id="books-hardcover-form"/);
  // Journal/progress panel: one row per source is painted by the shell.
  for (const id of ['books-progress', 'books-progress-jobs', 'books-progress-status', 'books-progress-error', 'books-progress-back']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /id="books-import"/);
});

test('games: profile chips, the one connections screen and the progress panel', () => {
  for (const id of ['games-profile-bar', 'games-profile-list', 'games-profile-empty']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /id="games-import-grid"/);
  assert.match(html, /data-source="steam"/);
  // One connections screen: the GOG card and the Epic slot live inside it.
  const screenStart = html.indexOf('id="games-connections-screen"');
  const screenEnd = html.indexOf('id="games-progress"');
  const screen = html.slice(screenStart, screenEnd);
  assert.match(screen, /id="games-connections-grid"/);
  assert.match(screen, /data-source="gog"/);
  assert.match(screen, /id="games-gog-status"/);
  assert.match(screen, /id="games-connections"/, 'Epic mounts its slot inside the same screen');
  assert.match(screen, /id="games-connections-back"/);
  assert.doesNotMatch(html.slice(0, screenStart), /id="games-gog-card"/, 'GOG card is not in the import grid');
  // Journal/progress panel: one Steam row.
  for (const id of ['games-progress', 'games-progress-jobs', 'games-progress-status', 'games-progress-error', 'games-progress-back']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  assert.match(html, /id="games-import"/);
});

/* =========================================================
   4. dashboard mounts (moved out of games-ui/m2/m4)
   ========================================================= */

test('games dashboard keeps every widget mount and its honest wording', () => {
  for (const id of [
    'games-dash', 'games-summary', 'games-profile-widget', 'games-top-widget',
    'games-pareto-widget', 'games-recent-widget', 'games-recent-strip',
    'games-decades-widget', 'games-decades-donut', 'games-decades-legend',
    'games-years-widget', 'games-years-donut', 'games-years-legend',
    'games-genres-widget', 'games-genres-chart', 'games-genres-more',
    'games-tags-widget', 'games-tags-title', 'games-tags-note', 'games-tags-chart', 'games-tags-more',
    'games-scores-widget', 'games-scores-title', 'games-scores-note',
    'games-scores-donut', 'games-scores-legend', 'games-scores-honest',
    'games-franchises-widget', 'games-franchises-title', 'games-franchises-note',
    'games-franchises-list', 'games-franchises-loading',
    'games-meta-widget', 'games-meta-body',
    'games-calendar-widget', 'games-calendar-host', 'games-streak-card',
    'games-filters', 'games-filter-free', 'games-filter-dlc', 'games-filter-note',
    'games-filter-hours', 'games-filter-hours-minus', 'games-filter-hours-plus', 'games-filter-hours-hint',
    'games-personnel', 'games-personnel-back', 'games-personnel-coverage',
    'games-role-chips', 'games-personnel-body', 'games-personnel-loading',
    'games-personnel-error', 'games-personnel-note',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет узла #${id}`);
  }
  // U5 removed these for good; the dashboard must never paint them again.
  // Cosmetic games round: the DLC and achievements-overview widgets are gone
  // too (the payload keeps both blocks, the dashboard just does not show them).
  for (const id of [
    'games-histogram-widget', 'games-backlog-widget', 'games-modes-widget', 'games-access-widget',
    'games-recent-list', 'games-personnel-open',
    'games-dlc-widget', 'games-dlc-title', 'games-dlc-note', 'games-dlc-summary', 'games-dlc-list',
    'games-achievements-widget', 'games-achievements-title', 'games-achievements-note', 'games-achievements-body',
  ]) {
    assert.equal(html.includes(`id="${id}"`), false, `виджет #${id} должен быть удалён`);
  }
  for (const label of ['Режимы', 'Доступ']) {
    assert.equal(html.includes(`>${label}<`), false, `подпись «${label}» должна быть удалена`);
  }
  assert.match(html, /Топ по часам/);
  assert.match(html, /Топ-10% и остальные/);
  assert.match(html, /Недавно играл/);
  assert.match(html, /Профиль Steam/);
  // Honest wording that must not be lost.
  assert.match(html, /дата запуска, а не игровая сессия/);
  assert.match(html, /это время с запущенным клиентом, а не хронометраж/);
  assert.match(html, /оценки Steam, не личные/);
  assert.match(html, /по датам разблокировок, а не игровое время/);
  assert.match(html, /releaseYear из Steam Store/);
  assert.match(html, /не год, когда вы играли/);
  // Filters: a numeric field with −/+ steppers; −1 = all games, 0 = default.
  assert.match(html, /for="games-filter-hours">мин\. часов</);
  assert.match(html, /id="games-filter-hours"[^>]*min="-1"[^>]*step="1"[^>]*value="0"/);
  assert.match(html, /id="games-filter-hours-minus"[^>]*>−</);
  assert.match(html, /id="games-filter-hours-plus"[^>]*>\+</);
  assert.match(html, /id="games-filter-free"[^>]*checked/);
  // Tags carry their own three-way weight toggle.
  const tagsBlock = /<section class="widget w-games-tags"[\s\S]*?<\/section>/.exec(html);
  assert.ok(tagsBlock, 'нет карточки тегов');
  for (const weight of ['hours', 'count', 'weight']) {
    assert.match(tagsBlock[0], new RegExp(`data-games-tag-weight="${weight}"`));
  }
});

/* =========================================================
   5. renderers: chips, cards, screen, rows
   ========================================================= */

installDom({});

function grid() {
  return document.createElement('div');
}

function cardBySource(host, id) {
  return host.children.find((node) => node.dataset && node.dataset.source === id) || null;
}

test('renderProfileBar paints one row model for films/books and a flat chip for games', async () => {
  const { renderProfileBar } = await import('../public/js/core/shell.js');
  const list = document.createElement('div');
  const picked = [];
  const removed = [];

  renderProfileBar({
    list,
    items: [
      { id: 'a', label: 'Я', meta: 'Кинопоиск · обновлён только что', active: true, checkHtml: '✓', deleteHtml: '×' },
      { id: 'b', label: 'Брат', meta: 'Кинопоиск · обновлён вчера' },
    ],
    onSelect: (id) => picked.push(id),
    onDelete: (id) => removed.push(id),
  });

  assert.equal(list.children.length, 2);
  const [first, second] = list.children;
  assert.equal(first.className, 'profile-item is-active');
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(second.getAttribute('aria-selected'), 'false');
  assert.match(textOf(first), /Я/);
  assert.match(textOf(first), /обновлён только что/);
  // The pick selects, the delete deletes — one shell loop, domain callbacks.
  first.children[0].click();
  first.children[1].click();
  second.children[0].click();
  assert.deepEqual(picked, ['a', 'b']);
  assert.deepEqual(removed, ['a']);

  // Games: flat chip with dot + name + count, no delete button.
  const chips = document.createElement('div');
  renderProfileBar({
    list: chips,
    variant: 'flat',
    itemClass: 'games-profile-chip',
    items: [
      { id: 'steam-1', label: 'Я', count: '340', active: true, title: 'Я · hattivatt' },
      { id: 'steam-2', label: 'Брат', count: '12' },
    ],
    onSelect: (id) => picked.push(id),
  });
  assert.equal(chips.children.length, 2);
  const chip = chips.children[0];
  assert.equal(chip.className, 'games-profile-chip is-active');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.equal(chip.getAttribute('title'), 'Я · hattivatt');
  assert.deepEqual(chip.children.map((node) => node.className), ['games-profile-dot', 'games-profile-name', 'games-profile-count']);
  assert.match(textOf(chip), /Я/);
  assert.match(textOf(chip), /340/);
  chip.click();
  assert.equal(picked[picked.length - 1], 'steam-1');
  assert.equal(chip.children.length, 3, 'a games chip has no delete button');

  // Empty bar: one quiet line, the add button is the only action.
  const empty = document.createElement('div');
  const add = document.createElement('button');
  renderProfileBar({ list: empty, items: [], emptyText: 'Пока нет профилей', add, maxReached: true });
  assert.equal(empty.children.length, 1);
  assert.equal(empty.children[0].className, 'profile-empty');
  assert.equal(add.disabled, true);
});

test('renderSourceCards creates a missing card from the descriptor and adopts an existing one', async () => {
  const { renderSourceCards, SOURCE_CARD, SOURCE_ROLE_LABEL } = await import('../public/js/core/shell.js');
  assert.equal(SOURCE_CARD.card, 'book-source-card');
  assert.equal(SOURCE_ROLE_LABEL.journal, 'журнал');
  assert.equal(SOURCE_ROLE_LABEL.enricher, 'обогащение');
  assert.equal(SOURCE_ROLE_LABEL.archive, 'архив');

  const host = grid();
  const actions = [];
  const cards = renderSourceCards({
    grid: host,
    onAction: (source, action) => actions.push(`${source}:${action}`),
    sources: [{
      id: 'demo',
      name: 'Demo',
      mark: 'DM',
      logoClass: 'is-demo',
      role: 'enricher',
      hint: 'вторая библиотека',
      status: { id: 'demo-status', className: 'games-gog-status', text: 'Demo: не подключён' },
      actions: [
        { id: 'demo-connect', label: 'Подключить', kind: 'primary' },
        { id: 'demo-off', label: 'Отключить', kind: 'link', hidden: true },
      ],
    }, { id: 'slot', name: 'Slot', role: 'enricher', card: false }],
  });

  assert.equal(cards.length, 1, 'card:false sources are painted by their own module');
  const card = cardBySource(host, 'demo');
  assert.ok(card, 'the card appears from the descriptor');
  assert.equal(card.className, 'book-source-card is-demo');
  const head = card.children[0];
  assert.equal(head.className, 'book-source-head');
  assert.equal(head.children[0].className, 'book-source-logo is-demo');
  assert.equal(head.children[0].textContent, 'DM');
  assert.equal(head.children[1].className, 'book-source-copy');
  assert.equal(head.children[2].className, 'book-source-role is-enricher');
  assert.equal(head.children[2].textContent, 'обогащение');
  const status = card.children[1];
  assert.equal(status.getAttribute('id'), 'demo-status');
  assert.equal(status.textContent, 'Demo: не подключён');
  const actionRow = card.children[2];
  assert.equal(actionRow.className, 'books-source-actions');
  assert.deepEqual(actionRow.children.map((node) => node.textContent), ['Подключить', 'Отключить']);
  assert.equal(actionRow.children[1].hidden, true);
  actionRow.children[0].click();
  assert.deepEqual(actions, ['demo:demo-connect']);

  // Adoption: static markup keeps its own form; the shell fills only the
  // parts it owns (role chip, status class/text, hint when empty).
  const adoptedHost = grid();
  const existing = document.createElement('article');
  existing.className = 'book-source-card';
  existing.dataset.source = 'gog';
  const existingHead = document.createElement('div');
  existingHead.className = 'book-source-head';
  const copy = document.createElement('span');
  copy.className = 'book-source-copy';
  const title = document.createElement('span');
  title.className = 'book-source-title';
  title.textContent = 'GOG';
  const hint = document.createElement('span');
  hint.className = 'book-source-hint';
  copy.append(title, hint);
  existingHead.append(copy);
  existing.append(existingHead);
  const form = document.createElement('form');
  form.className = 'books-source-form';
  existing.append(form);
  adoptedHost.append(existing);

  const adopted = renderSourceCards({
    grid: adoptedHost,
    sources: [{
      id: 'gog',
      name: 'GOG',
      role: 'enricher',
      hint: 'часы отдельно от Steam',
      status: { id: 'gog-status', className: 'games-gog-status', text: 'GOG: не подключён' },
    }],
  });
  assert.equal(adopted.length, 1);
  assert.equal(adoptedHost.children.length, 1, 'no second card for the same source');
  assert.equal(adopted[0], existing, 'the existing markup is adopted, not replaced');
  assert.ok(existing.contains(form), 'the domain form is untouched');
  assert.equal(hint.textContent, 'часы отдельно от Steam');
  assert.equal(existingHead.children[1].className, 'book-source-role is-enricher');
  const adoptedStatus = existing.children[1];
  assert.equal(adoptedStatus.className, 'book-source-status games-gog-status');
  assert.equal(adoptedStatus.getAttribute('id'), 'gog-status');
  assert.equal(adoptedStatus.textContent, 'GOG: не подключён');
});

test('mountConnectionsScreen owns the screen chrome and the card list', async () => {
  const { mountConnectionsScreen } = await import('../public/js/core/shell.js');
  const screen = document.createElement('section');
  const host = grid();
  const result = mountConnectionsScreen({
    screen,
    hero: { kicker: 'подключения', title: 'Вторые библиотеки', sub: 'часы не суммируются' },
    back: { id: 'demo-back', label: '← назад' },
    grid: host,
    sources: [{ id: 'gog', name: 'GOG', role: 'enricher' }],
  });

  assert.ok(result);
  assert.ok(result.hero, 'the hero is created from the descriptor');
  assert.match(textOf(result.hero), /Вторые библиотеки/);
  assert.match(textOf(result.hero), /часы не суммируются/);
  assert.equal(result.back.getAttribute('id'), 'demo-back');
  assert.equal(result.back.textContent, '← назад');
  assert.equal(result.cards.length, 1);
  assert.ok(cardBySource(host, 'gog'));

  // A second mount is idempotent: one hero, one back button, one card.
  mountConnectionsScreen({
    screen,
    hero: { kicker: 'подключения', title: 'Вторые библиотеки', sub: 'часы не суммируются' },
    back: { id: 'demo-back', label: '← назад' },
    grid: host,
    sources: [{ id: 'gog', name: 'GOG', role: 'enricher' }],
  });
  assert.equal(host.children.length, 1);
  assert.equal(screen.children.filter((node) => node.className === 'btn btn-link').length, 1);
});

test('renderJobRows paints the journal of every domain with one row model', async () => {
  const { renderJobRows } = await import('../public/js/core/shell.js');
  const host = grid();
  const rows = renderJobRows({
    host,
    jobs: [
      {
        source: 'livelib', mark: 'LL', title: 'LiveLib', account: '@Margaret',
        stage: 'Импорт идёт…', percent: 42, meta: 'страница 3 из 7', done: false,
      },
      {
        source: 'hardcover', mark: 'HC', title: 'Hardcover', account: 'user 34748',
        stage: 'Готово', percent: 100, done: true,
      },
    ],
  });

  assert.equal(rows.length, 2);
  const [first, second] = host.children;
  assert.equal(first.className, 'books-job-row shell-job-row is-livelib');
  assert.equal(first.children[0].className, 'books-job-head shell-job-head');
  assert.match(textOf(first.children[0]), /LiveLib/);
  assert.match(textOf(first.children[0]), /@Margaret/);
  const bar = first.children[1];
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '42');
  assert.equal(bar.children[0].style.width, '42%');
  assert.equal(first.children[2].className, 'books-job-meta');
  assert.equal(first.children[2].textContent, 'страница 3 из 7');
  // A done row is never indeterminate and never above 100.
  assert.equal(second.children[1].getAttribute('aria-valuenow'), '100');
  assert.equal(second.children[1].classList.contains('is-indeterminate'), false);
  // An empty journal paints nothing instead of a fake zero row.
  const emptyHost = grid();
  renderJobRows({ host: emptyHost, jobs: [] });
  assert.equal(emptyHost.children.length, 0);
});
