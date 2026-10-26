/* Dashboard widgets: summary strip + charts + persons. */

import {
  $, el, clear, fmtInt, fmtPercent, fmtRating, fmtPeriod, fmtWatchTime, plural, icon,
  monthName, monthShort, toNum, emptyState, showTooltip, moveTooltip, hideTooltip, debounce, slugTitle,
} from './ui.js';
import { renderDonut, renderTimeline, renderYearBars } from './charts.js';
import { initPersons } from './persons.js';
import {
  openFilmListModal, filmCountPhrase, EXTRA_SORT_OPTIONS, setFilmMenuContext,
  posterThumb, renderFilmMenu,
} from './modal.js';
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
  Animation: 'Мультфильмы',
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

/** Days since epoch for a `YYYY-MM-DD` string (UTC, no DST). */
function dayIndex(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

/**
 * Server streaks, with a local fallback so an older cached payload that
 * already has watchDays (but not streaks) still renders the card. Same rule:
 * the current run ends at the last viewing and is independent of today.
 */
function normalizeStreaks(raw, watchDays) {
  const validDate = (value) => dayIndex(value) != null;
  if (raw && typeof raw === 'object') {
    const current = Math.max(0, toNum(raw.current));
    const best = Math.max(0, toNum(raw.best));
    const lastWatchDate = validDate(raw.lastWatchDate) ? String(raw.lastWatchDate).slice(0, 10) : null;
    const bestDates = Array.isArray(raw.bestDates)
      ? raw.bestDates.map((date) => String(date).slice(0, 10)).filter(validDate)
      : [];
    if (best > 0 || lastWatchDate) {
      return { current, best, lastWatchDate, bestDates };
    }
  }
  const dates = (Array.isArray(watchDays) ? watchDays : [])
    .map((entry) => String((entry && entry.date) || '').slice(0, 10))
    .filter(validDate)
    .sort();
  if (!dates.length) return { current: 0, best: 0, lastWatchDate: null, bestDates: [] };
  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) run++;
    else { run = 1; runStart = dates[i]; }
    if (run > best) { best = run; bestFrom = runStart; bestTo = dates[i]; }
  }
  let current = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (dayIndex(dates[i]) - dayIndex(dates[i - 1]) === 1) current++;
    else break;
  }
  return {
    current,
    best,
    lastWatchDate: dates[dates.length - 1],
    bestDates: [bestFrom, bestTo],
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

  const attachedRaw = summary.attachedLb && typeof summary.attachedLb === 'object'
    ? summary.attachedLb
    : null;

  return {
    summary: {
      filmCount: toNum(summary.filmCount),
      ratedCount: toNum(summary.ratedCount),
      dateFrom: summary.dateFrom || null,
      dateTo: summary.dateTo || null,
      totalMinutes: numOrNull(summary.totalMinutes),
      unmatchedCount: Math.max(unmatched.length, Math.max(0, toNum(summary.unmatchedCount))),
      rewatchCount: Math.max(0, toNum(summary.rewatchCount)),
      attachedLb: attachedRaw ? {
        fileName: attachedRaw.fileName ? String(attachedRaw.fileName) : null,
        attachedAt: attachedRaw.attachedAt || null,
        events: Math.max(0, toNum(attachedRaw.events)),
        ratedEvents: Math.max(0, toNum(attachedRaw.ratedEvents)),
      } : null,
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
    watchDays: array(source.watchDays)
      .map((item) => {
        const date = String((item && item.date) || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        return {
          date,
          count: Math.max(0, toNum(item && item.count)),
          slugs: array(item && item.slugs).map((slug) => String(slug)).filter(Boolean),
        };
      })
      .filter((item) => item && item.count > 0)
      .sort((a, b) => a.date.localeCompare(b.date)),
    recentlyWatched: array(source.recentlyWatched)
      .map((item) => ({
        date: String((item && item.date) || '').slice(0, 10),
        slug: String((item && item.slug) || '').trim(),
        rewatch: item && item.rewatch === true,
      }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.slug),
    streaks: normalizeStreaks(source.streaks, array(source.watchDays)),
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
    const attachment = isKinopoisk ? stats.summary.attachedLb : null;
    sub.textContent = isKinopoisk
      ? (attachment
        ? `Оценки Кинопоиска, карточки TMDB и Letterboxd-архив: реальные даты просмотра, пересмотры${stats.summary.rewatchCount ? ` (${fmtInt(stats.summary.rewatchCount)})` : ''}.`
        : 'Собрано из оценок Кинопоиска и карточек TMDB. Прикрепите Letterboxd-архив ради реальных дат и пересмотров.')
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
  renderRecentlyWatched(stats);
  renderWatchCalendar(stats);
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

  host.append(renderSourceMetric(summary.source, summary.attachedLb));

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

function renderSourceMetric(source, attachedLb = null) {
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
    const attached = attachedLb && typeof attachedLb === 'object' ? attachedLb : null;
    if (attached) {
      plate.append(el('span', { class: 'src-sep', text: '·' }));
      plate.append(el('span', {
        class: 'src-lb-tag',
        text: 'LB',
        title: `Letterboxd: ${attached.fileName || 'архив'}`,
      }));
    }

    const fetched = formatFetchedAt(source.fetchedAt);
    const attachedAt = attached ? formatFetchedAt(attached.attachedAt) : '';
    const subParts = [
      fetched ? `оценки получены ${fetched}` : 'оценки Кинопоиска',
      attached ? `LB-событий: ${fmtInt(attached.events)}` : '',
      attached && attachedAt ? `архив ${attachedAt}` : '',
    ].filter(Boolean);
    const sub = subParts.join(' · ');
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
      attached
        ? `Letterboxd: ${attached.fileName || 'архив'}${attachedAt ? ` от ${attachedAt}` : ''} · ` +
          `${fmtInt(attached.events)} событий, ${fmtInt(attached.ratedEvents)} с оценкой КП`
        : '',
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

/* Country and genre/style picked in the year-bars widget. null = "all", in
 * which case the chart is rendered straight from stats.years (no extra work).
 * The choices survive refreshStats() because renderDashboard() does not touch
 * them; main.js resets both when the profile switcher selects another
 * profile or the uploadId changes. */
let selectedCountry = null;
let selectedGenreKey = null;

export function resetYearBarsFilters() {
  selectedCountry = null;
  selectedGenreKey = null;
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

/**
 * Build the combined country + genre/style predicate over filmsIndex.
 *
 * TMDB genre buckets use a "genre-<id>" key and are matched against the
 * localized genre names in filmsIndex (case-insensitive). Derived taxonomy
 * buckets ("giallo", "spaghetti-western", "noir", …) arrive with an explicit
 * `films` slug list, so membership is a set lookup.
 */
function yearBarsPredicate(country, genre) {
  const genreName =
    genre && /^genre-/.test(genre.key || '')
      ? String(genre.name || '').trim().toLowerCase()
      : '';
  const derivedSlugs =
    genre && !genreName
      ? new Set((Array.isArray(genre.films) ? genre.films : []).map(String))
      : null;
  return (slug, entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (country && (!Array.isArray(entry.countries) || !entry.countries.includes(country))) {
      return false;
    }
    if (genreName) {
      const genres = Array.isArray(entry.genres) ? entry.genres : [];
      if (!genres.some((name) => String(name || '').trim().toLowerCase() === genreName)) {
        return false;
      }
    }
    if (derivedSlugs && !derivedSlugs.has(slug)) return false;
    return true;
  };
}

/** Local aggregation by release year for the active filters. */
function yearsForFilters(filmsIndex, predicate) {
  const map = new Map();
  for (const [slug, entry] of Object.entries(filmsIndex || {})) {
    if (!predicate(slug, entry)) continue;
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

/** Sorted copy of the merged genre/category list (count desc). */
function genreFilterOptions(stats) {
  return (Array.isArray(stats.genres) ? stats.genres : [])
    .filter((item) => item && item.key && item.name && toNum(item.count) > 0)
    .slice()
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
}

function renderGenreFilter(stats, options) {
  const select = $('yearbars-genre');
  if (!select) return;
  clear(select);
  select.append(el('option', { value: '', text: 'Все' }));
  for (const item of options) {
    select.append(
      el('option', { value: item.key, text: `${item.name} (${fmtInt(item.count)})` })
    );
  }
  select.value = selectedGenreKey || '';
  select.onchange = () => {
    selectedGenreKey = select.value || null;
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

  const genreOptions = genreFilterOptions(stats);
  // Same rule for the genre/style filter: a refresh can remove a bucket when
  // the last film is re-matched, and a profile switch replaces the list.
  if (selectedGenreKey && !genreOptions.some((item) => item.key === selectedGenreKey)) {
    selectedGenreKey = null;
  }
  const selectedGenre = genreOptions.find((item) => item.key === selectedGenreKey) || null;
  const filtersActive = Boolean(selectedCountry || selectedGenre);

  renderCountryFilter(stats, countries);
  renderGenreFilter(stats, genreOptions);

  const series = filtersActive
    ? yearsForFilters(stats.filmsIndex, yearBarsPredicate(selectedCountry, selectedGenre))
    : stats.years;
  const total = series.reduce((sum, item) => sum + toNum(item.count), 0);

  const onYearClick = (year) => openYearModal(stats, year);

  if (filtersActive && !series.length) {
    clear(host);
    host.append(emptyState('Нет фильмов по выбранным фильтрам'));
  } else {
    renderYearBars(host, series, { onYearClick });
  }

  const note = $('yearbars-note');
  if (note) {
    if (filtersActive) {
      const parts = [];
      if (selectedCountry) parts.push(`страна: ${selectedCountry}`);
      if (selectedGenre) parts.push(`жанр/стиль: ${selectedGenre.name}`);
      const suffix = parts.join(' · ');
      note.textContent = total
        ? `${fmtInt(total)} ${plural(total, ['фильм', 'фильма', 'фильмов'])} · ${suffix}`
        : `нет фильмов · ${suffix}`;
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
      // An empty filtered result is rendered as a static empty state; calling
      // renderYearBars here would overwrite it with the chart's generic
      // "no year data" message.
      if (filtersActive && !series.length) return;
      renderYearBars(host, series, { onYearClick });
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._boxdResize = observer;
  }
}

/* Year column click: films of that release year, user rating first. The
 * country and genre/style filters are applied together. */
function filmsForYear(filmsIndex, year, country = null, genre = null) {
  const target = toNum(year);
  if (!target) return [];
  const predicate = yearBarsPredicate(country, genre);
  const films = [];
  for (const [slug, entry] of Object.entries(filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (toNum(entry.year) !== target) continue;
    if (!predicate(slug, entry)) continue;
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
  const genreOptions = genreFilterOptions(stats);
  const genre = genreOptions.find((item) => item.key === selectedGenreKey) || null;
  const films = filmsForYear(stats.filmsIndex, year, country, genre);
  const count = films.length;
  const n = toNum(year);
  const parts = [];
  if (country) parts.push(country);
  if (genre) parts.push(genre.name);
  const filters = parts.join(' · ');
  const title = filters ? `${filmCountPhrase(count, n)} · ${filters}` : filmCountPhrase(count, n);
  let hint = '';
  if (country && genre) hint = `Только фильмы страны ${country} с жанром/стилем «${genre.name}».`;
  else if (country) hint = `Только фильмы страны ${country}.`;
  else if (genre) hint = `Только фильмы жанра/стиля «${genre.name}».`;
  openFilmListModal({
    kicker: 'Просмотры по годам проката',
    title,
    subtitle: `${String(n)} год · ${fmtInt(count)} ${plural(count, ['фильм', 'фильма', 'фильмов'])}${filters ? ` · ${filters}` : ' в выгрузке'}`,
    hint,
    groupLabel: String(n),
    emptyText: country || genre
      ? 'Нет фильмов по выбранным фильтрам за этот год'
      : 'Для этого года нет фильмов с карточкой TMDB',
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

/* =========================================================
   F. recently watched strip
   ========================================================= */

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTHS_SHORT_GEN = [
  'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
  'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
];
/* Standalone month labels for the calendar axis ("май", not "мая"). */
const CAL_MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** "25 октября 2026" */
function fmtDayRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_GEN[parts.month - 1]} ${parts.year}`;
}

/** "25 окт. 2026" */
function fmtDayShortRu(value) {
  const parts = dateParts(value);
  if (!parts) return String(value || '');
  return `${parts.day} ${MONTHS_SHORT_GEN[parts.month - 1]} ${parts.year}`;
}

/** Days between today's local calendar date and a UTC `YYYY-MM-DD`. */
function daysSince(value) {
  const parts = dateParts(value);
  if (!parts) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - Date.UTC(parts.year, parts.month - 1, parts.day)) / 86400000);
}

/** "сегодня" / "вчера" / "3 дня назад" / "2025-06-14". */
function relativeDayLabel(value) {
  const diff = daysSince(value);
  if (diff == null) return String(value || '');
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'вчера';
  if (diff > 1 && diff <= 7) return `${diff} ${plural(diff, ['день', 'дня', 'дней'])} назад`;
  return value;
}

function fmtDateRange(dates) {
  const list = Array.isArray(dates) ? dates.filter(dateParts) : [];
  if (!list.length) return '';
  if (list.length === 1 || list[0] === list[1]) return fmtDayRu(list[0]);
  const a = dateParts(list[0]);
  const b = dateParts(list[list.length - 1]);
  if (a.year === b.year && a.month === b.month) {
    return `${a.day}–${b.day} ${MONTHS_GEN[b.month - 1]} ${b.year}`;
  }
  if (a.year === b.year) {
    return `${a.day} ${MONTHS_GEN[a.month - 1]} — ${b.day} ${MONTHS_GEN[b.month - 1]} ${b.year}`;
  }
  return `${fmtDayRu(list[0])} — ${fmtDayRu(list[list.length - 1])}`;
}

function renderRecentlyWatched(stats) {
  const section = $('w-recent-widget');
  const host = $('recent-strip');
  const note = $('recent-note');
  if (!section || !host) return;
  clear(host);

  const items = Array.isArray(stats.recentlyWatched) ? stats.recentlyWatched : [];
  if (!items.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (note) {
    note.textContent = `${fmtInt(items.length)} ${plural(items.length, ['просмотр', 'просмотра', 'просмотров'])}`;
  }

  for (const item of items) {
    const entry = stats.filmsIndex && stats.filmsIndex[item.slug];
    if (!entry || typeof entry !== 'object') continue;
    const film = filmFromEntry(item.slug, entry);
    const title = film.title || slugTitle(item.slug);

    const card = el('div', { class: 'recent-card' });
    const poster = el('div', {
      class: 'recent-poster',
      role: 'button',
      tabIndex: 0,
      'aria-label': `${title}: ссылки и действия`,
      title: `${title}${film.year ? ` (${film.year})` : ''} · ${fmtDayRu(item.date)}`,
    });
    poster.append(posterThumb(film.posterPath, title));

    if (item.rewatch) {
      poster.append(el('span', { class: 'tag recent-rewatch', text: 'повтор' }));
    }

    const menu = renderFilmMenu(film);
    if (menu) {
      menu.classList.add('recent-film-menu');
      poster.append(menu);
    }

    const openMenu = () => {
      const toggle = menu && menu.querySelector('.film-menu-toggle');
      if (toggle) {
        toggle.click();
        return;
      }
      // A film without any external links still opens a one-row list so the
      // card never becomes a dead end.
      openFilmListModal({
        kicker: 'Недавно смотрел',
        title,
        subtitle: fmtDayRu(item.date),
        groupLabel: fmtDayRu(item.date),
        films: [film],
        sortScope: 'recent',
      });
    };
    poster.addEventListener('click', (event) => {
      if (event.target.closest('.film-menu')) return;
      hideTooltip();
      openMenu();
    });
    poster.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      openMenu();
    });

    card.append(poster);
    card.append(el('div', {
      class: 'recent-date',
      text: relativeDayLabel(item.date),
      title: fmtDayRu(item.date),
    }));
    host.append(card);
  }
}

/* =========================================================
   G. watch calendar heatmap + streaks
   ========================================================= */

function heatLevel(count) {
  const n = toNum(count);
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function openWatchDayModal(stats, day) {
  const counts = new Map();
  for (const slug of Array.isArray(day.slugs) ? day.slugs : []) {
    const key = String(slug || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const films = [];
  for (const [slug, viewings] of counts) {
    const entry = stats.filmsIndex && stats.filmsIndex[slug];
    if (!entry || typeof entry !== 'object') continue;
    films.push(filmFromEntry(slug, entry, viewings > 1 ? { meta: 'повтор' } : {}));
  }

  // Fallback for an older payload without per-day slugs: use films whose
  // latest watchedDate is this day (still exact for one-viewing days).
  if (!films.length) {
    for (const [slug, entry] of Object.entries(stats.filmsIndex || {})) {
      if (!entry || typeof entry !== 'object') continue;
      if (String(entry.watchedDate || '').slice(0, 10) !== day.date) continue;
      films.push(filmFromEntry(slug, entry));
    }
  }

  const count = Math.max(toNum(day.count), films.length);
  openFilmListModal({
    kicker: 'Календарь просмотров',
    title: fmtDayRu(day.date),
    subtitle: `${fmtInt(count)} ${plural(count, ['просмотр', 'просмотра', 'просмотров'])} · `
      + `${fmtInt(films.length)} ${plural(films.length, ['фильм', 'фильма', 'фильмов'])}`,
    groupLabel: fmtDayRu(day.date),
    emptyText: 'За этот день нет фильмов в выгрузке',
    films,
    sortScope: 'watchday',
  });
}

function buildYearCalendar(year, byDate, stats) {
  const first = Date.UTC(year, 0, 1);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = leap ? 366 : 365;
  const offset = (new Date(first).getUTCDay() + 6) % 7; // Monday = 0
  const columns = Math.ceil((offset + daysInYear) / 7);
  const pitch = 13; // 11px cell + 2px gap; keep in sync with CSS

  const row = el('div', { class: 'cal-year', dataset: { year: String(year) } });
  row.append(el('div', { class: 'cal-year-label', text: String(year) }));

  const scroll = el('div', { class: 'cal-scroll' });
  const months = el('div', {
    class: 'cal-months',
    style: { width: `${columns * pitch}px` },
    'aria-hidden': 'true',
  });

  let lastLabelColumn = -10;
  let monthStartDay = 0;
  for (let month = 0; month < 12; month++) {
    const column = Math.floor((offset + monthStartDay) / 7);
    if (column - lastLabelColumn >= 2) {
      months.append(el('span', {
        class: 'cal-month-label',
        text: CAL_MONTHS[month],
        style: { left: `${column * pitch}px` },
      }));
      lastLabelColumn = column;
    }
    monthStartDay += new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  const grid = el('div', {
    class: 'cal-grid',
    role: 'grid',
    'aria-label': `Календарь просмотров, ${year}`,
    style: { gridTemplateColumns: `repeat(${columns}, 11px)` },
  });

  const totalCells = columns * 7;
  for (let index = 0; index < totalCells; index++) {
    const dayOfYear = index - offset;
    if (dayOfYear < 0 || dayOfYear >= daysInYear) {
      grid.append(el('span', { class: 'cal-cell is-blank', 'aria-hidden': 'true' }));
      continue;
    }
    const dateObj = new Date(first + dayOfYear * 86400000);
    const date = `${year}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;
    const day = byDate.get(date) || null;
    const count = day ? toNum(day.count) : 0;
    const cell = el(day && count > 0 ? 'button' : 'span', {
      class: `cal-cell cal-level-${heatLevel(count)}${count > 0 ? ' is-active' : ''}`,
      dataset: { date, count: String(count) },
      title: count > 0
        ? `${date} — ${fmtInt(count)} ${plural(count, ['просмотр', 'просмотра', 'просмотров'])}`
        : `${date} — нет просмотров`,
      role: 'gridcell',
      'aria-label': count > 0
        ? `${date}: ${fmtInt(count)} ${plural(count, ['просмотр', 'просмотра', 'просмотров'])}`
        : `${date}: нет просмотров`,
    });
    if (day && count > 0) {
      if (cell.tagName === 'BUTTON') cell.type = 'button';
      cell.addEventListener('pointerenter', (event) => {
        showTooltip(
          `${date} — ${fmtInt(count)} ${plural(count, ['просмотр', 'просмотра', 'просмотров'])}`,
          'нажмите, чтобы увидеть фильмы'
        );
        moveTooltip(event);
      });
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      cell.addEventListener('click', () => {
        hideTooltip();
        openWatchDayModal(stats, day);
      });
    }
    grid.append(cell);
  }

  scroll.append(months, grid);
  row.append(scroll);
  return row;
}

function renderStreaks(streaks) {
  const host = $('streak-card');
  if (!host) return;
  clear(host);

  if (!streaks || !streaks.lastWatchDate) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const current = Math.max(0, toNum(streaks.current));
  const best = Math.max(0, toNum(streaks.best));
  const currentWord = plural(current, ['день', 'дня', 'дней']);

  host.append(el('span', { class: 'streak-bolt', text: '⚡', 'aria-hidden': 'true' }));
  const main = el('span', { class: 'streak-main' });
  main.append(el('span', { class: 'streak-label', text: 'Серия:' }));
  main.append(el('b', { class: 'streak-num', text: fmtInt(current) }));
  main.append(el('span', { class: 'streak-unit', text: currentWord }));
  host.append(main);

  const meta = [];
  const range = fmtDateRange(streaks.bestDates);
  meta.push(`Рекорд: ${fmtInt(best)}${range ? ` (${range})` : ''}`);
  meta.push(`Последний просмотр: ${fmtDayShortRu(streaks.lastWatchDate)}`);
  host.append(el('span', { class: 'streak-meta', text: meta.join(' · ') }));

  const daysAgo = daysSince(streaks.lastWatchDate);
  if (current > 0) {
    host.title = `Текущая серия: ${current} ${currentWord} подряд · последний просмотр ${fmtDayRu(streaks.lastWatchDate)}`;
  } else {
    host.title = daysAgo == null
      ? 'Нет данных о просмотрах'
      : `Последний просмотр был ${daysAgo} ${plural(daysAgo, ['день', 'дня', 'дней'])} назад`;
  }
}

function renderWatchCalendar(stats) {
  const section = $('w-calendar-widget');
  const host = $('calendar-host');
  if (!section || !host) return;

  const days = Array.isArray(stats.watchDays) ? stats.watchDays : [];
  if (!days.length) {
    section.hidden = true;
    clear(host);
    return;
  }
  section.hidden = false;

  renderStreaks(stats.streaks);
  clear(host);

  const byDate = new Map(days.map((day) => [day.date, day]));
  const years = [...new Set(days.map((day) => Number(String(day.date).slice(0, 4))))]
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);

  const first = years[0];
  const last = years[years.length - 1];
  for (let year = first; year <= last; year++) {
    host.append(buildYearCalendar(year, byDate, stats));
  }

  const total = days.reduce((sum, day) => sum + toNum(day.count), 0);
  const note = $('calendar-note');
  if (note) {
    note.textContent = `${fmtInt(days.length)} ${plural(days.length, ['день', 'дня', 'дней'])} · `
      + `${fmtInt(total)} ${plural(total, ['просмотр', 'просмотра', 'просмотров'])}`;
  }
}
