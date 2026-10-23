/* Shared modal shell + reusable film-list modal.
 *
 * persons.js, unmatched.js and widgets.js (year click) all open dialogs
 * through openModal() so that Escape, backdrop clicks, focus trapping and
 * body scroll locking behave identically everywhere.
 */

import {
  $, el, clear, fmtInt, fmtRating, icon, plural, toNum, emptyState,
  serviceIcon, toast, debounce, shortErrorMessage,
} from './ui.js';
import { searchTmdb, matchFilm } from './api.js';

let seq = 0;
const stack = [];
const active = new Set();

/* =========================================================
   shared poster / rating bits
   ========================================================= */

export function posterUrl(path, size = 'w92') {
  if (!path || typeof path !== 'string') return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path.startsWith('/') ? '' : '/'}${path}`;
}

function initialOf(name) {
  const chars = Array.from(String(name || '').trim());
  return chars.length ? chars[0].toUpperCase() : '?';
}

function fallbackPoster(title, extraClass = '') {
  return el('div', {
    class: `film-poster poster-fallback${extraClass ? ` ${extraClass}` : ''}`,
    'aria-hidden': 'true',
    text: initialOf(title),
  });
}

export function posterThumb(path, title) {
  const url = posterUrl(path, 'w92');
  if (!url) return fallbackPoster(title);
  const img = el('img', {
    class: 'film-poster',
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => {
    img.replaceWith(fallbackPoster(title));
  });
  return img;
}

export function filmRating(entry) {
  const rating = entry && entry.rating != null ? Number(entry.rating) : null;
  const vote = entry && entry.voteAverage != null ? Number(entry.voteAverage) : null;
  const node = el('div', { class: 'film-rating' });
  if (rating != null && Number.isFinite(rating)) {
    node.append(el('span', { class: 'film-rating-star', text: '★' }));
    node.append(el('span', { text: fmtRating(rating) }));
    node.title = `Ваша оценка: ${fmtRating(rating)}`;
    if (vote != null && Number.isFinite(vote)) {
      node.append(el('span', { class: 'film-rating-tmdb', text: `TMDB ${fmtRating(vote)}` }));
    }
  } else if (vote != null && Number.isFinite(vote)) {
    node.append(el('span', { class: 'film-rating-tmdb', text: `TMDB ${fmtRating(vote)}` }));
    node.title = `Рейтинг TMDB: ${fmtRating(vote)}`;
  } else {
    node.textContent = '—';
    node.classList.add('is-empty');
  }
  return node;
}

/* =========================================================
   film sorting (shared by the person / studio / year modals)
   ========================================================= */

export const FILM_SORT_OPTIONS = [
  { key: 'rating', label: 'По моей оценке', hint: 'ваша оценка ↓' },
  { key: 'watched', label: 'По дате просмотра', hint: 'дата просмотра ↓' },
  { key: 'year', label: 'По году выхода', hint: 'год выхода ↓' },
];

/* Only offered by callers that opt in (the "watch time" modal). */
export const EXTRA_SORT_OPTIONS = [
  { key: 'runtime', label: 'По длительности', hint: 'длительность ↓' },
];

const ALL_SORT_OPTIONS = [...FILM_SORT_OPTIONS, ...EXTRA_SORT_OPTIONS];
const SORT_VALUES = new Set(ALL_SORT_OPTIONS.map((option) => option.key));
const SORT_STORAGE_PREFIX = 'kinoboxd.modalSort.';

function sortStorageKey(scope) {
  return `${SORT_STORAGE_PREFIX}${scope || 'films'}`;
}

/**
 * Saved sort for a modal type, validated against the known options.
 * `allowed` narrows the accepted keys for one dialog (e.g. runtime is only
 * offered in the watch-time modal); otherwise the fallback applies.
 */
export function getFilmSort(scope, { allowed = null, fallback = 'rating' } = {}) {
  let value = '';
  try {
    value = window.localStorage.getItem(sortStorageKey(scope)) || '';
  } catch {
    value = '';
  }
  if (!SORT_VALUES.has(value)) return fallback;
  if (allowed && !allowed.has(value)) return fallback;
  return value;
}

export function setFilmSort(scope, value) {
  if (!SORT_VALUES.has(value)) return;
  try {
    window.localStorage.setItem(sortStorageKey(scope), value);
  } catch {
    /* private mode / storage disabled — sorting still works for this dialog */
  }
}

function pickNum(value) {
  return value == null || value === '' ? null : Number(value);
}

function cmpTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
}

function cmpVote(a, b) {
  const av = pickNum(a.voteAverage);
  const bv = pickNum(b.voteAverage);
  const diff = (bv == null || !Number.isFinite(bv) ? -1 : bv) - (av == null || !Number.isFinite(av) ? -1 : av);
  return diff || cmpTitle(a, b);
}

function cmpRating(a, b) {
  const ar = pickNum(a.rating);
  const br = pickNum(b.rating);
  const diff = (br == null || !Number.isFinite(br) ? -1 : br) - (ar == null || !Number.isFinite(ar) ? -1 : ar);
  return diff || cmpVote(a, b);
}

function cmpWatched(a, b) {
  const ad = a.watchedDate ? String(a.watchedDate) : '';
  const bd = b.watchedDate ? String(b.watchedDate) : '';
  if (ad !== bd) {
    if (!ad) return 1;
    if (!bd) return -1;
    return bd.localeCompare(ad);
  }
  return cmpTitle(a, b);
}

function cmpYear(a, b) {
  const ay = pickNum(a.year);
  const by = pickNum(b.year);
  const diff = (by == null || !Number.isFinite(by) ? -1 : by) - (ay == null || !Number.isFinite(ay) ? -1 : ay);
  return diff || cmpVote(a, b);
}

function cmpRuntime(a, b) {
  const ar = pickNum(a.runtime);
  const br = pickNum(b.runtime);
  // Unknown/zero runtimes go to the end.
  const av = ar == null || !Number.isFinite(ar) || ar <= 0 ? -1 : ar;
  const bv = br == null || !Number.isFinite(br) || br <= 0 ? -1 : br;
  return (bv - av) || cmpRating(a, b);
}

/** Return a new array ordered by the selected sort. Input is not mutated. */
export function sortFilms(films, sortKey) {
  const list = Array.isArray(films) ? films.slice() : [];
  const comparator =
    sortKey === 'watched' ? cmpWatched
      : sortKey === 'year' ? cmpYear
        : sortKey === 'runtime' ? cmpRuntime
          : cmpRating;
  return list.sort(comparator);
}

export function filmSortHint(sortKey) {
  const option = ALL_SORT_OPTIONS.find((item) => item.key === sortKey);
  return option ? option.hint : '';
}

/** Small native select used in modal headers. */
export function createFilmSortSelect({
  scope, onChange, extraOptions = [], allowedKeys = null, fallback = 'rating',
} = {}) {
  const wrap = el('div', { class: 'modal-sort' });
  wrap.append(el('span', { class: 'modal-sort-label', text: 'Сортировка' }));

  const options = [...FILM_SORT_OPTIONS, ...extraOptions];
  const allowed = allowedKeys || new Set(options.map((option) => option.key));

  const selectWrap = el('div', { class: 'select-wrap' });
  const select = el('select', {
    class: 'select select-sm',
    'aria-label': 'Сортировка фильмов',
  });
  for (const option of options) {
    select.append(el('option', { value: option.key, text: option.label }));
  }
  select.value = getFilmSort(scope, { allowed, fallback });
  select.addEventListener('change', () => {
    const value = select.value;
    setFilmSort(scope, value);
    if (typeof onChange === 'function') onChange(value);
  });
  selectWrap.append(select);
  selectWrap.append(el('span', { class: 'select-chevron', html: icon('chevron', 14) }));
  wrap.append(selectWrap);
  return { node: wrap, value: select.value, select };
}

/* =========================================================
   generic shell
   ========================================================= */

/**
 * Open a modal shell. The caller supplies the head content (without the
 * close button) and an optional `.modal-body` node.
 *
 * @param {object} opts
 * @param {HTMLElement} [opts.head]  contents of `.modal-head` (close is added)
 * @param {HTMLElement} [opts.body]  usually `el('div', {class:'modal-body'})`
 * @param {string} [opts.labelledBy]
 * @param {string} [opts.className]  extra class on `.modal`
 * @param {() => void} [opts.onClose]
 * @returns {{close:()=>void, panel:HTMLElement, body:HTMLElement|null, head:HTMLElement}|null}
 */
export function openModal({ head, body = null, labelledBy = '', className = '', onClose } = {}) {
  const root = $('modal-root');
  if (!root) return null;

  seq += 1;
  const titleId = `modal-title-${seq}`;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const panel = el('div', {
    class: `modal${className ? ` ${className}` : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
  });
  if (labelledBy) panel.setAttribute('aria-labelledby', labelledBy);

  const headNode = head || el('div', { class: 'modal-head' });
  if (!headNode.classList.contains('modal-head')) headNode.classList.add('modal-head');
  const closeButton = el('button', {
    type: 'button',
    class: 'modal-close',
    'aria-label': 'Закрыть',
    html: icon('close', 16),
  });
  headNode.append(closeButton);

  panel.append(headNode);
  if (body) panel.append(body);
  backdrop.append(panel);

  const previouslyFocused = document.activeElement;
  let closed = false;

  const onKeyDown = (event) => {
    // Only the top-most dialog reacts, so Escape closes just one layer.
    if (stack[stack.length - 1] !== onKeyDown) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  function close() {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(onKeyDown);
    if (index >= 0) stack.splice(index, 1);
    active.delete(handle);
    document.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    if (!stack.length) document.body.classList.remove('modal-open');
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    if (typeof onClose === 'function') onClose();
  }

  const handle = { close, panel, body, head: headNode };
  active.add(handle);

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });

  document.addEventListener('keydown', onKeyDown);
  stack.push(onKeyDown);
  document.body.classList.add('modal-open');
  root.append(backdrop);
  closeButton.focus();

  // `titleId` is exposed for callers that need an accessible label.
  panel.dataset.titleId = titleId;
  return handle;
}

