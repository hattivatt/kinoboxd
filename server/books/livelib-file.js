'use strict';

/**
 * LiveLib export **file** import — the safe alternative to scraping.
 *
 * The file is produced by the community service `Chimildic/livelib-backup`
 * (Google Apps Script web app: https://chimildic.github.io/livelib-backup/).
 * The service reads the reader's public pages in a browser session and hands
 * the user a JSON/CSV file; we only ever parse that file. No request to
 * livelib.ru is made by this module, so importing a file can never look like
 * automated access from our IP (see §9 «ban risk» in КНИГИ-АРХИТЕКТУРА.md).
 *
 * Formats accepted (verified against the service sources, 28.10.2026):
 *
 *   src/gs/book-parser.js   -> one book object per shelf row
 *   src/webpage/export-script.js -> `JSON.stringify(bookArray)` for json,
 *                                   `;`-separated CSV otherwise
 *
 * JSON (top level is an array; `{items|books|data: [...]}` is tolerated):
 *
 *   {
 *     "title": "Аннигиляция",
 *     "bookHref": "https://www.livelib.ru/book/1002745594-annigilyatsiya-...",
 *     "coverHref": "https://s1.livelib.ru/boocover/1002745594/200x305/....jpg",
 *     "readDate": "Сентябрь 2026 г.",          // RU header of the month group
 *     "annotation": "...",
 *     "rating": { "overall": "7.4", "user": "3.5" },   // strings, 5-scale user
 *     "authors": [ { "name": "...", "href": "..." } ],
 *     "genres":  [ { "name": "фэнтези", "href": "...", "topPlace": "№10" } ],
 *     "stats":   { "loved": 0, "reviews": 5, "quotes": 2, "read": 2327 },
 *     "details": { "isbn": "978-5-699-98967-6", "year": "2018",
 *                  "publishers": "Эксмо", "series": "…", "language": "Русский" }
 *   }
 *
 * Only the columns the user ticked in the form are present, so every field is
 * optional. The shelf itself is NOT in the file: the service exports one page
 * at a time (`read`/`unread`/`reading`/`wish`), so the caller tells us which
 * one it is (form field or filename).
 *
 * Mapping into the profile model (§3.3):
 *   - `bookHref` -> `sourceBookId` (LiveLib art_edition id, the same id as
 *     `/book/{id}` and the RSC payload) — this is the stable key;
 *   - `rating.user` is the 5-star personal rating the legacy design shows;
 *     `rating10 = round(5-scale × 2)` keeps one unified 10-scale;
 *   - `readDate` is a month (`Сентябрь 2026 г.`) → `readMonth: '2026-09'`;
 *     `finishedAt` stays null because the export never carries a real day.
 *     A day is accepted only when the value explicitly has one AND it is not
 *     the first of the month (the Goodreads export fabricates `YYYY/MM/01`);
 *   - `details.isbn` may hold several ISBNs -> `isbn`/`isbn13`/`isbn10`;
 *   - `details.publishers|year|language|series` and `genres` are stored on the
 *     event itself: the export already carries them, so the metadata chain is
 *     an enrichment, not a requirement.
 */

const crypto = require('crypto');

const {
  cleanText,
  isbn10Of,
  normalizeIsbn,
  normalizeTitle,
  surnameOf,
} = require('./normalize');

const ORIGIN = 'livelib-file';
/**
 * A wishlist («Хочу прочитать») of a heavy reader is easily bigger than the
 * ~1 245 read books of our reference profile, so the cap is not the read
 * collection size: it only catches "two profiles glued together" / a database
 * dump. The 24 MB upload limit is the real ceiling.
 */
const MAX_BOOKS = 20000;

class LivelibFileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LivelibFileError';
    this.code = code || 'livelib_file_invalid';
  }
}

/* ------------------------------------------------------------------ */
/* Shelves                                                             */
/* ------------------------------------------------------------------ */

/** Shelves the service can export, mapped to the profile status labels. */
const SHELVES = ['read', 'dnf', 'reading', 'wish'];

/** Status label of a shelf — the same vocabulary Hardcover events use. */
const SHELF_STATUS = {
  read: 'read',
  dnf: 'dnf',
  reading: 'reading',
  wish: 'wish',
};

/** Shelves that belong to the reading history (everything else is a plan). */
const PROFILE_SHELVES = ['read', 'dnf'];

const SHELF_ALIASES = new Map(
  [
    // Прочитал
    ['read', 'read'],
    ['read books', 'read'],
    ['прочитал', 'read'],
    ['прочитано', 'read'],
    ['finished', 'read'],
    // Не дочитал (pagename `unread` in the service)
    ['dnf', 'dnf'],
    ['unread', 'dnf'],
    ['did not finish', 'dnf'],
    ['did-not-finish', 'dnf'],
    ['не дочитал', 'dnf'],
    ['недочитал', 'dnf'],
    ['брошено', 'dnf'],
    // Читаю сейчас
    ['reading', 'reading'],
    ['currently-reading', 'reading'],
    ['currently reading', 'reading'],
    ['читаю сейчас', 'reading'],
    ['читаю', 'reading'],
    // Хочу прочитать
    ['wish', 'wish'],
    ['to-read', 'wish'],
    ['want to read', 'wish'],
    ['хочу прочитать', 'wish'],
    ['хочу почитать', 'wish'],
  ].map(([alias, shelf]) => [alias, shelf])
);

