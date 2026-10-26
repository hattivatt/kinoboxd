'use strict';

const cache = require('./cache');
const attachmentStore = require('./attachment');
const { getJob } = require('./enrich');
const { buildTaxonomy, normalizeKeyword } = require('./taxonomy');
const wikidata = require('./wikidata');

const WRITER_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Script']);
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Music']);
const VOICE_RE = /\(voice/i;

/* Genres hidden from the dashboard: TMDB "TV Movie", "War", "History" and
 * "Animation". Animation is hidden because the dashboard splits it into the
 * derived categories "Мультфильмы" (Animation minus anime) + "Аниме": keeping
 * the raw genre would count the same films twice (its name is also localized
 * as the singular "Мультфильм", which looks like a duplicate row). They are
 * matched by id first (names are localized by TMDB) and by the
 * English/Russian label as a fallback for older cache entries. Western and
 * Music stay visible. */
const HIDDEN_GENRE_IDS = new Set([10770, 10752, 36, 16]);
const HIDDEN_GENRE_NAMES = new Set([
  'tv movie',
  'television film',
  'war',
  'history',
  'телевизионный фильм',
  'военный',
  'история',
  'animation',
  'мультфильм',
  'мультфильмы',
  'анимация',
]);

/* TMDB Music is id 10402 (id 35 is Comedy). The "Музыка" bucket is the Music
 * genre minus films tagged with the "musical" keyword: those belong to the
 * derived "Мюзикл" category only, so a film is never counted in both. */
const MUSIC_GENRE_ID = 10402;
const MUSIC_GENRE_NAMES = new Set(['music', 'музыка']);
const MUSICAL_KEYWORD = 'musical';

function isMusicGenre(genre) {
  if (!genre) return false;
  if (Number(genre.id) === MUSIC_GENRE_ID) return true;
  return MUSIC_GENRE_NAMES.has(normalizeKeyword(genre.name));
}

function isHiddenGenre(genre) {
  if (!genre) return false;
  if (HIDDEN_GENRE_IDS.has(Number(genre.id))) return true;
  return HIDDEN_GENRE_NAMES.has(String(genre.name || '').trim().toLowerCase());
}

/* TMDB returns production_countries with an English `name` even when the
 * request uses language=ru-RU, so the Russian label is resolved from the ISO
 * code here. Unknown codes fall back to whatever TMDB sent. */
const COUNTRY_RU = {
  AD: 'Андорра',
  AE: 'ОАЭ',
  AF: 'Афганистан',
  AL: 'Албания',
  AM: 'Армения',
  AN: 'Нидерландские Антильские острова',
  AR: 'Аргентина',
  AT: 'Австрия',
  AU: 'Австралия',
  AZ: 'Азербайджан',
  BA: 'Босния и Герцеговина',
  BD: 'Бангладеш',
  BE: 'Бельгия',
  BG: 'Болгария',
  BO: 'Боливия',
  BR: 'Бразилия',
  BY: 'Беларусь',
  CA: 'Канада',
  CH: 'Швейцария',
  CL: 'Чили',
  CN: 'Китай',
  CO: 'Колумбия',
  CR: 'Коста-Рика',
  CS: 'Сербия и Черногория',
  CU: 'Куба',
  CY: 'Кипр',
  CZ: 'Чехия',
  DE: 'Германия',
  DK: 'Дания',
  DO: 'Доминикана',
  DZ: 'Алжир',
  EC: 'Эквадор',
  EE: 'Эстония',
  EG: 'Египет',
  ES: 'Испания',
  ET: 'Эфиопия',
  FI: 'Финляндия',
  FR: 'Франция',
  GB: 'Великобритания',
  GE: 'Грузия',
  GR: 'Греция',
  GT: 'Гватемала',
  HK: 'Гонконг',
  HR: 'Хорватия',
  HU: 'Венгрия',
  ID: 'Индонезия',
  IE: 'Ирландия',
  IL: 'Израиль',
  IN: 'Индия',
  IQ: 'Ирак',
  IR: 'Иран',
  IS: 'Исландия',
  IT: 'Италия',
  JM: 'Ямайка',
  JO: 'Иордания',
  JP: 'Япония',
  KE: 'Кения',
  KG: 'Киргизия',
  KH: 'Камбоджа',
  KR: 'Южная Корея',
  KW: 'Кувейт',
  KZ: 'Казахстан',
  LB: 'Ливан',
  LK: 'Шри-Ланка',
  LT: 'Литва',
  LU: 'Люксембург',
  LV: 'Латвия',
  MA: 'Марокко',
  MC: 'Монако',
  MD: 'Молдавия',
  ME: 'Черногория',
  MK: 'Македония',
  MN: 'Монголия',
  MT: 'Мальта',
  MX: 'Мексика',
  MY: 'Малайзия',
  NG: 'Нигерия',
  NL: 'Нидерланды',
  NO: 'Норвегия',
  NP: 'Непал',
  NZ: 'Новая Зеландия',
  PA: 'Панама',
  PE: 'Перу',
  PH: 'Филиппины',
  PK: 'Пакистан',
  PL: 'Польша',
  PR: 'Пуэрто-Рико',
  PT: 'Португалия',
  PY: 'Парагвай',
  QA: 'Катар',
  RO: 'Румыния',
  RS: 'Сербия',
  RU: 'Россия',
  SA: 'Саудовская Аравия',
  SE: 'Швеция',
  SG: 'Сингапур',
  SI: 'Словения',
  SK: 'Словакия',
  SN: 'Сенегал',
  SU: 'СССР',
  SV: 'Сальвадор',
  SY: 'Сирия',
  TH: 'Таиланд',
  TJ: 'Таджикистан',
  TM: 'Туркмения',
  TN: 'Тунис',
  TR: 'Турция',
  TT: 'Тринидад и Тобаго',
  TW: 'Тайвань',
  UA: 'Украина',
  US: 'США',
  UY: 'Уругвай',
  UZ: 'Узбекистан',
  VA: 'Ватикан',
  VE: 'Венесуэла',
  VN: 'Вьетнам',
  XC: 'Чехословакия',
  XG: 'ГДР',
  XK: 'Косово',
  YU: 'Югославия',
  ZA: 'ЮАР',
  ZW: 'Зимбабве',
};

const CYRILLIC_RE = /[а-яё]/i;

function localizedCountryName(country) {
  const iso = String((country && country.iso_3166_1) || '').toUpperCase();
  const name = String((country && country.name) || '').trim();
  if (iso && COUNTRY_RU[iso]) return COUNTRY_RU[iso];
  if (CYRILLIC_RE.test(name)) return name;
  return name || iso || null;
}

/** Deduped list of localized country names for a matched film. */
function filmCountries(details) {
  const list =
    details && Array.isArray(details.production_countries)
      ? details.production_countries
      : [];
  const out = [];
  const seen = new Set();
  for (const country of list) {
    const name = localizedCountryName(country);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * ISO-3166-1 codes from TMDB production_countries. Kept separate from the
 * localized `filmCountries` payload: the period heuristics need codes
 * (e.g. "SU" for Soviet films), while the dashboard displays Russian names.
 */
function productionCountryCodes(details) {
  const list =
    details && Array.isArray(details.production_countries)
      ? details.production_countries
      : [];
  const out = [];
  const seen = new Set();
  for (const country of list) {
    const code = String((country && country.iso_3166_1) || '').toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Names of credited directors (TMDB crew job is exactly "Director"). */
function crewDirectorNames(credits) {
  const list = credits && Array.isArray(credits.crew) ? credits.crew : [];
  const out = [];
  const seen = new Set();
  for (const role of list) {
    if (!role || role.job !== 'Director') continue;
    const name = String(role.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Watch calendar / streaks                                            */
/* ------------------------------------------------------------------ */

/** UTC day number for a `YYYY-MM-DD` string (no DST, no local timezone). */
function dayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
}

/**
 * Consecutive calendar-day streaks over `watchDays` ([{ date, count }]).
 *
 * `current` is the run that ends at the most recent viewing, regardless of
 * today's date: "3 days in a row" from 23→25 Oct stays valid on the 26th.
 * The UI is responsible for the softer "last watch was N days ago" hint.
 * Dates are UTC strings; watching at 00:30 MSK is stored as the previous UTC
 * day by the KinoPoisk scraped `ratedAt` and Letterboxd diary dates alike.
 */
function computeStreaks(watchDays) {
  const dates = (Array.isArray(watchDays) ? watchDays : [])
    .map((entry) => (entry && entry.date ? String(entry.date) : ''))
    .filter((date) => dayNumber(date) != null)
    .sort();
  if (!dates.length) {
    return { current: 0, best: 0, lastWatchDate: null, bestDates: [] };
  }

  let best = 1;
  let bestFrom = dates[0];
  let bestTo = dates[0];
  let run = 1;
  let runStart = dates[0];

  for (let i = 1; i < dates.length; i++) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) {
      run++;
    } else {
      run = 1;
      runStart = dates[i];
    }
    if (run > best) {
      best = run;
      bestFrom = runStart;
      bestTo = dates[i];
    }
  }

  let current = 1;
  for (let i = dates.length - 1; i > 0; i--) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) === 1) current++;
    else break;
  }

  return {
    current,
    best,
    lastWatchDate: dates[dates.length - 1],
    bestDates: [bestFrom, bestTo],
  };
}

function releaseYear(releaseDate, fallbackYear) {
  if (releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    return parseInt(releaseDate.slice(0, 4), 10);
  }
  return Number.isFinite(fallbackYear) ? fallbackYear : null;
}

function isAnimation(details) {
  const genres = (details && details.genres) || [];
  return genres.some(
    (g) =>
      g.id === 16 ||
      /^(animation|анимация)$/i.test(String(g.name || '').trim())
  );
}

/* ------------------------------------------------------------------ */
/* Matched / unmatched helpers                                         */
/* ------------------------------------------------------------------ */

/**
 * Media kind to use for cache lookups: a manual match (or a cached object
 * entry) wins over the kind implied by the upload. Letterboxd entries have
 * no kind and default to "movie".
 */
function effectiveKind(film, filmJob) {
  if (filmJob && (filmJob.kind === 'tv' || filmJob.kind === 'movie')) {
    return filmJob.kind;
  }
  return film && film.kind === 'tv' ? 'tv' : 'movie';
}

function isKpUpload(upload) {
  const source =
    upload.summary && upload.summary.source
      ? upload.summary.source
      : { type: 'letterboxd' };
  return source.type === 'kinopoisk';
}

/**
 * Title shown in the "unrecognized films" list.
 * Letterboxd: exactly what the CSV said. KinoPoisk: the Russian title plus
 * the original title when they differ, so a manual TMDB search is possible.
 */
function unmatchedTitle(film, kpSource) {
  const main = String(film.title || '').trim();
  const ru = String(film.titleRu || '').trim();
  if (!kpSource) return main || ru;
  if (ru && main && ru !== main) return `${ru} / ${main}`;
  return ru || main;
}

/**
 * Films whose TMDB match is missing or whose details are not cached. These
 * are exactly the entries the frontend offers for manual matching.
 */
function computeUnmatched(upload, job) {
  const kpSource = isKpUpload(upload);
  const out = [];
  for (const film of upload.films) {
    const filmJob = job.films.get(film.slug) || null;
    const tmdbId = filmJob && filmJob.tmdbId != null ? filmJob.tmdbId : null;
    const data =
      tmdbId != null ? cache.getDetails(tmdbId, effectiveKind(film, filmJob)) : null;
    if (tmdbId == null || !data) {
      const entry = {
        slug: film.slug,
        title: unmatchedTitle(film, kpSource),
        year: film.year != null ? film.year : null,
      };
      // Even an unmatched entry can be looked up at its source, so the modal
      // that offers manual matching can also link to the original page.
      if (kpSource) {
        const kpUrl = film.kpUrl
          || (Number.isFinite(Number(film.kpId))
            ? `https://www.kinopoisk.ru/${film.kind === 'tv' ? 'series' : 'film'}/${film.kpId}/`
            : null);
        if (kpUrl) entry.kpUrl = kpUrl;
      } else if (film.lbUri) {
        entry.lbUri = film.lbUri;
      }
      out.push(entry);
    }
  }
  return out;
}

function listUnmatched(upload) {
  const job = getJob(upload.uploadId);
  if (!job || !job.done) return null;
  return computeUnmatched(upload, job);
}

/* ------------------------------------------------------------------ */
/* People aggregation                                                  */
/* ------------------------------------------------------------------ */

function bucketAdd(bucket, person) {
  let entry = bucket.get(person.id);
  if (!entry) {
    entry = {
      id: person.id,
      name: person.name || '',
      profilePath: person.profile_path || null,
      films: new Map(),
    };
    bucket.set(person.id, entry);
  } else if (!entry.profilePath && person.profile_path) {
    entry.profilePath = person.profile_path;
  }
  return entry;
}

function addRole(bucket, person, filmSlug, counted, extra) {
  if (!person || person.id == null) return;
  const entry = bucketAdd(bucket, person);
  const existing = entry.films.get(filmSlug);
  if (!existing) {
    entry.films.set(filmSlug, {
      filmSlug,
      counted,
      reason: counted ? null : (extra && extra.reason) || null,
      ...extra,
    });
  } else if (counted && !existing.counted) {
    existing.counted = true;
    existing.reason = null;
    Object.assign(existing, extra);
  }
}

function serializePeople(bucket, onlyCounted) {
  const list = [];
  for (const entry of bucket.values()) {
    const films = [...entry.films.values()];
    const counted = films.filter((f) => f.counted).length;
    if (onlyCounted && counted < 1) continue;
    list.push({
      id: entry.id,
      name: entry.name,
      profilePath: entry.profilePath,
      counted,
      total: films.length,
      films,
    });
  }
  list.sort((a, b) => {
    if (b.counted !== a.counted) return b.counted - a.counted;
    return a.name.localeCompare(b.name, 'ru');
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

function buildStats(upload) {
  const job = getJob(upload.uploadId);
  if (!job || !job.done) {
    return null;
  }

  // A backfill run is a separate process; pick up its wd-tags.json without a
  // server restart. The check is one stat() per stats build.
  wikidata.reloadIfChanged();

  const source =
    upload.summary && upload.summary.source
      ? upload.summary.source
      : { type: 'letterboxd' };
  const isKpSource = source.type === 'kinopoisk';

  // Letterboxd attachment: real watch dates, rewatches and watchlist. The
  // file is read on every stats build so a restart, a re-attach or a new
  // KinoPoisk import (which creates a new uploadId) is picked up instantly.
  const attachment = isKpSource && source.kpUserId
    ? attachmentStore.readAttachment(source.kpUserId)
    : null;
  const attachmentDiaryByTmdb = new Map(); // tmdbId -> diary events (real dates)
  const attachmentRewatchByTmdb = new Map(); // tmdbId -> rewatch=true event count
  let attachmentRewatchCount = 0;
  if (attachment) {
    for (const event of attachment.events || []) {
      if (!event || event.tmdbId == null) continue;
      if (event.rewatch) {
        attachmentRewatchCount += 1;
        attachmentRewatchByTmdb.set(
          event.tmdbId,
          (attachmentRewatchByTmdb.get(event.tmdbId) || 0) + 1
        );
      }
      if (event.source !== 'diary') continue;
      const key = Number(event.tmdbId);
      if (!Number.isFinite(key)) continue;
      if (!attachmentDiaryByTmdb.has(key)) attachmentDiaryByTmdb.set(key, []);
      attachmentDiaryByTmdb.get(key).push(event);
    }
  }
  const appliedAttachmentTmdbIds = new Set();
  let appliedEventCount = 0;
  let appliedRatedEventCount = 0;
  let realDateFrom = null;
  let realDateTo = null;
  const rewatchBySlug = new Map(); // KinoPoisk slug -> rewatch=true diary events

  const actors = new Map();
  const directors = new Map();
  const writers = new Map();
  const composers = new Map();
  const studios = new Map();

  const ratingCounts = {};
  for (let score = 1; score <= 10; score++) ratingCounts[score] = 0;
  ratingCounts[0] = 0;

  const genreMap = new Map(); // name -> { key, name, count, ratingSum, ratingCount, films }
  const decadeMap = new Map();
  const yearMap = new Map();
  const timelineMap = new Map();
  const filmsIndex = {};
  const taxEntries = [];

  // Day-level view of the same events that feed `timeline`. The sum of
  // watchDays[].count is therefore always equal to sum timeline[].watched.
  // `slugs` keeps one entry per viewing (rewatches repeat the slug) so the
  // calendar can open the exact film list of a day without another endpoint.
  const watchDayMap = new Map(); // "YYYY-MM-DD" -> { date, count, slugs }
  const watchEvents = []; // { date, slug, rewatch } — one per viewing

  function addTimelineEvent(date, rated, event = null) {
    if (!date || !/^\d{4}-\d{2}/.test(String(date))) return;
    const day = String(date).slice(0, 10);
    const month = day.slice(0, 7);
    let bucket = timelineMap.get(month);
    if (!bucket) {
      bucket = { month, watched: 0, rated: 0 };
      timelineMap.set(month, bucket);
    }
    bucket.watched++;
    if (rated) bucket.rated++;
    if (!realDateFrom || day < realDateFrom) realDateFrom = day;
    if (!realDateTo || day > realDateTo) realDateTo = day;

    if (event && event.slug) {
      let watchDay = watchDayMap.get(day);
      if (!watchDay) {
        watchDay = { date: day, count: 0, slugs: [] };
        watchDayMap.set(day, watchDay);
      }
      watchDay.count++;
      watchDay.slugs.push(String(event.slug));
      watchEvents.push({
        date: day,
        slug: String(event.slug),
        rewatch: event.rewatch === undefined ? null : event.rewatch,
      });
    }
  }

  let ratedCount = 0;
  let totalMinutes = 0;

  for (const film of upload.films) {
    const filmJob = job.films.get(film.slug) || {};
    const tmdbId = filmJob.tmdbId != null ? filmJob.tmdbId : null;
    const kind = effectiveKind(film, filmJob);
    const data = tmdbId != null ? cache.getDetails(tmdbId, kind) : null;
    const details = data ? data.details : null;
    const credits = data ? data.credits : null;

    // ---- real watch date + viewing timeline (KinoPoisk + attachment) ----
    // With an attached Letterboxd archive every diary event is one viewing,
    // so rewatches are counted and the month comes from Watched Date instead
    // of the KinoPoisk rating date. Films without a matched diary event keep
    // the old proxy: one viewing in the month of the KinoPoisk rating.
    let effectiveWatchedDate = film.watchedDate || null;
    if (isKpSource) {
      const rated = film.rating !== null && film.rating !== undefined;
      const tmdbKey = tmdbId != null ? Number(tmdbId) : null;
      const diaryEvents = tmdbKey != null && !appliedAttachmentTmdbIds.has(tmdbKey)
        ? attachmentDiaryByTmdb.get(tmdbKey) || null
        : null;

      if (diaryEvents && diaryEvents.length > 0) {
        appliedAttachmentTmdbIds.add(tmdbKey);
        let latest = null;
        for (const event of diaryEvents) {
          const watchDate = event.watchDate ? String(event.watchDate).slice(0, 10) : null;
          addTimelineEvent(watchDate, rated, {
            slug: film.slug,
            rewatch: Boolean(event.rewatch),
          });
          appliedEventCount++;
          if (rated) appliedRatedEventCount++;
          if (watchDate && (!latest || watchDate > latest)) latest = watchDate;
        }
        if (latest) effectiveWatchedDate = latest;
        const rewatches = attachmentRewatchByTmdb.get(tmdbKey) || 0;
        if (rewatches > 0) rewatchBySlug.set(film.slug, rewatches);
      } else if (effectiveWatchedDate) {
        // No diary event for this KinoPoisk film (or no attachment at all):
        // count one proxy viewing on the rating date. There is no rewatch
        // signal on KinoPoisk itself, so the flag stays null.
        addTimelineEvent(effectiveWatchedDate, rated, {
          slug: film.slug,
          rewatch: null,
        });
      }
    }

    // ---- ratings histogram ----
    // Letterboxd ratings are half-stars (0.5-5, scaled x2). KinoPoisk is a
    // native 1-10 scale and must not be doubled.
    if (film.rating !== null) {
      ratedCount++;
      const score = isKpSource ? Math.round(film.rating) : Math.round(film.rating * 2);
      if (ratingCounts[score] === undefined) ratingCounts[score] = 0;
      ratingCounts[score]++;
    } else {
      ratingCounts[0]++;
    }

    // ---- runtime ----
    const runtime = details && Number.isFinite(details.runtime) ? details.runtime : 0;
    if (runtime > 0) totalMinutes += runtime;

    // ---- year / decade ----
    const year = releaseYear(details && details.release_date, film.year);
    if (year != null) {
      yearMap.set(year, (yearMap.get(year) || 0) + 1);
      const start = Math.floor(year / 10) * 10;
      decadeMap.set(start, (decadeMap.get(start) || 0) + 1);
    }

    // ---- genres ----
    if (details) {
      const keywordSet = new Set(
        (Array.isArray(details.keywords) ? details.keywords : [])
          .map((keyword) => normalizeKeyword(keyword && keyword.name))
          .filter(Boolean)
      );
      const isMusical = keywordSet.has(MUSICAL_KEYWORD);
      for (const genre of details.genres || []) {
        if (isHiddenGenre(genre)) continue;
        // "Мюзикл" (keyword) and "Музыка" (TMDB genre) are mutually
        // exclusive: a musical-tagged Music film is counted in Мюзикл only.
        if (isMusical && isMusicGenre(genre)) continue;
        const name = (genre.name || '').trim();
        if (!name) continue;
        let g = genreMap.get(name);
        if (!g) {
          g = {
            key: `genre-${Number(genre.id) || normalizeKeyword(name).replace(/\s+/g, '-')}`,
            name,
            count: 0,
            ratingSum: 0,
            ratingCount: 0,
            films: [],
          };
          genreMap.set(name, g);
        }
        g.count++;
        g.films.push(film.slug);
        if (film.rating !== null) {
          g.ratingSum += film.rating;
          g.ratingCount++;
        }
      }
      // Keyword-based categories / origins / periods are aggregated once,
      // after the per-film loop (see buildTaxonomy below). The director
      // heuristic additionally needs the media kind, credited directors and
      // production-country ISO codes; statistics displayed elsewhere are
      // unaffected.
      taxEntries.push({
        slug: film.slug,
        rating: film.rating,
        // Same value as filmsIndex.year; period rules (film noir) need it.
        year,
        genres: details.genres || [],
        keywords: details.keywords || [],
        wd: wikidata.getTags(details.imdb_id, tmdbId),
        kind,
        directors: crewDirectorNames(credits),
        countries: productionCountryCodes(details),
      });
    }

    // ---- persons ----
    if (credits) {
      const cast = Array.isArray(credits.cast) ? credits.cast : [];
      // Only the first half of the billed cast counts as a significant role.
      // ceil(n / 2) keeps a single-billed-actor film counted (1, not 0).
      const threshold = Math.ceil(cast.length / 2);
      const animation = isAnimation(details);

      cast.forEach((role, index) => {
        const order = Number.isFinite(role.order) ? role.order : index;
        const isVoice = VOICE_RE.test(role.character || '');
        const counted = order < threshold && !isVoice && !animation;
        // The backend knows the exact reason a role is not counted; the
        // frontend must not guess from "character" anymore.
        let reason = null;
        if (!counted) {
          if (animation) reason = 'animation';
          else if (isVoice) reason = 'voice';
          else if (order >= threshold) reason = 'insignificant';
          else reason = 'unmatched';
        }
        addRole(actors, role, film.slug, counted, {
          character: role.character || '',
          reason,
        });
      });

      for (const role of credits.crew || []) {
        const jobName = role.job || '';
        const extra = { job: jobName, reason: null };
        if (jobName === 'Director') {
          addRole(directors, role, film.slug, true, extra);
        } else if (WRITER_JOBS.has(jobName)) {
          addRole(writers, role, film.slug, true, extra);
        } else if (COMPOSER_JOBS.has(jobName)) {
          addRole(composers, role, film.slug, true, extra);
        }
      }
    }

    // ---- studios ----
    // Production companies are taken from the same cached details. They only
    // exist for matched films and every appearance counts (one entry per film,
    // duplicates inside a film are ignored). Older cache files may miss the
    // optional field entirely — that is a silent skip, not an error.
    if (details) {
      const companies =
        Array.isArray(details.production_companies) ? details.production_companies : [];
      const seenCompanies = new Set();
      for (const company of companies) {
        if (!company || company.id == null) continue;
        if (seenCompanies.has(company.id)) continue;
        seenCompanies.add(company.id);
        addRole(
          studios,
          {
            id: company.id,
            name: company.name || '',
            profile_path: company.logo_path || null,
          },
          film.slug,
          true,
          {}
        );
      }
    }

    // ---- film index ----
    // `kind` decides whether a TMDB link points at /movie/ or /tv/; the
    // source-specific link (Letterboxd URI or KinoPoisk page) is only added
    // for the matching import source.
    const filmEntry = {
      title: (details && details.title) || film.titleRu || film.title,
      year,
      tmdbId,
      kind,
      posterPath: details ? details.poster_path || null : null,
      runtime: details ? details.runtime ?? null : null,
      voteAverage: details ? details.vote_average ?? null : null,
      rating: film.rating,
      watchedDate: effectiveWatchedDate,
    };
    if (details) {
      // Localized genre names in display form ("комедия" -> "Комедия"),
      // deduplicated; the genres widget matches them case-insensitively.
      const genreNames = [];
      const seenGenres = new Set();
      for (const genre of details.genres || []) {
        const name = String((genre && genre.name) || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seenGenres.has(key)) continue;
        seenGenres.add(key);
        genreNames.push(name.charAt(0).toUpperCase() + name.slice(1));
      }
      filmEntry.genres = genreNames;
      filmEntry.imdbId = details.imdb_id || null;
      filmEntry.countries = filmCountries(details);
    }
    if (isKpSource) {
      const kpUrl = film.kpUrl
        || (Number.isFinite(Number(film.kpId))
          ? `https://www.kinopoisk.ru/${kind === 'tv' ? 'series' : 'film'}/${film.kpId}/`
          : null);
      filmEntry.kpUrl = kpUrl || null;
      // A KinoPoisk import has no Letterboxd URI of its own, but a previous
      // Letterboxd export may have taught the server the TMDB <-> boxd.it
      // pair for this very film. Letterboxd pages are public and per-film,
      // so the link works across accounts/sources.
      const mappedLbUri = tmdbId != null ? cache.getLbLink(tmdbId, kind) : null;
      if (mappedLbUri) filmEntry.lbUri = mappedLbUri;
    } else {
      // Own upload source always wins; the global mapping is only a fallback
      // for films whose export did not provide a usable URI.
      filmEntry.lbUri = film.lbUri
        || (tmdbId != null ? cache.getLbLink(tmdbId, kind) : null)
        || null;
    }
    filmsIndex[film.slug] = filmEntry;
  }

  // ---- timeline ----
  // KinoPoisk timelines are built in the film loop above (attachment diary
  // events or the ratedAt proxy). A pure Letterboxd upload — still supported
  // as an attachment payload / legacy upload — only uses diary events here.
  // watched.csv carries the import date for every film, which would create a
  // huge fake spike, so it never feeds the timeline.
  if (!isKpSource) {
    for (const event of upload.events || []) {
      if (event.source !== 'diary') continue;
      if (!event.date) continue;
      addTimelineEvent(
        event.date,
        event.rating !== null && event.rating !== undefined,
        { slug: event.slug || null, rewatch: Boolean(event.rewatch) }
      );
    }
  }

  // Rewatch ranking for KinoPoisk profiles: films whose diary has at least
  // two entries marked Rewatch=true. Counts are rewatch events, not viewings.
  const rewatches = [...rewatchBySlug.entries()]
    .filter(([, count]) => count >= 2)
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  const ratings = [];
  for (let score = 1; score <= 10; score++) {
    ratings.push({ score, count: ratingCounts[score] || 0 });
  }
  ratings.push({ score: 0, count: ratingCounts[0] || 0 });

  const genres = [...genreMap.values()]
    .map((g) => ({
      key: g.key,
      // TMDB returns Russian genre names in lowercase ("драма"); the
      // payload uses the display form ("Драма").
      name: g.name.charAt(0).toUpperCase() + g.name.slice(1),
      count: g.count,
      avgRating: g.ratingCount > 0 ? round2(g.ratingSum / g.ratingCount) : null,
      films: g.films.slice().sort(),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));

  const decades = [...decadeMap.entries()]
    .map(([start, count]) => ({ label: `${start}-е`, start, count }))
    .sort((a, b) => a.start - b.start);

  const years = [...yearMap.entries()]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year - b.year);

  const timeline = [...timelineMap.values()].sort((a, b) =>
    a.month.localeCompare(b.month)
  );

  // Day-level viewing history for the calendar heatmap. Sorted ascending;
  // sum(count) === sum(timeline.watched) by construction.
  const watchDays = [...watchDayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  // The newest 15 viewings, newest first, for the "recently watched" strip.
  const recentlyWatched = watchEvents
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);
  const streaks = computeStreaks(watchDays);

  const persons = {
    actor: serializePeople(actors, true),
    director: serializePeople(directors, false),
    writer: serializePeople(writers, false),
    composer: serializePeople(composers, false),
    studio: serializePeople(studios, true),
  };

  // Keyword taxonomy over matched films. Categories include only non-empty
  // buckets; origins are mutually exclusive and always sum to taxEntries.
  const taxonomy = buildTaxonomy(taxEntries);

  // One flat list for the dashboard: TMDB genres (hidden ones filtered out,
  // Music already adjusted for the "musical" keyword) plus keyword-derived
  // categories. Sorting is count desc, ties by Russian name asc. Counts are
  // intentionally not expected to sum to filmCount: a film can have several
  // genres and several independent categories.
  const mergedGenres = [...genres, ...taxonomy.categories].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')
  );

  const unmatched = computeUnmatched(upload, job);

  const summary = {
    filmCount: upload.films.length,
    ratedCount,
    // With an attachment the displayed period is derived from the real
    // viewing dates that actually feed the timeline (including the ratedAt
    // fallback for films without a diary event).
    dateFrom: isKpSource ? (realDateFrom || upload.summary.dateFrom) : upload.summary.dateFrom,
    dateTo: isKpSource ? (realDateTo || upload.summary.dateTo) : upload.summary.dateTo,
    totalMinutes,
    source,
    unmatchedCount: unmatched.length,
  };
  if (Number.isFinite(upload.summary.movieCount)) summary.movieCount = upload.summary.movieCount;
  if (Number.isFinite(upload.summary.tvCount)) summary.tvCount = upload.summary.tvCount;
  if (attachment) {
    summary.rewatchCount = attachmentRewatchCount;
    summary.attachedLb = {
      fileName: attachment.fileName || null,
      attachedAt: attachment.attachedAt || null,
      events: appliedEventCount,
      ratedEvents: appliedRatedEventCount,
    };
  }

  return {
    summary,
    ratings,
    genres: mergedGenres,
    decades,
    years,
    timeline,
    watchDays,
    recentlyWatched,
    streaks,
    persons,
    origins: taxonomy.origins,
    periods: taxonomy.periods,
    filmsIndex,
    rewatches,
    unmatched,
  };
}

module.exports = { buildStats, listUnmatched, effectiveKind };