export function closeAllModals() {
  for (const handle of Array.from(active)) handle.close();
}

/* =========================================================
   reusable film list modal (year click, future reuse)
   ========================================================= */

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.kicker]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.hint]
 * @param {string} [opts.groupLabel]
 * @param {string} [opts.groupNote]
 * @param {string} [opts.emptyText]
 * @param {number} [opts.batch]
 * @param {Array<{title:string,year?:number,posterPath?:string,rating?:number,voteAverage?:number,watchedDate?:string,meta?:string,runtime?:number,lbUri?:string,kpUrl?:string,tmdbId?:number,kind?:string,imdbId?:string}>} opts.films
 * @param {string} [opts.sortScope]  localStorage scope for the sort selector ('year', ...)
 * @param {Array<{key:string,label:string,hint:string}>} [opts.extraSorts] extra sorts for this dialog only
 * @param {string} [opts.defaultSort] sort used when nothing valid is stored for the scope
 */
export function openFilmListModal({
  title,
  kicker = '',
  subtitle = '',
  hint = '',
  groupLabel = 'Фильмы',
  groupNote = '',
  emptyText = 'Нет фильмов',
  batch = 60,
  films = [],
  sortScope = '',
  extraSorts = [],
  defaultSort = null,
} = {}) {
  seq += 1;
  const titleId = `film-list-title-${seq}`;
  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  if (kicker) copy.append(el('div', { class: 'modal-role', text: kicker }));
  copy.append(el('h2', { class: 'modal-title', id: titleId, text: title || 'Фильмы' }));
  if (subtitle) copy.append(el('div', { class: 'modal-sub', text: subtitle }));
  if (hint) copy.append(el('p', { class: 'modal-hint', text: hint }));
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  const list = Array.isArray(films) ? films.filter(Boolean) : [];

  const sortOptions = [...FILM_SORT_OPTIONS, ...extraSorts];
  const allowedSorts = new Set(sortOptions.map((option) => option.key));
  let sortKey = sortScope
    ? getFilmSort(sortScope, { allowed: allowedSorts, fallback: defaultSort || 'rating' })
    : null;
  let ordered = sortScope ? sortFilms(list, sortKey) : list;
  let groupNoteNode = null;

  if (sortScope) {
    const control = createFilmSortSelect({
      scope: sortScope,
      extraOptions: extraSorts,
      allowedKeys: allowedSorts,
      fallback: defaultSort || 'rating',
      onChange: (value) => {
        sortKey = value;
        ordered = sortFilms(list, sortKey);
        if (groupNoteNode) groupNoteNode.textContent = filmSortHint(sortKey);
        if (typeof renderVisible === 'function') renderVisible();
      },
    });
    head.append(control.node);
    groupNote = filmSortHint(sortKey);
  }

  let renderVisible = null;

  if (!list.length) {
    body.append(emptyState(emptyText));
  } else {
    const group = el('div', { class: 'film-group-label' });
    group.append(el('span', { text: groupLabel }));
    if (groupNote) {
      groupNoteNode = el('span', { text: groupNote });
      group.append(groupNoteNode);
    }
    body.append(group);

    const listHost = el('div', { class: 'film-list' });
    const moreHost = el('div', { class: 'modal-more' });
    body.append(listHost, moreHost);

    const size = Math.max(10, Math.min(Number(batch) || 60, 200));
    let shown = Math.min(size, ordered.length);

    renderVisible = () => {
      clear(listHost);
      clear(moreHost);
      const slice = ordered.slice(0, shown);
      for (const film of slice) listHost.append(filmListRow(film));
      if (shown < ordered.length) {
        const more = el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: `Показать ещё ${fmtInt(Math.min(size, ordered.length - shown))}`,
        });
        more.addEventListener('click', () => {
          shown = Math.min(ordered.length, shown + size);
          renderVisible();
        });
        moreHost.append(more);
      }
    };
    renderVisible();
  }

  return openModal({ head, body, labelledBy: titleId, className: 'modal-films' });
}

