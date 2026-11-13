'use strict';

const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { HttpError } = require('./core/errors');

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

function findEntry(entries, fileName) {
  const wanted = fileName.toLowerCase();
  const hits = entries.filter(
    (e) => !e.isDirectory && path.posix.basename(e.entryName).toLowerCase() === wanted
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length);
  return hits[0];
}

function readCsvEntry(zip, entries, name) {
  const entry = findEntry(entries, name);
  if (!entry) return null;
  const text = zip.readAsText(entry).toString('utf8');
  return parseCsv(text);
}

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
  const watchlistRows = readCsvEntry(zip, entries, 'watchlist.csv');

  if (!diaryRows && !watchedRows) {
    throw new HttpError(
      400,
      'ZIP archive does not contain watched.csv or diary.csv.',
      'missing_letterboxd_files'
    );
  }

  const films = new Map();
  const events = [];
  const diarySlugs = new Set();

  const titleYear = new Map();

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

  function fullUri(rawUri, slug) {
    const value = String(rawUri || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
    return slug ? `https://boxd.it/${slug}` : null;
  }

  function upsert(slug, title, year, uri) {
    if (!slug) return null;
    let film = films.get(slug);
    if (!film) {
      film = {
        slug,
        title: String(title || '').trim(),
        year: parseYear(year),
        lbUri: fullUri(uri, slug),
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
      if (!film.lbUri) film.lbUri = fullUri(uri, slug);
    }
    return film;
  }

  let watchedCount = 0;
  for (const row of watchedRows || []) {
    watchedCount++;
    const slug = slugFromUri(getField(row, 'Letterboxd URI'));
    const title = getField(row, 'Name');
    const year = getField(row, 'Year');
    const film = upsert(slug, title, year, getField(row, 'Letterboxd URI'));
    if (!film) continue;

    rememberTitleYear(title, year, film.slug);
    const date = validDate(getField(row, 'Date'));
    if (date && (!film.watchedCsvDate || date > film.watchedCsvDate)) {
      film.watchedCsvDate = date;
    }
    events.push({ slug: film.slug, date, rating: null, rewatch: false, source: 'watched' });
  }

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
      film = upsert(slug, title, year, getField(row, 'Letterboxd URI'));
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
      film = upsert(slug, title, year, getField(row, 'Letterboxd URI'));
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

    const rewatchRaw = String(getField(row, 'Rewatch') || '').trim().toLowerCase();
    events.push({
      slug: film.slug,
      date: watchedDate,
      rating,
      rewatch: rewatchRaw === 'yes' || rewatchRaw === 'true' || rewatchRaw === '1',
      source: 'diary',
    });
  }

  const watchedOnlyEvents = events.filter(
    (e) => e.source === 'watched' && !diarySlugs.has(e.slug)
  );
  const diaryEvents = events.filter((e) => e.source === 'diary');
  events.length = 0;
  events.push(...watchedOnlyEvents, ...diaryEvents);

  for (const film of films.values()) {
    film.rating =
      film.diaryRating !== null ? film.diaryRating : film.ratingsRating;
    film.watchedDate = film.diaryWatchedDate || null;
    delete film.diaryRating;
    delete film.diaryRatingDate;
    delete film.ratingsRating;
    delete film.ratingsRatingDate;
    delete film.diaryWatchedDate;
    delete film.watchedCsvDate;
  }

  for (const event of events) {
    if (event.source === 'watched' && event.rating === null) {
      const film = films.get(event.slug);
      if (film && film.rating !== null) event.rating = film.rating;
    }
    const film = films.get(event.slug);
    if (film) {
      event.title = film.title;
      event.year = film.year;
      event.lbUri = film.lbUri;
    }
    event.rewatch = Boolean(event.rewatch);
  }

  const datedEvents = events.filter((e) => e.date);

  const watchlist = [];
  const watchlistSeen = new Map();
  for (const row of watchlistRows || []) {
    const slug = slugFromUri(getField(row, 'Letterboxd URI'));
    if (!slug) continue;
    const entry = {
      lbSlug: slug,
      title: String(getField(row, 'Name') || '').trim(),
      year: parseYear(getField(row, 'Year')),
      listedAt: validDate(getField(row, 'Date')),
    };
    if (watchlistSeen.has(slug)) {
      watchlist[watchlistSeen.get(slug)] = entry;
    } else {
      watchlistSeen.set(slug, watchlist.length);
      watchlist.push(entry);
    }
  }

  const ratedFilms = [...films.values()].filter((f) => f.rating !== null).length;

  let dateFrom = null;
  let dateTo = null;
  for (const e of events) {
    if (e.source !== 'diary' || !e.date) continue;
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
      lbUri: f.lbUri || `https://boxd.it/${f.slug}`,
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
    watchlist,
    files: {
      diary: Boolean(diaryRows),
      watched: Boolean(watchedRows),
      ratings: Boolean(ratingRows),
      watchlist: Boolean(watchlistRows),
    },
  };
}

const uploads = new Map();
const MAX_UPLOADS = 30;

function createUpload(dataset) {
  const uploadId = crypto.randomBytes(12).toString('hex');
  uploads.set(uploadId, {
    uploadId,
    ...dataset,
    createdAt: Date.now(),
  });
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
