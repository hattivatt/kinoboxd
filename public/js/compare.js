/* Profile comparison view: two cached KinoPoisk profiles side by side.
 *
 * The heavy counters are computed server-side from the persistent caches
 * (/api/compare), so this module only owns the picker and the presentation.
 * Opening the view never changes the active profile or the dashboard data.
 */

import { getKpProfiles, getCompare } from './api.js';
import {
  $, el, clear, fmtInt, fmtRating, fmtPeriod, fmtWatchTime, plural,
  shortErrorMessage,
} from './ui.js';

let handlers = { onShow: null, onBack: null };
let bound = false;
let profiles = [];
let lastPayload = null;
let lastKey = '';
let requestSeq = 0;

function profileLabel(profile) {
  const nick = profile && profile.nick ? profile.nick : `user ${profile.kpUserId}`;
  return nick;
}

function profileOptionLabel(profile) {
  const entries = Number(profile.entries) || 0;
  return `${profileLabel(profile)} · ${fmtInt(entries)} ${plural(entries, ['фильм', 'фильма', 'фильмов'])}`;
}

function selectedValues() {
  const a = $('compare-a');
  const b = $('compare-b');
  return {
    a: a ? a.value : '',
    b: b ? b.value : '',
  };
}

function setSelectOptions(select, list, selectedId) {
  if (!select) return;
  clear(select);
  for (const profile of list) {
    select.append(el('option', {
      value: profile.kpUserId,
      text: profileOptionLabel(profile),
    }));
  }
  if (selectedId && list.some((profile) => profile.kpUserId === selectedId)) {
    select.value = selectedId;
  }
}

/**
 * Show/hide the topbar and switcher entry points. Exposed so the main module
 * can update them whenever it refreshes the server profile list.
 */
export function renderCompareAvailability(list) {
  if (Array.isArray(list)) profiles = list;
  const available = profiles.length >= 2;
  const buttons = [$('compare-open'), $('compare-menu')];
  for (const button of buttons) {
    if (button) button.hidden = !available;
  }
}

export function getCompareProfiles() {
  return profiles;
}

function showError(message) {
  const host = $('compare-error');
  if (!host) return;
  clear(host);
  host.textContent = message || '';
  host.hidden = !message;
}

function setLoading(loading) {
  const node = $('compare-loading');
  if (node) node.hidden = !loading;
  const body = $('compare-body');
  if (body && loading) body.hidden = true;
}

function fact(label, value, title) {
  const row = el('div', { class: 'compare-fact' });
  row.append(el('dt', { text: label }));
  row.append(el('dd', { text: value, title: title || value }));
  return row;
}

function factValue(value, sub) {
  const dd = el('dd');
  dd.append(document.createTextNode(value));
  if (sub) dd.append(el('span', { class: 'compare-fact-sub', text: sub }));
  return dd;
}

function renderSide(profile, side) {
  const article = el('article', { class: `compare-side is-${side}` });
  const head = el('div', { class: 'compare-side-head' });
  head.append(el('span', { class: 'compare-side-badge', text: side.toUpperCase() }));
  const who = el('div', { class: 'compare-side-who' });
  who.append(el('div', { class: 'compare-side-nick', text: profileLabel(profile), title: profileLabel(profile) }));
  who.append(el('div', {
    class: 'compare-side-id',
    text: `Кинопоиск · user ${profile.kpUserId}`,
  }));
  head.append(who);
  article.append(head);

  const facts = el('dl', { class: 'compare-facts' });
  facts.append(fact('фильмов', fmtInt(profile.filmCount)));

  const views = Number(profile.viewCount) || 0;
  if (views > 0) {
    const rewatches = Math.max(0, Number(profile.rewatchCount) || 0);
    const viewFact = el('div', { class: 'compare-fact' });
    viewFact.append(el('dt', { text: 'просмотров' }));
    const viewValue = el('dd');
    viewValue.append(document.createTextNode(fmtInt(views)));
    const sub = profile.hasAttachment
      ? (rewatches > 0
        ? `вкл. ${fmtInt(rewatches)} ${plural(rewatches, ['пересмотр', 'пересмотра', 'пересмотров'])}`
        : 'включая пересмотры')
      : 'прокси, без архива';
    viewValue.append(el('span', { class: 'compare-fact-sub compare-fact-sub-block', text: sub }));
    viewFact.append(viewValue);
    viewFact.title = profile.hasAttachment
      ? `Просмотров с пересмотрами: ${fmtInt(views)}${rewatches > 0 ? `, из них ${fmtInt(rewatches)}` : ''}`
      : `Letterboxd-архив не прикреплён: ${fmtInt(views)} просмотров — прокси по одной дате оценки на фильм`;
    facts.append(viewFact);
  }

  facts.append(fact('с оценками', fmtInt(profile.ratedCount)));

  const avg = el('div', { class: 'compare-fact' });
  avg.append(el('dt', { text: 'средняя' }));
  avg.append(factValue(fmtRating(profile.avgRating), ' из 10'));
  facts.append(avg);

  const time = fmtWatchTime(profile.totalMinutes);
  const timeFact = el('div', { class: 'compare-fact' });
  timeFact.append(el('dt', { text: 'время' }));
  timeFact.append(factValue(time.value, ''));
  timeFact.title = time.title || '';
  facts.append(timeFact);

  facts.append(fact('период', fmtPeriod(profile.dateFrom, profile.dateTo)));
  article.append(facts);
  return article;
}

