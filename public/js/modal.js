/* Shared modal shell + reusable film-list modal.
 *
 * persons.js, unmatched.js and widgets.js (year click) all open dialogs
 * through openModal() so that Escape, backdrop clicks, focus trapping and
 * body scroll locking behave identically everywhere.
 */

import {
  $, el, clear, fmtInt, fmtRating, icon, plural, toNum, emptyState,
  serviceIcon, showTooltip, moveTooltip, hideTooltip,
} from './ui.js';

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

/**
 * Compact aggregator links for one film: Letterboxd / KinoPoisk (source-
 * specific), TMDB (by media kind) and IMDb. Missing ids show no button.
 * Rendered from plain film objects so the links survive re-sorting.
 */
export function filmLinks(film) {
  if (!film) return null;
  const links = [];
  const add = (service, label, href) => {
    if (!href) return;
    const anchor = el('a', {
      class: `film-link film-link-${service}`,
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `${label}: открыть страницу`,
      title: label,
      html: serviceIcon(service, 13),
    });
    anchor.addEventListener('pointerenter', (event) => {
      showTooltip(label, `открыть на ${label}`);
      moveTooltip(event);
    });
    anchor.addEventListener('pointermove', moveTooltip);
    anchor.addEventListener('pointerleave', hideTooltip);
    links.push(anchor);
  };

  add('lb', 'Letterboxd', film.lbUri);
  add('kp', 'Кинопоиск', film.kpUrl);
  if (film.tmdbId != null && Number.isFinite(Number(film.tmdbId))) {
    const kind = film.kind === 'tv' ? 'tv' : 'movie';
    add('tmdb', 'TMDB', `https://www.themoviedb.org/${kind}/${film.tmdbId}`);
  }
  if (film.imdbId) {
    add('imdb', 'IMDb', `https://www.imdb.com/title/${encodeURIComponent(film.imdbId)}/`);
  }

  if (!links.length) return null;
  const host = el('div', { class: 'film-links' });
  for (const link of links) host.append(link);
  return host;
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
  const links = filmLinks(film);
  if (links) info.append(links);
  row.append(info);
  row.append(filmRating(film));
  return row;
}

/** Russian count phrase used in modal titles: "66 фильмов 2019 года". */
export function filmCountPhrase(count, year) {
  const n = Math.max(0, Math.round(toNum(count)));
  const base = `${fmtInt(n)} ${plural(n, ['фильм', 'фильма', 'фильмов'])}`;
  return year ? `${base} ${year} года` : base;
}
