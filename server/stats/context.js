'use strict';

/**
 * Context builder of the films stats payload (S3 split).
 *
 * One pass over `upload.films` fills every Map/array the section builders
 * read: ratings histogram, genres, decades, franchises, MCU membership,
 * persons, studios, filmsIndex, taxonomy entries, the viewing timeline and the
 * calendar. The maps are insertion-ordered by the film loop, which is why the
 * loop order is part of the payload contract.
 *
 * The builder is a pure read of the persistent caches (`cache.getDetails`,
 * `cache.getLbLink`, the Letterboxd attachment). No live source is called.
 */

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
  // Backfill / rematch run in separate processes; pick up their cache files
  // without a server restart. Each check is one stat() per stats build (the
  // accessors also self-check before returning memory-cached values).
  wikidata.reloadIfChanged();
  cache.refreshIndexIfChanged();
  cache.refreshLbLinksIfChanged();

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
    rewatchBySlug: new Map(), // KinoPoisk slug -> rewatch=true diary events
    actors: new Map(),
    directors: new Map(),
    writers: new Map(),
    composers: new Map(),
    studios: new Map(),
    ratingCounts: emptyRatingCounts(),
    genreMap: new Map(), // name -> { key, name, count, ratingSum, ratingCount, films }
    decadeMap: new Map(),
    decadeScoreMap: new Map(), // decade start -> counts[1..10]
    franchiseMap: new Map(), // collection id -> { id, name, posterPath, films, rating… }
    mcuFilms: new Map(), // slug -> { slug, year, title, rating } (parent franchise)
    yearMap: new Map(),
    timelineMap: new Map(),
    filmsIndex: {},
    taxEntries: [],
    // Day-level view of the same events that feed `timeline`. The sum of
    // watchDays[].count is therefore always equal to sum timeline[].watched.
    // `slugs` keeps one entry per viewing (rewatches repeat the slug) so the
    // calendar can open the exact film list of a day without another endpoint.
    watchDayMap: new Map(), // "YYYY-MM-DD" -> { date, count, rewatchCount, slugs }
    watchEvents: [], // { date, slug, rewatch } — one per viewing
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

/**
 * Real watch date + viewing timeline of one film.
 *
 * With an attached Letterboxd archive every diary event is one viewing, so
 * rewatches are counted and the month comes from Watched Date instead of the
 * KinoPoisk rating date. Films without a matched diary event keep the old
 * proxy: one viewing in the month of the KinoPoisk rating.
 */
function collectTimeline(film, tmdbId, ctx) {
  // ---- real watch date + viewing timeline (KinoPoisk + attachment) ----
  // With an attached Letterboxd archive every diary event is one viewing,
  // so rewatches are counted and the month comes from Watched Date instead
  // of the KinoPoisk rating date. Films without a matched diary event keep
  // the old proxy: one viewing in the month of the KinoPoisk rating.
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
        // A diary row without a usable Watched Date/Date cannot be placed
        // on the timeline; it must not suppress the ratedAt proxy below.
        if (!watchDate || !/^\d{4}-\d{2}-\d{2}$/.test(watchDate)) continue;
        applied++;
        addTimelineEvent(ctx, watchDate, rated, {
          slug: film.slug,
          rewatch: Boolean(event.rewatch),
        });
        if (!latest || watchDate > latest) latest = watchDate;
      }
      if (latest) effectiveWatchedDate = latest;
      // Diary exists but carries no usable date: fall back to the KinoPoisk
      // proxy so watchedDate and the timeline stay consistent.
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
      // No diary event for this KinoPoisk film (or no attachment at all):
      // count one proxy viewing on the rating date. There is no rewatch
      // signal on KinoPoisk itself, so the flag stays null.
      addTimelineEvent(ctx, effectiveWatchedDate, rated, {
        slug: film.slug,
        rewatch: null,
      });
    }
  }

  return effectiveWatchedDate;
}

/** Ratings/runtime/year/genres/persons/studios/index entry of one film. */
function collectFacts(film, kind, tmdbId, details, credits, effectiveWatchedDate, ctx) {
  // ---- ratings histogram ----
  // Letterboxd ratings are half-stars (0.5-5, scaled x2). KinoPoisk is a
  // native 1-10 scale and must not be doubled.
  if (film.rating !== null) {
    ctx.ratedCount++;
    const score = ctx.isKpSource ? Math.round(film.rating) : Math.round(film.rating * 2);
    if (ctx.ratingCounts[score] === undefined) ctx.ratingCounts[score] = 0;
    ctx.ratingCounts[score]++;
  } else {
    ctx.ratingCounts[0]++;
  }

  // ---- runtime ----
  const runtime = details && Number.isFinite(details.runtime) ? details.runtime : 0;
  if (runtime > 0) {
    ctx.totalMinutes += runtime;
    ctx.runtimeCount++;
  }

  // ---- year / decade ----
  const year = releaseYear(details && details.release_date, film.year);
  if (year != null) {
    ctx.yearMap.set(year, (ctx.yearMap.get(year) || 0) + 1);
    const start = Math.floor(year / 10) * 10;
    ctx.decadeMap.set(start, (ctx.decadeMap.get(start) || 0) + 1);
  }

  // ---- decade × score matrix ----
  // Same score scale as the ratings widget: KinoPoisk is native 1-10,
  // Letterboxd half-stars are doubled.
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

  // ---- franchises (TMDB collections) ----
  // Only TMDB movies carry belongs_to_collection. The localized (`ru-RU`)
  // collection name and poster are stored as-is; grouping is by collection
  // id, so two different collections with the same display name stay apart.
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

  // ---- MCU parent franchise ----
  // Synthetic parent over the film-level Wikidata/static membership. It is
  // deliberately independent of belongs_to_collection: the user can have
  // films with no TMDB collection (Black Widow, Eternals, …) and the Sony
  // sub-collections (Venom, Deadpool 1-2, Spider-Verse) must stay out. The
  // sub-collection rows remain untouched; the same film can appear in both
  // its sub-row and this parent row (that is the point of a parent).
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
    // Keyword-based categories / origins / periods are aggregated once,
    // after the per-film loop (see buildTaxonomy below). The director
    // heuristic additionally needs the media kind, credited directors and
    // production-country ISO codes; statistics displayed elsewhere are
    // unaffected.
    ctx.taxEntries.push({
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
  if (ctx.isKpSource) {
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
  ctx.filmsIndex[film.slug] = filmEntry;
}

module.exports = {
  buildContext,
};