function renderSummary(payload) {
  const host = $('compare-sides');
  if (!host) return;
  clear(host);
  host.append(renderSide(payload.a, 'a'));
  const vs = el('div', { class: 'compare-vs', 'aria-hidden': 'true' });
  vs.append(el('span', { text: 'vs' }));
  host.append(vs);
  host.append(renderSide(payload.b, 'b'));
}

function renderOverlap(payload) {
  const host = $('compare-overlap');
  if (!host) return;
  clear(host);
  host.append(el('span', { class: 'compare-overlap-item is-shared' },
    el('b', { text: fmtInt(payload.intersection) }), ' общих'));
  host.append(el('span', { class: 'compare-overlap-sep', text: '·' }));
  host.append(el('span', { class: 'compare-overlap-item is-a' },
    'только у A ', el('b', { text: fmtInt(payload.uniqueA) })));
  host.append(el('span', { class: 'compare-overlap-sep', text: '·' }));
  host.append(el('span', { class: 'compare-overlap-item is-b' },
    'только у B ', el('b', { text: fmtInt(payload.uniqueB) })));
  host.append(el('span', {
    class: 'compare-overlap-hint',
    text: 'пересечение по TMDB id',
  }));
}

function deltaCell(delta) {
  const value = Number(delta) || 0;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const text = value === 0 ? '0' : `${sign}${fmtInt(Math.abs(value))}`;
  const cls = value > 0 ? 'is-a' : value < 0 ? 'is-b' : 'is-even';
  return el('td', { class: `compare-delta ${cls}`, text });
}

