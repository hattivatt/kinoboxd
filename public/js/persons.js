/* Persons widget: role switcher, ranked list, batched rendering, filmography modal. */

import {
  $, el, clear, fmtInt, fmtRating, plural, toNum, emptyState, slugTitle,
} from './ui.js';
import {
  openModal as openModalShell, createFilmSortSelect, getFilmSort, sortFilms, filmSortHint,
} from './modal.js';

const INITIAL = 15;
const BATCH = 50;
const FILM_BATCH = 60;

const JOB_RU = {
  Director: 'Режиссёр',
  'Second Unit Director': 'Второй режиссёр',
  Screenplay: 'Сценарий',
  Writer: 'Сценарист',
  Story: 'Сюжет',
  Characters: 'Персонажи',
  Novel: 'Роман',
  'Original Music Composer': 'Композитор',
  Music: 'Музыка',
  'Additional Music': 'Доп. музыка',
  Teleplay: 'Телесценарий',
};

const ROLES = {
  actor: { label: 'Актёры', one: 'Актёр', forms: ['актёр', 'актёра', 'актёров'] },
  director: { label: 'Режиссёры', one: 'Режиссёр', forms: ['режиссёр', 'режиссёра', 'режиссёров'] },
  writer: { label: 'Сценаристы', one: 'Сценарист', forms: ['сценарист', 'сценариста', 'сценаристов'] },
  composer: { label: 'Композиторы', one: 'Композитор', forms: ['композитор', 'композитора', 'композиторов'] },
  studio: { label: 'Студии', one: 'Студия', forms: ['студия', 'студии', 'студий'] },
};

const PERSON_SORT_SCOPE = 'person';

let stats = null;
let role = 'actor';
let expanded = false;
let visible = INITIAL;
let query = '';
let sorted = [];
let bound = false;
let avgCache = new WeakMap();
let closeModalFn = null;

/* =========================================================
   init + static bindings
   ========================================================= */

export function initPersons(nextStats) {
  if (closeModalFn) closeModalFn();
  stats = nextStats;
  role = 'actor';
  expanded = false;
  visible = INITIAL;
  query = '';
  avgCache = new WeakMap();

  const select = $('persons-role');
  if (select) select.value = 'actor';
  const search = $('persons-search');
  if (search) search.value = '';
  const searchWrap = $('persons-search-wrap');
  if (searchWrap) searchWrap.hidden = true;

  if (!bound) {
    bindStatic();
    bound = true;
  }
  render();
}

function bindStatic() {
  const select = $('persons-role');
  if (select) {
    select.addEventListener('change', () => {
      if (!ROLES[select.value]) return;
      role = select.value;
      expanded = false;
      visible = INITIAL;
      query = '';
      const search = $('persons-search');
      if (search) search.value = '';
      const searchWrap = $('persons-search-wrap');
      if (searchWrap) searchWrap.hidden = true;
      render();
    });
  }

  const search = $('persons-search');
  if (search) {
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      visible = query ? BATCH : (expanded ? Math.max(BATCH, visible) : INITIAL);
      renderList();
    });
  }

  const list = $('person-list');
  if (list) {
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.person-row');
      if (!row) return;
      const person = sorted[Number(row.dataset.index)];
      if (person) openModal(person);
    });
    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('.person-row');
      if (!row) return;
      event.preventDefault();
      const person = sorted[Number(row.dataset.index)];
      if (person) openModal(person);
    });
  }
}

/* =========================================================
   data helpers
   ========================================================= */

function roleList() {
  const raw = stats && stats.persons ? stats.persons[role] : null;
  return (Array.isArray(raw) ? raw : []).filter((person) => person && person.name);
}

