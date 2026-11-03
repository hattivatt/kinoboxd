/* Book-specific charts: the monthly reading timeline.
 *
 * The film dashboard's donut / year-bar primitives are reused as-is from
 * charts.js; only the pieces whose wording is domain-specific (просмотры →
 * книги, пересмотры → перечитывания) live here. No dependencies.
 */

import {
  el, clear, fmtInt, fmtPercent, monthName, monthShort, plural, toNum,
  showTooltip, moveTooltip, hideTooltip,
} from './ui.js';
import { svgEl, niceStep } from './core/charts.js';

export { pad2 } from './core/charts.js';

/* =========================================================
   dates (shared with books.js)
   ========================================================= */

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_SHORT_GEN = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];

export function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "25 октября 2026" */
export function fmtDayRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_GEN[parts.month - 1]} ${parts.year}`;
}

/** "25 окт. 2026" */
export function fmtDayShortRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_SHORT_GEN[parts.month - 1]} ${parts.year}`;
}

/* =========================================================
   monthly timeline
   ========================================================= */

/**
 * Monthly bar chart of finished books. Mirrors charts.js#renderTimeline but
 * uses book wording and shows the per-source split in the tooltip.
 *
 * @param {HTMLElement} host
 * @param {Array<{month:string,finished:number,reRead?:number,livelib?:number,hardcover?:number}>} timeline
 * @param {{onMonthClick?: (month:string)=>void}} [opts]
 */
export function renderBooksTimeline(host, timeline, { onMonthClick } = {}) {
  const data = (Array.isArray(timeline) ? timeline : [])
    .filter((item) => item && typeof item.month === 'string' && /^\d{4}-\d{2}$/.test(item.month))
    .map((item) => ({
      ...item,
      finished: Math.max(0, toNum(item.finished)),
      reRead: Math.max(0, toNum(item.reRead)),
      livelib: Math.max(0, toNum(item.livelib)),
      hardcover: Math.max(0, toNum(item.hardcover)),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  clear(host);
  if (!data.length) {
    host.append(el('div', { class: 'empty-state', text: 'Нет прочитанных книг с датами' }));
    return;
  }

  const baseWidth = Math.max(host.clientWidth || 0, 320);
  const minStep = data.length > 80 ? 15 : 22;
  const width = Math.ceil(Math.max(baseWidth, data.length * minStep + 56));
  const height = 288;
  const pad = { left: 38, right: 12, top: 14, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const stepX = plotW / data.length;
  const barW = Math.max(2.4, Math.min(20, stepX * 0.62));

  const maxValue = Math.max(1, ...data.map((d) => d.finished));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  const scaleMax = step * ticks;

  const svg = svgEl('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'timeline-svg',
    role: 'img',
    'aria-label': `Прочитанные книги по месяцам: ${monthName(data[0].month)} — ${monthName(data[data.length - 1].month)}`,
  });

  for (let i = 0; i <= ticks; i += 1) {
    const value = i * step;
    const y = pad.top + plotH - (value / scaleMax) * plotH;
    svg.append(svgEl('line', {
      x1: pad.left, x2: width - pad.right, y1: y, y2: y,
      class: `tl-grid${i === 0 ? ' base' : ''}`,
    }));
    const label = svgEl('text', {
      x: pad.left - 8,
      y: y + 3,
      'text-anchor': 'end',
      class: 'tl-tick',
    });
    label.textContent = fmtInt(value);
    svg.append(label);
  }

  data.forEach((item, index) => {
    const x = pad.left + index * stepX + (stepX - barW) / 2;
    const h = (item.finished / scaleMax) * plotH;
    const y = pad.top + plotH - h;

    const bar = svgEl('rect', {
      x, y,
      width: barW,
      height: Math.max(h, 0),
      rx: Math.min(2.5, barW / 2),
      class: 'tl-bar',
    });
    bar.style.animationDelay = `${Math.min(index * 5, 260)}ms`;
    svg.append(bar);

    const hit = svgEl('rect', {
      x: pad.left + index * stepX,
      y: pad.top,
      width: stepX,
      height: plotH,
      class: 'tl-hit',
    });

    hit.addEventListener('pointerenter', (event) => {
      bar.classList.add('is-hot');
      const books = `${fmtInt(item.finished)} ${plural(item.finished, ['книга', 'книги', 'книг'])}`;
      const reReads = item.reRead > 0
        ? ` (в т.ч. ${fmtInt(item.reRead)} ${plural(item.reRead, ['перечитка', 'перечитки', 'перечитываний'])})`
        : '';
      const sources = [];
      if (item.livelib > 0) sources.push(`LiveLib ${fmtInt(item.livelib)}`);
      if (item.hardcover > 0) sources.push(`Hardcover ${fmtInt(item.hardcover)}`);
      showTooltip(
        `${monthName(item.month)} — ${books}${reReads}`,
        sources.length ? sources.join(' · ') : `${fmtPercent(item.finished, data.reduce((sum, d) => sum + d.finished, 0))} всех книг`,
      );
      moveTooltip(event);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hot');
      hideTooltip();
    });

    if (item.finished > 0 && typeof onMonthClick === 'function') {
      hit.classList.add('is-clickable');
      hit.setAttribute('data-month', item.month);
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label',
        `${monthName(item.month)}: ${fmtInt(item.finished)} ${plural(item.finished, ['книга', 'книги', 'книг'])} — открыть список`);
      const activate = () => {
        hideTooltip();
        onMonthClick(item.month);
      };
      hit.addEventListener('click', activate);
      hit.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
    }
    svg.append(hit);
  });

  const labels = [];
  if (data.length > 14) {
    data.forEach((item, index) => {
      if (item.month.endsWith('-01')) labels.push({ index, text: item.month.slice(0, 4) });
    });
    if (!labels.length) {
      const every = Math.max(1, Math.ceil(data.length / 6));
      for (let i = 0; i < data.length; i += every) labels.push({ index: i, text: monthShort(data[i].month) });
    }
  } else {
    const every = data.length > 8 ? 2 : 1;
    for (let i = 0; i < data.length; i += every) labels.push({ index: i, text: monthShort(data[i].month) });
  }

  const drawn = [];
  for (const label of labels) {
    const cx = pad.left + label.index * stepX + stepX / 2;
    if (drawn.length && cx - drawn[drawn.length - 1].cx < 34) continue;
    drawn.push({ cx, text: label.text });
  }

  for (const label of drawn) {
    const text = svgEl('text', {
      x: label.cx,
      y: height - 12,
      'text-anchor': 'middle',
      class: 'tl-xlabel',
    });
    text.textContent = label.text;
    svg.append(text);
  }

  host.append(svg);
}
