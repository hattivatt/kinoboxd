/* Hand-rolled SVG charts: donut arcs and timeline bars. No dependencies. */

import {
  clear, el, fmtInt, fmtPercent, monthName, monthShort, showTooltip, moveTooltip, hideTooltip, toNum,
  plural,
} from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
}

function polar(cx, cy, radius, degrees) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

function ringSlice(cx, cy, outer, inner, from, to) {
  const [x0, y0] = polar(cx, cy, outer, from);
  const [x1, y1] = polar(cx, cy, outer, to);
  const [x2, y2] = polar(cx, cy, inner, to);
  const [x3, y3] = polar(cx, cy, inner, from);
  const large = to - from > 180 ? 1 : 0;
  return [
    `M${x0} ${y0}`,
    `A${outer} ${outer} 0 ${large} 1 ${x1} ${y1}`,
    `L${x2} ${y2}`,
    `A${inner} ${inner} 0 ${large} 0 ${x3} ${y3}`,
    'Z',
  ].join(' ');
}

/**
 * Donut chart with optional interactive legend.
 *
 * Interaction can run in two modes:
 *  - uncontrolled (default, used by ratings): clicking pins a segment locally;
 *  - controlled (`opts.onSelect` supplied, used by decades): clicking calls
 *    onSelect(seg) and the caller owns the selection, passing it back via
 *    opts.selectedKey and/or the returned `setSelected(key)` controller.
 *
 * @param {HTMLElement} host
 * @param {object} opts
 * @param {Array<{key?:string,label:string,value:number,color:string}>} opts.segments
 * @param {string|number} [opts.centerValue]
 * @param {string} [opts.centerLabel]
 * @param {HTMLElement} [opts.legendHost]
 * @param {string} [opts.ariaLabel]
 * @param {(seg:object,total:number)=>string} [opts.secondary]
 * @param {string|null} [opts.selectedKey] persistently highlighted segment
 * @param {(seg:object)=>void} [opts.onSelect] controlled selection handler
 * @returns {{setSelected:(key:string|null)=>void}}
 */