/** Normalize a shelf token (RU/EN/goodreads label); null when unknown. */
function shelfOf(value) {
  const key = cleanText(value).toLowerCase().replace(/ё/g, 'е');
  if (!key) return null;
  return SHELF_ALIASES.get(key) || null;
}

/**
 * Guess the shelf from a file name. The service names its files
 * `livelib-{username}-{pagename}-{date}.{ext}`, e.g.
 * `livelib-margaret-read-28.10.2026.json`.
 */
function shelfFromFilename(filename) {
  const name = cleanText(filename).toLowerCase().replace(/ё/g, 'е');
  if (!name) return null;
  const stem = name.replace(/\.[a-z0-9]+$/, '');
  const parts = stem.split(/[-_.\s]+/).filter(Boolean);
  // Longest match first so "currently-reading" beats "reading".
  for (const shelf of ['currently-reading', 'did-not-finish', 'to-read', 'unread', 'wish', 'reading', 'read']) {
    if (parts.includes(shelf) || stem.includes(`-${shelf}-`) || stem.endsWith(`-${shelf}`)) {
      return shelfOf(shelf);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const MONTHS = new Map(
  [
    ['январь', 1], ['января', 1], ['январе', 1],
    ['февраль', 2], ['февраля', 2], ['феврале', 2],
    ['март', 3], ['марта', 3], ['марте', 3],
    ['апрель', 4], ['апреля', 4], ['апреле', 4],
    ['май', 5], ['мая', 5], ['мае', 5],
    ['июнь', 6], ['июня', 6], ['июне', 6],
    ['июль', 7], ['июля', 7], ['июле', 7],
    ['август', 8], ['августа', 8], ['августе', 8],
    ['сентябрь', 9], ['сентября', 9], ['сентябре', 9],
    ['октябрь', 10], ['октября', 10], ['октябре', 10],
    ['ноябрь', 11], ['ноября', 11], ['ноябре', 11],
    ['декабрь', 12], ['декабря', 12], ['декабре', 12],
    // The service shows the nominative form ("Декабрь 2025 г."), the older
    // page headers used the prepositional one ("прочитано в марте 2023"), and
    // a hand-edited column may hold either. English is accepted for tolerance.
    ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5],
    ['june', 6], ['july', 7], ['august', 8], ['september', 9], ['october', 10],
    ['november', 11], ['december', 12],
  ].map(([name, month]) => [name, month])
);

/**
 * Leading words a date column may carry: «прочитано в марте 2023»,
 * «read in March 2023». Stripped before parsing; the month word itself never
 * starts with any of them.
 */
const DATE_PREFIX = /^(?:прочитан[оа]?|прочитал[аи]?|читал[аи]?|read|finished)\s+(?:in|в)?\s*/i;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isoDay(year, month, day) {
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return iso;
}

/**
 * Parse the `readDate` value of the export.
 *
 * Returns `{ finishedAt, readMonth, precision }`:
 *   - `day`   — an explicit real day (`2024-03-02`, `02.03.2024`);
 *   - `month` — month + year (`Сентябрь 2026 г.`, `2026-09`, `09.2026`);
 *   - `year`  — only a year (`2025 г.`) — no month, so no timeline bucket;
 *   - `null`  — nothing usable.
 *
 * A `01` day is treated as month precision: the Goodreads flavour of the
 * export fabricates `YYYY/MM/01` out of the same month header, and inventing a
 * day would put fake dots on the reading calendar.
 */
function parseFileReadDate(raw) {
  let value = cleanText(raw).toLowerCase().replace(/ё/g, 'е');
  if (!value) return { finishedAt: null, readMonth: null, precision: null };
  // «прочитано в марте 2023» / «read in March 2023» -> «марте 2023»
  if (DATE_PREFIX.test(value)) value = value.replace(DATE_PREFIX, '').trim();
  else if (/^в\s+/.test(value)) value = value.replace(/^в\s+/, '');
  if (!value) return { finishedAt: null, readMonth: null, precision: null };

  // ISO day: 2024-03-02
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const [, year, month, day] = match;
    return dayResult(Number(year), Number(month), Number(day));
  }

  // Goodreads flavour: 2024/03/02
  match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  if (match) {
    const [, year, month, day] = match;
    return dayResult(Number(year), Number(month), Number(day));
  }

  // RU dotted day: 02.03.2024
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/.exec(value);
  if (match) {
    const [, day, month, year] = match;
    const result = dayResult(Number(year), Number(month), Number(day));
    if (result.precision) return result;
  }

  // Month + year: "сентябрь 2026 г." / "сентябрь 2026" / "сентября 2026" /
  // "марте 2023 году" (the page header of the old design).
  match = /^([\p{L}]+)\.?\s+(\d{4})\s*(?:г(?:од[ау]?)?\.?)?$/u.exec(value);
  if (match) {
    const month = MONTHS.get(match[1]);
    const year = Number(match[2]);
    if (month && year >= 1800 && year <= 2200) {
      return { finishedAt: null, readMonth: `${year}-${pad2(month)}`, precision: 'month' };
    }
  }

  // Day + month name + year: "2 марта 2024" (hand-edited / Goodreads flavour).
  match = /^(\d{1,2})\s+([\p{L}]+)\.?\s+(\d{4})\s*(?:г(?:од[ау]?)?\.?)?$/u.exec(value);
  if (match) {
    const month = MONTHS.get(match[2]);
    if (month) return dayResult(Number(match[3]), month, Number(match[1]));
  }

  // Numeric month: 2026-09 / 09.2026 / 09/2026
  match = /^(\d{4})[-.](\d{1,2})$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return { finishedAt: null, readMonth: `${year}-${pad2(month)}`, precision: 'month' };
    }
  }
  match = /^(\d{1,2})[./](\d{4})$/.exec(value);
  if (match) {
    const month = Number(match[1]);
    const year = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return { finishedAt: null, readMonth: `${year}-${pad2(month)}`, precision: 'month' };
    }
  }

  // Year only: "2025 г." / "2025" / "2025 году"
  match = /^(\d{4})\s*(?:г(?:од[ау]?)?\.?)?$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    if (year >= 1800 && year <= 2200) {
      return { finishedAt: null, readMonth: null, precision: 'year' };
    }
  }

  return { finishedAt: null, readMonth: null, precision: null };

  function dayResult(year, month, day) {
    if (!(year >= 1800 && year <= 2200)) {
      return { finishedAt: null, readMonth: null, precision: null };
    }
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
      return { finishedAt: null, readMonth: null, precision: null };
    }
    if (day === 1) {
      // Fabricated first-of-month (export header) — keep the month only.
      return { finishedAt: null, readMonth: `${year}-${pad2(month)}`, precision: 'month' };
    }
    const iso = isoDay(year, month, day);
    if (!iso) return { finishedAt: null, readMonth: `${year}-${pad2(month)}`, precision: 'month' };
    return { finishedAt: iso, readMonth: null, precision: 'day' };
  }
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/** Number with either decimal separator; null for empty/garbage. */
function numOrNull(value) {
  const raw = cleanText(value).replace(',', '.');
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/** Personal rating on the 5-star scale the export uses; null when absent. */
function rating5Of(value) {
  const number = numOrNull(value);
  if (number == null || number <= 0) return null;
  if (number >= 1 && number <= 5) return number;
  // A value that already looks 1..10 is halved instead of clamped: some users
  // hand-edit the column to the LiveLib 10-point scale.
  if (number > 5 && number <= 10) return Math.round(number) / 2;
  return null;
}

function rating10Of(value) {
  const rating5 = rating5Of(value);
  return rating5 == null ? null : Math.round(rating5 * 2);
}

/** ISBN-13 check digit (mod 10); true for a well-formed 978/979 number. */
function isbn13ChecksumOk(digits) {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

/**
 * First usable ISBN of the column (may hold a list — the service joins every
 * ISBN of an edition with `,`).
 *
 * A checksum-valid number always wins: LiveLib data is dirty, and a garbled
 * ISBN would send the resolve chain to a query that cannot match. When nothing
 * validates, the first well-formed-looking number is kept (the display value
 * is still useful) but `isbn13` — the matching key — stays null.
 */
function isbnOf(value) {
  const raw = cleanText(value);
  if (!raw) return { isbn: null, isbn13: null, isbn10: null };
  const candidates = raw
    .split(/[,;/|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const wellFormed = [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/[^\dXx]/g, '').toUpperCase();
    if (digits.length !== 10 && digits.length !== 13) continue;
    const isbn13 = normalizeIsbn(digits);
    if (!isbn13) continue;
    wellFormed.push({ isbn: isbn13, isbn13, isbn10: isbn10Of(isbn13), ok: isbn13ChecksumOk(isbn13) });
  }
  const valid = wellFormed.find((entry) => entry.ok);
  if (valid) return { isbn: valid.isbn, isbn13: valid.isbn13, isbn10: valid.isbn10 };
  if (wellFormed.length) {
    const first = wellFormed[0];
    return { isbn: first.isbn, isbn13: null, isbn10: null };
  }
  return { isbn: null, isbn13: null, isbn10: null };
}

function yearOf(value) {
  const match = /(\d{4})/.exec(cleanText(value));
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 2100 ? year : null;
}

/** LiveLib book id from `/book/1002745594-slug` or a bare id. */
function bookIdOf(hrefOrId) {
  const value = cleanText(hrefOrId);
  if (!value) return null;
  const match = /\/book\/(\d+)/.exec(value);
  if (match) return match[1];
  if (/^\d{3,}$/.test(value)) return value;
  return null;
}

/**
 * Absolute URL. The service prefixes `bookHref` with `BASE_URL` itself, but a
 * hand-edited file may carry `/book/123-slug` — and a relative cover would be
 * a dead link in the dashboard.
 */
function absoluteUrl(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `https://www.livelib.ru${raw}`;
  return raw;
}

/**
 * Identity of a record when the file has no «Ссылка на книгу» column — which
 * is the service's default (the checkbox is unticked). Title + first author
 * surname is stable across re-exports and makes a repeated upload idempotent
 * instead of appending a second copy of the same shelf.
 */
function titleKeyOf(title, authors) {
  const name = cleanText(title);
  if (!name) return null;
  const normalized = normalizeTitle(name);
  if (!normalized) return null;
  const surname = surnameOf(Array.isArray(authors) ? authors[0] : '');
  return `${normalized}|${surname}`;
}

/** Short stable id fragment for a title-keyed event (no book id in file). */
function titleHashOf(titleKey) {
  return crypto.createHash('sha1').update(titleKey).digest('hex').slice(0, 10);
}

/** Language code from the RU column (`Русский` -> `ru`). */
function languageOf(value) {
  const raw = cleanText(value).toLowerCase();
  if (!raw) return null;
  if (/^(ru|рус)/.test(raw)) return 'ru';
  if (/^(en|англ)/.test(raw)) return 'en';
  if (/^(uk|укр)/.test(raw)) return 'uk';
  if (/^(de|нем)/.test(raw)) return 'de';
  if (/^(fr|франц)/.test(raw)) return 'fr';
  if (/^[a-z]{2}$/.test(raw)) return raw;
  return null;
}

function authorsOf(value) {
  if (Array.isArray(value)) {
    const names = [];
    for (const entry of value) {
      const name = entry && typeof entry === 'object' ? entry.name || entry.author : entry;
      const clean = cleanText(name);
      if (clean && !names.includes(clean)) names.push(clean);
    }
    return names;
  }
  const raw = cleanText(value);
  if (!raw) return [];
  return [...new Set(raw.split(/\s*,\s*|\s*;\s*/).map(cleanText).filter(Boolean))];
}

function genresOf(value) {
  if (Array.isArray(value)) {
    const names = [];
    for (const entry of value) {
      const name = entry && typeof entry === 'object' ? entry.name : entry;
      const clean = cleanText(name);
      if (clean && !names.includes(clean)) names.push(clean);
    }
    return names;
  }
  const raw = cleanText(value);
  if (!raw) return [];
  return [...new Set(raw.split(/\s*,\s*|\s*;\s*/).map(cleanText).filter(Boolean))];
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

/** Pick a key case-insensitively from a list of aliases. */
function pick(source, aliases) {
  if (!source || typeof source !== 'object') return undefined;
  const wanted = aliases.map((alias) => alias.toLowerCase());
  for (const key of Object.keys(source)) {
    if (wanted.includes(String(key).toLowerCase())) return source[key];
  }
  return undefined;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function detailValue(source, aliases) {
  const details = asObject(pick(source, ['details', 'детали'])) || {};
  const direct = pick(source, aliases);
  if (direct !== undefined) return direct;
  return pick(details, aliases);
}

/** One raw JSON/CSV record -> the normalized shape the importer consumes. */
function normalizeRecord(raw) {
  const book = asObject(raw);
  if (!book) return null;

  const title = cleanText(pick(book, ['title', 'название', 'name']));
  const bookHref = cleanText(pick(book, ['bookHref', 'bookHrefs', 'url', 'ссылка на книгу', 'ссылка']));
  const bookId = bookIdOf(bookHref) || bookIdOf(pick(book, ['bookId', 'id', 'artId']));
  // A row with neither a title nor a book id cannot be matched to anything:
  // it is dropped instead of becoming an anonymous event.
  if (!title && !bookId) return null;

  const ratingBlock = asObject(pick(book, ['rating', 'оценка', 'рейтинг']));
  const ratingUserRaw = ratingBlock
    ? pick(ratingBlock, ['user', 'my', 'личная', 'моя'])
    : pick(book, ['ratingUser', 'моя оценка', 'myRating']);
  const ratingOverallRaw = ratingBlock
    ? pick(ratingBlock, ['overall', 'community', 'общая'])
    : pick(book, ['ratingOverall', 'общая оценка']);

  const statsBlock = asObject(pick(book, ['stats', 'счётчики', 'counts'])) || {};

  const readDateRaw = pick(book, ['readDate', 'дата прочтения', 'dateRead', 'finishedAt']);
  const date = parseFileReadDate(readDateRaw);

  const isbnRaw = detailValue(book, ['isbn']);
  const isbn = isbnOf(isbnRaw);
  const authors = authorsOf(pick(book, ['authors', 'автор', 'авторы']));

  return {
    bookId,
    title: title || null,
    titleKey: titleKeyOf(title, authors),
    bookHref: absoluteUrl(bookHref) || (bookId ? `https://www.livelib.ru/book/${bookId}` : null),
    coverHref: absoluteUrl(pick(book, ['coverHref', 'cover', 'ссылка на обложку', 'обложка'])),
    readDateRaw: cleanText(readDateRaw) || null,
    finishedAt: date.finishedAt,
    readMonth: date.readMonth,
    datePrecision: date.precision,
    rating5: rating5Of(ratingUserRaw),
    communityRating: numOrNull(ratingOverallRaw),
    authors,
    genres: genresOf(pick(book, ['genres', 'жанры'])),
    publisher: cleanText(detailValue(book, ['publishers', 'publisher', 'издатель', 'издательство'])) || null,
    year: yearOf(detailValue(book, ['year', 'дата издания', 'год', 'publicationYear'])),
    language: languageOf(detailValue(book, ['language', 'язык'])),
    series: cleanText(detailValue(book, ['series', 'серия'])) || null,
    isbn,
    bookStats: {
      loved: numOrNull(pick(statsBlock, ['loved', 'лайки', 'количество лайков'])),
      reviews: numOrNull(pick(statsBlock, ['reviews', 'рецензии', 'количество рецензий'])),
      quotes: numOrNull(pick(statsBlock, ['quotes', 'цитаты', 'количество цитат'])),
      read: numOrNull(pick(statsBlock, ['read', 'прочтения', 'количество прочтений'])),
    },
  };
}

function parseJsonDocument(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LivelibFileError(
      'Файл не похож на JSON-экспорт: не удалось разобрать JSON.',
      'livelib_file_invalid_json'
    );
  }
  if (Array.isArray(parsed)) return parsed;
  const wrapper = asObject(parsed);
  if (!wrapper) {
    throw new LivelibFileError(
      'JSON-экспорт должен быть массивом книг (или объектом с items/books/data).',
      'livelib_file_invalid_json'
    );
  }
  for (const key of ['items', 'books', 'data', 'bookArray', 'rows']) {
    const value = wrapper[key];
    if (Array.isArray(value)) return value;
  }
  throw new LivelibFileError(
    'JSON-экспорт должен быть массивом книг (или объектом с items/books/data).',
    'livelib_file_invalid_json'
  );
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Minimal delimited parser (RFC4180 quotes, CRLF, BOM). `parseCsv` from
 * `server/upload.js` is comma-only, and the service writes `;` (so that the
 * comma stays usable inside `Автор`/`Жанры` cells).
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(headerLine) {
  const semicolons = (headerLine.match(/;/g) || []).length;
  const commas = (headerLine.match(/,/g) || []).length;
  const tabs = (headerLine.match(/\t/g) || []).length;
  if (tabs > semicolons && tabs > commas) return '\t';
  return semicolons >= commas ? ';' : ',';
}

/** CSV header -> canonical field name (RU titles of the export + EN). */
const CSV_COLUMNS = new Map(
  [
    ['название', 'title'], ['title', 'title'], ['name', 'title'],
    ['автор', 'author'], ['авторы', 'author'], ['author', 'author'], ['authors', 'author'],
    ['дата прочтения', 'readDate'], ['date read', 'readDate'], ['readdate', 'readDate'],
    ['date read', 'readDate'], ['read date', 'readDate'],
    ['моя оценка', 'ratingUser'], ['my rating', 'ratingUser'], ['ratinguser', 'ratingUser'],
    ['общая оценка', 'ratingOverall'], ['average rating', 'ratingOverall'],
    ['ratingoverall', 'ratingOverall'],
    ['isbn', 'isbn'],
    ['жанры', 'genres'], ['genres', 'genres'],
    ['издатель', 'publisher'], ['publisher', 'publisher'], ['издательство', 'publisher'],
    ['дата издания', 'year'], ['year published', 'year'], ['year', 'year'], ['год', 'year'],
    ['язык', 'language'], ['language', 'language'],
    ['серия', 'series'], ['series', 'series'],
    ['количество лайков', 'loved'], ['likes', 'loved'],
    ['количество рецензий', 'reviews'], ['reviews', 'reviews'],
    ['количество цитат', 'quotes'], ['quotes', 'quotes'],
    ['количество прочтений', 'read'], ['reads', 'read'],
    ['ссылка на книгу', 'bookHref'], ['link', 'bookHref'], ['bookhref', 'bookHref'],
    ['ссылка на обложку', 'coverHref'], ['cover', 'coverHref'], ['coverhref', 'coverHref'],
    ['аннотация', 'annotation'], ['annotation', 'annotation'],
    ['полка', 'shelf'], ['shelf', 'shelf'], ['shelves', 'shelf'],
  ].map(([alias, field]) => [alias, field])
);

function canonicalHeader(header) {
  const key = cleanText(header).toLowerCase().replace(/ё/g, 'е');
  return CSV_COLUMNS.get(key) || null;
}

function parseCsvDocument(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = body.split('\n')[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows = parseDelimited(body, delimiter);
  if (!rows.length) {
    throw new LivelibFileError('CSV-файл пуст.', 'livelib_file_empty');
  }
  const headers = rows[0].map(canonicalHeader);
  if (!headers.includes('title') && !headers.includes('bookHref')) {
    throw new LivelibFileError(
      'CSV не похож на экспорт livelib-backup: нет колонки «Название»/«Ссылка на книгу».',
      'livelib_file_unknown_columns'
    );
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length === 1 && cleanText(cells[0]) === '') continue;
    const record = {};
    headers.forEach((field, index) => {
      if (!field) return;
      record[field] = cells[index] == null ? '' : cells[index];
    });
    const normalized = normalizeRecord({
      title: record.title,
      bookHref: record.bookHref,
      coverHref: record.coverHref,
      readDate: record.readDate,
      ratingUser: record.ratingUser,
      ratingOverall: record.ratingOverall,
      isbn: record.isbn,
      genres: record.genres,
      publishers: record.publisher,
      year: record.year,
      language: record.language,
      series: record.series,
      authors: record.author,
      stats: {
        loved: record.loved,
        reviews: record.reviews,
        quotes: record.quotes,
        read: record.read,
      },
    });
    if (!normalized) continue;
    if (record.shelf) normalized.shelfHint = shelfOf(record.shelf) || null;
    out.push(normalized);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse an uploaded export file.
 *
 * @param {Buffer|string} input raw file bytes
 * @param {{filename?: string}} [options] used for format sniffing and the
 *        shelf guess
 * @returns {{format:'json'|'csv', books: object[], shelf: string|null,
 *            warnings: string[], stats: object}}
 */
function parseExportFile(input, options = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  if (text.length > 24 * 1024 * 1024) {
    throw new LivelibFileError('Файл слишком большой (лимит 24 МБ).', 'livelib_file_too_large');
  }
  if (!text.trim()) {
    throw new LivelibFileError('Файл пуст.', 'livelib_file_empty');
  }

  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  const warnings = [];
  let format;
  let books;

  if (looksJson) {
    format = 'json';
    const rows = parseJsonDocument(trimmed);
    books = [];
    for (const row of rows) {
      const normalized = normalizeRecord(row);
      if (normalized) books.push(normalized);
    }
  } else {
    format = 'csv';
    books = parseCsvDocument(trimmed);
  }

  if (!books.length) {
    throw new LivelibFileError(
      'В файле не найдено ни одной книги — проверьте, что выбрана страница «Прочитал» и хотя бы колонка «Название».',
      'livelib_file_no_books'
    );
  }
  if (books.length > MAX_BOOKS) {
    throw new LivelibFileError(
      `В файле ${books.length} строк — это больше лимита ${MAX_BOOKS}. Проверьте, что не склеены несколько профилей.`,
      'livelib_file_too_many_books'
    );
  }

  let withBookId = 0;
  let withTitleKey = 0;
  let withDate = 0;
  let withMonth = 0;
  let withYearOnly = 0;
  let withRating = 0;
  let withIsbn = 0;
  let withGenres = 0;
  const seen = new Set();
  let duplicates = 0;
  for (const book of books) {
    if (book.bookId) withBookId++;
    if (book.titleKey) withTitleKey++;
    if (book.finishedAt) withDate++;
    else if (book.readMonth) withMonth++;
    else if (book.datePrecision === 'year') withYearOnly++;
    if (book.rating5 != null) withRating++;
    if (book.isbn && book.isbn.isbn13) withIsbn++;
    if (book.genres.length) withGenres++;
    const key = book.bookId ? `id:${book.bookId}` : book.titleKey ? `tk:${book.titleKey}` : null;
    if (key) {
      if (seen.has(key)) duplicates++;
      seen.add(key);
    }
  }
  if (withBookId === 0) {
    warnings.push(
      'В файле нет ссылок на книгу: книги сопоставляются по названию и автору. Включите колонку «Ссылка на книгу» — по ней повторный импорт узнаёт книгу точнее.'
    );
  }
  if (withDate === 0) {
    warnings.push(
      'Точных дат прочтения в файле нет: LiveLib отдаёт только месяц, поэтому календарь и стрики по этим событиям не строятся (таймлайн — по месяцам).'
    );
  }
  if (withYearOnly > 0) {
    warnings.push(
      `${withYearOnly} ${withYearOnly === 1 ? 'книга' : 'книг'} с датой «только год»: у них нет даже месяца, в таймлайн и календарь они не попадут.`
    );
  }

  // The shelf is a property of the exported page, not of a row. A file-level
  // hint wins; a per-row `shelf` column (Goodreads flavour) fills the rest.
  const fileShelf = shelfOf(options.shelf) || shelfFromFilename(options.filename) || null;
  const rowShelf = books.reduce((found, book) => found || book.shelfHint || null, null);

  return {
    format,
    books,
    shelf: fileShelf || rowShelf || null,
    warnings,
    stats: {
      books: books.length,
      withBookId,
      withTitleKey,
      withDay: withDate,
      withMonth,
      withYearOnly,
      withRating,
      withIsbn,
      withGenres,
      duplicateBookIds: duplicates,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/** Build one profile event out of a normalized record. */
function buildFileEvent(book, shelf, position) {
  const suffix = position > 1 ? `#${position}` : '';
  // Stable identity: the LiveLib book id when the file has the link column,
  // otherwise a title+author hash (the service's default column set has no
  // link, and a positional id would duplicate a re-exported shelf).
  const fileKey = book.bookId
    ? `id:${book.bookId}`
    : book.titleKey
      ? `tk:${titleHashOf(book.titleKey)}`
      : null;
  const id = fileKey ? `llfile:${fileKey}:${shelf}${suffix}` : `llfile:${shelf}:${position}`;
  const isbn = book.isbn && typeof book.isbn === 'object'
    ? book.isbn
    : { isbn: null, isbn13: null, isbn10: null };
  return {
    id,
    fileKey,
    source: ORIGIN,
    origin: ORIGIN,
    sourceBookId: book.bookId || null,
    sourceUrl: book.bookHref || (book.bookId ? `https://www.livelib.ru/book/${book.bookId}` : null),
    workId: null,
    title: book.title || null,
    authors: Array.isArray(book.authors) ? book.authors : [],
    rating: book.rating5 == null ? null : book.rating5,
    ratingScale: 5,
    rating10: book.rating5 == null ? null : Math.round(book.rating5 * 2),
    status: SHELF_STATUS[shelf] || 'read',
    shelf,
    startedAt: null,
    finishedAt: book.finishedAt || null,
    readMonth: book.readMonth || null,
    readDateRaw: book.readDateRaw || null,
    reread: false,
    readIndex: 1,
    edition: {
      publisher: book.publisher || null,
      year: book.year || null,
      isbn: isbn.isbn || null,
      isbn13: isbn.isbn13 || null,
      isbn10: isbn.isbn10 || null,
      language: book.language || null,
      series: book.series || null,
    },
    genres: Array.isArray(book.genres) ? book.genres : [],
    coverUrl: book.coverHref || null,
    communityRating: book.communityRating == null ? null : book.communityRating,
    bookStats: book.bookStats || null,
  };
}

/** Fill fields the incoming row knows and the stored event does not. */
function fillMissing(target, incoming) {
  let changed = 0;
  const setIfEmpty = (key, value) => {
    if (value == null || value === '') return;
    if (target[key] == null || target[key] === '') {
      target[key] = value;
      changed++;
    }
  };
  setIfEmpty('title', incoming.title);
  setIfEmpty('sourceUrl', incoming.sourceUrl);
  setIfEmpty('coverUrl', incoming.coverUrl);
  setIfEmpty('communityRating', incoming.communityRating);
  if (Array.isArray(incoming.authors) && incoming.authors.length) {
    const have = Array.isArray(target.authors) ? target.authors.filter(Boolean) : [];
    if (!have.length) {
      target.authors = [...incoming.authors];
      changed++;
    }
  }
  if (Array.isArray(incoming.genres) && incoming.genres.length) {
    const have = Array.isArray(target.genres) ? target.genres : [];
    if (!have.length) {
      target.genres = [...incoming.genres];
      changed++;
    }
  }
  if (incoming.rating10 != null && target.rating10 == null) {
    target.rating = incoming.rating;
    target.ratingScale = incoming.ratingScale;
    target.rating10 = incoming.rating10;
    changed++;
  }
  // Dates: an exact day always wins; a month only fills a gap.
  if (incoming.finishedAt && !target.finishedAt) {
    target.finishedAt = incoming.finishedAt;
    target.readMonth = null;
    changed++;
  } else if (!target.finishedAt && incoming.readMonth && !target.readMonth) {
    target.readMonth = incoming.readMonth;
    changed++;
  }
  if (incoming.bookStats && !target.bookStats) {
    target.bookStats = { ...incoming.bookStats };
    changed++;
  }
  const targetEdition = target.edition && typeof target.edition === 'object' ? target.edition : {};
  const incomingEdition = incoming.edition || {};
  let editionChanged = false;
  for (const key of ['publisher', 'year', 'isbn', 'isbn13', 'isbn10', 'language', 'series']) {
    if (incomingEdition[key] == null || incomingEdition[key] === '') continue;
    if (targetEdition[key] == null || targetEdition[key] === '') {
      targetEdition[key] = incomingEdition[key];
      editionChanged = true;
    }
  }
  if (editionChanged) {
    target.edition = targetEdition;
    changed++;
  }
  // Audit marker only: the row was originally obtained some other way (a
  // scrape), so its `origin` must not claim the file created it. `stats` reads
  // the file as a metadata source only for events of `origin: 'livelib-file'`.
  if (changed) target.fileEnriched = true;
  return changed;
}

/** Identity used to recognise "the same book on the same shelf". */
function identityOfEvent(event) {
  if (!event) return null;
  if (event.fileKey) return `key:${event.fileKey}`;
  if (event.sourceBookId) return `key:id:${event.sourceBookId}`;
  const titleKey = titleKeyOf(event.title, event.authors);
  return titleKey ? `key:tk:${titleHashOf(titleKey)}` : null;
}

/**
 * Merge one exported shelf into a profile document.
 *
 * Union semantics: an upload never deletes events. Several files (one per
 * shelf, or a re-export that dropped a column) must be able to arrive in any
 * order without wiping what the previous file — or a previous scrape — already
 * contributed. A book already present on the same shelf is *enriched* (dates,
 * ISBN, publisher, series, genres, rating) instead of duplicated; an exact day
 * from a scrape is never downgraded to a month.
 *
 * @param {object|null} existingProfile profile document or null
 * @param {{userKey: string, books: object[], shelf: string,
 *          format: string, filename?: string, now?: string}} input
 */
function mergeFileIntoProfile(existingProfile, input) {
  const now = input.now || new Date().toISOString();
  const userKey = String(input.userKey);
  const shelf = shelfOf(input.shelf) || 'read';
  const profile = existingProfile && Array.isArray(existingProfile.events)
    ? {
        ...existingProfile,
        events: existingProfile.events.map((event) => ({ ...event })),
      }
    : {
        schemaVersion: 1,
        source: 'livelib',
        userKey,
        sourceUserId: null,
        importedAt: now,
        events: [],
        warnings: [],
      };

  // Existing events of the same shelf, keyed by their identity (LiveLib book
  // id, else the title+author key of a previous file import). A scraped
  // profile has no `shelf` field: its rows always come from «Прочитано».
  const index = new Map();
  for (const event of profile.events) {
    if (!event) continue;
    const eventShelf = event.shelf || 'read';
    if (eventShelf !== shelf) continue;
    const key = identityOfEvent(event);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(event);
  }

  let added = 0;
  let enriched = 0;
  let skipped = 0;
  const seenInFile = new Map();
  for (const book of input.books) {
    if (!book) continue;
    const incoming = buildFileEvent(book, shelf, 1);
    const key = incoming.fileKey ? `key:${incoming.fileKey}` : null;
    const position = key ? (seenInFile.get(key) || 0) + 1 : 1;
    if (key) seenInFile.set(key, position);
    if (position > 1) {
      // A repeated book inside one file (a re-read, or the same edition on the
      // shelf twice) is a separate event, not an enrichment.
      const repeated = buildFileEvent(book, shelf, position);
      profile.events.push(repeated);
      added++;
      continue;
    }

    const candidates = key ? index.get(key) || [] : [];
    const target = candidates[0] || null;
    if (target) {
      if (fillMissing(target, incoming) > 0) enriched++;
      else skipped++;
      continue;
    }
    profile.events.push(incoming);
    added++;
  }

  profile.importedAt = now;
  profile.fileImports = Array.isArray(profile.fileImports) ? profile.fileImports : [];
  profile.fileImports.push({
    shelf,
    format: input.format || null,
    filename: input.filename ? String(input.filename).slice(0, 180) : null,
    books: input.books.length,
    added,
    enriched,
    importedAt: now,
  });
  // Keep the per-shelf view small and stable.
  profile.shelves = shelfCounts(profile.events);
  // Several acquisition paths may share one profile document: a scrape always
  // produces shelf-less events (they are «Прочитано»), a file import marks its
  // own rows. The document says `mixed` when both contributed, so the UI never
  // claims a scraped profile was imported from a file.
  const origins = new Set(
    profile.events.map((event) => (event && event.origin ? ORIGIN : 'livelib'))
  );
  if (origins.size > 1) profile.origin = 'mixed';
  else profile.origin = origins.has(ORIGIN) ? ORIGIN : profile.origin || 'livelib';
  if (!Array.isArray(profile.warnings)) profile.warnings = [];

  profile.events.sort((left, right) => {
    const a = left.finishedAt || (left.readMonth ? `${left.readMonth}-00` : '');
    const b = right.finishedAt || (right.readMonth ? `${right.readMonth}-00` : '');
    if (a === b) return String(left.id) < String(right.id) ? -1 : 1;
    return a < b ? 1 : -1;
  });

  return { profile, added, enriched, skipped, shelf };
}

/** How many events each shelf holds (drives the plan/watchlist counters). */
function shelfCounts(events) {
  const counts = { read: 0, dnf: 0, reading: 0, wish: 0 };
  for (const event of Array.isArray(events) ? events : []) {
    const shelf = event && event.shelf;
    if (shelf && counts[shelf] != null) counts[shelf]++;
    else if (event) counts.read++;
  }
  return counts;
}

/** Shelves a scrape does NOT read: only a file import can supply them. */
const FILE_ONLY_SHELVES = ['dnf', 'reading', 'wish'];

/**
 * Carry file-imported plan/abandoned shelves over a scrape.
 *
 * A scrape rebuilds the profile document from `/reader/{name}/read` alone, so a
 * plain overwrite would silently delete «Не дочитал»/«Читаю сейчас»/«Хочу
 * прочитать» events the user uploaded — shelves the scraper never touches.
 * `read` rows are *not* carried over: the scrape covers that collection fully
 * and its rows are richer (exact day, `status_set_at`).
 *
 * @param {object|null} previous profile document being replaced
 * @param {object} scraped freshly scraped profile document (mutated)
 * @returns {{ profile: object, preserved: number }}
 */
function preserveFileState(previous, scraped) {
  if (!scraped || !Array.isArray(scraped.events)) return { profile: scraped, preserved: 0 };
  const prevEvents = previous && Array.isArray(previous.events) ? previous.events : [];
  const kept = prevEvents.filter(
    (event) => event && event.origin === ORIGIN && FILE_ONLY_SHELVES.includes(event.shelf)
  );
  if (kept.length) {
    const ids = new Set(scraped.events.map((event) => (event ? event.id : null)));
    for (const event of kept) if (!ids.has(event.id)) scraped.events.push({ ...event });
  }
  const carriedImports = previous && Array.isArray(previous.fileImports)
    ? previous.fileImports.slice(-20)
    : [];
  if (carriedImports.length) scraped.fileImports = carriedImports;
  scraped.shelves = shelfCounts(scraped.events);
  const origins = new Set(scraped.events.map((event) => (event && event.origin === ORIGIN ? ORIGIN : 'livelib')));
  scraped.origin = origins.size > 1 ? 'mixed' : 'livelib';
  if (kept.length) {
    scraped.events.sort((left, right) => {
      const a = left.finishedAt || (left.readMonth ? `${left.readMonth}-00` : '');
      const b = right.finishedAt || (right.readMonth ? `${right.readMonth}-00` : '');
      if (a === b) return String(left.id) < String(right.id) ? -1 : 1;
      return a < b ? 1 : -1;
    });
  }
  return { profile: scraped, preserved: kept.length };
}

module.exports = {
  ORIGIN,
  MAX_BOOKS,
  SHELVES,
  PROFILE_SHELVES,
  FILE_ONLY_SHELVES,
  SHELF_STATUS,
  LivelibFileError,
  shelfOf,
  shelfFromFilename,
  parseFileReadDate,
  rating5Of,
  rating10Of,
  isbnOf,
  bookIdOf,
  languageOf,
  normalizeRecord,
  parseExportFile,
  buildFileEvent,
  mergeFileIntoProfile,
  preserveFileState,
  shelfCounts,
};
