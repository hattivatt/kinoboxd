/* Shared modal shell + reusable film-list modal.
 *
 * persons.js, unmatched.js and widgets.js (year click) all open dialogs
 * through openModal() so that Escape, backdrop clicks, focus trapping and
 * body scroll locking behave identically everywhere.
 */

import {
  $, el, clear, fmtInt, fmtRating, icon, plural, toNum, emptyState,
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
 * @param {Array<{title:string,year?:number,posterPath?:string,rating?:number,voteAverage?:number,meta?:string}>} opts.films
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

  if (!list.length) {
    body.append(emptyState(emptyText));
  } else {
    const group = el('div', { class: 'film-group-label' });
    group.append(el('span', { text: groupLabel }));
    if (groupNote) group.append(el('span', { text: groupNote }));
    body.append(group);

    const listHost = el('div', { class: 'film-list' });
    const moreHost = el('div', { class: 'modal-more' });
    body.append(listHost, moreHost);

    const size = Math.max(10, Math.min(Number(batch) || 60, 200));
    let shown = 0;
    const loadBatch = () => {
      const slice = list.slice(shown, shown + size);
      for (const film of slice) listHost.append(filmListRow(film));
      shown += slice.length;
      clear(moreHost);
      if (shown < list.length) {
        const more = el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: `Показать ещё ${fmtInt(Math.min(size, list.length - shown))}`,
        });
        more.addEventListener('click', loadBatch);
        moreHost.append(more);
      }
    };
    loadBatch();
  }

  return openModal({ head, body, labelledBy: titleId, className: 'modal-films' });
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
  row.append(filmRating(film));
  return row;
}

/** Russian count phrase used in modal titles: "66 фильмов 2019 года". */
export function filmCountPhrase(count, year) {
  const n = Math.max(0, Math.round(toNum(count)));
  const base = `${fmtInt(n)} ${plural(n, ['фильм', 'фильма', 'фильмов'])}`;
  return year ? `${base} ${year} года` : base;
}
