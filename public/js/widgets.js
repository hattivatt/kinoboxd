/* Dashboard widgets: summary strip + charts + persons. */

import {
  $, el, clear, fmtInt, fmtPercent, fmtRating, fmtPeriod, fmtWatchTime, plural, icon,
  monthName, monthShort, toNum, emptyState, showTooltip, moveTooltip, hideTooltip, debounce, slugTitle,
} from './ui.js';
import { renderDonut, renderTimeline, renderYearBars } from './charts.js';
import { initPersons } from './persons.js';
import { openFilmListModal, filmCountPhrase, EXTRA_SORT_OPTIONS, setFilmMenuContext } from './modal.js';
import { openUnmatchedModal } from './unmatched.js';

let dashHooks = {};

const RATING_COLORS = [
  '#e8253f', '#f1553b', '#ff7a30', '#ffa42b', '#ffd23f',
  '#c9e64e', '#00e054', '#00c9a7', '#40bcf4', '#7b6bff',
];
const DECADE_COLORS = ['#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166'];
const YEAR_COLORS = [
  '#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166',
  '#00c9a7', '#f472b6', '#8ddb3f', '#7189ff', '#ff9e64', '#5eead4',
];
const GENRE_RU = {
  Action: 'Боевик',
  Adventure: 'Приключения',
  Animation: 'Анимация',
  Comedy: 'Комедия',
  Crime: 'Криминал',
  Documentary: 'Документальный',
  Drama: 'Драма',
  Family: 'Семейный',
  Fantasy: 'Фэнтези',
  History: 'История',
  Horror: 'Ужасы',
  Music: 'Музыка',
  Mystery: 'Детектив',
  Romance: 'Мелодрама',
  'Science Fiction': 'Фантастика',
  'TV Movie': 'ТВ-фильм',
  Thriller: 'Триллер',
  War: 'Военный',
  Western: 'Вестерн',
};

function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one keyword-taxonomy bucket (categories / origins / periods). */
function mapTaxonomy(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      key: String(item && item.key ? item.key : '').trim(),
      name: String(item && item.name ? item.name : '').trim(),
      count: Math.max(0, toNum(item && item.count)),
      avgRating: numOrNull(item && item.avgRating),
      films: Array.isArray(item && item.films)
        ? item.films.map((slug) => String(slug)).filter(Boolean)
        : [],
    }))
    .filter((item) => item.key && item.name && item.count > 0);
}

/**
 * Build a modal-ready film object from one filmsIndex entry. Link fields are
 * copied verbatim so every openFilmListModal() row can render them and they
 * keep working after re-sorting.
 */
function filmFromEntry(slug, entry, extra = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return {
    slug,
    title: e.title || slugTitle(slug),
    year: toNum(e.year) || null,
    posterPath: e.posterPath || null,
    rating: numOrNull(e.rating),
    voteAverage: numOrNull(e.voteAverage),
    watchedDate: e.watchedDate || null,
    runtime: numOrNull(e.runtime),
    kind: e.kind === 'tv' ? 'tv' : 'movie',
    tmdbId: e.tmdbId != null ? e.tmdbId : null,
    imdbId: e.imdbId || null,
    lbUri: e.lbUri || null,
    kpUrl: e.kpUrl || null,
    ...extra,
  };
}

function normalizeStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
  const persons = source.persons && typeof source.persons === 'object' ? source.persons : {};
  const sourceRaw = summary.source && typeof summary.source === 'object' ? summary.source : null;
  const array = (value) => (Array.isArray(value) ? value : []);

  const unmatched = array(source.unmatched)
    .map((item) => ({
      slug: String(item && item.slug ? item.slug : '').trim(),
      title: String(item && item.title ? item.title : '').trim(),
      year: toNum(item && item.year),
      lbUri: item && typeof item.lbUri === 'string' ? item.lbUri : null,
      kpUrl: item && typeof item.kpUrl === 'string' ? item.kpUrl : null,
    }))
    .filter((item) => item.slug);

  return {
    summary: {
      filmCount: toNum(summary.filmCount),
      ratedCount: toNum(summary.ratedCount),
      dateFrom: summary.dateFrom || null,
      dateTo: summary.dateTo || null,
      totalMinutes: numOrNull(summary.totalMinutes),
      unmatchedCount: Math.max(unmatched.length, Math.max(0, toNum(summary.unmatchedCount))),
      source: sourceRaw ? {
        type: String(sourceRaw.type || '').trim().toLowerCase(),
        kpUserId: sourceRaw.kpUserId != null ? String(sourceRaw.kpUserId) : '',
        kpNick: sourceRaw.kpNick ? String(sourceRaw.kpNick) : '',
        fetchedAt: sourceRaw.fetchedAt || null,
      } : null,
    },
    unmatched,
    ratings: array(source.ratings)
      .map((item) => ({ score: toNum(item && item.score, -1), count: Math.max(0, toNum(item && item.count)) }))
      .filter((item) => item.score >= 0 && item.score <= 10),
    genres: array(source.genres)
      .map((item) => {
        const rawName = String(item && item.name ? item.name : '').trim();
        return {
          key: String(item && item.key ? item.key : '').trim(),
          name: GENRE_RU[rawName] || rawName,
          count: Math.max(0, toNum(item && item.count)),
          avgRating: numOrNull(item && item.avgRating),
          films: array(item && item.films)
            .map((slug) => String(slug))
            .filter(Boolean),
        };
      })
      .filter((item) => item.name && item.count > 0),
    decades: array(source.decades)
      .map((item) => ({
        label: String(item && item.label ? item.label : '').trim().replace(/^(\d{4})s$/i, '$1-е'),
        start: numOrNull(item && item.start) ?? 0,
        count: Math.max(0, toNum(item && item.count)),
      }))
      .filter((item) => item.label && item.count > 0),
    years: array(source.years)
      .map((item) => ({
        year: toNum(item && item.year),
        count: Math.max(0, toNum(item && item.count)),
      }))
      .filter((item) => item.year > 0 && item.count > 0),
    timeline: array(source.timeline).filter((item) => item && item.month),
    persons: {
      actor: array(persons.actor),
      director: array(persons.director),
      writer: array(persons.writer),
      composer: array(persons.composer),
      studio: array(persons.studio),
    },
    origins: mapTaxonomy(source.origins),
    periods: mapTaxonomy(source.periods),
    filmsIndex: source.filmsIndex && typeof source.filmsIndex === 'object' ? source.filmsIndex : {},
  };
}

