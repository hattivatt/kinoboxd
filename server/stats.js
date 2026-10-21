'use strict';

const cache = require('./cache');
const { getJob } = require('./enrich');

const WRITER_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Script']);
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Music']);
const VOICE_RE = /\(voice/i;

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

  const ratingCounts = {};
  for (let score = 1; score <= 10; score++) ratingCounts[score] = 0;
  ratingCounts[0] = 0;

  const genreMap = new Map(); // name -> { count, ratingSum, ratingCount }
  const decadeMap = new Map();
  const yearMap = new Map();
  const timelineMap = new Map();
  const filmsIndex = {};

  let ratedCount = 0;
  let totalMinutes = 0;

  for (const film of upload.films) {
    const filmJob = job.films.get(film.slug) || {};
    const tmdbId = filmJob.tmdbId != null ? filmJob.tmdbId : null;
    const data = tmdbId != null ? cache.getDetails(tmdbId, film.kind) : null;
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

    // ---- film index ----
    filmsIndex[film.slug] = {
      title: (details && details.title) || film.titleRu || film.title,
      year,
      tmdbId,
      posterPath: details ? details.poster_path || null : null,
      runtime: details ? details.runtime ?? null : null,
      voteAverage: details ? details.vote_average ?? null : null,
      rating: film.rating,
      watchedDate: film.watchedDate || null,
    };
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
  };

  const summary = {
    filmCount: upload.films.length,
    ratedCount,
    dateFrom: upload.summary.dateFrom,
    dateTo: upload.summary.dateTo,
    totalMinutes,
    source,
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
    filmsIndex,
  };
}

module.exports = { buildStats };