export function renderDonut(host, opts = {}) {
  const { legendHost = null, ariaLabel = '' } = opts;
  const segments = (opts.segments || [])
    .map((seg, index) => ({ ...seg, key: String(seg.key ?? index), value: toNum(seg.value) }))
    .filter((seg) => seg.value > 0);
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);
  const controlled = typeof opts.onSelect === 'function';
  let selectedKey = opts.selectedKey != null ? String(opts.selectedKey) : null;

  clear(host);
  if (legendHost) clear(legendHost);

  const wrap = el('div', { class: 'donut-wrap' });
  const svg = svgEl('svg', {
    viewBox: '0 0 220 220',
    class: 'donut-svg',
    role: 'group',
    'aria-label': ariaLabel || 'Круговая диаграмма',
  });

  const centerValue = opts.centerValue != null ? String(opts.centerValue) : fmtInt(total);
  const centerLabel = opts.centerLabel || '';

  if (!total) {
    svg.append(svgEl('circle', {
      cx: 110, cy: 110, r: 78, fill: 'none', stroke: '#2a3541', 'stroke-width': 32,
    }));
    wrap.append(svg);
    wrap.append(el('div', { class: 'donut-center' },
      el('strong', { text: '0' }),
      el('span', { text: centerLabel || 'нет данных' }),
    ));
    host.append(wrap);
    return { setSelected() {} };
  }

  const map = new Map();
  const rows = new Map();
  let pinned = null;
  let hovered = null;

  const activeKey = () => (controlled ? selectedKey : (pinned || selectedKey));

  const describe = (seg) => {
    const primary = `${seg.label} — ${fmtInt(seg.value)}`;
    const secondary = opts.secondary
      ? opts.secondary(seg, total)
      : `${fmtPercent(seg.value, total)} от всех`;
    return [primary, secondary];
  };

  const applyState = () => {
    const selected = activeKey();
    const anyActive = Boolean(hovered || selected);
    for (const [key, path] of map) {
      const hot = key === hovered;
      const isSelected = key === selected;
      path.classList.toggle('is-hot', hot || (isSelected && !controlled));
      path.classList.toggle('is-selected', isSelected);
      path.classList.toggle('is-dim', anyActive && !hot && !isSelected);
      path.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
    for (const [key, row] of rows) {
      const isSelected = key === selected;
      row.classList.toggle('is-hot', key === hovered);
      row.classList.toggle('is-active', isSelected);
      row.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    }
  };

  const activate = (seg) => {
    if (controlled) {
      opts.onSelect(seg);
      return;
    }
    pinned = pinned === seg.key ? null : seg.key;
    applyState();
  };

  const bindSegment = (node, seg) => {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-pressed', 'false');
    const name = `${seg.label}: ${fmtInt(seg.value)}`;
    node.setAttribute('aria-label', name);
    node.addEventListener('pointerenter', (event) => {
      hovered = seg.key;
      applyState();
      const [primary, secondary] = describe(seg);
      showTooltip(primary, secondary);
      moveTooltip(event);
    });
    node.addEventListener('pointermove', moveTooltip);
    node.addEventListener('pointerleave', () => {
      hovered = null;
      applyState();
      hideTooltip();
    });
    node.addEventListener('click', () => activate(seg));
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate(seg);
    });
    node.addEventListener('focus', () => {
      hovered = seg.key;
      applyState();
    });
    node.addEventListener('blur', () => {
      hovered = null;
      applyState();
    });
  };

  if (segments.length === 1) {
    const seg = segments[0];
    const circle = svgEl('circle', {
      cx: 110, cy: 110, r: 78, fill: 'none',
      stroke: seg.color, 'stroke-width': 32, class: 'donut-seg',
    });
    circle.dataset.key = seg.key;
    svg.append(circle);
    map.set(seg.key, circle);
    bindSegment(circle, seg);
  } else {
    let angle = 0;
    for (const seg of segments) {
      const span = (seg.value / total) * 360;
      const gap = span > 1.8 ? Math.min(1.0, span * 0.028) : 0;
      const from = angle + gap;
      const to = angle + span - gap;
      if (to > from) {
        const path = svgEl('path', {
          d: ringSlice(110, 110, 94, 64, from, to),
          fill: seg.color,
          class: 'donut-seg',
        });
        path.dataset.key = seg.key;
        svg.append(path);
        map.set(seg.key, path);
        bindSegment(path, seg);
      }
      angle += span;
    }
  }

  wrap.append(svg);
  wrap.append(el('div', { class: 'donut-center' },
    el('strong', { text: centerValue }),
    el('span', { text: centerLabel }),
  ));
  host.append(wrap);

  if (legendHost) {
    const legend = el('div', { class: 'legend' });
    for (const seg of segments) {
      const row = el('button', {
        type: 'button',
        class: 'legend-row',
        'aria-pressed': 'false',
        'aria-label': `${seg.label}: ${fmtInt(seg.value)}`,
      });
      row.append(el('span', { class: 'swatch', style: { background: seg.color } }));
      row.append(el('span', { class: 'legend-label', text: seg.label }));
      row.append(el('span', { class: 'legend-count', text: fmtInt(seg.value) }));
      row.append(el('span', { class: 'legend-pct', text: fmtPercent(seg.value, total) }));
      row.addEventListener('pointerenter', (event) => {
        hovered = seg.key;
        applyState();
        const [primary, secondary] = describe(seg);
        showTooltip(primary, secondary);
        moveTooltip(event);
      });
      row.addEventListener('pointermove', moveTooltip);
      row.addEventListener('pointerleave', () => {
        hovered = null;
        applyState();
        hideTooltip();
      });
      row.addEventListener('click', () => activate(seg));
      rows.set(seg.key, row);
      legend.append(row);
    }
    legendHost.append(legend);
  }

  applyState();

  return {
    setSelected(key) {
      selectedKey = key != null ? String(key) : null;
      applyState();
    },
  };
}

/* =========================================================
   timeline
   ========================================================= */

function niceStep(raw) {
  if (raw <= 1) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  const base = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, base * power);
}

/**
 * Full-width monthly bar chart. Renders a fixed-size SVG inside a scroll wrapper;
 * widgets.js re-renders it on container resize.
 *
 * @param {HTMLElement} host
 * @param {Array<{month:string,watched:number,rated:number}>} timeline
 * @param {{onMonthClick?: (month:string)=>void}} [opts]
 */
