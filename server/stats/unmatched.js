'use strict';

/**
 * Matched / unmatched helpers of the films payload (S3 split).
 *
 * The unmatched list is exactly what the manual-match modal offers: a film
 * whose TMDB id is missing or whose details are not cached. It reads the
 * persistent details cache only (no live request).
 */

const cache = require('../cache');
const { getJob } = require('../enrich');

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

module.exports = {
  effectiveKind,
  isKpUpload,
  unmatchedTitle,
  computeUnmatched,
  listUnmatched,
};