/* =========================================================
   film actions menu (aggregator links + manual re-match)
   ========================================================= */

let filmMenuContext = { uploadId: null, refreshStats: null };
let openFilmMenu = null;

/**
 * Dashboard-wide context for film rows rendered outside the dashboard
 * render call (persons modal, openFilmListModal rows). widgets.js updates
 * this on every dashboard render.
 */
export function setFilmMenuContext(context = {}) {
  filmMenuContext = {
    uploadId: context.uploadId !== undefined ? context.uploadId : filmMenuContext.uploadId,
    refreshStats: context.refreshStats !== undefined
      ? context.refreshStats
      : filmMenuContext.refreshStats,
  };
}

function closeFilmMenu() {
  const close = openFilmMenu;
  openFilmMenu = null;
  if (close) close();
}

/** Links available for one film, in menu order. */
function filmLinkItems(film) {
  const items = [];
  if (film.lbUri) items.push({ service: 'lb', label: 'Letterboxd', href: film.lbUri });
  if (film.kpUrl) items.push({ service: 'kp', label: 'Кинопоиск', href: film.kpUrl });
  if (film.tmdbId != null && Number.isFinite(Number(film.tmdbId))) {
    const kind = film.kind === 'tv' ? 'tv' : 'movie';
    items.push({
      service: 'tmdb',
      label: 'TMDB',
      href: `https://www.themoviedb.org/${kind}/${film.tmdbId}`,
    });
  }
  if (film.imdbId) {
    items.push({
      service: 'imdb',
      label: 'IMDb',
      href: `https://www.imdb.com/title/${encodeURIComponent(film.imdbId)}/`,
    });
  }
  return items;
}

