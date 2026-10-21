/* Dashboard widgets: summary strip + charts + persons. */

import {
  $, el, clear, fmtInt, fmtPercent, fmtRating, fmtPeriod, fmtWatchTime, plural, icon,
  monthShort, toNum, emptyState, showTooltip, moveTooltip, hideTooltip, debounce, slugTitle,
} from './ui.js';
import { renderDonut, renderTimeline, renderYearBars } from './charts.js';
import { initPersons } from './persons.js';
import { openFilmListModal, filmCountPhrase } from './modal.js';
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
          name: GENRE_RU[rawName] || rawName,
          count: Math.max(0, toNum(item && item.count)),
          avgRating: numOrNull(item && item.avgRating),
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
    },
    filmsIndex: source.filmsIndex && typeof source.filmsIndex === 'object' ? source.filmsIndex : {},
  };
}

export function renderDashboard(rawStats, hooks = {}) {
  dashHooks = hooks && typeof hooks === 'object' ? hooks : {};
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

  host.append(metric('clock', 'время просмотра',
    el('div', {
      class: 'metric-value',
      title: watch ? watch.title : 'Нет данных',
      text: watch ? watch.value : '—',
    }),
    watch ? watch.sub : 'нет данных',
  ));

  host.append(metric('calendar', 'период',
    el('div', { class: 'metric-value is-small', text: fmtPeriod(summary.dateFrom, summary.dateTo) }),
    'первый — последний просмотр',
  ));

  host.append(renderSourceMetric(summary.source));

  host.classList.toggle('has-unmatched', summary.unmatchedCount > 0);
  if (summary.unmatchedCount > 0) host.append(renderUnmatchedMetric(stats));
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
    });
  }
  if (unrated > 0) {
    segments.push({ key: 'score-0', label: 'Без оценки', value: unrated, color: '#566675' });
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

  renderDonut(donutHost, {
    segments,
    legendHost,
    centerValue: fmtInt(ratedTotal),
    centerLabel: 'оценок',
    ariaLabel: `Распределение по оценкам, ${fmtInt(ratedTotal)} оценённых фильмов`,
    secondary: (seg) => `${fmtPercent(seg.value, totalAll)} всех фильмов`,
  });
}

/* =========================================================
   B. genres
   ========================================================= */

function renderGenres(stats) {
  const host = $('genres-list');
  const note = $('genres-note');
  if (!host) return;
  clear(host);

  const genres = stats.genres.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  if (note) note.textContent = genres.length
    ? `${fmtInt(genres.length)} ${plural(genres.length, ['жанр', 'жанра', 'жанров'])}`
    : '';

  if (!genres.length) {
    host.append(emptyState('Жанры появятся после обогащения TMDB'));
    return;
  }

  const max = Math.max(1, ...genres.map((g) => g.count));

  for (const genre of genres) {
    const row = el('div', { class: 'genre-row' });
    const name = el('div', { class: 'genre-name' });
    name.append(el('span', { class: 'genre-label', text: genre.name }));
    name.append(el('span', { class: 'genre-count', text: fmtInt(genre.count) }));

    const track = el('div', { class: 'genre-track' });
    const fill = el('div', { class: 'genre-fill' });
    track.append(fill);

    const avg = genre.avgRating != null ? fmtRating(genre.avgRating) : '—';
    const avgNode = el('div', {
      class: 'genre-avg',
      text: avg,
      title: genre.avgRating != null ? `Средняя оценка: ${fmtRating(genre.avgRating)}` : 'Нет оценок в этом жанре',
    });

    row.append(name, track, avgNode);
    host.append(row);

    requestAnimationFrame(() => {
      fill.style.width = `${Math.max(2, (genre.count / max) * 100)}%`;
    });

    row.addEventListener('pointerenter', (event) => {
      showTooltip(
        `${genre.name} — ${fmtInt(genre.count)} ${plural(genre.count, ['фильм', 'фильма', 'фильмов'])}`,
        genre.avgRating != null ? `средняя оценка ${fmtRating(genre.avgRating)}` : 'средней оценки нет',
      );
      moveTooltip(event);
    });
    row.addEventListener('pointermove', moveTooltip);
    row.addEventListener('pointerleave', hideTooltip);
  }
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
  });
}

/* =========================================================
   D2. views by release year
   ========================================================= */

function renderYearBarsWidget(stats) {
  const host = $('yearbars-chart');
  if (!host) return;

  if (host._boxdResize) {
    host._boxdResize.disconnect();
    host._boxdResize = null;
  }

  const onYearClick = (year) => openYearModal(stats, year);
  renderYearBars(host, stats.years, { onYearClick });

  const years = stats.years.slice().sort((a, b) => a.year - b.year);
  const note = $('yearbars-note');
  if (note) {
    if (!years.length) note.textContent = 'нет данных';
    else if (years.length === 1) note.textContent = String(years[0].year);
    else note.textContent = `${years[0].year} — ${years[years.length - 1].year}`;
  }

  if (typeof ResizeObserver === 'function') {
    const rerender = debounce(() => {
      if (!host.clientWidth) return;
      renderYearBars(host, stats.years, { onYearClick });
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._boxdResize = observer;
  }
}

/* Year column click: films of that release year, user rating first. */
function filmsForYear(filmsIndex, year) {
  const target = toNum(year);
  if (!target) return [];
  const films = [];
  for (const [slug, entry] of Object.entries(filmsIndex || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (toNum(entry.year) !== target) continue;
    films.push({
      slug,
      title: entry.title || slugTitle(slug),
      year: target,
      posterPath: entry.posterPath || null,
      rating: numOrNull(entry.rating),
      voteAverage: numOrNull(entry.voteAverage),
    });
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
  const films = filmsForYear(stats.filmsIndex, year);
  const count = films.length;
  const n = toNum(year);
  openFilmListModal({
    kicker: 'Просмотры по годам проката',
    title: filmCountPhrase(count, n),
    subtitle: `${String(n)} год · ${fmtInt(count)} ${plural(count, ['фильм', 'фильма', 'фильмов'])} в выгрузке`,
    hint: n ? 'Сортировка: сначала высокая ваша оценка, затем рейтинг TMDB.' : '',
    groupLabel: String(n),
    groupNote: count ? 'ваша оценка ↓' : '',
    emptyText: 'Для этого года нет фильмов с карточкой TMDB',
    batch: 60,
    films,
  });
}

/* =========================================================
   E. timeline
   ========================================================= */

function renderTimelineWidget(stats) {
  const host = $('timeline-chart');
  if (!host) return;

  if (host._boxdResize) {
    host._boxdResize.disconnect();
    host._boxdResize = null;
  }

  renderTimeline(host, stats.timeline);

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
      renderTimeline(host, stats.timeline);
    }, 160);
    const observer = new ResizeObserver(rerender);
    observer.observe(host);
    host._boxdResize = observer;
  }
}