function isCounted(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function sortPersons(list) {
  return list.slice().sort((a, b) => {
    const diff = toNum(b.counted) - toNum(a.counted);
    if (diff) return diff;
    return String(a.name).localeCompare(String(b.name), 'ru');
  });
}

function currentList() {
  const all = sortPersons(roleList());
  if (!query) return { all, filtered: all };
  return { all, filtered: all.filter((person) => String(person.name).toLowerCase().includes(query)) };
}

function avgRatingFor(person) {
  if (avgCache.has(person)) return avgCache.get(person);
  const films = Array.isArray(person.films) ? person.films : [];
  let sum = 0;
  let count = 0;
  for (const film of films) {
    if (!film || !isCounted(film.counted)) continue;
    const entry = stats.filmsIndex[film.filmSlug];
    const raw = entry ? entry.rating : null;
    if (raw == null) continue;
    const rating = Number(raw);
    if (Number.isFinite(rating)) {
      sum += rating;
      count += 1;
    }
  }
  const result = count ? sum / count : null;
  avgCache.set(person, result);
  return result;
}

function profileUrl(path, size = 'w185') {
  if (!path || typeof path !== 'string') return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path.startsWith('/') ? '' : '/'}${path}`;
}

function initialOf(name) {
  const chars = Array.from(String(name || '').trim());
  return chars.length ? chars[0].toUpperCase() : '?';
}

function fallbackStyle(name) {
  let hash = 0;
  for (const char of String(name || '?')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return {
    background: `linear-gradient(145deg, hsl(${hue} 32% 33%), hsl(${(hue + 48) % 360} 36% 19%))`,
  };
}

function avatarEl(name, path, extraClass = 'avatar', size = 'w185') {
  const url = profileUrl(path, size);
  if (!url) {
    return el('div', {
      class: `${extraClass} avatar-fallback`,
      style: fallbackStyle(name),
      'aria-hidden': 'true',
      text: initialOf(name),
    });
  }
  const img = el('img', {
    class: extraClass,
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', {
      class: `${extraClass} avatar-fallback`,
      style: fallbackStyle(name),
      'aria-hidden': 'true',
      text: initialOf(name),
    }));
  });
  return img;
}

/* =========================================================
   list rendering
   ========================================================= */

function render() {
  const select = $('persons-role');
  if (select && select.value !== role) select.value = role;

  const searchWrap = $('persons-search-wrap');
  if (searchWrap) searchWrap.hidden = !(expanded || query);

  renderList();
}

function renderList() {
  const listHost = $('person-list');
  const moreHost = $('persons-more');
  const note = $('persons-note');
  if (!listHost || !moreHost) return;

  const { all, filtered } = currentList();
  sorted = filtered;

  if (note) {
    if (!all.length) note.textContent = '';
    else if (query) note.textContent = `${fmtInt(filtered.length)} из ${fmtInt(all.length)}`;
    else note.textContent = `${fmtInt(all.length)} ${plural(all.length, ROLES[role].forms)}`;
  }

  clear(listHost);
  clear(moreHost);

  if (!filtered.length) {
    listHost.append(emptyState(
      all.length ? 'Никого не нашли — попробуй другой запрос' : 'Нет данных о персоналиях',
    ));
    return;
  }

  const slice = filtered.slice(0, visible);
  slice.forEach((person, index) => listHost.append(personRow(person, index)));

  const remaining = filtered.length - visible;
  if (remaining > 0) {
    const button = el('button', {
      type: 'button',
      class: 'btn',
      text: !expanded && !query
        ? `Показать всех (${fmtInt(filtered.length)})`
        : `Показать ещё ${fmtInt(Math.min(BATCH, remaining))}`,
    });
    button.addEventListener('click', () => {
      expanded = true;
      visible = Math.min(filtered.length, visible + BATCH);
      const searchWrap = $('persons-search-wrap');
      if (searchWrap) searchWrap.hidden = false;
      render();
    });
    moreHost.append(button);
  }
}

function personRow(person, index) {
  const counted = toNum(person.counted);
  const total = Math.max(toNum(person.total), Array.isArray(person.films) ? person.films.length : 0);
  const avg = avgRatingFor(person);
  const isStudio = role === 'studio';

  const row = el('div', {
    class: 'person-row',
    role: 'button',
    tabindex: '0',
    'data-index': String(index),
    'data-rank': String(index + 1),
    'aria-label': `${index + 1}. ${person.name}, ${fmtInt(counted)} ${plural(counted, ['фильм', 'фильма', 'фильмов'])}`,
  });

  row.append(el('span', { class: 'person-rank', text: String(index + 1) }));
  row.append(avatarEl(
    person.name,
    person.profilePath,
    isStudio ? 'avatar studio-logo' : 'avatar',
    isStudio ? 'w154' : 'w185',
  ));

  const info = el('div', { class: 'person-info' });
  info.append(el('div', { class: 'person-name', text: person.name }));
  if (isStudio) {
    info.append(el('div', { class: 'person-sub', text: 'кинокомпания' }));
  } else if (total > counted) {
    info.append(el('div', {
      class: 'person-sub',
      text: `учтено ${fmtInt(counted)} из ${fmtInt(total)}`,
    }));
  } else if (Array.isArray(person.films) && person.films.length) {
    info.append(el('div', {
      class: 'person-sub',
      text: `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} в выгрузке`,
    }));
  }
  row.append(info);

  const statsBox = el('div', { class: 'person-stats' });
  statsBox.append(el('div', { class: 'person-count', text: fmtInt(counted) }));
  const avgNode = el('div', { class: 'person-avg' });
  if (avg != null) {
    avgNode.append(el('span', { class: 'star', text: '★' }));
    avgNode.append(document.createTextNode(fmtRating(avg)));
  } else {
    avgNode.textContent = '—';
  }
  statsBox.append(avgNode);
  row.append(statsBox);

  return row;
}

/* =========================================================
   modal
   ========================================================= */

const REASON_TAGS = {
  voice: 'озвучка',
  animation: 'озвучка (мультфильм)',
  insignificant: 'незначимая роль',
  unmatched: 'без данных',
};

function exclusionReason(film) {
  const reason = film && typeof film.reason === 'string' ? film.reason : null;
  return REASON_TAGS[reason] || null;
}

function posterEl(film) {
  const entry = stats.filmsIndex[film.filmSlug] || {};
  const title = entry.title || slugTitle(film.filmSlug);
  const url = profileUrl(entry.posterPath, 'w92');
  if (!url) {
    return el('div', {
      class: 'film-poster poster-fallback',
      'aria-hidden': 'true',
      text: initialOf(title),
    });
  }
  const img = el('img', {
    class: 'film-poster',
    src: url,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', {
      class: 'film-poster poster-fallback',
      'aria-hidden': 'true',
      text: initialOf(title),
    }));
  });
  return img;
}

function filmRow(film) {
  const entry = stats.filmsIndex[film.filmSlug] || {};
  const title = entry.title || slugTitle(film.filmSlug);
  const year = toNum(entry.year);
  const isStudio = role === 'studio';
  const excluded = !isStudio && !isCounted(film.counted);

  const row = el('div', { class: `film-row${excluded ? ' is-excluded' : ''}` });
  row.append(posterEl(film));

  const info = el('div', { class: 'film-info' });
  const titleNode = el('div', { class: 'film-title', text: title });
  if (year > 0) titleNode.append(el('span', { class: 'film-year', text: String(year) }));
  info.append(titleNode);

  let detail = '';
  if (!isStudio && role === 'actor') {
    if (film.character) detail = `«${film.character}»`;
  } else if (!isStudio && film.job) {
    detail = JOB_RU[film.job] || String(film.job);
  }
  if (detail) info.append(el('div', { class: 'film-char', text: detail }));
  row.append(info);

  if (excluded) {
    const tag = exclusionReason(film);
    if (tag) row.append(el('span', { class: 'tag', text: tag }));
  }

  return row;
}

function decorateFilm(film) {
  const entry = stats.filmsIndex[film.filmSlug] || {};
  return {
    ...film,
    title: entry.title || slugTitle(film.filmSlug),
    year: entry.year != null ? entry.year : null,
    rating: entry.rating != null ? entry.rating : null,
    voteAverage: entry.voteAverage != null ? entry.voteAverage : null,
    watchedDate: entry.watchedDate || null,
  };
}

function openModal(person) {
  if (closeModalFn) closeModalFn();
  const isStudio = role === 'studio';
  const films = (Array.isArray(person.films) ? person.films : [])
    .filter((film) => film && film.filmSlug)
    .map(decorateFilm);

  let sortKey = getFilmSort(PERSON_SORT_SCOPE);
  let ordered = sortFilms(films, sortKey);

  const countedFromFilms = films.reduce((sum, film) => sum + (isCounted(film.counted) ? 1 : 0), 0);
  const total = Math.max(films.length, toNum(person.total));
  const counted = Math.min(total, Math.max(countedFromFilms, toNum(person.counted)));
  const excluded = Math.max(0, total - counted);
  const avg = avgRatingFor(person);

  const head = el('div', { class: 'modal-head' });
  head.append(avatarEl(
    person.name,
    person.profilePath,
    isStudio ? 'modal-portrait studio-logo' : 'modal-portrait',
    isStudio ? 'w154' : 'w185',
  ));

  const copy = el('div', { class: 'modal-head-copy' });
  copy.append(el('div', { class: 'modal-role', text: ROLES[role].one }));
  copy.append(el('h2', { class: 'modal-title', id: 'person-modal-title', text: person.name }));
  if (isStudio) {
    copy.append(el('div', {
      class: 'modal-sub',
      text: `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} в прокате`,
    }));
    if (avg != null) {
      copy.append(el('p', {
        class: 'modal-hint',
        text: `Средняя оценка по фильмам компании — ${fmtRating(avg)}.`,
      }));
    }
  } else {
    copy.append(el('div', {
      class: 'modal-sub',
      text: `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} (${fmtInt(counted)} учтено)`,
    }));

    const hintParts = [];
    if (excluded > 0) {
      hintParts.push(`Не учтено ${fmtInt(excluded)}: озвучка, анимация, незначимые роли или нет данных TMDB.`);
    }
    if (avg != null) hintParts.push(`Средняя оценка по учтённым фильмам — ${fmtRating(avg)}.`);
    if (hintParts.length) copy.append(el('p', { class: 'modal-hint', text: hintParts.join(' ') }));
  }
  head.append(copy);

  const body = el('div', { class: 'modal-body' });
  if (!films.length) {
    body.append(emptyState(isStudio ? 'Нет фильмов этой компании' : 'Нет фильмов с этой персоной'));
  } else {
    const group = el('div', { class: 'film-group-label' });
    group.append(el('span', { text: isStudio ? 'Фильмы компании' : 'Фильмография' }));
    const noteNode = el('span', { text: filmSortHint(sortKey) });
    group.append(noteNode);
    body.append(group);

    const listHost = el('div');
    const moreHost = el('div', { class: 'modal-more' });
    body.append(listHost, moreHost);

    let shown = Math.min(FILM_BATCH, ordered.length);
    const renderVisible = () => {
      clear(listHost);
      clear(moreHost);
      for (const film of ordered.slice(0, shown)) listHost.append(filmRow(film));
      if (shown < ordered.length) {
        const more = el('button', {
          type: 'button',
          class: 'btn btn-ghost',
          text: `Показать ещё ${fmtInt(Math.min(FILM_BATCH, ordered.length - shown))}`,
        });
        more.addEventListener('click', () => {
          shown = Math.min(ordered.length, shown + FILM_BATCH);
          renderVisible();
        });
        moreHost.append(more);
      }
    };

    const control = createFilmSortSelect({
      scope: PERSON_SORT_SCOPE,
      onChange: (value) => {
        sortKey = value;
        ordered = sortFilms(films, sortKey);
        noteNode.textContent = filmSortHint(sortKey);
        renderVisible();
      },
    });
    head.append(control.node);

    renderVisible();
  }

  if (!films.length) {
    // Keep the selector reachable even when the list is empty.
    const control = createFilmSortSelect({ scope: PERSON_SORT_SCOPE });
    head.append(control.node);
  }

  const modal = openModalShell({
    head,
    body,
    labelledBy: 'person-modal-title',
    onClose: () => {
      closeModalFn = null;
    },
  });
  if (modal) closeModalFn = modal.close;
}