export function renderDashboard(rawStats, hooks = {}) {
  dashHooks = hooks && typeof hooks === 'object' ? hooks : {};
  // Film rows live inside modals rendered outside this call (persons,
  // openFilmListModal), so hand them the current upload id and refresh hook.
  setFilmMenuContext({
    uploadId: typeof dashHooks.getUploadId === 'function' ? dashHooks.getUploadId() : null,
    refreshStats: typeof dashHooks.refreshStats === 'function'
      ? dashHooks.refreshStats
      : null,
  });
  const stats = normalizeStats(rawStats);
  const isKinopoisk = Boolean(stats.summary.source && stats.summary.source.type === 'kinopoisk');
  const kicker = $('dash-kicker');
  if (kicker) kicker.textContent = isKinopoisk ? 'Кинопоиск · сводка' : 'Letterboxd · сводка';
  const sub = $('dash-sub');
  if (sub) {
    sub.textContent = isKinopoisk
      ? 'Собрано из оценок Кинопоиска и карточек TMDB.'
      : 'Собрано из дневника, оценок и карточек TMDB.';
  }
  renderSummary(stats);
  renderRatings(stats);
  renderGenres(stats);
  /* Full dashboard render always starts with no decade picked: the years
     card is intentionally empty until the user selects a decade. */
  selectedDecade = null;
  renderDecades(stats);
  renderYears(stats);
  renderOrigins(stats);
  renderPeriods(stats);
  renderYearBarsWidget(stats);
  renderTimelineWidget(stats);
  initPersons(stats);
}

/* =========================================================
   summary strip
   ========================================================= */

function renderSummary(stats) {
  const host = $('summary-strip');
  if (!host) return;
  clear(host);
  const { summary } = stats;

  const ratedFromRatings = stats.ratings
    .filter((item) => item.score >= 1)
    .reduce((sum, item) => sum + item.count, 0);
  const totalFromRatings = stats.ratings.reduce((sum, item) => sum + item.count, 0);
  const filmCount = summary.filmCount || totalFromRatings;
  const ratedCount = summary.ratedCount || ratedFromRatings;
  const watch = summary.totalMinutes != null ? fmtWatchTime(summary.totalMinutes) : null;
  const ratedShare = filmCount > 0 ? fmtPercent(ratedCount, filmCount) : '';
  const isKinopoisk = Boolean(summary.source && summary.source.type === 'kinopoisk');

  const metric = (iconName, label, valueNode, sub = '', title = '', extraClass = '') => {
    const node = el('div', { class: `metric${extraClass ? ` ${extraClass}` : ''}` });
    const labelNode = el('div', { class: 'metric-label' });
    if (iconName) labelNode.innerHTML = icon(iconName, 12);
    labelNode.append(document.createTextNode(label));
    node.append(labelNode);
    node.append(valueNode);
    if (sub) node.append(el('div', { class: 'metric-sub', text: sub }));
    if (title) node.title = title;
    return node;
  };

  host.append(metric('film', 'всего фильмов',
    el('div', { class: 'metric-value', text: fmtInt(filmCount) }),
    summary.dateFrom || summary.dateTo
      ? (isKinopoisk ? 'по профилю Кинопоиска' : 'по данным дневника')
      : '',
  ));

  host.append(metric('star', 'с оценками',
    el('div', { class: 'metric-value', text: fmtInt(ratedCount) }),
    ratedShare ? `${ratedShare} от всех` : '',
  ));

  host.append(renderWatchMetric(stats, watch));

  host.append(metric('calendar', 'период',
    el('div', { class: 'metric-value is-small', text: fmtPeriod(summary.dateFrom, summary.dateTo) }),
    'первый — последний просмотр',
  ));

  host.append(renderSourceMetric(summary.source));

  host.classList.toggle('has-unmatched', summary.unmatchedCount > 0);
  if (summary.unmatchedCount > 0) host.append(renderUnmatchedMetric(stats));
}