/**
 * Kebab menu shown in the right-hand column of every film row.
 *
 * @param {object} film  filmsIndex-shaped object (slug/title/year/tmdbId/kind/imdbId/lbUri/kpUrl)
 * @param {object} [opts]
 * @param {string|null} [opts.uploadId]  override the dashboard upload id
 * @param {boolean} [opts.allowRematch]  false hides "Исправить матч" (unmatched rows)
 * @param {() => void} [opts.onRematched] called after a successful POST /api/match
 * @returns {HTMLElement|null}
 */
export function renderFilmMenu(film, opts = {}) {
  if (!film) return null;
  const links = filmLinkItems(film);
  const canRematch = opts.allowRematch !== false &&
    Boolean(film.slug) &&
    film.tmdbId != null &&
    Number.isFinite(Number(film.tmdbId));
  if (!links.length && !canRematch) return null;

  const context = filmMenuContext;
  const uploadId = opts.uploadId !== undefined ? opts.uploadId : context.uploadId;

  const wrap = el('div', { class: 'film-menu' });
  const toggle = el('button', {
    type: 'button',
    class: 'film-menu-toggle',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': 'Ссылки и действия',
    title: 'Ссылки и действия',
    html: icon('more', 16),
  });
  wrap.append(toggle);

  function cleanup() {
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onWindowChange, true);
    window.removeEventListener('resize', onWindowChange);
  }

  function close() {
    cleanup();
    if (popup) {
      popup.remove();
      popup = null;
    }
  }

  function onDocPointerDown(event) {
    if (popup && popup.contains(event.target)) return;
    if (wrap.contains(event.target)) return;
    closeFilmMenu();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    // Keep the modal open: Escape only dismisses the menu layer.
    event.preventDefault();
    event.stopPropagation();
    closeFilmMenu();
  }

  function onWindowChange(event) {
    // Scrolling the clicked row into view fires a scroll event right after
    // the menu opens; ignore that first tick so it does not self-dismiss.
    if (Date.now() - openedAt < 350) return;
    if (event && event.type === 'scroll' && popup && popup.contains(event.target)) return;
    closeFilmMenu();
  }

  let popup = null;
  let openedAt = 0;

  function open() {
    closeFilmMenu();
    popup = el('div', {
      class: 'film-menu-popup',
      role: 'menu',
      'aria-label': `Ссылки и действия: ${film.title || 'фильм'}`,
    });

    for (const item of links) {
      const anchor = el('a', {
        class: 'film-menu-item',
        role: 'menuitem',
        href: item.href,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
        el('span', { class: 'film-menu-icon', html: serviceIcon(item.service, 14) }),
        el('span', { class: 'film-menu-label', text: item.label }),
      );
      anchor.addEventListener('click', () => closeFilmMenu());
      popup.append(anchor);
    }

    if (canRematch) {
      if (links.length) popup.append(el('div', { class: 'film-menu-sep', role: 'separator' }));
      const rematch = el('button', {
        type: 'button',
        class: 'film-menu-item film-menu-rematch',
        role: 'menuitem',
      },
        el('span', { class: 'film-menu-icon', html: icon('pencil', 14) }),
        el('span', { class: 'film-menu-label', text: 'Исправить матч' }),
      );
      rematch.addEventListener('click', () => {
        closeFilmMenu();
        if (uploadId == null) {
          toast('Данные устарели — обнови профиль', 'error');
          return;
        }
        openMatchSearchModal({
          film,
          uploadId,
          kind: film.kind === 'tv' ? 'tv' : 'movie',
          mode: 'rematch',
          onPicked: (result, response) => {
            if (typeof opts.onRematched === 'function') {
              opts.onRematched(result, response);
              return;
            }
            if (typeof context.refreshStats === 'function') context.refreshStats();
          },
        });
      });
      popup.append(rematch);
    }

    if (!links.length && !canRematch) {
      popup.remove();
      popup = null;
      return;
    }

    document.body.append(popup);
    toggle.setAttribute('aria-expanded', 'true');

    // Fixed-position portal: film lists scroll inside modals, and an
    // absolutely positioned popup would be clipped by .modal-body.
    const rect = toggle.getBoundingClientRect();
    popup.style.visibility = 'hidden';
    const popupRect = popup.getBoundingClientRect();
    let left = Math.max(8, Math.min(rect.right - popupRect.width, window.innerWidth - popupRect.width - 8));
    let top = rect.bottom + 6;
    if (top + popupRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - popupRect.height - 6);
    }
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.style.visibility = '';

    openFilmMenu = close;
    openedAt = Date.now();
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onWindowChange, true);
    window.addEventListener('resize', onWindowChange);
  }

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popup) {
      closeFilmMenu();
      return;
    }
    open();
  });

  return wrap;
}