export function renderTimeline(host, timeline, { onMonthClick } = {}) {
  const data = (Array.isArray(timeline) ? timeline : [])
    .filter((item) => item && typeof item.month === 'string' && /^\d{4}-\d{2}$/.test(item.month))
    .map((item) => ({ ...item, watched: Math.max(0, toNum(item.watched)), rated: Math.max(0, toNum(item.rated)) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  clear(host);
  if (!data.length) {
    host.append(el('div', { class: 'empty-state', text: 'Нет данных о просмотрах' }));
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

  const maxValue = Math.max(1, ...data.map((d) => d.watched));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  const scaleMax = step * ticks;

  const svg = svgEl('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'timeline-svg',
    role: 'img',
    'aria-label': `Просмотры по месяцам: ${monthName(data[0].month)} — ${monthName(data[data.length - 1].month)}`,
  });

  // horizontal grid + y labels
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

  // bars + hit areas
  data.forEach((item, index) => {
    const x = pad.left + index * stepX + (stepX - barW) / 2;
    const h = (item.watched / scaleMax) * plotH;
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
      showTooltip(
        `${monthName(item.month)} — ${fmtInt(item.watched)}`,
        `${fmtInt(item.rated)} с оценкой`,
      );
      moveTooltip(event);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hot');
      hideTooltip();
    });

    if (item.watched > 0 && typeof onMonthClick === 'function') {
      hit.classList.add('is-clickable');
      hit.setAttribute('data-month', item.month);
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label',
        `${monthName(item.month)}: ${fmtInt(item.watched)} ${plural(item.watched, ['просмотр', 'просмотра', 'просмотров'])} — открыть список`);
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

  // x labels: January of each year for longer series, every other month for short ones
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

  // keep only labels that have enough breathing room
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

/* =========================================================
   release years
   ========================================================= */

/**
 * Full-width bar chart of watched films by their release year.
 * Every year between the first and the last gets a column, so gaps are
 * drawn as zero-height bars and the x axis stays linear. Same visual
 * language as the monthly timeline; widgets.js re-renders on resize.
 *
 * @param {HTMLElement} host
 * @param {Array<{year:number,count:number}>} years
 * @param {{onYearClick?: (year:number)=>void}} [opts]
 */
export function renderYearBars(host, years, { onYearClick } = {}) {
  const counts = new Map();
  for (const item of Array.isArray(years) ? years : []) {
    const year = Math.round(toNum(item && item.year));
    const count = Math.max(0, toNum(item && item.count));
    if (year > 0 && count > 0) counts.set(year, (counts.get(year) || 0) + count);
  }

  clear(host);
  if (!counts.size) {
    host.append(el('div', { class: 'empty-state', text: 'Нет данных по годам выпуска' }));
    return;
  }

  const minYear = Math.min(...counts.keys());
  const maxYear = Math.max(...counts.keys());
  const data = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    data.push({ year, count: counts.get(year) || 0 });
  }
  const total = data.reduce((sum, item) => sum + item.count, 0);

  const baseWidth = Math.max(host.clientWidth || 0, 320);
  const minStep = data.length > 40 ? 5 : 22;
  const width = Math.ceil(Math.max(baseWidth, data.length * minStep + 56));
  const height = 288;
  const pad = { left: 38, right: 12, top: 14, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const stepX = plotW / data.length;
  const barW = Math.max(3.5, Math.min(28, stepX * 0.66));

  const maxValue = Math.max(1, ...data.map((item) => item.count));
  const step = niceStep(maxValue / 4);
  let ticks = Math.ceil(maxValue / step);
  if (ticks < 2) ticks = 2;
  const scaleMax = step * ticks;

  const svg = svgEl('svg', {
    width, height,
    viewBox: `0 0 ${width} ${height}`,
    class: 'timeline-svg yearbars-svg',
    role: 'img',
    'aria-label': `Просмотры по годам выпуска: ${minYear} — ${maxYear}`,
  });

  // horizontal grid + y labels
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

  // bars + hit areas
  data.forEach((item, index) => {
    const x = pad.left + index * stepX + (stepX - barW) / 2;
    const h = (item.count / scaleMax) * plotH;
    const y = pad.top + plotH - h;

    const bar = svgEl('rect', {
      x, y,
      width: barW,
      height: Math.max(h, 0),
      rx: Math.min(2.5, barW / 2),
      class: 'tl-bar',
    });
    bar.style.animationDelay = `${Math.min(index * 4, 260)}ms`;
    svg.append(bar);

    const hit = svgEl('rect', {
      x: pad.left + index * stepX,
      y: pad.top,
      width: stepX,
      height: plotH,
      class: 'tl-hit',
    });
    hit.setAttribute('data-year', String(item.year));

    hit.addEventListener('pointerenter', (event) => {
      bar.classList.add('is-hot');
      showTooltip(
        `${item.year} — ${fmtInt(item.count)}`,
        `${fmtPercent(item.count, total)} всех фильмов`,
      );
      moveTooltip(event);
    });
    hit.addEventListener('pointermove', moveTooltip);
    hit.addEventListener('pointerleave', () => {
      bar.classList.remove('is-hot');
      hideTooltip();
    });

    if (item.count > 0 && typeof onYearClick === 'function') {
      hit.classList.add('is-clickable');
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label', `${item.year}: ${fmtInt(item.count)} ${plural(item.count, ['фильм', 'фильма', 'фильмов'])} — открыть список`);
      const activate = () => {
        hideTooltip();
        onYearClick(item.year);
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

  // x labels: evenly spaced years, always keeping the first and the last
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
  const rawStep = Math.ceil(data.length / maxLabels);
  const nice = [1, 2, 5, 10, 20, 25, 50, 100];
  const yearStep = nice.find((value) => value >= rawStep) || Math.ceil(rawStep / 100) * 100;

  const picked = new Set([minYear, maxYear]);
  for (let year = Math.ceil(minYear / yearStep) * yearStep; year <= maxYear; year += yearStep) {
    picked.add(year);
  }
  const labels = [...picked]
    .sort((a, b) => a - b)
    .map((year) => ({ year, cx: pad.left + (year - minYear + 0.5) * stepX }));

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

  for (const label of drawn) {
    const text = svgEl('text', {
      x: label.cx,
      y: height - 12,
      'text-anchor': 'middle',
      class: 'tl-xlabel',
    });
    text.textContent = String(label.year);
    svg.append(text);
  }

  host.append(svg);
}