/* "watch time" tile: opens the longest-viewings list (runtime desc). */
function renderWatchMetric(stats, watch) {
  const node = el('button', {
    type: 'button',
    class: 'metric metric-clickable',
    title: watch ? `${watch.title} — открыть самые длинные просмотры` : 'Самые длинные просмотры',
    'aria-label': 'Время просмотра. Открыть самые длинные просмотры',
  });
  const labelNode = el('div', { class: 'metric-label' });
  labelNode.innerHTML = icon('clock', 12);
  labelNode.append(document.createTextNode('время просмотра'));
  node.append(labelNode);
  node.append(el('div', {
    class: 'metric-value',
    title: watch ? watch.title : 'Нет данных',
    text: watch ? watch.value : '—',
  }));
  node.append(el('div', { class: 'metric-sub', text: watch ? watch.sub : 'нет данных' }));
  node.addEventListener('click', () => {
    hideTooltip();
    openRuntimeModal(stats);
  });
  return node;
}

/** All films with their runtime, longest first (unknown runtime at the end). */
function openRuntimeModal(stats) {
  const films = [];
  for (const [slug, entry] of Object.entries(stats.filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const runtime = numOrNull(entry.runtime);
    films.push(filmFromEntry(slug, entry, {
      meta: runtime != null && runtime > 0 ? `${fmtInt(runtime)} мин` : 'длительность неизвестна',
    }));
  }
  const total = numOrNull(stats.summary.totalMinutes);
  const totalText = total != null && total > 0 ? fmtWatchTime(total).title : '';
  openFilmListModal({
    kicker: 'Время просмотра',
    title: 'Самые длинные просмотры',
    subtitle: [
      `${fmtInt(films.length)} ${plural(films.length, ['фильм', 'фильма', 'фильмов'])}`,
      totalText,
    ].filter(Boolean).join(' · '),
    hint: 'Сортировка по длительности: сначала самые долгие, фильмы без хронометража — в конце.',
    groupLabel: 'Длительность',
    emptyText: 'Нет фильмов с карточкой TMDB',
    films,
    sortScope: 'runtime',
    extraSorts: EXTRA_SORT_OPTIONS,
    defaultSort: 'runtime',
    batch: 60,
  });
}

/* unmatched tile: only when there is at least one film without a TMDB match */
function renderUnmatchedMetric(stats) {
  const count = stats.summary.unmatchedCount;
  const node = el('button', {
    type: 'button',
    class: 'metric metric-unmatched',
    id: 'metric-unmatched',
    title: `Не распознано: ${fmtInt(count)} — открыть список`,
    'aria-label': `Не распознано: ${fmtInt(count)}. Открыть список фильмов без пары`,
  });

  const labelNode = el('div', { class: 'metric-label' });
  labelNode.innerHTML = icon('alert', 12);
  labelNode.append(document.createTextNode('не распознано'));
  node.append(labelNode);
  node.append(el('div', {
    class: 'metric-value',
    text: fmtInt(count),
  }));
  node.append(el('div', {
    class: 'metric-sub',
    text: count > 0 ? 'сматчить вручную' : 'всё найдено',
  }));

  node.addEventListener('click', () => {
    hideTooltip();
    openUnmatchedModal({
      items: stats.unmatched,
      uploadId: typeof dashHooks.getUploadId === 'function' ? dashHooks.getUploadId() : null,
      onMatched: () => {
        if (typeof dashHooks.refreshStats === 'function') return dashHooks.refreshStats();
        return null;
      },
    });
  });
  return node;
}

/* source tile: Letterboxd ZIP or Kinopoisk profile */
function formatFetchedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
}

