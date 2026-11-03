'use strict';

/**
 * Frontend core (U12/P8): the chart primitives extracted into
 * `public/js/core/charts.js`.
 *
 * The three tab controllers used to carry their own copies of `svgEl`,
 * `niceStep`, `pad2`, `heatLevel` and `buildYearCalendar`. The primitives were
 * identical; the calendar was not (wording + per-day field + click payload),
 * so the test pins both halves:
 *
 *   - the primitives behave exactly as the copies did;
 *   - the three frozen calendar variants still render their own wording and
 *     keep their own dataset keys — a partial round must not unify semantics;
 *   - no domain module defines a second copy of a shared primitive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installDom } = require('./helpers/dom-shim');

installDom();

const JS_DIR = path.join(__dirname, '..', 'public', 'js');

test('svgEl: namespaced element, attributes stringified, null skipped', async () => {
  const { svgEl } = await import('../public/js/core/charts.js');
  const node = svgEl('rect', { x: 0, width: 12, title: null, focusable: false });
  assert.equal(node.tagName, 'RECT');
  assert.equal(node.getAttribute('x'), '0');
  assert.equal(node.getAttribute('width'), '12');
  assert.equal(node.getAttribute('title'), null);
  assert.equal(node.getAttribute('focusable'), 'false');
});

test('pad2 / niceStep / heatLevel match the old copies', async () => {
  const { pad2, niceStep, heatLevel } = await import('../public/js/core/charts.js');
  assert.equal(pad2(7), '07');
  assert.equal(pad2(12), '12');
  assert.equal(niceStep(0.5), 1);
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(2), 2);
  assert.equal(niceStep(4), 5);
  assert.equal(niceStep(10), 10);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 99].map((n) => heatLevel(n)),
    [0, 1, 2, 3, 4, 4],
  );
  assert.equal(heatLevel('2'), 2, 'string counts are coerced like the copies did');
});

test('buildYearCalendarBook: 2024 is a leap year, cells carry reRead, click gives the day', async () => {
  const { buildYearCalendarBook } = await import('../public/js/core/charts.js');
  const day = { date: '2024-02-29', count: 1, reReadCount: 1 };
  const byDate = new Map([[day.date, day]]);
  const clicked = [];
  const row = buildYearCalendarBook(2024, byDate, (value) => clicked.push(value));

  assert.equal(row.className, 'cal-year');
  assert.equal(row.dataset.year, '2024');
  const grid = row.children[1].children[1];
  assert.equal(grid.getAttribute('aria-label'), 'Календарь чтения, 2024');
  const cells = grid.children.filter((cell) => !cell.classList.contains('is-blank'));
  assert.equal(cells.length, 366, 'leap year has 366 day cells');
  assert.equal(grid.children.length, 371, 'the week grid is padded to whole weeks');

  const leap = cells.find((cell) => cell.dataset.date === '2024-02-29');
  assert.equal(leap.tagName, 'BUTTON');
  assert.equal(leap.dataset.count, '1');
  assert.equal(leap.dataset.reRead, '1');
  assert.match(leap.getAttribute('title'), /в т\.ч\. 1 перечитка/);
  leap.dispatch('click');
  assert.deepEqual(clicked, [day]);
});

test('buildYearCalendarFilm keeps «просмотр» wording and the rewatch dataset key', async () => {
  const { buildYearCalendarFilm } = await import('../public/js/core/charts.js');
  const day = { date: '2024-03-01', count: 2, rewatchCount: 1, slugs: ['a', 'b'] };
  const clicked = [];
  const row = buildYearCalendarFilm(2024, new Map([[day.date, day]]), {
    onDayClick: (value) => clicked.push(value),
  });
  const grid = row.children[1].children[1];
  assert.equal(grid.getAttribute('aria-label'), 'Календарь просмотров, 2024');
  const cell = grid.children.find((node) => node.dataset.date === '2024-03-01');
  assert.equal(cell.dataset.rewatch, '1');
  assert.equal(cell.dataset.reRead, undefined, 'films never grow a books key');
  assert.match(cell.getAttribute('title'), /2 просмотра/);
  cell.dispatch('click');
  assert.deepEqual(clicked, [day]);
});

test('buildYearCalendarGame keeps «достижение» wording and appid names', async () => {
  const { buildYearCalendarGame } = await import('../public/js/core/charts.js');
  const day = { date: '2024-03-02', count: 1, appids: [10, 20] };
  const row = buildYearCalendarGame(2024, new Map([[day.date, day]]), {
    nameOf: (appid) => ({ 10: 'Alpha', 20: 'Beta' }[appid]),
  });
  const grid = row.children[1].children[1];
  assert.equal(grid.getAttribute('aria-label'), 'Календарь достижений, 2024');
  const cell = grid.children.find((node) => node.dataset.date === '2024-03-02');
  assert.equal(cell.dataset.games, '2');
  assert.equal(cell.dataset.rewatch, undefined);
  assert.match(cell.getAttribute('title'), /1 достижение/);
  assert.match(cell.getAttribute('title'), /Alpha, Beta/);
});

test('no domain module defines a second copy of a shared primitive', () => {
  const files = fs.readdirSync(JS_DIR).filter((name) => name.endsWith('.js'));
  const shared = ['svgEl', 'niceStep', 'pad2', 'heatLevel'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    for (const name of shared) {
      assert.equal(
        source.includes(`function ${name}(`),
        false,
        `${file} must import ${name} from core/charts.js, not redefine it`,
      );
    }
    for (const name of ['buildYearCalendar', 'buildYearCalendarFilm', 'buildYearCalendarBook', 'buildYearCalendarGame']) {
      assert.equal(
        source.includes(`function ${name}(`),
        false,
        `${file} must not define ${name}; the calendars live in core/charts.js`,
      );
    }
  }
  const core = fs.readFileSync(path.join(JS_DIR, 'core', 'charts.js'), 'utf8');
  for (const name of [...shared, 'buildYearCalendarFilm', 'buildYearCalendarBook', 'buildYearCalendarGame']) {
    assert.ok(core.includes(`function ${name}(`), `core/charts.js must define ${name}`);
  }
});
