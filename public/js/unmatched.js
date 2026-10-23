/* "Не распознано" tile modal: list of unmatched films + manual TMDB search. */

import {
  el, clear, fmtInt, plural, icon, toNum, emptyState,
} from './ui.js';
import { openModal, renderFilmMenu, openMatchSearchModal } from './modal.js';

const PAGE = 50;

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
    // available even before a manual TMDB match; unmatched rows have no
    // "Исправить матч" item — the button below is their matching flow.
    const actions = el('div', { class: 'unmatched-actions' });
    const menu = renderFilmMenu(film, { allowRematch: false });
    if (menu) actions.append(menu);
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
    openMatchSearchModal({
      film,
      uploadId,
      kind: 'all',
      mode: 'match',
      onPicked: (result) => {
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
