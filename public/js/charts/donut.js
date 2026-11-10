/* Donut chart: ring arcs, centre label and an optional interactive legend. */

import {
  clear, el, fmtInt, fmtPercent, showTooltip, moveTooltip, hideTooltip, toNum,
} from '../ui.js';
import { svgEl } from '../core/charts.js';

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
 * @param {(seg:object,total:number)=>string} [opts.primary] tooltip first line
 *   (default `«label — value»`); the games charts add the unit there
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
    const primary = typeof opts.primary === 'function'
      ? String(opts.primary(seg, total))
      : `${seg.label} — ${fmtInt(seg.value)}`;
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
    circle.setAttribute('data-key', seg.key);
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
        path.setAttribute('data-key', seg.key);
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