function renderSourceMetric(source) {
  const isKinopoisk = Boolean(source && source.type === 'kinopoisk');
  const plate = el('div', { class: `source-plate${isKinopoisk ? '' : ' is-letterboxd'}` });

  if (isKinopoisk) {
    plate.innerHTML = icon('kp', 13);
    plate.append(el('span', { text: 'Кинопоиск' }));
    plate.append(el('span', { class: 'src-sep', text: '·' }));
    const who = source.kpNick || (source.kpUserId ? `user ${source.kpUserId}` : 'профиль');
    plate.append(el('span', {
      class: 'src-uid',
      text: who,
    }));

    const fetched = formatFetchedAt(source.fetchedAt);
    const sub = fetched ? `список оценок получен ${fetched}` : 'оценки Кинопоиска';
    const metricNode = el('div', { class: 'metric metric-source' });
    const labelNode = el('div', { class: 'metric-label' });
    labelNode.innerHTML = icon('kp', 12);
    labelNode.append(document.createTextNode('источник'));
    metricNode.append(labelNode);
    const valueNode = el('div', { class: 'metric-value' });
    valueNode.append(plate);
    metricNode.append(valueNode);
    metricNode.append(el('div', { class: 'metric-sub', text: sub }));

    const primary = source.kpNick
      ? `Кинопоиск · ${source.kpNick}`
      : `Кинопоиск · ${source.kpUserId ? `user ${source.kpUserId}` : 'профиль'}`;
    const tooltipSecondary = [
      source.kpNick && source.kpUserId ? `user ${source.kpUserId}` : '',
      fetched ? `список оценок получен ${fetched}` : 'источник: профиль Кинопоиска',
    ].filter(Boolean).join(' · ');
    metricNode.addEventListener('pointerenter', (event) => {
      showTooltip(primary, tooltipSecondary);
      moveTooltip(event);
    });
    metricNode.addEventListener('pointermove', moveTooltip);
    metricNode.addEventListener('pointerleave', hideTooltip);
    return metricNode;
  }

  plate.append(el('span', { text: 'Letterboxd' }));
  const metricNode = el('div', { class: 'metric metric-source' });
  const labelNode = el('div', { class: 'metric-label' });
  labelNode.innerHTML = icon('upload', 12);
  labelNode.append(document.createTextNode('источник'));
  metricNode.append(labelNode);
  const valueNode = el('div', { class: 'metric-value' });
  valueNode.append(plate);
  metricNode.append(valueNode);
  metricNode.append(el('div', { class: 'metric-sub', text: 'ZIP-выгрузка' }));

  metricNode.addEventListener('pointerenter', (event) => {
    showTooltip('Letterboxd', 'источник: ZIP-выгрузка из Settings → Data');
    moveTooltip(event);
  });
  metricNode.addEventListener('pointermove', moveTooltip);
  metricNode.addEventListener('pointerleave', hideTooltip);
  return metricNode;
}

/* =========================================================
   A. ratings
   ========================================================= */

function renderRatings(stats) {
  const donutHost = $('ratings-donut');
  const legendHost = $('ratings-legend');
  const note = $('ratings-note');
  if (!donutHost || !legendHost) return;

  const counts = new Map();
  for (const item of stats.ratings) {
    if (item.score >= 1) counts.set(item.score, (counts.get(item.score) || 0) + item.count);
  }
  const unrated = stats.ratings
    .filter((item) => item.score === 0)
    .reduce((sum, item) => sum + item.count, 0);

  const segments = [];
  let ratedTotal = 0;
  for (let score = 1; score <= 10; score += 1) {
    const count = counts.get(score) || 0;
    ratedTotal += count;
    segments.push({
      key: `score-${score}`,
      label: String(score),
      value: count,
      color: RATING_COLORS[score - 1],
      score,
    });
  }
  if (unrated > 0) {
    segments.push({ key: 'score-0', label: 'Без оценки', value: unrated, color: '#566675', score: 0 });
  }
  const totalAll = ratedTotal + unrated;

  if (note) {
    note.textContent = totalAll > 0
      ? `${fmtInt(ratedTotal)} из ${fmtInt(totalAll)}`
      : 'нет оценок';
  }

  if (!totalAll) {
    clear(legendHost);
    clear(donutHost);
    donutHost.append(emptyState('Оценок в выгрузке нет'));
    return;
  }

  const isKp = Boolean(stats.summary.source && stats.summary.source.type === 'kinopoisk');
  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(ratedTotal),
    centerLabel: 'оценок',
    ariaLabel: `Распределение по оценкам, ${fmtInt(ratedTotal)} оценённых фильмов`,
    secondary: (seg) => `${fmtPercent(seg.value, totalAll)} всех фильмов`,
    onSelect: (seg) => {
      hideTooltip();
      openRatingsModal(stats, toNum(seg.score), isKp);
    },
  });
}

/* Letterboxd ratings are half-stars (0.5-5 -> 1-10); KinoPoisk already 1-10. */
function filmScore(entry, isKp) {
  if (!entry || entry.rating == null) return 0;
  const rating = Number(entry.rating);
  if (!Number.isFinite(rating)) return 0;
  return isKp ? Math.round(rating) : Math.round(rating * 2);
}

