'use strict';

const cache = require('../cache');
const attachmentStore = require('../attachment');
const wikidata = require('../wikidata');
const mcu = require('../mcu');
const { normalizeKeyword } = require('../taxonomy');
const { effectiveKind } = require('./unmatched');
const { addRole } = require('./people');
const { addTimelineEvent } = require('./timeline');
const { releaseYear } = require('./numeric');
const {
  isHiddenGenre,
  isMusicGenre,
  crewDirectorNames,
  filmCountries,
  productionCountryCodes,
  isAnimation,
} = require('./documents');
const {
  MUSICAL_KEYWORD,
  VOICE_RE,
  WRITER_JOBS,
  COMPOSER_JOBS,
} = require('./constants');

function emptyRatingCounts() {
  const counts = {};
  for (let score = 1; score <= 10; score++) counts[score] = 0;
  counts[0] = 0;
  return counts;
}

function buildContext(upload, job) {
  wikidata.reloadIfChanged();
  cache.refreshIndexIfChanged();
  cache.refreshLbLinksIfChanged();

  const source =
    upload.summary && upload.summary.source
      ? upload.summary.source
      : { type: 'letterboxd' };
  const isKpSource = source.type === 'kinopoisk';

  const attachment = isKpSource && source.kpUserId
    ? attachmentStore.readAttachment(source.kpUserId)
    : null;
  const attachmentDiaryByTmdb = new Map();
  const attachmentRewatchByTmdb = new Map();
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

  const ctx = {
    upload,
    job,
    source,
    isKpSource,
    attachment,
    attachmentDiaryByTmdb,
    attachmentRewatchByTmdb,
    attachmentRewatchCount,
    appliedAttachmentTmdbIds: new Set(),
    appliedEventCount: 0,
    appliedRatedEventCount: 0,
    realDateFrom: null,
    realDateTo: null,
    rewatchBySlug: new Map(),
    actors: new Map(),
    directors: new Map(),
    writers: new Map(),
    composers: new Map(),
    studios: new Map(),
    ratingCounts: emptyRatingCounts(),
    genreMap: new Map(),
    decadeMap: new Map(),
    decadeScoreMap: new Map(),
    franchiseMap: new Map(),
    mcuFilms: new Map(),
    yearMap: new Map(),
    timelineMap: new Map(),
    filmsIndex: {},
    taxEntries: [],
    watchDayMap: new Map(),
    watchEvents: [],
    ratedCount: 0,
    totalMinutes: 0,
    runtimeCount: 0,
  };

  for (const film of upload.films) {
    const filmJob = job.films.get(film.slug) || {};
    const tmdbId = filmJob.tmdbId != null ? filmJob.tmdbId : null;
    const kind = effectiveKind(film, filmJob);
    const data = tmdbId != null ? cache.getDetails(tmdbId, kind) : null;
    const details = data ? data.details : null;
    const credits = data ? data.credits : null;

    const effectiveWatchedDate = collectTimeline(film, tmdbId, ctx);
    collectFacts(film, kind, tmdbId, details, credits, effectiveWatchedDate, ctx);
  }

  return ctx;
}

function collectTimeline(film, tmdbId, ctx) {
  let effectiveWatchedDate = film.watchedDate || null;
  if (ctx.isKpSource) {
    const rated = film.rating !== null && film.rating !== undefined;
    const tmdbKey = tmdbId != null ? Number(tmdbId) : null;
    const diaryEvents = tmdbKey != null && !ctx.appliedAttachmentTmdbIds.has(tmdbKey)
      ? ctx.attachmentDiaryByTmdb.get(tmdbKey) || null
      : null;

    if (diaryEvents && diaryEvents.length > 0) {
      ctx.appliedAttachmentTmdbIds.add(tmdbKey);
      let latest = null;
      let applied = 0;
      for (const event of diaryEvents) {
        const watchDate = event.watchDate ? String(event.watchDate).slice(0, 10) : null;
        if (!watchDate || !/^\d{4}-\d{2}-\d{2}$/.test(watchDate)) continue;
        applied++;
        addTimelineEvent(ctx, watchDate, rated, {
          slug: film.slug,
          rewatch: Boolean(event.rewatch),
        });
        if (!latest || watchDate > latest) latest = watchDate;
      }
      if (latest) effectiveWatchedDate = latest;
      if (applied === 0 && effectiveWatchedDate) {
        addTimelineEvent(ctx, effectiveWatchedDate, rated, {
          slug: film.slug,
          rewatch: null,
        });
        applied = 1;
      }
      ctx.appliedEventCount += applied;
      if (rated) ctx.appliedRatedEventCount += applied;
      const rewatches = ctx.attachmentRewatchByTmdb.get(tmdbKey) || 0;
      if (rewatches > 0) ctx.rewatchBySlug.set(film.slug, rewatches);
    } else if (effectiveWatchedDate) {
      addTimelineEvent(ctx, effectiveWatchedDate, rated, {
        slug: film.slug,
        rewatch: null,
      });
    }
  }

  return effectiveWatchedDate;
}