export function filmListRow(film) {
  const row = el('div', { class: 'film-row film-row-static' });
  const title = film.title || 'Без названия';
  row.append(posterThumb(film.posterPath, title));

  const info = el('div', { class: 'film-info' });
  const titleNode = el('div', { class: 'film-title', text: title });
  const year = toNum(film.year);
  if (year > 0) titleNode.append(el('span', { class: 'film-year', text: String(year) }));
  info.append(titleNode);
  if (film.meta) info.append(el('div', { class: 'film-char', text: film.meta }));
  row.append(info);

  const controls = el('div', { class: 'film-row-controls' });
  controls.append(filmRating(film));
  const menu = renderFilmMenu(film);
  if (menu) controls.append(menu);
  row.append(controls);
  return row;
}

/** Russian count phrase used in modal titles: "66 фильмов 2019 года". */
export function filmCountPhrase(count, year) {
  const n = Math.max(0, Math.round(toNum(count)));
  const base = `${fmtInt(n)} ${plural(n, ['фильм', 'фильма', 'фильмов'])}`;
  return year ? `${base} ${year} года` : base;
}

/* =========================================================
   shared TMDB search / match dialog
   ========================================================= */

const KIND_LABEL = {
  movie: 'фильм',
  tv: 'сериал',
  all: 'всё',
};

