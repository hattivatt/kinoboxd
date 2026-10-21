'use strict';

const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

/* ------------------------------------------------------------------ */
/* CSV parsing (RFC4180-ish: quotes, escaped quotes, CRLF, BOM)        */
/* ------------------------------------------------------------------ */

function parseCsv(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // swallow, \r\n handled by the \n branch
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    // skip fully empty lines
    if (r.length === 1 && r[0].trim() === '') continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = r[j] !== undefined ? r[j] : '';
    }
    out.push(obj);
  }
  return out;
}

function getField(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  return '';
}

function slugFromUri(uri) {
  if (!uri) return null;
  let s = String(uri).trim();
  if (!s) return null;
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/\/+$/, '');
  const seg = s.split('/').pop();
  return seg || null;
}

function parseYear(value) {
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseRating(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0.5 || n > 5) return null;
  return n;
}

function validDate(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/* ------------------------------------------------------------------ */
/* ZIP handling                                                        */
/* ------------------------------------------------------------------ */

function findEntry(entries, fileName) {
  const wanted = fileName.toLowerCase();
  const hits = entries.filter(
    (e) => !e.isDirectory && path.posix.basename(e.entryName).toLowerCase() === wanted
  );
  if (hits.length === 0) return null;
  // Prefer the shallowest match (Letterboxd puts files at the root, but a
  // re-zipped folder must work too). Stable for equal depth.
  hits.sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length);
  return hits[0];
}

function readCsvEntry(zip, entries, name) {
  const entry = findEntry(entries, name);
  if (!entry) return null;
  const text = zip.readAsText(entry).toString('utf8');
  return parseCsv(text);
}

/* ------------------------------------------------------------------ */
/* Dataset building                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse a Letterboxd export ZIP buffer.
 * Returns { summary, films, events }.
 */
function parseLetterboxdZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Uploaded file is empty.', 'empty_file');
  }

  let zip;
  let entries;
  try {
    zip = new AdmZip(buffer);
    entries = zip.getEntries();
  } catch (err) {
    throw new HttpError(400, 'Uploaded file is not a valid ZIP archive.', 'invalid_zip');
  }

  const diaryRows = readCsvEntry(zip, entries, 'diary.csv');
  const watchedRows = readCsvEntry(zip, entries, 'watched.csv');
  const ratingRows = readCsvEntry(zip, entries, 'ratings.csv');

  if (!diaryRows && !watchedRows) {
    throw new HttpError(
      400,
      'ZIP archive does not contain watched.csv or diary.csv.',
      'missing_letterboxd_files'
    );
  }

  const films = new Map(); // slug -> film record
  const events = []; // { slug, date, rating: number|null, source }
  const diarySlugs = new Set();

  // Some Letterboxd exports use a per-user short link in diary.csv and the
  // canonical short link in watched.csv/ratings.csv for the SAME film. Both
  // end in different slugs (e.g. boxd.it/85jq3H vs boxd.it/29Xu for The
  // Wizard of Oz). To avoid counting one film twice we merge diary/ratings
  // rows into an existing film with the same normalized title + year.
  const titleYear = new Map(); // "title|year" -> slug | null (ambiguous)

  function titleYearKey(title, year) {
    const t = String(title || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const y = parseYear(year);
    if (!t || !y) return null;
    return `${t}|${y}`;
  }

  function rememberTitleYear(title, year, slug) {
    const key = titleYearKey(title, year);
    if (!key) return;
    if (!titleYear.has(key)) titleYear.set(key, slug);
    else if (titleYear.get(key) !== slug) titleYear.set(key, null);
  }

  function findMergeSlug(title, year) {
    const key = titleYearKey(title, year);
    if (!key) return null;
    const slug = titleYear.get(key);
    return typeof slug === 'string' ? slug : null;
  }

  function upsert(slug, title, year) {
    if (!slug) return null;
    let film = films.get(slug);
    if (!film) {
      film = {
        slug,
        title: String(title || '').trim(),
        year: parseYear(year),
        rating: null,
        watchedDate: null,
        diaryWatchedDate: null,
        watchedCsvDate: null,
        diaryRating: null,
        diaryRatingDate: null,
        ratingsRating: null,
        ratingsRatingDate: null,
      };
      films.set(slug, film);
    } else {
      if (!film.title && title) film.title = String(title).trim();
      if (!film.year && parseYear(year)) film.year = parseYear(year);
    }
    return film;
  }

  // watched.csv -------------------------------------------------------
  let watchedCount = 0;
  for (const row of watchedRows || []) {
    watchedCount++;
    const slug = slugFromUri(getField(row, 'Letterboxd URI'));
    const title = getField(row, 'Name');
    const year = getField(row, 'Year');
    const film = upsert(slug, title, year);
    if (!film) continue;

    rememberTitleYear(title, year, film.slug);
    const date = validDate(getField(row, 'Date'));
    if (date && (!film.watchedCsvDate || date > film.watchedCsvDate)) {
      film.watchedCsvDate = date;
    }
    // A watched.csv event is only used for films that have no diary entries.
    // (resolved after diary.csv is parsed)
    events.push({ slug: film.slug, date, rating: null, source: 'watched' });
  }

  // ratings.csv -------------------------------------------------------
  for (const row of ratingRows || []) {
    const slug = slugFromUri(getField(row, 'Letterboxd URI'));
    const title = getField(row, 'Name');
    const year = getField(row, 'Year');
    let film = slug ? films.get(slug) : null;
    if (!film) {
      const mergeSlug = findMergeSlug(title, year);
      if (mergeSlug) film = films.get(mergeSlug);
    }
    if (!film) {
      film = upsert(slug, title, year);
      if (film) rememberTitleYear(title, year, film.slug);
    }
    if (!film) continue;

    const rating = parseRating(getField(row, 'Rating'));
    if (rating === null) continue;
    const date = validDate(getField(row, 'Date')) || '';
    if (film.ratingsRating === null || date >= (film.ratingsRatingDate || '')) {
      film.ratingsRating = rating;
      film.ratingsRatingDate = date;
    }
  }

  // diary.csv ---------------------------------------------------------
  for (const row of diaryRows || []) {
    const slug = slugFromUri(getField(row, 'Letterboxd URI'));
    const title = getField(row, 'Name');
    const year = getField(row, 'Year');

    let film = slug ? films.get(slug) : null;
    if (!film) {
      const mergeSlug = findMergeSlug(title, year);
      if (mergeSlug) film = films.get(mergeSlug);
    }
    if (!film) {
      film = upsert(slug, title, year);
      if (film) rememberTitleYear(title, year, film.slug);
    }
    if (!film) continue;

    const entryDate = validDate(getField(row, 'Date'));
    const watchedDate = validDate(getField(row, 'Watched Date')) || entryDate;
    const rating = parseRating(getField(row, 'Rating'));

    diarySlugs.add(film.slug);
    if (watchedDate && (!film.diaryWatchedDate || watchedDate > film.diaryWatchedDate)) {
      film.diaryWatchedDate = watchedDate;
    }
    if (rating !== null) {
      const cmp = entryDate || '';
      if (film.diaryRating === null || cmp >= (film.diaryRatingDate || '')) {
        film.diaryRating = rating;
        film.diaryRatingDate = cmp;
      }
    }

    events.push({
      slug: film.slug,
      date: watchedDate,
      rating,
      source: 'diary',
    });
  }

  // watched.csv fallback events for films without diary entries
  const watchedOnlyEvents = events.filter(
    (e) => e.source === 'watched' && !diarySlugs.has(e.slug)
  );
  const diaryEvents = events.filter((e) => e.source === 'diary');
  events.length = 0;
  events.push(...watchedOnlyEvents, ...diaryEvents);

  // Resolve final ratings and last watched date ------------------------
  for (const film of films.values()) {
    film.rating =
      film.diaryRating !== null ? film.diaryRating : film.ratingsRating;
    film.watchedDate = film.diaryWatchedDate || film.watchedCsvDate || null;
    delete film.diaryRating;
    delete film.diaryRatingDate;
    delete film.ratingsRating;
    delete film.ratingsRatingDate;
    delete film.diaryWatchedDate;
    delete film.watchedCsvDate;
  }

  // Timeline events for watched-only films get the film rating (if any).
  for (const event of events) {
    if (event.source === 'watched' && event.rating === null) {
      const film = films.get(event.slug);
      if (film && film.rating !== null) event.rating = film.rating;
    }
  }

  // Drop events without a usable date (they cannot be placed on timeline)
  const datedEvents = events.filter((e) => e.date);

  const ratedFilms = [...films.values()].filter((f) => f.rating !== null).length;

  let dateFrom = null;
  let dateTo = null;
  for (const e of datedEvents) {
    if (!dateFrom || e.date < dateFrom) dateFrom = e.date;
    if (!dateTo || e.date > dateTo) dateTo = e.date;
  }

  const filmList = [...films.values()]
    .sort((a, b) => a.title.localeCompare(b.title, 'en'))
    .map((f) => ({
      slug: f.slug,
      title: f.title,
      year: f.year,
      rating: f.rating,
      watchedDate: f.watchedDate,
    }));

  return {
    summary: {
      source: { type: 'letterboxd' },
      diaryEntries: (diaryRows || []).length,
      watchedEntries: watchedCount,
      films: filmList.length,
      ratedFilms,
      dateFrom,
      dateTo,
    },
    films: filmList,
    events: datedEvents,
  };
}

/* ------------------------------------------------------------------ */
/* In-memory upload store                                              */
/* ------------------------------------------------------------------ */

const uploads = new Map();
const MAX_UPLOADS = 30;

function createUpload(dataset) {
  const uploadId = crypto.randomBytes(12).toString('hex');
  uploads.set(uploadId, {
    uploadId,
    ...dataset,
    createdAt: Date.now(),
  });
  // Keep memory bounded on a long-running server.
  while (uploads.size > MAX_UPLOADS) {
    const oldest = uploads.keys().next().value;
    uploads.delete(oldest);
  }
  return uploads.get(uploadId);
}

function getUpload(uploadId) {
  if (!uploadId || typeof uploadId !== 'string') return null;
  return uploads.get(uploadId) || null;
}

module.exports = {
  HttpError,
  parseCsv,
  parseLetterboxdZip,
  createUpload,
  getUpload,
};