function collectFacts(film, kind, tmdbId, details, credits, effectiveWatchedDate, ctx) {
  if (film.rating !== null) {
    ctx.ratedCount++;
    const score = ctx.isKpSource ? Math.round(film.rating) : Math.round(film.rating * 2);
    if (ctx.ratingCounts[score] === undefined) ctx.ratingCounts[score] = 0;
    ctx.ratingCounts[score]++;
  } else {
    ctx.ratingCounts[0]++;
  }

  const runtime = details && Number.isFinite(details.runtime) ? details.runtime : 0;
  if (runtime > 0) {
    ctx.totalMinutes += runtime;
    ctx.runtimeCount++;
  }

  const year = releaseYear(details && details.release_date, film.year);
  if (year != null) {
    ctx.yearMap.set(year, (ctx.yearMap.get(year) || 0) + 1);
    const start = Math.floor(year / 10) * 10;
    ctx.decadeMap.set(start, (ctx.decadeMap.get(start) || 0) + 1);
  }

  if (year != null && film.rating !== null && film.rating !== undefined) {
    const score = ctx.isKpSource ? Math.round(film.rating) : Math.round(film.rating * 2);
    if (score >= 1 && score <= 10) {
      const start = Math.floor(year / 10) * 10;
      let counts = ctx.decadeScoreMap.get(start);
      if (!counts) {
        counts = new Array(11).fill(0);
        ctx.decadeScoreMap.set(start, counts);
      }
      counts[score]++;
    }
  }

  const collection = details && details.belongs_to_collection;
  if (collection && collection.id != null) {
    const collectionId = Number(collection.id);
    if (Number.isFinite(collectionId) && collectionId > 0) {
      let franchise = ctx.franchiseMap.get(collectionId);
      if (!franchise) {
        franchise = {
          collectionId,
          name: '',
          posterPath: null,
          films: [],
          ratingSum: 0,
          ratingCount: 0,
        };
        ctx.franchiseMap.set(collectionId, franchise);
      }
      if (collection.name) franchise.name = String(collection.name);
      if (!franchise.posterPath && collection.poster_path) {
        franchise.posterPath = collection.poster_path;
      }
      franchise.films.push({ slug: film.slug, year, title: film.titleRu || film.title || '' });
      if (film.rating !== null && film.rating !== undefined) {
        franchise.ratingSum += film.rating;
        franchise.ratingCount++;
      }
    }
  }

  if (mcu.isMcuFilm({
    imdbId: details && details.imdb_id,
    tmdbId,
    kind,
  })) {
    const slug = String(film.slug);
    if (!ctx.mcuFilms.has(slug)) {
      ctx.mcuFilms.set(slug, {
        slug,
        year,
        title: film.titleRu || film.title || '',
        rating: film.rating,
      });
    }
  }

  if (details) {
    const keywordSet = new Set(
      (Array.isArray(details.keywords) ? details.keywords : [])
        .map((keyword) => normalizeKeyword(keyword && keyword.name))
        .filter(Boolean)
    );
    const isMusical = keywordSet.has(MUSICAL_KEYWORD);
    for (const genre of details.genres || []) {
      if (isHiddenGenre(genre)) continue;
      if (isMusical && isMusicGenre(genre)) continue;
      const name = (genre.name || '').trim();
      if (!name) continue;
      let g = ctx.genreMap.get(name);
      if (!g) {
        g = {
          key: `genre-${Number(genre.id) || normalizeKeyword(name).replace(/\s+/g, '-')}`,
          name,
          count: 0,
          ratingSum: 0,
          ratingCount: 0,
          films: [],
        };
        ctx.genreMap.set(name, g);
      }
      g.count++;
      g.films.push(film.slug);
      if (film.rating !== null) {
        g.ratingSum += film.rating;
        g.ratingCount++;
      }
    }
    ctx.taxEntries.push({
      slug: film.slug,
      rating: film.rating,
      year,
      genres: details.genres || [],
      keywords: details.keywords || [],
      wd: wikidata.getTags(details.imdb_id, tmdbId),
      kind,
      directors: crewDirectorNames(credits),
      countries: productionCountryCodes(details),
    });
  }

  if (credits) {
    const cast = Array.isArray(credits.cast) ? credits.cast : [];
    const threshold = Math.ceil(cast.length / 2);
    const animation = isAnimation(details);

    cast.forEach((role, index) => {
      const order = Number.isFinite(role.order) ? role.order : index;
      const isVoice = VOICE_RE.test(role.character || '');
      const counted = order < threshold && !isVoice && !animation;
      let reason = null;
      if (!counted) {
        if (animation) reason = 'animation';
        else if (isVoice) reason = 'voice';
        else if (order >= threshold) reason = 'insignificant';
        else reason = 'unmatched';
      }
      addRole(ctx.actors, role, film.slug, counted, {
        character: role.character || '',
        reason,
      });
    });

    for (const role of credits.crew || []) {
      const jobName = role.job || '';
      const extra = { job: jobName, reason: null };
      if (jobName === 'Director') {
        addRole(ctx.directors, role, film.slug, true, extra);
      } else if (WRITER_JOBS.has(jobName)) {
        addRole(ctx.writers, role, film.slug, true, extra);
      } else if (COMPOSER_JOBS.has(jobName)) {
        addRole(ctx.composers, role, film.slug, true, extra);
      }
    }
  }

  if (details) {
    const companies =
      Array.isArray(details.production_companies) ? details.production_companies : [];
    const seenCompanies = new Set();
    for (const company of companies) {
      if (!company || company.id == null) continue;
      if (seenCompanies.has(company.id)) continue;
      seenCompanies.add(company.id);
      addRole(
        ctx.studios,
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
  if (ctx.isKpSource) {
    const kpUrl = film.kpUrl
      || (Number.isFinite(Number(film.kpId))
        ? `https://www.kinopoisk.ru/${kind === 'tv' ? 'series' : 'film'}/${film.kpId}/`
        : null);
    filmEntry.kpUrl = kpUrl || null;
    const mappedLbUri = tmdbId != null ? cache.getLbLink(tmdbId, kind) : null;
    if (mappedLbUri) filmEntry.lbUri = mappedLbUri;
  } else {
    filmEntry.lbUri = film.lbUri
      || (tmdbId != null ? cache.getLbLink(tmdbId, kind) : null)
      || null;
  }
  ctx.filmsIndex[film.slug] = filmEntry;
}

module.exports = {
  buildContext,
};
