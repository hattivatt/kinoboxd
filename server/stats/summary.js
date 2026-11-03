'use strict';

/**
 * The `summary` block of the films payload (S3 split).
 *
 * Key order is the payload contract (the golden hash is byte-sensitive):
 * filmCount, ratedCount, viewCount, dateFrom, dateTo, totalMinutes,
 * avgRuntime, auteurIndex, source, unmatchedCount, then the optional
 * movieCount/tvCount and attachment fields.
 */

const { round2 } = require('./numeric');

function buildAuteurIndex(persons, matchedFilmCount) {
  // Auteur index: unique credited directors among the matched films. The
  // director bucket is always counted (addRole(..., true)), but filter on
  // counted >= 1 to be robust against older payloads.
  const creditedDirectors = persons.director.filter((person) => person.counted >= 1);
  const directorCount = creditedDirectors.length;
  const filmsPerDirector = directorCount > 0 ? matchedFilmCount / directorCount : null;
  const topDirector = creditedDirectors.length > 0
    ? creditedDirectors
        .slice()
        .sort((a, b) => b.counted - a.counted || a.name.localeCompare(b.name, 'ru'))[0]
    : null;
  return {
    directors: directorCount,
    films: matchedFilmCount,
    ratio: filmsPerDirector != null ? round2(filmsPerDirector) : null,
    avgFilmsPerDirector: filmsPerDirector != null
      ? Math.round(filmsPerDirector * 10) / 10
      : null,
    topAuteur: topDirector ? { name: topDirector.name, count: topDirector.counted } : null,
  };
}

function buildSummary(ctx, options) {
  const { unmatchedCount, matchedFilmCount, persons, viewCount } = options;
  const summary = {
    filmCount: ctx.upload.films.length,
    ratedCount: ctx.ratedCount,
    // One entry per viewing, so rewatches make this larger than filmCount when
    // a Letterboxd attachment is present.
    viewCount,
    // With an attachment the displayed period is derived from the real
    // viewing dates that actually feed the timeline (including the ratedAt
    // fallback for films without a diary event).
    dateFrom: ctx.isKpSource
      ? (ctx.realDateFrom || ctx.upload.summary.dateFrom)
      : ctx.upload.summary.dateFrom,
    dateTo: ctx.isKpSource
      ? (ctx.realDateTo || ctx.upload.summary.dateTo)
      : ctx.upload.summary.dateTo,
    totalMinutes: ctx.totalMinutes,
    avgRuntime: ctx.runtimeCount > 0
      ? Math.round(ctx.totalMinutes / ctx.runtimeCount)
      : null,
    auteurIndex: buildAuteurIndex(persons, matchedFilmCount),
    source: ctx.source,
    unmatchedCount,
  };
  if (Number.isFinite(ctx.upload.summary.movieCount)) {
    summary.movieCount = ctx.upload.summary.movieCount;
  }
  if (Number.isFinite(ctx.upload.summary.tvCount)) {
    summary.tvCount = ctx.upload.summary.tvCount;
  }
  if (ctx.attachment) {
    summary.rewatchCount = ctx.attachmentRewatchCount;
    summary.attachedLb = {
      fileName: ctx.attachment.fileName || null,
      attachedAt: ctx.attachment.attachedAt || null,
      events: ctx.appliedEventCount,
      ratedEvents: ctx.appliedRatedEventCount,
    };
  }
  return summary;
}

module.exports = {
  buildAuteurIndex,
  buildSummary,
};
