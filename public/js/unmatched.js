/* "Не распознано" tile modal: list of unmatched films + manual TMDB search. */

import {
  el, clear, fmtInt, fmtRating, plural, icon, toNum, debounce, emptyState, toast,
  shortErrorMessage,
} from './ui.js';
import { openModal, posterThumb, filmLinks } from './modal.js';
import { searchTmdb, matchFilm } from './api.js';

const PAGE = 50;
let searchSeq = 0;

const KIND_LABEL = {
  movie: 'фильм',
  tv: 'сериал',
  all: 'всё',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || 'фильм';
}

/**
 * @param {object} opts
 * @param {Array<{slug:string,title:string,year:number}>} opts.items
 * @param {string|null} opts.uploadId
 * @param {() => (void|Promise<void>)} [opts.onMatched] called after a successful POST /api/match
 */
export function openUnmatchedModal({ items = [], uploadId = null, onMatched = null } = {}) {
  let films = (Array.isArray(items) ? items : []).filter((item) => item && item.slug);
  let query = '';
  let visible = PAGE;

  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: 'TMDB · без пары' }));
  const title = el('h2', { class: 'modal-title', id: 'unmatched-modal-title' });
  const sub = el('div', { class: 'modal-sub' });
  copy.append(title, sub);
  copy.append(el('p', {
    class: 'modal-hint',
    text: 'Автоматический матчинг не нашёл эти фильмы в TMDB. Найди нужный вариант вручную — статистика обновится сразу.',
  }));
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  const toolbar = el('div', { class: 'unmatched-toolbar' });

  const searchWrap = el('div', { class: 'unmatched-search' });
  searchWrap.append(el('span', { class: 'unmatched-search-icon', html: icon('search', 15) }));
  const filterInput = el('input', {
    type: 'search',
    class: 'search-input',
    id: 'unmatched-filter',
    placeholder: 'Фильтр по названию',
    autocomplete: 'off',
    'aria-label': 'Фильтр по названию',
  });
  searchWrap.append(filterInput);
  const note = el('span', { class: 'widget-note unmatched-note', id: 'unmatched-note' });
  toolbar.append(searchWrap, note);

  const listHost = el('div', { class: 'unmatched-list' });
  const moreHost = el('div', { class: 'modal-more' });
  body.append(toolbar, listHost, moreHost);

  const modal = openModal({
    head,
    body,
    labelledBy: 'unmatched-modal-title',
    className: 'modal-unmatched',
  });
  if (!modal) return null;

  function filtered() {
    const q = query.trim().toLowerCase();
    if (!q) return films;
    return films.filter((film) => {
      const haystack = `${film.title || ''} ${film.year || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  function updateHead() {
    const total = films.length;
    title.textContent = `Не распознанные фильмы (${fmtInt(total)})`;
    sub.textContent = total
      ? `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} ${total === 1 ? 'ждёт' : 'ждут'} ручного выбора в TMDB`
      : 'Все фильмы сопоставлены';
  }

  function render() {
    updateHead();
    clear(listHost);
    clear(moreHost);

    if (!films.length) {
      listHost.append(emptyState('Все фильмы распознаны — отличная работа'));
      note.textContent = '';
      return;
    }

    const list = filtered();
    note.textContent = query
      ? `${fmtInt(list.length)} из ${fmtInt(films.length)}`
      : `${fmtInt(films.length)} ${plural(films.length, ['фильм', 'фильма', 'фильмов'])}`;

    if (!list.length) {
      listHost.append(emptyState('Ничего не нашли — попробуй другой запрос'));
      return;
    }

    for (const film of list.slice(0, visible)) listHost.append(filmRow(film));

    const remaining = list.length - visible;
    if (remaining > 0) {
      const more = el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: `Показать ещё ${fmtInt(Math.min(PAGE, remaining))}`,
      });
      more.addEventListener('click', () => {
        visible += PAGE;
        render();
      });
      moreHost.append(more);
    }
  }

  function filmRow(film) {
    const row = el('div', {
      class: 'unmatched-row',
      'data-slug': film.slug,
    });
    row.append(el('div', {
      class: 'film-poster poster-fallback unmatched-poster',
      'aria-hidden': 'true',
      html: icon('film', 15),
    }));

    const info = el('div', { class: 'film-info' });
    const titleNode = el('div', { class: 'film-title', text: film.title || film.slug });
    const year = toNum(film.year);
    if (year > 0) titleNode.append(el('span', { class: 'film-year', text: `(${String(year)})` }));
    info.append(titleNode);
    info.append(el('div', { class: 'film-char', text: `slug: ${film.slug}` }));

    const button = el('button', {
      type: 'button',
      class: 'btn btn-ghost unmatched-match-btn',
      text: 'Сматчить вручную',
    });
    button.addEventListener('click', () => openSearch(film));

    // Source-page links (Letterboxd short URI / KinoPoisk title page) stay
    // available even before a manual TMDB match.
    const actions = el('div', { class: 'unmatched-actions' });
    const links = filmLinks(film);
    if (links) actions.append(links);
    actions.append(button);

    row.append(info, actions);
    return row;
  }

  function removeFilm(slug) {
    films = films.filter((film) => film.slug !== slug);
    visible = Math.min(Math.max(visible, PAGE), Math.max(films.length, PAGE));
    render();
  }

  function openSearch(film) {
    openMatchSearch({
      film,
      uploadId,
      onMatched: (result) => {
        removeFilm(film.slug);
        if (typeof onMatched === 'function') {
          try {
            const task = onMatched(result);
            if (task && typeof task.catch === 'function') task.catch(() => {});
          } catch {
            /* dashboard refresh is best-effort */
          }
        }
      },
    });
  }

  filterInput.addEventListener('input', () => {
    query = filterInput.value;
    visible = PAGE;
    render();
  });

  render();
  return modal;
}

/* =========================================================
   TMDB search dialog
   ========================================================= */

function openMatchSearch({ film, uploadId, onMatched }) {
  searchSeq += 1;
  const id = `match-search-title-${searchSeq}`;
  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: 'Ручной матч · TMDB' }));
  copy.append(el('h2', { class: 'modal-title', id, text: 'Найти фильм в TMDB' }));
  const year = toNum(film.year);
  copy.append(el('div', {
    class: 'modal-sub',
    text: `Для «${film.title || film.slug}»${year > 0 ? ` (${year})` : ''} · slug: ${film.slug}`,
  }));
  copy.append(el('p', {
    class: 'modal-hint',
    text: 'Выбери подходящий результат. Мы привяжем его к этой записи и пересчитаем статистику.',
  }));
  head.append(copy);

  const body = el('div', { class: 'modal-body match-body' });

  const bar = el('div', { class: 'match-search-bar' });
  const searchWrap = el('div', { class: 'match-search' });
  searchWrap.append(el('span', { class: 'match-search-icon', html: icon('search', 15) }));
  const input = el('input', {
    type: 'search',
    class: 'search-input',
    id: 'match-search-input',
    placeholder: 'Название на любом языке',
    autocomplete: 'off',
    'aria-label': 'Поисковый запрос в TMDB',
  });
  searchWrap.append(input);

  const selectWrap = el('div', { class: 'select-wrap' });
  const select = el('select', { class: 'select', id: 'match-search-kind', 'aria-label': 'Тип: фильм или сериал' });
  for (const [value, label] of [['all', 'Всё'], ['movie', 'Фильмы'], ['tv', 'Сериалы']]) {
    select.append(el('option', { value, text: label }));
  }
  selectWrap.append(select);
  selectWrap.append(el('span', {
    class: 'select-chevron',
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  }));
  bar.append(searchWrap, selectWrap);
  body.append(bar);

  const status = el('div', { class: 'match-status', id: 'match-search-status', 'aria-live': 'polite' });
  const results = el('div', { class: 'match-results' });
  const moreHost = el('div', { class: 'modal-more' });
  body.append(status, results, moreHost);

  const modal = openModal({
    head,
    body,
    labelledBy: id,
    className: 'modal-match',
  });
  if (!modal) return null;

  let closed = false;
  let matching = false;
  let seq = 0;
  let controller = null;
  let allResults = [];
  let visible = 12;

  const debouncedSearch = debounce(() => runSearch(), 400);

  function setStatus(text, { error = false } = {}) {
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(error && text));
  }

  async function runSearch() {
    const query = input.value.trim();
    if (!query) {
      allResults = [];
      clear(results);
      clear(moreHost);
      setStatus('Введи название — поиск идёт по TMDB');
      return;
    }

    seq += 1;
    const mine = seq;
    if (controller) controller.abort();
    controller = new AbortController();
    setStatus('Ищем в TMDB…');

    try {
      const data = await searchTmdb(query, select.value, { signal: controller.signal });
      if (closed || mine !== seq) return;
      const list = data && Array.isArray(data.results) ? data.results : [];
      allResults = list;
      visible = 12;
      renderResults();
    } catch (error) {
      if (closed || mine !== seq) return;
      if (error && error.code === 'aborted') return;
      allResults = [];
      clear(results);
      clear(moreHost);
      setStatus(shortErrorMessage(error), { error: true });
    }
  }

  function renderResults() {
    clear(results);
    clear(moreHost);

    if (!allResults.length) {
      setStatus('Ничего не нашли — попробуй другое название или тип');
      return;
    }

    setStatus(`${fmtInt(allResults.length)} ${plural(allResults.length, ['вариант', 'варианта', 'вариантов'])} · выбери нужный`);

    for (const result of allResults.slice(0, visible)) results.append(resultRow(result));

    const remaining = allResults.length - visible;
    if (remaining > 0) {
      const more = el('button', {
        type: 'button',
        class: 'btn btn-ghost',
        text: `Показать ещё ${fmtInt(Math.min(12, remaining))}`,
      });
      more.addEventListener('click', () => {
        visible += 12;
        renderResults();
      });
      moreHost.append(more);
    }
  }

  function resultRow(result) {
    const row = el('div', { class: 'match-result' });
    row.append(posterThumb(result.posterPath, result.title));

    const info = el('div', { class: 'film-info' });
    const titleNode = el('div', { class: 'film-title', text: result.title || 'Без названия' });
    const resultYear = toNum(result.year);
    if (resultYear > 0) titleNode.append(el('span', { class: 'film-year', text: String(resultYear) }));
    info.append(titleNode);

    const meta = el('div', { class: 'film-char match-meta' });
    meta.append(el('span', { class: 'match-kind', text: kindLabel(result.kind) }));
    if (result.voteAverage != null && Number.isFinite(Number(result.voteAverage))) {
      meta.append(el('span', { class: 'match-score', text: `TMDB ${fmtRating(result.voteAverage)}` }));
    }
    if (result.id != null) meta.append(el('span', { class: 'match-id', text: `#${result.id}` }));
    info.append(meta);

    const button = el('button', {
      type: 'button',
      class: 'btn btn-primary match-choose',
      text: 'Выбрать',
    });
    button.addEventListener('click', () => choose(result, button));

    row.append(info, button);
    return row;
  }

  async function choose(result, button) {
    if (matching) return;
    if (!uploadId) {
      setStatus('Нет активной выгрузки — обнови страницу и попробуй снова.', { error: true });
      return;
    }
    matching = true;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Матчим…';
    setStatus(`Сопоставляем «${result.title || 'фильм'}» с TMDB…`);

    try {
      const kind = result.kind === 'tv' || result.kind === 'movie'
        ? result.kind
        : (select.value === 'tv' ? 'tv' : 'movie');
      await matchFilm({
        uploadId,
        slug: film.slug,
        tmdbId: result.id,
        kind,
      });
      if (closed) return;
      closed = true;
      modal.close();
      toast(`Сматчено: ${result.title || 'фильм'}`, 'success');
      if (typeof onMatched === 'function') onMatched(result);
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      let message = shortErrorMessage(error);
      if (error && error.status === 409) {
        message = 'Этот фильм уже сопоставлен с другой записью TMDB — обнови страницу.';
      } else if (error && error.status === 400) {
        message = 'Сервер ещё не готов принять матч. Попробуй через пару секунд.';
      }
      setStatus(message, { error: true });
    } finally {
      matching = false;
    }
  }

  input.addEventListener('input', debouncedSearch);
  select.addEventListener('change', () => runSearch());
  modal.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      runSearch();
    }
  });

  input.value = film.title || '';
  input.focus();
  input.select();
  runSearch();
  return modal;
}