function kindLabel(kind) {
  return KIND_LABEL[kind] || 'фильм';
}

function apiErrorCode(error) {
  if (!error) return '';
  if (typeof error.code === 'string' && error.code) return error.code;
  const payload = error.payload;
  return payload && typeof payload === 'object' && typeof payload.error === 'string'
    ? payload.error
    : '';
}

let matchSeq = 0;

/**
 * Manual TMDB search dialog, shared by the unmatched list and the
 * "Исправить матч" action in matched film rows.
 *
 * @param {object} opts
 * @param {object} opts.film  { slug, title, year, kind }
 * @param {string|null} opts.uploadId
 * @param {string} [opts.initialQuery] defaults to the film title
 * @param {'movie'|'tv'|'all'} [opts.kind] pre-selected search type
 * @param {'match'|'rematch'} [opts.mode] changes copy/toast wording
 * @param {(result:object, response:object) => void} [opts.onPicked]
 */
export function openMatchSearchModal({
  film = {},
  uploadId = null,
  initialQuery = '',
  kind = 'all',
  mode = 'match',
  onPicked = null,
} = {}) {
  matchSeq += 1;
  const id = `match-search-title-${matchSeq}`;
  const rematch = mode === 'rematch';
  const head = el('div', { class: 'modal-head' });
  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: rematch ? 'Исправить матч · TMDB' : 'Ручной матч · TMDB' }));
  copy.append(el('h2', {
    class: 'modal-title',
    id,
    text: rematch ? 'Найти правильную запись в TMDB' : 'Найти фильм в TMDB',
  }));
  const year = toNum(film.year);
  copy.append(el('div', {
    class: 'modal-sub',
    text: `Для «${film.title || film.slug || 'фильм'}»${year > 0 ? ` (${year})` : ''} · slug: ${film.slug || '—'}`,
  }));
  copy.append(el('p', {
    class: 'modal-hint',
    text: rematch
      ? 'Выбери правильный вариант — старый матч будет заменён, статистика пересчитается.'
      : 'Выбери подходящий результат. Мы привяжем его к этой записи и пересчитаем статистику.',
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
      if (apiErrorCode(error) === 'aborted') return;
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
      text: rematch ? 'Перематчить' : 'Выбрать',
    });
    button.addEventListener('click', () => choose(result, button));

    row.append(info, button);
    return row;
  }

  async function choose(result, button) {
    if (matching) return;
    if (!uploadId) {
      const message = 'Данные устарели — обнови профиль';
      setStatus(message, { error: true });
      toast(message, 'error');
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
      const response = await matchFilm({
        uploadId,
        slug: film.slug,
        tmdbId: result.id,
        kind,
      });
      if (closed) return;
      closed = true;
      modal.close();
      const name = result.title || 'фильм';
      toast(rematch ? `Пересматчено: «${name}»` : `Сматчено: ${name}`, 'success');
      if (typeof onPicked === 'function') {
        try {
          onPicked(result, response);
        } catch {
          /* dashboard refresh is best-effort */
        }
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = label;
      const code = apiErrorCode(error);
      let message = shortErrorMessage(error);
      if (error && error.status === 409) {
        message = 'Этот фильм уже сопоставлен с другой записью TMDB — обнови страницу.';
      } else if (error && error.status === 400) {
        message = 'Сервер ещё не готов принять матч. Попробуй через пару секунд.';
      } else if (code === 'unknown_upload' || error && error.status === 404) {
        message = 'Данные устарели — обнови профиль';
        toast(message, 'error');
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

  select.value = kind === 'movie' || kind === 'tv' ? kind : 'all';
  input.value = initialQuery || film.title || '';
  input.focus();
  input.select();
  runSearch();
  return modal;
}
