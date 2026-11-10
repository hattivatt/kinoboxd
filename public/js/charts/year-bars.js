/* Full-width bar chart of watched films by their release year. */

import {
  clear, el, fmtInt, fmtPercent, plural, showTooltip, moveTooltip, hideTooltip,
} from '../ui.js';
import { svgEl, niceStep } from '../core/charts.js';
import { drawValueGrid, drawXLabels } from './axis.js';
import { collectYearBuckets, fillYearRange } from './year-data.js';

/** Width of the separate ancient slot and the gap before the year axis. */
const ANCIENT_SLOT_W = 54;
const ANCIENT_SLOT_GAP = 14;
const FILM_FORMS = ['фильм', 'фильма', 'фильмов'];
const NICE_YEAR_STEPS = [1, 2, 5, 10, 20, 25, 50, 100];

function yearBarsLayout(host, data, counts, ancient) {
  const slotW = ancient ? ANCIENT_SLOT_W : 0;
  const slotGap = ancient ? ANCIENT_SLOT_GAP : 0;
  const baseWidth = Math.max(host.clientWidth || 0, 320);
  const minStep = data.length > 40 ? 5 : 22;
  const width = Math.ceil(Math.max(baseWidth, data.length * minStep + 56 + slotW + slotGap));
  const height = 288;
  const pad = { left: 38, right: 12, top: 14, bottom: 34 };
  // The year axis starts after the ancient slot; the slot itself is not a
  // year column, so gaps/scale/step count only real years.
  const axisLeft = pad.left + slotW + slotGap;
  const plotW = width - axisLeft - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const stepX = data.length ? plotW / data.length : 0;
  const barW = data.length ? Math.max(3.5, Math.min(28, stepX * 0.66)) : 0;

  const maxValue = Math.max(1, ...data.map((item) => item.count));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  return {
    slotW, slotGap, width, height, pad, plotW, axisLeft, plotH, stepX, barW, step, ticks,
    scaleMax: step * ticks,
    minYear: counts.size ? Math.min(...counts.keys()) : null,
    maxYear: counts.size ? Math.max(...counts.keys()) : null,
    total: data.reduce((sum, item) => sum + item.count, 0),
  };
}

function drawYearBar(svg, item, index, layout, barLabels) {
  const x = layout.axisLeft + index * layout.stepX + (layout.stepX - layout.barW) / 2;
  const h = (item.count / layout.scaleMax) * layout.plotH;
  const y = layout.pad.top + layout.plotH - h;

  const bar = svgEl('rect', {
    x, y,
    width: layout.barW,
    height: Math.max(h, 0),
    rx: Math.min(2.5, layout.barW / 2),
    class: 'tl-bar',
  });
  bar.style.animationDelay = `${Math.min(index * 4, 260)}ms`;
  svg.append(bar);

  // Optional count above the column. Skipped when the bars get narrower
  // than ~16px: 26+ years on a phone would turn the labels into noise.
  if (barLabels && item.count > 0 && layout.stepX >= 16) {
    const label = svgEl('text', {
      x: x + layout.barW / 2,
      y: Math.max(8, y - 4),
      'text-anchor': 'middle',
      class: 'tl-bar-count',
    });
    label.textContent = fmtInt(item.count);
    svg.append(label);
  }
  return bar;
}

function bindTooltip(hit, bar, describe) {
  hit.addEventListener('pointerenter', (event) => {
    bar.classList.add('is-hot');
    const [primary, secondary] = describe();
    showTooltip(primary, secondary);
    moveTooltip(event);
  });
  hit.addEventListener('pointermove', moveTooltip);
  hit.addEventListener('pointerleave', () => {
    bar.classList.remove('is-hot');
    hideTooltip();
  });
}

function bindActivate(hit, ariaLabel, activate) {
  hit.classList.add('is-clickable');
  hit.setAttribute('role', 'button');
  hit.setAttribute('tabindex', '0');
  hit.setAttribute('aria-label', ariaLabel);
  hit.addEventListener('click', activate);
  hit.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
}

