'use strict';

const WRITER_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Script']);
const COMPOSER_JOBS = new Set(['Original Music Composer', 'Music']);
const VOICE_RE = /\(voice/i;

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

const MUSIC_GENRE_ID = 10402;
const MUSIC_GENRE_NAMES = new Set(['music', 'музыка']);
const MUSICAL_KEYWORD = 'musical';

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