function openRatingsModal(stats, score, isKp) {
  const films = [];
  for (const [slug, entry] of Object.entries(stats.filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (filmScore(entry, isKp) !== score) continue;
    films.push(filmFromEntry(slug, entry));
  }
  const count = films.length;
  const phrase = filmCountPhrase(count);
  const title = score === 0 ? `Без оценки — ${phrase}` : `${phrase} с оценкой ${fmtInt(score)}`;
  openFilmListModal({
    kicker: 'Оценки',
    title,
    subtitle: score === 0
      ? 'Фильмы без вашей оценки'
      : `Ваша оценка ${fmtInt(score)} из 10`,
    groupLabel: score === 0 ? 'Без оценки' : `Оценка ${score}`,
    emptyText: score === 0 ? 'Все фильмы с оценками' : 'Нет фильмов с этой оценкой',
    films,
    sortScope: 'ratings',
    batch: 60,
  });
}

/* =========================================================
   B. genres
   ========================================================= */

function renderGenreRow(host, item, max, { isCategory = false, onClick = null } = {}) {
  const row = el('div', { class: `genre-row${isCategory ? ' is-category' : ''}${onClick ? ' is-clickable' : ''}` });
  const name = el('div', { class: 'genre-name' });
  name.append(el('span', { class: 'genre-label', text: item.name }));
  name.append(el('span', { class: 'genre-count', text: fmtInt(item.count) }));

  const track = el('div', { class: 'genre-track' });
  const fill = el('div', { class: 'genre-fill' });
  track.append(fill);

  const avg = item.avgRating != null ? fmtRating(item.avgRating) : '—';
  const avgNode = el('div', {
    class: 'genre-avg',
    text: avg,
    title: item.avgRating != null ? `Средняя оценка: ${fmtRating(item.avgRating)}` : 'Нет оценок в этой категории',
  });

  row.append(name, track, avgNode);
  host.append(row);

  requestAnimationFrame(() => {
    fill.style.width = `${Math.max(2, (item.count / max) * 100)}%`;
  });

  const kindLabel = isCategory ? 'категория' : 'жанр';
  row.addEventListener('pointerenter', (event) => {
    showTooltip(
      `${item.name} — ${fmtInt(item.count)} ${plural(item.count, ['фильм', 'фильма', 'фильмов'])}`,
      item.avgRating != null
        ? `${kindLabel} · средняя оценка ${fmtRating(item.avgRating)}`
        : `${kindLabel} · средней оценки нет`,
    );
    moveTooltip(event);
  });
  row.addEventListener('pointermove', moveTooltip);
  row.addEventListener('pointerleave', hideTooltip);

  if (onClick) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `${item.name}: ${fmtInt(item.count)} фильмов. Открыть список`);
    row.addEventListener('click', () => {
      hideTooltip();
      onClick(item);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      onClick(item);
    });
  }
}

function renderGenres(stats) {
  const host = $('genres-list');
  const note = $('genres-note');
  if (!host) return;

  // stats.genres is already the merged genre + category list (count desc,
  // name asc on ties) from the backend. Re-sorting here keeps old cached
  // payloads consistent and makes the widget independent of payload order.
  const items = stats.genres
    .slice()
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));

  if (note) {
    note.textContent = items.length
      ? `${fmtInt(items.length)} ${plural(items.length, ['жанр', 'жанра', 'жанров'])}`
      : '';
  }

  clear(host);

  if (!items.length) {
    host.append(emptyState('Жанры появятся после обогащения TMDB'));
    return;
  }

  const max = Math.max(1, ...items.map((item) => item.count));
  for (const item of items) {
    // Genre buckets use the "genre-<id>" key; keyword taxonomy buckets use
    // short slugs ("musical", "anime", …). Only the latter are categories.
    const isCategory = !/^genre-/.test(item.key || '');
    renderGenreRow(host, item, max, {
      isCategory,
      onClick: (rowItem) => openGenreModal(stats, rowItem, { isCategory }),
    });
  }
}