function yearTooltip(item, config) {
  const primary = config.unitForms
    ? `${item.year} — ${fmtInt(item.count)} ${plural(item.count, config.unitForms)}`
    : `${item.year} — ${fmtInt(item.count)}`;
  const extraNote = typeof config.yearNote === 'function' ? config.yearNote(item.year, item) : '';
  return [
    primary,
    `${fmtPercent(item.count, config.total)} ${config.shareLabel}${extraNote ? ` · ${extraNote}` : ''}`,
  ];
}

// The ancient slot: a tinted background + a dashed separator say «this is
// not a year on the axis, it is everything before it».
function drawAncientSlot(svg, layout) {
  svg.append(svgEl('rect', {
    x: layout.pad.left - 2,
    y: layout.pad.top,
    width: layout.slotW + 4,
    height: layout.plotH,
    class: 'tl-slot-ancient',
  }));
  const sepX = layout.pad.left + layout.slotW + layout.slotGap / 2;
  svg.append(svgEl('line', {
    x1: sepX, x2: sepX, y1: layout.pad.top, y2: layout.pad.top + layout.plotH,
    class: 'tl-separator',
  }));
}

function drawAncientLabels(svg, ancient, layout) {
  // Two-line label: the slot is narrow on purpose, it is not a year tick.
  const lines = ancient.beforeYear ? ['до', `${ancient.beforeYear} г.`] : [ancient.label];
  lines.forEach((line, index) => {
    const text = svgEl('text', {
      x: layout.pad.left + layout.slotW / 2,
      y: layout.height - 12 - (lines.length - 1 - index) * 11,
      'text-anchor': 'middle',
      class: 'tl-xlabel tl-xlabel-ancient',
    });
    text.textContent = line;
    svg.append(text);
  });
}

// The ancient bucket: its own slot, its own label, its own click target.
function drawAncientBucket(svg, ancient, layout, config) {
  const forms = config.unitForms || FILM_FORMS;
  const ancientBarW = Math.min(28, layout.slotW * 0.62);
  const barX = layout.pad.left + (layout.slotW - ancientBarW) / 2;
  const h = (ancient.count / layout.scaleMax) * layout.plotH;
  const y = layout.pad.top + layout.plotH - h;

  const bar = svgEl('rect', {
    x: barX, y,
    width: ancientBarW,
    height: Math.max(h, 0),
    rx: Math.min(2.5, ancientBarW / 2),
    class: 'tl-bar is-ancient',
  });
  svg.append(bar);

  const hit = svgEl('rect', {
    x: layout.pad.left - 2,
    y: layout.pad.top,
    width: layout.slotW + 4,
    height: layout.plotH,
    class: 'tl-hit',
  });
  hit.setAttribute('data-bucket', String(ancient.key || 'before-1000'));
  bindTooltip(hit, bar, () => [
    `${ancient.label} — ${fmtInt(ancient.count)} ${plural(ancient.count, forms)}`,
    `${fmtPercent(ancient.count, layout.total + ancient.count)} ${config.shareLabel}` +
      (ancient.editionCount > 0
        ? ` · ${fmtInt(ancient.editionCount)} ${plural(ancient.editionCount, forms)}: год издания`
        : ''),
  ]);
  if (typeof config.onAncientClick === 'function') {
    bindActivate(hit,
      `${ancient.label}: ${fmtInt(ancient.count)} ${plural(ancient.count, forms)} — открыть список`,
      () => {
        hideTooltip();
        config.onAncientClick(ancient);
      });
  }
  svg.append(hit);

  drawAncientLabels(svg, ancient, layout);
}

// x labels: evenly spaced years, always keeping the first and the last
function pickYearLabels(layout, count) {
  const maxLabels = Math.max(2, Math.floor(layout.plotW / 64));
  const rawStep = Math.ceil(count / maxLabels);
  const yearStep = NICE_YEAR_STEPS.find((value) => value >= rawStep) || Math.ceil(rawStep / 100) * 100;

  const picked = new Set(layout.minYear != null ? [layout.minYear, layout.maxYear] : []);
  for (let year = layout.minYear != null ? Math.ceil(layout.minYear / yearStep) * yearStep : 0; layout.minYear != null && year <= layout.maxYear; year += yearStep) {
    picked.add(year);
  }
  const labels = [...picked]
    .sort((a, b) => a - b)
    .map((year) => ({
      year,
      cx: layout.axisLeft + (year - layout.minYear + 0.5) * layout.stepX,
    }));

  const drawn = [];
  for (const label of labels) {
    if (drawn.length && label.cx - drawn[drawn.length - 1].cx < 44) continue;
    drawn.push(label);
  }
  const last = labels[labels.length - 1];
  if (last && (!drawn.length || drawn[drawn.length - 1].year !== last.year)) {
    while (drawn.length && last.cx - drawn[drawn.length - 1].cx < 44) drawn.pop();
    drawn.push(last);
  }
  return drawn.map((label) => ({ cx: label.cx, text: String(label.year) }));
}