function renderCountTable(hostId, rows, label) {
  const host = $(hostId);
  if (!host) return;
  clear(host);
  if (!rows || rows.length === 0) {
    host.append(el('div', { class: 'compare-empty', text: 'Нет данных для сравнения' }));
    return;
  }

  const table = el('table', { class: 'compare-table' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { class: 'compare-col-name', text: label }));
  headRow.append(el('th', { class: 'compare-col-num', text: 'A' }));
  headRow.append(el('th', { class: 'compare-col-num', text: 'B' }));
  headRow.append(el('th', { class: 'compare-col-num compare-col-delta', text: 'Δ' }));
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.append(el('td', { class: 'compare-name', text: row.name, title: row.name }));
    tr.append(el('td', { class: 'compare-num is-a', text: fmtInt(row.countA) }));
    tr.append(el('td', { class: 'compare-num is-b', text: fmtInt(row.countB) }));
    tr.append(deltaCell(row.delta));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderRatings(payload) {
  const host = $('compare-ratings-body');
  if (!host) return;
  clear(host);

  const rows = (payload.ratings || []).slice().sort((left, right) => right.score - left.score);
  const max = rows.reduce(
    (acc, row) => Math.max(acc, Number(row.countA) || 0, Number(row.countB) || 0),
    0
  );

  const table = el('table', { class: 'compare-table compare-ratings-table' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { class: 'compare-score-col', text: 'Оценка' }));
  headRow.append(el('th', { class: 'compare-rating-head is-a', text: 'A' }));
  headRow.append(el('th', { class: 'compare-rating-head is-b', text: 'B' }));
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.append(el('td', { class: 'compare-score', text: String(row.score) }));

    for (const side of ['a', 'b']) {
      const count = Number(side === 'a' ? row.countA : row.countB) || 0;
      const td = el('td', { class: 'compare-rating-cell' });
      const line = el('div', { class: `compare-rating-line is-${side}` });
      const bar = el('span', { class: 'compare-rating-bar' });
      bar.style.width = `${max > 0 ? Math.max(count > 0 ? 2 : 0, (count / max) * 100) : 0}%`;
      line.append(bar);
      line.append(el('span', { class: 'compare-rating-count', text: fmtInt(count) }));
      td.append(line);
      tr.append(td);
    }

    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
}

function renderPayload(payload) {
  renderSummary(payload);
  renderOverlap(payload);
  renderCountTable('compare-genres-wrap', payload.genres, 'Жанр');
  renderCountTable('compare-actors-wrap', payload.actors, 'Актёр');
  renderCountTable('compare-directors-wrap', payload.directors, 'Режиссёр');
  renderRatings(payload);

  const body = $('compare-body');
  if (body) body.hidden = false;
}

async function runCompare({ force = false } = {}) {
  const { a, b } = selectedValues();
  if (!a || !b) {
    showError('Выберите два профиля.');
    return;
  }
  if (a === b) {
    showError('Для сравнения нужны два разных профиля.');
    return;
  }

  const key = `${a}:${b}`;
  if (!force && key === lastKey && lastPayload) {
    setLoading(false);
    renderPayload(lastPayload);
    return;
  }

  const seq = ++requestSeq;
  showError('');
  setLoading(true);
  try {
    const payload = await getCompare(a, b);
    if (seq !== requestSeq) return;
    lastPayload = payload;
    lastKey = key;
    setLoading(false);
    renderPayload(payload);
  } catch (error) {
    if (seq !== requestSeq) return;
    setLoading(false);
    showError(shortErrorMessage(error));
  }
}

function fillPicker({ activeUserId = null } = {}) {
  const aSelect = $('compare-a');
  const bSelect = $('compare-b');
  if (!aSelect || !bSelect || profiles.length < 2) return false;

  const active = profiles.find((profile) => String(profile.kpUserId) === String(activeUserId));
  const first = active || profiles[0];
  const second = profiles.find((profile) => profile.kpUserId !== first.kpUserId) || profiles[1];

  setSelectOptions(aSelect, profiles, first.kpUserId);
  setSelectOptions(bSelect, profiles, second.kpUserId);
  return true;
}

/**
 * Open the comparison view. Fetches the server-side profile list on every
 * entry (it may have changed after an import) and pre-runs the comparison for
 * the default pair, so the screen is useful immediately.
 */
export async function openCompare({ activeUserId = null } = {}) {
  if (typeof handlers.onShow === 'function') handlers.onShow();
  showError('');
  lastPayload = null;
  lastKey = '';
  setLoading(true);

  const body = $('compare-body');
  if (body) body.hidden = true;
  const picker = $('compare-a');
  if (picker) {
    const option = el('option', { value: '', text: 'Загружаем профили…' });
    clear(picker);
    picker.append(option);
    const bPicker = $('compare-b');
    if (bPicker) {
      clear(bPicker);
      bPicker.append(el('option', { value: '', text: 'Загружаем профили…' }));
    }
  }

  try {
    const list = await getKpProfiles();
    profiles = Array.isArray(list) ? list.filter((profile) => profile && profile.kpUserId) : [];
    renderCompareAvailability(profiles);
    setLoading(false);

    if (profiles.length < 2) {
      showError('Нужно как минимум два кэшированных профиля Кинопоиска. Импортируйте второй профиль.');
      return;
    }
    if (!fillPicker({ activeUserId })) {
      showError('Не удалось подготовить список профилей.');
      return;
    }
    await runCompare({ force: true });
  } catch (error) {
    setLoading(false);
    showError(shortErrorMessage(error));
  }
}

export function initCompare(nextHandlers = {}) {
  handlers = { ...handlers, ...nextHandlers };
  if (bound) return;
  bound = true;

  const run = $('compare-run');
  if (run) run.addEventListener('click', () => { runCompare({ force: true }); });

  const back = $('compare-back');
  if (back) {
    back.addEventListener('click', () => {
      if (typeof handlers.onBack === 'function') handlers.onBack();
    });
  }

  const open = $('compare-open');
  if (open) open.addEventListener('click', () => {
    if (typeof handlers.onOpen === 'function') handlers.onOpen();
  });

  const menu = $('compare-menu');
  if (menu) menu.addEventListener('click', () => {
    if (typeof handlers.onMenuOpen === 'function') handlers.onMenuOpen();
  });
}
