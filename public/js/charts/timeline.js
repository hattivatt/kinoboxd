import {
  clear, el, fmtInt, monthName, monthShort, plural, toNum, showTooltip, moveTooltip, hideTooltip,
} from '../ui.js';
import { svgEl, niceStep } from '../core/charts.js';
import { drawValueGrid, drawXLabels } from './axis.js';

const FILM_TIMELINE = {
  emptyText: 'Нет данных о просмотрах',
  ariaPrefix: 'Просмотры по месяцам',
  valueKey: 'watched',
  rewatchKey: 'rewatchCount',
  valueForms: ['просмотр', 'просмотра', 'просмотров'],
  rewatchForms: ['пересмотр', 'пересмотра', 'пересмотров'],
  numericKeys: ['watched', 'rated', 'rewatchCount'],
  secondary: (item) => `${fmtInt(item.rated)} с оценкой`,
};

function normalizeTimeline(timeline, numericKeys) {
  return (Array.isArray(timeline) ? timeline : [])
    .filter((item) => item && typeof item.month === 'string' && /^\d{4}-\d{2}$/.test(item.month))
    .map((item) => {
      const entry = { ...item };
      for (const key of numericKeys) entry[key] = Math.max(0, toNum(item[key]));
      return entry;
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

function monthTooltip(item, config, total) {
  const value = item[config.valueKey];
  const views = `${fmtInt(value)} ${plural(value, config.valueForms)}`;
  const rewatchCount = item[config.rewatchKey];
  const rewatches = rewatchCount > 0
    ? ` (в т.ч. ${fmtInt(rewatchCount)} ${plural(rewatchCount, config.rewatchForms)})`
    : '';
  return [`${monthName(item.month)} — ${views}${rewatches}`, config.secondary(item, total)];
}

function pickMonthLabels(data) {
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
  return labels;
}

export function renderTimeline(host, timeline, { onMonthClick, ...options } = {}) {
  const config = { ...FILM_TIMELINE, ...options };
  const data = normalizeTimeline(timeline, config.numericKeys);

  clear(host);
  if (!data.length) {
    host.append(el('div', { class: 'empty-state', text: config.emptyText }));
    return;
  }
  const total = data.reduce((sum, item) => sum + item[config.valueKey], 0);

  const baseWidth = Math.max(host.clientWidth || 0, 320);
  const minStep = data.length > 80 ? 15 : 22;
  const width = Math.ceil(Math.max(baseWidth, data.length * minStep + 56));
  const height = 288;
  const pad = { left: 38, right: 12, top: 14, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const stepX = plotW / data.length;
  const barW = Math.max(2.4, Math.min(20, stepX * 0.62));

  const maxValue = Math.max(1, ...data.map((d) => d[config.valueKey]));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  const scaleMax = step * ticks;

  const svg = svgEl('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'timeline-svg',
    role: 'img',
    'aria-label': `${config.ariaPrefix}: ${monthName(data[0].month)} — ${monthName(data[data.length - 1].month)}`,
  });

  drawValueGrid(svg, { pad, width, plotH, step, ticks, scaleMax });

  data.forEach((item, index) => {
    const x = pad.left + index * stepX + (stepX - barW) / 2;
    const h = (item[config.valueKey] / scaleMax) * plotH;
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
      const [primary, secondary] = monthTooltip(item, config, total);
      showTooltip(primary, secondary);
      moveTooltip(event);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hot');
      hideTooltip();
    });

    if (item[config.valueKey] > 0 && typeof onMonthClick === 'function') {
      hit.classList.add('is-clickable');
      hit.setAttribute('data-month', item.month);
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label',
        `${monthName(item.month)}: ${fmtInt(item[config.valueKey])} ${plural(item[config.valueKey], config.valueForms)} — открыть список`);
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

  const drawn = [];
  for (const label of pickMonthLabels(data)) {
    const cx = pad.left + label.index * stepX + stepX / 2;
    if (drawn.length && cx - drawn[drawn.length - 1].cx < 34) continue;
    drawn.push({ cx, text: label.text });
  }
  drawXLabels(svg, drawn, height);

  host.append(svg);
}
