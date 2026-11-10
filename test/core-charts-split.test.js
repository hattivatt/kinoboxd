'use strict';

/**
 * Charts split (F2): `public/js/charts.js` is a barrel over
 * `charts/{donut,timeline,year-bars}.js`, and the books timeline is the same
 * implementation as the films one, parameterised by wording.
 *
 * The refactor was supposed to be a pure move, so this pins the rendered DOM
 * of all three renderers — element counts, classes, geometry, labels, aria
 * attributes, click payloads and the tooltip strings of both timeline modes.
 * Any change of output (a class, a number, a word) fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installDom } = require('./helpers/dom-shim');

const { nodeFor } = installDom();

const JS_DIR = path.join(__dirname, '..', 'public', 'js');

function host(id) {
  const node = nodeFor(id);
  node.children = [];
  return node;
}

function classOf(node) {
  return `${(node.classList && node.classList.value) || ''} ${(node.attributes && node.attributes.class) || ''}`.trim();
}

function all(node, found = []) {
  for (const child of node.children || []) {
    found.push(child);
    all(child, found);
  }
  return found;
}

function byClass(root, name) {
  return all(root).filter((node) => classOf(node).split(/\s+/).includes(name));
}

function tooltipLines() {
  return nodeFor('tooltip').children.map((node) => `${classOf(node)}:${node.textContent}`);
}

function jsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('charts.js is a barrel: exactly the three renderers, no renderer bodies left', async () => {
  const module = await import('../public/js/charts.js');
  assert.deepEqual(Object.keys(module).sort(), ['renderDonut', 'renderTimeline', 'renderYearBars']);

  const barrel = fs.readFileSync(path.join(JS_DIR, 'charts.js'), 'utf8');
  assert.doesNotMatch(barrel, /function\s/, 'the barrel must not carry a renderer');
  assert.ok(barrel.split('\n').length <= 60, 'the barrel stays small');
});

test('every renderer is defined exactly once across public/js', () => {
  const unique = ['renderDonut', 'renderYearBars', 'renderBooksTimeline'];
  const sources = jsFiles(JS_DIR).map((file) => fs.readFileSync(file, 'utf8'));
  for (const name of unique) {
    const pattern = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
    const hits = sources.reduce((sum, source) => sum + (source.match(pattern) || []).length, 0);
    assert.equal(hits, 1, `${name} must have exactly one implementation`);
  }

  const chartFiles = [path.join(JS_DIR, 'charts.js'), path.join(JS_DIR, 'books-charts.js'), ...jsFiles(path.join(JS_DIR, 'charts'))];
  const chartSources = chartFiles.map((file) => fs.readFileSync(file, 'utf8'));
  for (const name of ['renderTimeline', 'renderDonut', 'renderYearBars', 'renderBooksTimeline']) {
    const pattern = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
    const hits = chartSources.reduce((sum, source) => sum + (source.match(pattern) || []).length, 0);
    assert.equal(hits, 1, `${name} must be defined once in the chart modules`);
  }
});

test('donut: arcs, centre, legend and segment tooltip', async () => {
  const { renderDonut } = await import('../public/js/charts.js');
  const hostNode = host('charts-donut');
  const legend = host('charts-donut-legend');
  renderDonut(hostNode, {
    segments: [
      { label: '8', value: 6, color: '#111111' },
      { label: '9', value: 3, color: '#222222' },
      { label: '10', value: 1, color: '#333333' },
    ],
    centerValue: '10',
    centerLabel: 'фильмов',
    ariaLabel: 'Оценки фильмов',
    legendHost: legend,
  });

  assert.equal(hostNode.children.length, 1);
  assert.equal(classOf(hostNode.children[0]), 'donut-wrap');
  const svg = byClass(hostNode, 'donut-svg')[0];
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('viewBox'), '0 0 220 220');
  assert.equal(svg.getAttribute('role'), 'group');
  assert.equal(svg.getAttribute('aria-label'), 'Оценки фильмов');

  const arcs = byClass(hostNode, 'donut-seg');
  assert.equal(arcs.length, 3);
  assert.deepEqual(arcs.map((arc) => arc.getAttribute('data-key')), ['0', '1', '2']);
  assert.deepEqual(arcs.map((arc) => arc.getAttribute('aria-label')), ['8: 6', '9: 3', '10: 1']);
  assert.deepEqual(arcs.map((arc) => arc.getAttribute('role')), ['button', 'button', 'button']);
  assert.deepEqual(arcs.map((arc) => arc.getAttribute('tabindex')), ['0', '0', '0']);
  assert.deepEqual(arcs.map((arc) => arc.getAttribute('aria-pressed')), ['false', 'false', 'false']);
  assert.equal(
    arcs[0].getAttribute('d'),
    'M111.64052620510463 16.014316655299226 A94 94 0 1 1 56.083814983001695 187.00029216316526 '
      + 'L73.29110807353307 162.42573083449548 A64 64 0 1 0 111.11695401198614 46.00974750999096 Z',
  );

  const center = byClass(hostNode, 'donut-center')[0];
  assert.deepEqual(center.children.map((child) => `${child.tagName}:${child.textContent}`), [
    'STRONG:10',
    'SPAN:фильмов',
  ]);

  const rows = byClass(legend, 'legend-row');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-label')), ['8: 6', '9: 3', '10: 1']);
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-pressed')), ['false', 'false', 'false']);
  assert.deepEqual(rows.map((row) => row.children.map((cell) => `${classOf(cell)}:${cell.textContent}`)), [
    ['swatch:', 'legend-label:8', 'legend-count:6', 'legend-pct:60,0%'],
    ['swatch:', 'legend-label:9', 'legend-count:3', 'legend-pct:30,0%'],
    ['swatch:', 'legend-label:10', 'legend-count:1', 'legend-pct:10,0%'],
  ]);
  assert.equal(rows[0].children[0].style.background, '#111111');

  arcs[0].dispatch('pointerenter', { clientX: 10, clientY: 10 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:8 — 6',
    'tooltip-secondary:60,0% от всех',
  ]);
  assert.equal(arcs[0].classList.contains('is-hot'), true);
  assert.equal(arcs[1].classList.contains('is-dim'), true);
  assert.equal(arcs[2].classList.contains('is-dim'), true);

  arcs[0].dispatch('pointerleave');
  assert.equal(arcs[0].classList.contains('is-hot'), false);
  assert.equal(arcs[1].classList.contains('is-dim'), false);

  rows[1].dispatch('pointerenter', { clientX: 10, clientY: 10 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:9 — 3',
    'tooltip-secondary:30,0% от всех',
  ]);
  rows[1].dispatch('pointerleave');
});

test('donut: zero total paints the quiet ring and the fallback wording', async () => {
  const { renderDonut } = await import('../public/js/charts.js');
  const hostNode = host('charts-donut-empty');
  const controller = renderDonut(hostNode, { segments: [], ariaLabel: '' });
  assert.deepEqual(controller.setSelected(), undefined);

  const svg = byClass(hostNode, 'donut-svg')[0];
  assert.equal(svg.getAttribute('aria-label'), 'Круговая диаграмма');
  const rings = svg.children;
  assert.equal(rings.length, 1);
  assert.equal(rings[0].getAttribute('stroke'), '#2a3541');
  assert.equal(rings[0].getAttribute('stroke-width'), '32');
  assert.deepEqual(
    byClass(hostNode, 'donut-center')[0].children.map((child) => `${child.tagName}:${child.textContent}`),
    ['STRONG:0', 'SPAN:нет данных'],
  );
});

test('films timeline: bars, hits, labels, aria and the two tooltip lines', async () => {
  const { renderTimeline } = await import('../public/js/charts.js');
  const hostNode = host('charts-films');
  const clicked = [];
  renderTimeline(hostNode, [
    { month: '2023-12', watched: 1, rated: 1, rewatchCount: 2 },
    { month: '2024-01', watched: 4, rated: 3, rewatchCount: 0 },
    { month: '2024-02', watched: 0, rated: 0, rewatchCount: 0 },
  ], { onMonthClick: (month) => clicked.push(month) });

  const svg = byClass(hostNode, 'timeline-svg')[0];
  assert.equal(svg.tagName, 'SVG');
  assert.equal(svg.getAttribute('width'), '900');
  assert.equal(svg.getAttribute('height'), '288');
  assert.equal(svg.getAttribute('viewBox'), '0 0 900 288');
  assert.equal(svg.getAttribute('class'), 'timeline-svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Просмотры по месяцам: декабрь 2023 — февраль 2024');

  const grid = byClass(hostNode, 'tl-grid');
  assert.equal(grid.length, 5);
  assert.equal(grid[0].getAttribute('class'), 'tl-grid base');
  assert.deepEqual(grid.map((line) => line.getAttribute('y1')), ['254', '194', '134', '74', '14']);
  assert.deepEqual(byClass(hostNode, 'tl-tick').map((node) => node.textContent), ['0', '1', '2', '3', '4']);

  const bars = byClass(hostNode, 'tl-bar');
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => bar.style.animationDelay), ['0ms', '5ms', '10ms']);
  assert.equal(bars[0].getAttribute('x'), '169.66666666666666');
  assert.equal(bars[0].getAttribute('y'), '194');
  assert.equal(bars[0].getAttribute('width'), '20');
  assert.equal(bars[0].getAttribute('height'), '60');
  assert.equal(bars[0].getAttribute('rx'), '2.5');
  assert.equal(bars[2].getAttribute('height'), '0');

  const hits = byClass(hostNode, 'tl-hit');
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((hit) => hit.getAttribute('data-month')), ['2023-12', '2024-01', null]);
  assert.deepEqual(hits.map((hit) => hit.getAttribute('role')), ['button', 'button', null]);
  assert.deepEqual(hits.map((hit) => hit.getAttribute('tabindex')), ['0', '0', null]);
  assert.deepEqual(hits.map((hit) => hit.getAttribute('aria-label')), [
    'декабрь 2023: 1 просмотр — открыть список',
    'январь 2024: 4 просмотра — открыть список',
    null,
  ]);

  assert.deepEqual(byClass(hostNode, 'tl-xlabel').map((node) => node.textContent), [
    'дек. 23', 'янв. 24', 'февр. 24',
  ]);

  hits[1].dispatch('pointerenter', { clientX: 3, clientY: 4 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:январь 2024 — 4 просмотра',
    'tooltip-secondary:3 с оценкой',
  ]);
  assert.equal(bars[1].classList.contains('is-hot'), true);
  hits[1].dispatch('pointerleave');
  assert.equal(bars[1].classList.contains('is-hot'), false);

  hits[0].dispatch('pointerenter', { clientX: 3, clientY: 4 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:декабрь 2023 — 1 просмотр (в т.ч. 2 пересмотра)',
    'tooltip-secondary:1 с оценкой',
  ]);
  hits[0].dispatch('pointerleave');

  hits[1].dispatch('click');
  hits[0].dispatch('keydown', { key: 'Enter' });
  hits[2].dispatch('click');
  assert.deepEqual(clicked, ['2024-01', '2023-12']);
});

test('films timeline: empty state and the long-series axis', async () => {
  const { renderTimeline } = await import('../public/js/charts.js');
  const emptyHost = host('charts-films-empty');
  renderTimeline(emptyHost, [], {});
  assert.equal(emptyHost.children.length, 1);
  assert.equal(classOf(emptyHost.children[0]), 'empty-state');
  assert.equal(emptyHost.children[0].textContent, 'Нет данных о просмотрах');

  const longHost = host('charts-films-long');
  const series = [];
  for (let index = 0; index < 20; index += 1) {
    const year = 2022 + Math.floor(index / 12);
    series.push({ month: `${year}-${String((index % 12) + 1).padStart(2, '0')}`, watched: index, rated: 0 });
  }
  renderTimeline(longHost, series, {});
  const labels = byClass(longHost, 'tl-xlabel').map((node) => node.textContent);
  assert.deepEqual(labels, ['2022', '2023']);
  assert.equal(
    byClass(longHost, 'timeline-svg')[0].getAttribute('aria-label'),
    'Просмотры по месяцам: январь 2022 — август 2023',
  );
});

test('books timeline: same geometry, book wording, per-source tooltip split', async () => {
  const { renderBooksTimeline } = await import('../public/js/books-charts.js');
  const hostNode = host('charts-books');
  const clicked = [];
  renderBooksTimeline(hostNode, [
    { month: '2024-01', finished: 2, reRead: 1, livelib: 2, hardcover: 0 },
    { month: '2024-02', finished: 3, reRead: 0, livelib: 3, hardcover: 1 },
    { month: '2024-03', finished: 1, reRead: 0, livelib: 0, hardcover: 0 },
  ], { onMonthClick: (month) => clicked.push(month) });

  const svg = byClass(hostNode, 'timeline-svg')[0];
  assert.equal(svg.getAttribute('width'), '900');
  assert.equal(svg.getAttribute('height'), '288');
  assert.equal(svg.getAttribute('viewBox'), '0 0 900 288');
  assert.equal(svg.getAttribute('class'), 'timeline-svg');
  assert.equal(svg.getAttribute('aria-label'), 'Прочитанные книги по месяцам: январь 2024 — март 2024');

  const grid = byClass(hostNode, 'tl-grid');
  assert.equal(grid.length, 4);
  assert.deepEqual(grid.map((line) => line.getAttribute('y1')), ['254', '174', '94', '14']);
  assert.deepEqual(byClass(hostNode, 'tl-tick').map((node) => node.textContent), ['0', '1', '2', '3']);

  const bars = byClass(hostNode, 'tl-bar');
  assert.equal(bars.length, 3);
  assert.deepEqual(bars.map((bar) => bar.getAttribute('height')), ['160', '240', '80']);
  assert.deepEqual(bars.map((bar) => bar.style.animationDelay), ['0ms', '5ms', '10ms']);

  const hits = byClass(hostNode, 'tl-hit');
  assert.deepEqual(hits.map((hit) => hit.getAttribute('aria-label')), [
    'январь 2024: 2 книги — открыть список',
    'февраль 2024: 3 книги — открыть список',
    'март 2024: 1 книга — открыть список',
  ]);
  assert.deepEqual(byClass(hostNode, 'tl-xlabel').map((node) => node.textContent), [
    'янв. 24', 'февр. 24', 'мар. 24',
  ]);

  hits[1].dispatch('pointerenter', { clientX: 3, clientY: 4 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:февраль 2024 — 3 книги',
    'tooltip-secondary:LiveLib 3 · Hardcover 1',
  ]);
  hits[1].dispatch('pointerleave');

  hits[0].dispatch('pointerenter', { clientX: 3, clientY: 4 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:январь 2024 — 2 книги (в т.ч. 1 перечитка)',
    'tooltip-secondary:LiveLib 2',
  ]);
  hits[0].dispatch('pointerleave');

  hits[2].dispatch('pointerenter', { clientX: 3, clientY: 4 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:март 2024 — 1 книга',
    'tooltip-secondary:16,7% всех книг',
  ]);
  hits[2].dispatch('pointerleave');

  hits[2].dispatch('click');
  assert.deepEqual(clicked, ['2024-03']);

  const emptyHost = host('charts-books-empty');
  renderBooksTimeline(emptyHost, [], {});
  assert.equal(emptyHost.children[0].textContent, 'Нет прочитанных книг с датами');
});

test('year bars: year axis, ancient slot, tooltips and click payloads', async () => {
  const { renderYearBars } = await import('../public/js/charts.js');
  const hostNode = host('charts-years');
  const yearClicks = [];
  const ancientClicks = [];
  renderYearBars(hostNode, [
    { year: 1999, count: 2 },
    { year: 2000, count: 5 },
    { year: 2001, count: 0 },
    { year: 2002, count: 1 },
    { ancient: true, count: 3, editionCount: 1, beforeYear: 1000, label: 'до 1000 г.', key: 'before-1000' },
  ], {
    unitForms: ['книга', 'книги', 'книг'],
    shareLabel: 'всех книг',
    onYearClick: (year) => yearClicks.push(year),
    onAncientClick: (bucket) => ancientClicks.push(bucket.count),
    yearNote: (year, item) => (item.editionCount > 0 ? 'год издания вместо первоиздания' : ''),
  });

  const svg = byClass(hostNode, 'timeline-svg')[0];
  assert.equal(svg.getAttribute('class'), 'timeline-svg yearbars-svg');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Просмотры по годам выпуска: 1999 — 2002');

  assert.deepEqual(byClass(hostNode, 'tl-tick').map((node) => node.textContent), ['0', '2', '4', '6']);
  assert.deepEqual(
    byClass(hostNode, 'tl-grid').map((line) => line.getAttribute('y1')),
    ['254', '174', '94', '14'],
  );

  assert.equal(byClass(hostNode, 'tl-slot-ancient').length, 1);
  assert.equal(byClass(hostNode, 'tl-slot-ancient')[0].getAttribute('width'), '58');
  const separator = byClass(hostNode, 'tl-separator')[0];
  assert.equal(separator.getAttribute('x1'), '99');
  assert.equal(separator.getAttribute('y2'), '254');

  const bars = byClass(hostNode, 'tl-bar');
  assert.equal(bars.length, 5);
  assert.equal(bars[0].getAttribute('x'), '189.75');
  assert.equal(bars[0].getAttribute('width'), '28');
  assert.equal(bars[0].getAttribute('height'), '80');
  assert.equal(bars[4].getAttribute('class'), 'tl-bar is-ancient');
  assert.equal(bars[4].getAttribute('x'), '51');

  const yearHits = byClass(hostNode, 'tl-hit').filter((hit) => hit.getAttribute('data-year') != null);
  assert.deepEqual(yearHits.map((hit) => hit.getAttribute('data-year')), ['1999', '2000', '2001', '2002']);
  assert.deepEqual(yearHits.map((hit) => hit.getAttribute('aria-label')), [
    '1999: 2 книги — открыть список',
    '2000: 5 книг — открыть список',
    null,
    '2002: 1 книга — открыть список',
  ]);
  const bucketHit = byClass(hostNode, 'tl-hit').find((hit) => hit.getAttribute('data-bucket'));
  assert.equal(bucketHit.getAttribute('data-bucket'), 'before-1000');
  assert.equal(bucketHit.getAttribute('aria-label'), 'до 1000 г.: 3 книги — открыть список');

  assert.deepEqual(byClass(hostNode, 'tl-xlabel-ancient').map((node) => node.textContent), ['до', '1000 г.']);
  assert.deepEqual(byClass(hostNode, 'tl-xlabel').map((node) => node.textContent), [
    'до', '1000 г.', '1999', '2000', '2001', '2002',
  ]);

  yearHits[1].dispatch('pointerenter', { clientX: 5, clientY: 6 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:2000 — 5 книг',
    'tooltip-secondary:62,5% всех книг',
  ]);
  assert.equal(bars[1].classList.contains('is-hot'), true);
  yearHits[1].dispatch('pointerleave');
  assert.equal(bars[1].classList.contains('is-hot'), false);

  bucketHit.dispatch('pointerenter', { clientX: 5, clientY: 6 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:до 1000 г. — 3 книги',
    'tooltip-secondary:27,3% всех книг · 1 книга: год издания',
  ]);
  bucketHit.dispatch('pointerleave');

  yearHits[1].dispatch('click');
  yearHits[2].dispatch('click');
  bucketHit.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(yearClicks, [2000]);
  assert.deepEqual(ancientClicks, [3]);
});

test('year bars: count labels, no ancient slot and the empty state', async () => {
  const { renderYearBars } = await import('../public/js/charts.js');
  const labelsHost = host('charts-years-labels');
  renderYearBars(labelsHost, [
    { year: 2019, count: 34 },
    { year: 2020, count: 0 },
    { year: 2021, count: 7 },
  ], {
    barLabels: true,
    unitForms: ['игра', 'игры', 'игр'],
    shareLabel: 'всех игр',
    ariaLabel: 'Игры по годам',
  });
  assert.equal(byClass(labelsHost, 'tl-slot-ancient').length, 0);
  assert.equal(byClass(labelsHost, 'tl-separator').length, 0);
  assert.deepEqual(byClass(labelsHost, 'tl-bar-count').map((node) => node.textContent), ['34', '7']);
  assert.equal(byClass(labelsHost, 'tl-bar-count')[0].getAttribute('x'), '179.66666666666666');
  assert.equal(byClass(labelsHost, 'timeline-svg')[0].getAttribute('aria-label'), 'Игры по годам');
  assert.deepEqual(byClass(labelsHost, 'tl-xlabel').map((node) => node.textContent), ['2019', '2020', '2021']);

  const bars = byClass(labelsHost, 'tl-bar');
  const hit = byClass(labelsHost, 'tl-hit')[0];
  hit.dispatch('pointerenter', { clientX: 5, clientY: 6 });
  assert.deepEqual(tooltipLines(), [
    'tooltip-primary:2019 — 34 игры',
    'tooltip-secondary:82,9% всех игр',
  ]);
  hit.dispatch('pointerleave');

  const emptyHost = host('charts-years-empty');
  renderYearBars(emptyHost, [], {});
  assert.equal(classOf(emptyHost.children[0]), 'empty-state');
  assert.equal(emptyHost.children[0].textContent, 'Нет данных по годам выпуска');

  const ancientOnly = host('charts-years-ancient-only');
  renderYearBars(ancientOnly, [{ ancient: true, count: 2 }], {});
  assert.equal(byClass(ancientOnly, 'empty-state').length, 0);
  assert.equal(byClass(ancientOnly, 'tl-bar')[0].getAttribute('class'), 'tl-bar is-ancient');
  assert.deepEqual(byClass(ancientOnly, 'tl-xlabel-ancient').map((node) => node.textContent), ['до 1000 г.']);
  assert.equal(bars.length, 3);
});