/**
 * Full-width bar chart of watched films by their release year.
 * Every year between the first and the last gets a column, so gaps are
 * drawn as zero-height bars and the x axis stays linear. Same visual
 * language as the monthly timeline; widgets.js re-renders on resize.
 *
 * A payload may also carry one non-year bucket (`ancient: true`, «до 1000 г.»).
 * It is painted in its own slot to the left of the year axis, behind a
 * separator, and shares the y scale only — never the x axis: one book written
 * in 300 AD must not stretch the axis back to year 300. Clicking the slot
 * calls `onAncientClick(bucket)` (the same list as the decade bucket).
 *
 * @param {HTMLElement} host
 * @param {Array<{year?:number,count:number,ancient?:boolean,beforeYear?:number,label?:string}>} years
 * @param {object} [opts]
 * @param {(year:number)=>void} [opts.onYearClick]
 * @param {(bucket:object)=>void} [opts.onAncientClick]
 * @param {string[]|null} [opts.unitForms] plural forms of the unit ("книга"/"фильм");
 *        when set the tooltip names it, otherwise the film wording stays compact
 * @param {string} [opts.shareLabel] suffix of the percentage line ("всех фильмов")
 * @param {string} [opts.emptyText] empty-state message
 * @param {string} [opts.ariaLabel] accessible chart description
 * @param {boolean} [opts.barLabels] print the count above every column
 * @param {(year:number,item:object)=>string} [opts.yearNote] extra tooltip note
 */
export function renderYearBars(host, years, {
  onYearClick,
  onAncientClick,
  unitForms = null,
  shareLabel = 'всех фильмов',
  emptyText = 'Нет данных по годам выпуска',
  ariaLabel = '',
  yearNote = null,
  // Print the count above every column. Off by default: films/books stay
  // compact, the games year chart asks for it explicitly so «34 игры» is
  // readable without hovering.
  barLabels = false,
} = {}) {
  const { counts, ancient } = collectYearBuckets(years);

  clear(host);
  if (!counts.size && !ancient) {
    host.append(el('div', { class: 'empty-state', text: emptyText }));
    return;
  }

  const data = fillYearRange(counts);
  const layout = yearBarsLayout(host, data, counts, ancient);
  const config = { unitForms, shareLabel, yearNote, total: layout.total, onAncientClick };

  const svg = svgEl('svg', {
    width: layout.width,
    height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    class: 'timeline-svg yearbars-svg',
    role: 'img',
    'aria-label': ariaLabel || (layout.minYear != null
      ? `Просмотры по годам выпуска: ${layout.minYear} — ${layout.maxYear}`
      : 'Просмотры по годам выпуска'),
  });

  drawValueGrid(svg, layout);
  if (ancient) drawAncientSlot(svg, layout);

  data.forEach((item, index) => {
    const bar = drawYearBar(svg, item, index, layout, barLabels);
    const hit = svgEl('rect', {
      x: layout.axisLeft + index * layout.stepX,
      y: layout.pad.top,
      width: layout.stepX,
      height: layout.plotH,
      class: 'tl-hit',
    });
    hit.setAttribute('data-year', String(item.year));
    bindTooltip(hit, bar, () => yearTooltip(item, config));

    if (item.count > 0 && typeof onYearClick === 'function') {
      bindActivate(hit,
        `${item.year}: ${fmtInt(item.count)} ${plural(item.count, unitForms || FILM_FORMS)} — открыть список`,
        () => {
          hideTooltip();
          onYearClick(item.year);
        });
    }
    svg.append(hit);
  });

  if (ancient) drawAncientBucket(svg, ancient, layout, config);
  drawXLabels(svg, pickYearLabels(layout, data.length), layout.height);

  host.append(svg);
}
