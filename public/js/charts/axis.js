import { fmtInt } from '../ui.js';
import { svgEl } from '../core/charts.js';

export function drawValueGrid(svg, { pad, width, plotH, step, ticks, scaleMax }) {
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
}

export function drawXLabels(svg, labels, height) {
  for (const label of labels) {
    const text = svgEl('text', {
      x: label.cx,
      y: height - 12,
      'text-anchor': 'middle',
      class: 'tl-xlabel',
    });
    text.textContent = label.text;
    svg.append(text);
  }
}
