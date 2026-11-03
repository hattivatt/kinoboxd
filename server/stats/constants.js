'use strict';

/**
 * Films stats constants (S3 split).
 *
 * Genre/keyword classification and the runtime histogram buckets. The lists
 * are TMDB facts, not tuning knobs: ids are matched first because TMDB
 * localizes genre names.
 */

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

/* Runtime histogram buckets, in display order. Any runtime that is missing,
 * null or 0 belongs to "unknown"; TMDB series often report no episode runtime. */
const RUNTIME_BUCKET_ORDER = [
  '<40', '40-59', '60-89', '90-119', '120-149', '150-179', '180-239', '240+', 'unknown',
];

module.exports = {
  WRITER_JOBS,
  COMPOSER_JOBS,
  VOICE_RE,
  HIDDEN_GENRE_IDS,
  HIDDEN_GENRE_NAMES,
  MUSIC_GENRE_ID,
  MUSIC_GENRE_NAMES,
  MUSICAL_KEYWORD,
  RUNTIME_BUCKET_ORDER,
};
