'use strict';

/**
 * Letterboxd archive attachments for KinoPoisk profiles.
 *
 * A Letterboxd export is no longer a profile of its own. It is attached to a
 * KinoPoisk profile (keyed by `kpUserId`) and supplies the things KinoPoisk
 * does not expose: real watch dates from diary.csv, rewatches and the
 * watchlist. The attachment survives server restarts in
 *
 *   cache/profile-lb/{kpUserId}.json
 *
 * Shape:
 *   {
 *     attachedAt: ISO string,
 *     fileName: "letterboxd-export.zip",
 *     events: [{
 *       tmdbId: number|null, lbSlug, title, year,
 *       rating: 0.5..5|null, watchDate: "YYYY-MM-DD",
 *       rewatch: boolean, source: "diary"|"watched"
 *     }],
 *     watchlist: [{ lbSlug, title, year, listedAt: "YYYY-MM-DD"|null }]
 *   }
 *
 * Events from watched.csv exist only for films that have no diary row; their
 * watchDate is the export/import date, not a real viewing date. They are kept
 * for the watchlist/rewatch backlog but stats.js only trusts diary events for
 * timeline and filmsIndex.watchedDate.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const cache = require('./cache');
const tmdb = require('./tmdb');
const { HttpError, parseLetterboxdZip } = require('./upload');

const ATTACH_DIR = path.join(cache.CACHE_DIR, 'profile-lb');
fs.mkdirSync(ATTACH_DIR, { recursive: true });

const MATCH_CONCURRENCY = 8;

function attachmentPath(kpUserId) {
  return path.join(ATTACH_DIR, `${String(kpUserId)}.json`);
}

function normalizeUserId(kpUserId) {
  const value = String(kpUserId == null ? '' : kpUserId).trim();
  return /^\d+$/.test(value) ? value : null;
}

function readAttachment(kpUserId) {
  const id = normalizeUserId(kpUserId);
  if (!id) return null;
  try {
    const raw = fs.readFileSync(attachmentPath(id), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.events)) return null;
    if (!Array.isArray(parsed.watchlist)) parsed.watchlist = [];
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[attachment] Could not read profile-lb/${id}.json (${err.message})`);
    }
    return null;
  }
}

async function writeAttachment(kpUserId, data) {
  const id = normalizeUserId(kpUserId);
  if (!id) throw new Error('attachment: invalid kpUserId');
  const target = attachmentPath(id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 0), 'utf8');
  await fsp.rename(tmp, target);
}

/** Resolve one Letterboxd film to a TMDB id, cache first, network second. */
async function resolveFilm(film) {
  const movieKey = cache.makeKindKey(film.title, film.year, 'movie');
  const tvKey = cache.makeKindKey(film.title, film.year, 'tv');
  const movieEntry = cache.getIndexEntry(movieKey);
  const tvEntry = cache.getIndexEntry(tvKey);

  if (movieEntry && movieEntry !== false) {
    return { tmdbId: movieEntry.id, kind: movieEntry.kind || 'movie' };
  }
  if (tvEntry && tvEntry !== false) {
    return { tmdbId: tvEntry.id, kind: tvEntry.kind || 'tv' };
  }
  // A known miss for both media kinds: do not hammer TMDB on every attach.
  if (movieEntry === false && (tvEntry === false || tvEntry === undefined)) return null;

  if (movieEntry === undefined) {
    const found = await tmdb.searchMovie(film.title, film.year, { language: 'en-US' });
    if (found) {
      cache.setIndexValue(movieKey, found.id);
      return { tmdbId: found.id, kind: 'movie' };
    }
  }
  if (tvEntry === undefined) {
    const found = await tmdb.searchTv(film.title, film.year, { language: 'en-US' });
    if (found) {
      cache.setIndexValue(tvKey, found.id);
      return { tmdbId: found.id, kind: 'tv' };
    }
  }
  return null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Parse an uploaded Letterboxd ZIP and turn it into the persistent attachment
 * payload. Both diary.csv and watched.csv are required (the archive is a
 * supplement, not a profile source). Matching is done through the shared TMDB
 * matcher / cache; new TMDB <-> boxd.it pairs are learned globally.
 */
async function buildAttachment(buffer, fileName) {
  const dataset = parseLetterboxdZip(buffer);
  if (!dataset.files || !dataset.files.diary || !dataset.files.watched) {
    throw new HttpError(
      400,
      'Letterboxd archive must contain both diary.csv and watched.csv.',
      'missing_letterboxd_files'
    );
  }

  const films = new Map();
  for (const film of dataset.films) films.set(film.slug, film);

  // One lookup per film even if the diary contains rewatches of it.
  const uniqueSlugs = [...new Set(dataset.events.map((event) => event.slug))];
  const matches = new Map();
  await mapWithConcurrency(uniqueSlugs, MATCH_CONCURRENCY, async (slug) => {
    const film = films.get(slug);
    if (!film) {
      matches.set(slug, null);
      return;
    }
    let match = null;
    try {
      match = await resolveFilm(film);
    } catch (err) {
      // One failed TMDB lookup must not abort the whole archive: the event is
      // stored unmatched and can be re-attached later.
      console.warn(`[attachment] TMDB lookup failed for "${film.title}" (${film.year}): ${err.message}`);
    }
    matches.set(slug, match);
  });

  // Learn the global TMDB <-> boxd.it map for every matched film (“first
  // wins” in cache.setLbLink). This is what lets a KinoPoisk dashboard show
  // Letterboxd links without ever re-attaching an archive.
  let learned = 0;
  for (const slug of uniqueSlugs) {
    const film = films.get(slug);
    const match = matches.get(slug);
    if (!film || !match || !film.lbUri) continue;
    if (cache.setLbLink(match.tmdbId, film.lbUri, match.kind)) learned++;
  }
  if (learned > 0) cache.flushLbLinks();

  const events = dataset.events.map((event) => {
    const film = films.get(event.slug) || {};
    const match = matches.get(event.slug) || null;
    return {
      tmdbId: match ? match.tmdbId : null,
      lbSlug: event.slug,
      title: film.title || event.title || '',
      year: film.year != null ? film.year : (event.year != null ? event.year : null),
      rating: event.rating != null ? event.rating : null,
      watchDate: event.date || null,
      rewatch: Boolean(event.rewatch),
      source: event.source === 'diary' ? 'diary' : 'watched',
    };
  });
  events.sort((a, b) => String(a.watchDate || '').localeCompare(String(b.watchDate || ''))
    || String(a.title || '').localeCompare(String(b.title || ''), 'en'));

  const watchlist = dataset.watchlist.map((item) => ({
    lbSlug: item.lbSlug,
    title: item.title,
    year: item.year,
    listedAt: item.listedAt || null,
  }));

  const matchedEvents = events.filter((event) => event.tmdbId != null).length;
  const matchedFilms = uniqueSlugs.filter((slug) => {
    const match = matches.get(slug);
    return Boolean(match && match.tmdbId != null);
  }).length;

  return {
    attachment: {
      attachedAt: new Date().toISOString(),
      fileName: fileName || 'letterboxd-export.zip',
      events,
      watchlist,
    },
    stats: {
      events: events.length,
      diaryEvents: events.filter((event) => event.source === 'diary').length,
      watchedEvents: events.filter((event) => event.source === 'watched').length,
      rewatchCount: events.filter((event) => event.rewatch).length,
      matched: matchedEvents,
      matchedFilms,
      films: uniqueSlugs.length,
      watchlist: watchlist.length,
      learnedLinks: learned,
    },
  };
}

module.exports = {
  ATTACH_DIR,
  attachmentPath,
  readAttachment,
  writeAttachment,
  buildAttachment,
  resolveFilm,
};