/** Films of one merged genre/category bucket. */
function openGenreModal(stats, item, { isCategory = false } = {}) {
  let films = [];
  if (Array.isArray(item.films) && item.films.length) {
    films = filmsFromSlugs(stats.filmsIndex, item.films);
  } else {
    // Fallback for old payloads / genre buckets without a films array:
    // match the localized genre name against the film index.
    const target = String(item && item.name ? item.name : '').trim().toLowerCase();
    if (target) {
      for (const [slug, entry] of Object.entries(stats.filmsIndex || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const genres = Array.isArray(entry.genres) ? entry.genres : [];
        if (!genres.some((name) => String(name || '').trim().toLowerCase() === target)) continue;
        films.push(filmFromEntry(slug, entry));
      }
    }
  }
  const count = films.length;
  const avg = item.avgRating != null ? ` · средняя оценка ${fmtRating(item.avgRating)}` : '';
  openFilmListModal({
    kicker: isCategory ? 'Категория' : 'Жанр',
    title: item.name,
    subtitle: `${fmtInt(count)} ${plural(count, ['фильм', 'фильма', 'фильмов'])}${avg}`,
    groupLabel: item.name,
    emptyText: 'Нет фильмов с карточкой TMDB',
    films,
    sortScope: isCategory ? 'taxonomy' : 'genre',
  });
}

/* =========================================================
   C/D. decades + years (linked)
   ========================================================= */

/* Selected decade drives the years card. null = nothing selected, which is
   the default state: the years donut is not rendered at all. */
let selectedDecade = null;
let decadesDonut = null;

function decadeHint(text = 'Выберите десятилетие слева, чтобы увидеть годы') {
  const box = el('div', { class: 'years-empty' });
  box.append(el('span', { class: 'years-empty-ring', 'aria-hidden': 'true' }));
  box.append(el('p', { class: 'years-empty-text', text }));
  return box;
}

function selectDecade(stats, decade) {
  const same = selectedDecade && selectedDecade.start === decade.start;
  selectedDecade = same ? null : { start: decade.start, label: decade.label };
  if (decadesDonut) {
    decadesDonut.setSelected(selectedDecade ? `decade-${selectedDecade.start}` : null);
  }
  renderYears(stats);
}

function renderDecades(stats) {
  const donutHost = $('decades-donut');
  const legendHost = $('decades-legend');
  const note = $('decades-note');
  if (!donutHost || !legendHost) return;

  decadesDonut = null;
  const decades = stats.decades.slice().sort((a, b) => b.start - a.start || b.label.localeCompare(a.label, 'ru'));
  const total = decades.reduce((sum, item) => sum + item.count, 0);
  if (note) note.textContent = decades.length ? `${fmtInt(decades.length)} ${plural(decades.length, ['десятилетие', 'десятилетия', 'десятилетий'])}` : '';

  clear(legendHost);
  clear(donutHost);
  if (!total) {
    donutHost.append(emptyState('Нет данных по десятилетиям'));
    return;
  }

  const segments = decades.map((item, index) => ({
    key: `decade-${item.start}`,
    label: item.label,
    value: item.count,
    color: DECADE_COLORS[index % DECADE_COLORS.length],
    decadeStart: item.start,
  }));
  const selectedKey = selectedDecade ? `decade-${selectedDecade.start}` : null;

  decadesDonut = renderDonut(donutHost, {
    segments,
    legendHost,
    selectedKey,
    onSelect: (seg) => selectDecade(stats, { start: seg.decadeStart, label: seg.label }),
    centerValue: fmtInt(total),
    centerLabel: 'фильмов',
    ariaLabel: 'Распределение фильмов по десятилетиям. Выберите десятилетие, чтобы увидеть годы',
    secondary: (seg) => `${fmtPercent(seg.value, total)} всех фильмов`,
  });
}

function renderYears(stats) {
  const donutHost = $('years-donut');
  const legendHost = $('years-legend');
  const note = $('years-note');
  const titleText = $('years-title-text');
  if (!donutHost || !legendHost) return;

  clear(legendHost);
  clear(donutHost);

  if (titleText) titleText.textContent = selectedDecade ? `Годы · ${selectedDecade.label}` : 'Годы';

  if (!selectedDecade) {
    if (note) note.textContent = '';
    donutHost.append(decadeHint());
    return;
  }

  const start = toNum(selectedDecade.start)
    || toNum((String(selectedDecade.label).match(/\d{4}/) || [])[0]);
  const years = stats.years
    .filter((item) => item.year >= start && item.year <= start + 9)
    .sort((a, b) => b.year - a.year);
  const total = years.reduce((sum, item) => sum + item.count, 0);

  if (note) {
    note.textContent = total
      ? `${start}–${start + 9} · ${fmtInt(years.length)} ${plural(years.length, ['год', 'года', 'лет'])}`
      : 'нет фильмов';
  }

  if (!total) {
    donutHost.append(decadeHint(`В ${selectedDecade.label} нет фильмов`));
    return;
  }

  const segments = years.map((item, index) => ({
    key: `year-${item.year}`,
    label: String(item.year),
    value: item.count,
    color: YEAR_COLORS[index % YEAR_COLORS.length],
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(total),
    centerLabel: 'фильмов',
    ariaLabel: `Распределение фильмов по годам: ${selectedDecade.label}`,
    secondary: (seg) => `${fmtPercent(seg.value, total)} фильмов десятилетия`,
    onSelect: (seg) => {
      const year = Number(seg.label);
      if (!Number.isFinite(year) || year <= 0) return;
      hideTooltip();
      openYearModal(stats, year);
    },
  });
}

/* =========================================================
   C2. keyword categories modal helper
   ========================================================= */

const ORIGIN_COLORS = ['#00e054', '#40bcf4', '#ff8000', '#e8253f', '#b18cff', '#ffd166', '#00c9a7', '#f472b6'];
const PERIOD_COLORS = ['#e8253f', '#ffd166', '#40bcf4', '#00e054', '#b18cff', '#ff8000', '#00c9a7', '#f472b6'];

/** Build modal-ready film rows from the slugs stored in a taxonomy bucket. */
function filmsFromSlugs(filmsIndex, slugs) {
  const films = [];
  for (const slug of Array.isArray(slugs) ? slugs : []) {
    const entry = filmsIndex && filmsIndex[slug];
    if (!entry || typeof entry !== 'object') continue;
    films.push(filmFromEntry(slug, entry));
  }
  return films;
}

/** Shared modal for categories / origins / periods (all carry `films`). */
function openTaxonomyModal(stats, item, { kicker = '', sortScope = 'taxonomy' } = {}) {
  const films = filmsFromSlugs(stats.filmsIndex, item.films);
  const avg = item.avgRating != null ? ` · средняя оценка ${fmtRating(item.avgRating)}` : '';
  openFilmListModal({
    kicker,
    title: item.name,
    subtitle: `${fmtInt(films.length)} ${plural(films.length, ['фильм', 'фильма', 'фильмов'])}${avg}`,
    groupLabel: item.name,
    emptyText: 'Нет фильмов с карточкой TMDB',
    batch: 60,
    films,
    sortScope,
  });
}

/* =========================================================
   C3. originals / adaptations donut
   ========================================================= */

function renderOrigins(stats) {
  const donutHost = $('origins-donut');
  const legendHost = $('origins-legend');
  const note = $('origins-note');
  if (!donutHost || !legendHost) return;

  clear(donutHost);
  clear(legendHost);

  const origins = stats.origins.filter((item) => item.count > 0);
  const total = origins.reduce((sum, item) => sum + item.count, 0);
  if (!total) {
    if (note) note.textContent = '';
    donutHost.append(emptyState('Нет данных об экранизациях'));
    return;
  }
  if (note) {
    note.textContent = `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])}`;
  }

  const segments = origins.map((item, index) => ({
    key: `origin-${item.key}`,
    label: item.name,
    value: item.count,
    color: ORIGIN_COLORS[index % ORIGIN_COLORS.length],
    originKey: item.key,
    avgRating: item.avgRating,
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(total),
    centerLabel: 'фильмов',
    ariaLabel: 'Оригинальные сценарии и экранизации. Нажмите на сегмент, чтобы увидеть фильмы',
    secondary: (seg) => {
      const pct = `${fmtPercent(seg.value, total)} всех фильмов`;
      return seg.avgRating != null ? `${pct} · средняя ${fmtRating(seg.avgRating)}` : pct;
    },
    onSelect: (seg) => {
      const item = origins.find((entry) => entry.key === seg.originKey);
      if (item) {
        hideTooltip();
        openTaxonomyModal(stats, item, { kicker: 'Оригинальные и экранизации', sortScope: 'origins' });
      }
    },
  });
}

/* =========================================================
   C4. film movements / periods donut + list
   ========================================================= */

function renderPeriods(stats) {
  const section = $('w-periods-widget');
  const donutHost = $('periods-donut');
  const legendHost = $('periods-legend');
  const note = $('periods-note');
  if (!donutHost || !legendHost) return;

  const periods = stats.periods.filter((item) => item.count > 0);
  // A donut with one wedge carries no information; hide the whole widget.
  if (section) section.hidden = periods.length < 2;
  if (periods.length < 2) {
    clear(donutHost);
    clear(legendHost);
    if (note) note.textContent = '';
    return;
  }

  clear(donutHost);
  clear(legendHost);

  const total = periods.reduce((sum, item) => sum + item.count, 0);
  if (note) {
    note.textContent = `${fmtInt(periods.length)} ${plural(periods.length, ['движение', 'движения', 'движений'])}`;
  }

  const segments = periods.map((item, index) => ({
    key: `period-${item.key}`,
    label: item.name,
    value: item.count,
    color: PERIOD_COLORS[index % PERIOD_COLORS.length],
    periodKey: item.key,
    avgRating: item.avgRating,
  }));

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(total),
    centerLabel: 'фильмов',
    ariaLabel: 'Кинематографические движения и периоды. Нажмите на сегмент, чтобы увидеть фильмы',
    secondary: (seg) => {
      const pct = `${fmtPercent(seg.value, total)} упоминаний`;
      return seg.avgRating != null ? `${pct} · средняя ${fmtRating(seg.avgRating)}` : pct;
    },
    onSelect: (seg) => {
      const item = periods.find((entry) => entry.key === seg.periodKey);
      if (item) {
        hideTooltip();
        openTaxonomyModal(stats, item, { kicker: 'Периоды', sortScope: 'periods' });
      }
    },
  });
}

/* =========================================================
   D2. views by release year
   ========================================================= */

/* Country picked in the year-bars widget. null = "all countries", in which
 * case the chart is rendered straight from stats.years (no extra work).
 * The choice survives refreshStats() because renderDashboard() does not touch
 * it; main.js resets it when the profile switcher selects another profile. */
let selectedCountry = null;

export function resetYearBarsCountry() {
  selectedCountry = null;
}

/** Countries of all matched films: [{ name, count }], most films first. */
function countryCounts(filmsIndex) {
  const map = new Map();
  for (const entry of Object.values(filmsIndex || {})) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.countries)) continue;
    for (const name of entry.countries) {
      if (!name) continue;
      map.set(name, (map.get(name) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

/** Local aggregation by release year for one country (matched films only). */
function yearsForCountry(filmsIndex, country) {
  const map = new Map();
  for (const entry of Object.values(filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Array.isArray(entry.countries) || !entry.countries.includes(country)) continue;
    const year = toNum(entry.year);
    if (!year) continue;
    map.set(year, (map.get(year) || 0) + 1);
  }
  return [...map.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);
}

function renderCountryFilter(stats, countries) {
  const select = $('yearbars-country');
  if (!select) return;
  clear(select);
  select.append(el('option', { value: '', text: 'Все' }));
  for (const country of countries) {
    select.append(el('option', { value: country.name, text: country.name }));
  }
  select.value = selectedCountry || '';
  select.onchange = () => {
    selectedCountry = select.value || null;
    renderYearBarsWidget(stats);
  };
}

function renderYearBarsWidget(stats) {
  const host = $('yearbars-chart');
  if (!host) return;

  if (host._boxdResize) {
    host._boxdResize.disconnect();
    host._boxdResize = null;
  }

  const countries = countryCounts(stats.filmsIndex);
  // A profile switch may leave a country that does not exist in the new data.
  if (selectedCountry && !countries.some((country) => country.name === selectedCountry)) {
    selectedCountry = null;
  }
  renderCountryFilter(stats, countries);

  const series = selectedCountry
    ? yearsForCountry(stats.filmsIndex, selectedCountry)
    : stats.years;
  const total = series.reduce((sum, item) => sum + toNum(item.count), 0);

  const onYearClick = (year) => openYearModal(stats, year);

  if (selectedCountry && !series.length) {
    clear(host);
    host.append(emptyState('Нет фильмов этой страны'));
  } else {
    renderYearBars(host, series, { onYearClick });
  }

  const note = $('yearbars-note');
  if (note) {
    if (selectedCountry) {
      note.textContent = total
        ? `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} · страна: ${selectedCountry}`
        : 'нет фильмов этой страны';
    } else {
      const years = series.slice().sort((a, b) => a.year - b.year);
      if (!years.length) note.textContent = 'нет данных';
      else if (years.length === 1) note.textContent = String(years[0].year);
      else note.textContent = `${years[0].year} — ${years[years.length - 1].year}`;
    }
  }

  if (typeof ResizeObserver === 'function') {
    const rerender = debounce(() => {
      if (!host.clientWidth) return;
      renderYearBars(host, series, { onYearClick });
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._boxdResize = observer;
  }
}

/* Year column click: films of that release year, user rating first. When a
 * country filter is active, only that country's films are listed. */
function filmsForYear(filmsIndex, year, country = null) {
  const target = toNum(year);
  if (!target) return [];
  const films = [];
  for (const [slug, entry] of Object.entries(filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (toNum(entry.year) !== target) continue;
    if (country && (!Array.isArray(entry.countries) || !entry.countries.includes(country))) continue;
    films.push(filmFromEntry(slug, entry, { year: target }));
  }
  films.sort((a, b) => {
    const ratingDiff = (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating);
    if (ratingDiff) return ratingDiff;
    const voteDiff = (b.voteAverage == null ? -1 : b.voteAverage) - (a.voteAverage == null ? -1 : a.voteAverage);
    if (voteDiff) return voteDiff;
    return a.title.localeCompare(b.title, 'ru');
  });
  return films;
}

function openYearModal(stats, year) {
  const country = selectedCountry;
  const films = filmsForYear(stats.filmsIndex, year, country);
  const count = films.length;
  const n = toNum(year);
  const title = country
    ? `${filmCountPhrase(count, n)} · ${country}`
    : filmCountPhrase(count, n);
  openFilmListModal({
    kicker: 'Просмотры по годам проката',
    title,
    subtitle: `${String(n)} год · ${fmtInt(count)} ${plural(count, ['фильм', 'фильма', 'фильмов'])}${country ? ` · ${country}` : ' в выгрузке'}`,
    hint: country ? `Только фильмы страны ${country}.` : '',
    groupLabel: String(n),
    emptyText: country ? 'Нет фильмов этой страны за этот год' : 'Для этого года нет фильмов с карточкой TMDB',
    batch: 60,
    films,
    sortScope: 'year',
  });
}

/* =========================================================
   E. timeline
   ========================================================= */

/** Films whose last watched date falls into one `YYYY-MM` bucket. */
function openMonthModal(stats, month) {
  const prefix = String(month || '');
  const films = [];
  if (/^\d{4}-\d{2}$/.test(prefix)) {
    for (const [slug, entry] of Object.entries(stats.filmsIndex || {})) {
      if (!entry || typeof entry !== 'object') continue;
      const watched = entry.watchedDate ? String(entry.watchedDate) : '';
      if (!watched.startsWith(prefix)) continue;
      films.push(filmFromEntry(slug, entry));
    }
  }
  const label = monthName(prefix);
  const count = films.length;
  openFilmListModal({
    kicker: 'История просмотров',
    title: `Просмотрено: ${label}`,
    subtitle: `${fmtInt(count)} ${plural(count, ['фильм', 'фильма', 'фильмов'])} · ${label}`,
    groupLabel: label,
    emptyText: 'За этот месяц в выгрузке нет фильмов',
    films,
    sortScope: 'month',
  });
}

function renderTimelineWidget(stats) {
  const host = $('timeline-chart');
  if (!host) return;

  if (host._boxdResize) {
    host._boxdResize.disconnect();
    host._boxdResize = null;
  }

  const onMonthClick = (month) => openMonthModal(stats, month);
  renderTimeline(host, stats.timeline, { onMonthClick });

  const months = stats.timeline
    .filter((item) => item && /^\d{4}-\d{2}$/.test(item.month))
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month));

  const note = $('timeline-note');
  if (note) {
    if (!months.length) note.textContent = 'нет данных';
    else if (months.length === 1) note.textContent = monthShort(months[0].month);
    else note.textContent = `${monthShort(months[0].month)} — ${monthShort(months[months.length - 1].month)}`;
  }

  if (typeof ResizeObserver === 'function') {
    const rerender = debounce(() => {
      if (!host.clientWidth) return;
      renderTimeline(host, stats.timeline, { onMonthClick });
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._boxdResize = observer;
  }
}
