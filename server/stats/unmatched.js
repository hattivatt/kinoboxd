'use strict';

const cache = require('../cache');
const { getJob } = require('../enrich');

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

function unmatchedTitle(film, kpSource) {
  const main = String(film.title || '').trim();
  const ru = String(film.titleRu || '').trim();
  if (!kpSource) return main || ru;
  if (ru && main && ru !== main) return `${ru} / ${main}`;
  return ru || main;
}

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
