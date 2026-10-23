'use strict';

const cache = require('./cache');
const { getJob } = require('./enrich');
const { buildTaxonomy } = require('./taxonomy');

const WRITER_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Script']);
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Music']);
const VOICE_RE = /\(voice/i;

/* Genres hidden from the dashboard: TMDB "TV Movie", "War" and "History".
 * They are matched by id first (names are localized by TMDB) and by the
 * English/Russian label as a fallback for older cache entries. Western and
 * Music stay visible. */
const HIDDEN_GENRE_IDS = new Set([10770, 10752, 36]);
const HIDDEN_GENRE_NAMES = new Set([
  'tv movie',
  'television film',
  'war',
  'history',
  'телевизионный фильм',
  'военный',
  'история',
]);

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

function round2(value) {
  return Math.round(value * 100) / 100;
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
      out.push({
        slug: film.slug,
        title: unmatchedTitle(film, kpSource),
        year: film.year != null ? film.year : null,
      });
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

  const source =
    upload.summary && upload.summary.source
      ? upload.summary.source
      : { type: 'letterboxd' };
  const isKpSource = source.type === 'kinopoisk';

  const actors = new Map();
  const directors = new Map();
  const writers = new Map();
  const composers = new Map();
  const studios = new Map();

  const ratingCounts = {};
  for (let score = 1; score <= 10; score++) ratingCounts[score] = 0;
  ratingCounts[0] = 0;

  const genreMap = new Map(); // name -> { count, ratingSum, ratingCount }
  const decadeMap = new Map();
  const yearMap = new Map();
  const timelineMap = new Map();
  const filmsIndex = {};
  const taxEntries = [];

  let ratedCount = 0;
  let totalMinutes = 0;

  for (const film of upload.films) {
    const filmJob = job.films.get(film.slug) || {};
    const tmdbId = filmJob.tmdbId != null ? filmJob.tmdbId : null;
    const kind = effectiveKind(film, filmJob);
    const data = tmdbId != null ? cache.getDetails(tmdbId, kind) : null;
    const details = data ? data.details : null;
    const credits = data ? data.credits : null;

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
      for (const genre of details.genres || []) {
        if (isHiddenGenre(genre)) continue;
        const name = (genre.name || '').trim();
        if (!name) continue;
        let g = genreMap.get(name);
        if (!g) {
          g = { name, count: 0, ratingSum: 0, ratingCount: 0 };
          genreMap.set(name, g);
        }
        g.count++;
        if (film.rating !== null) {
          g.ratingSum += film.rating;
          g.ratingCount++;
        }
      }
      // Keyword-based categories / origins / periods are aggregated once,
      // after the per-film loop (see buildTaxonomy below).
      taxEntries.push({
        slug: film.slug,
        rating: film.rating,
        genres: details.genres || [],
        keywords: details.keywords || [],
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
    const filmEntry = {
      title: (details && details.title) || film.titleRu || film.title,
      year,
      tmdbId,
      posterPath: details ? details.poster_path || null : null,
      runtime: details ? details.runtime ?? null : null,
      voteAverage: details ? details.vote_average ?? null : null,
      rating: film.rating,
      watchedDate: film.watchedDate || null,
    };
    // Only matched films have a TMDB card and therefore countries. Unmatched
    // entries deliberately have no `countries` key at all.
    if (details) filmEntry.countries = filmCountries(details);
    filmsIndex[film.slug] = filmEntry;
  }

  // ---- timeline ----
  // Only real diary entries belong on the Letterboxd viewing timeline and
  // only ratedAt entries on the KinoPoisk one. watched.csv carries the
  // Letterboxd import date for every film (all 2024-12-18 in this export),
  // which would create a huge fake spike. Rewatches are kept: the parser
  // emits one event per diary row.
  for (const event of upload.events || []) {
    if (event.source !== 'diary' && event.source !== 'kp') continue;
    if (!event.date) continue;
    const month = event.date.slice(0, 7);
    let bucket = timelineMap.get(month);
    if (!bucket) {
      bucket = { month, watched: 0, rated: 0 };
      timelineMap.set(month, bucket);
    }
    bucket.watched++;
    if (event.rating !== null && event.rating !== undefined) bucket.rated++;
  }

  const ratings = [];
  for (let score = 1; score <= 10; score++) {
    ratings.push({ score, count: ratingCounts[score] || 0 });
  }
  ratings.push({ score: 0, count: ratingCounts[0] || 0 });

  const genres = [...genreMap.values()]
    .map((g) => ({
      // TMDB returns Russian genre names in lowercase ("драма"); the
      // payload uses the display form ("Драма").
      name: g.name.charAt(0).toUpperCase() + g.name.slice(1),
      count: g.count,
      avgRating: g.ratingCount > 0 ? round2(g.ratingSum / g.ratingCount) : null,
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

  const unmatched = computeUnmatched(upload, job);

  const summary = {
    filmCount: upload.films.length,
    ratedCount,
    dateFrom: upload.summary.dateFrom,
    dateTo: upload.summary.dateTo,
    totalMinutes,
    source,
    unmatchedCount: unmatched.length,
  };
  if (Number.isFinite(upload.summary.movieCount)) summary.movieCount = upload.summary.movieCount;
  if (Number.isFinite(upload.summary.tvCount)) summary.tvCount = upload.summary.tvCount;

  return {
    summary,
    ratings,
    genres,
    decades,
    years,
    timeline,
    persons,
    categories: taxonomy.categories,
    origins: taxonomy.origins,
    periods: taxonomy.periods,
    filmsIndex,
    unmatched,
  };
}

module.exports = { buildStats, listUnmatched, effectiveKind };
