'use strict';

/**
 * Hardcover GraphQL client + journal import.
 *
 * Endpoint: POST https://api.hardcover.app/v1/graphql with
 * `authorization: Bearer <HARDCOVER_API_TOKEN>`. The token comes from
 * server/config.js (env -> config/hardcover-token) and never appears in logs:
 * every log line here uses maskToken() for diagnostics.
 *
 * Free plan limits (confirmed by response headers):
 *   RateLimit-Policy: "Free";q=60;w=60;burst=10, "daily";q=5000;w=86400
 * The local gate therefore allows at most HARDCOVER_MAX_PER_MINUTE (55)
 * requests in a rolling minute and at least HARDCOVER_MIN_INTERVAL_MS (1100)
 * between two requests. 429 responses honour Retry-After, transport errors are
 * retried up to 3 times with backoff.
 *
 * Journal paging: user_books ordered by id asc, limit 100 + offset, until a
 * short page. 656 user_books = 7 pages. Each page joins book metadata
 * (authors via contributions, genres via taggings, series via book_series)
 * and the edition publisher/language in the same query — Hasura counts
 * top-level fields per request, not join depth, so one request per page is
 * enough.
 */

const config = require('../config');
const bookCache = require('./book-cache');

const HARDCOVER_URL = 'https://api.hardcover.app/v1/graphql';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_PER_MINUTE = 55;
const WINDOW_MS = 60000;
const MIN_INTERVAL_MS = 1100;
const MAX_TRANSPORT_ATTEMPTS = 3;

const GENRE_TAG_CATEGORY_ID = 1; // Hardcover "Genre" tag category (confirmed live)

class HardcoverError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HardcoverError';
    this.code = code || 'hardcover_error';
  }
}

/* ------------------------------------------------------------------ */
/* Token masking                                                       */
/* ------------------------------------------------------------------ */

/**
 * `hc_pat_abcdef...` -> `hc_pat_***`; any other secret -> `***`.
 * Used in logs and in error messages; the raw value is never stored.
 */
function maskToken(token) {
  const value = String(token == null ? '' : token);
  if (!value) return '(none)';
  const prefix = value.match(/^([a-z]{2,10}_[a-z]{2,12}_)/i);
  return prefix ? `${prefix[1]}***` : '***';
}

/* ------------------------------------------------------------------ */
/* Local rate gate                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RateGate {
  constructor(options = {}) {
    this.maxPerMinute = options.maxPerMinute || MAX_PER_MINUTE;
    this.windowMs = options.windowMs || WINDOW_MS;
    this.minIntervalMs = options.minIntervalMs || MIN_INTERVAL_MS;
    this.stamps = [];
    this.lastRequestAt = 0;
    this.blockedUntil = 0;
    this.requests = 0;
    this.waits = 0;
  }

  /** Wait until a new request is allowed by all three rules. */
  async acquire() {
    for (;;) {
      const now = Date.now();
      if (now < this.blockedUntil) {
        this.waits++;
        await sleep(this.blockedUntil - now);
        continue;
      }
      while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
      const sinceLast = now - this.lastRequestAt;
      if (sinceLast < this.minIntervalMs) {
        this.waits++;
        await sleep(this.minIntervalMs - sinceLast);
        continue;
      }
      if (this.stamps.length >= this.maxPerMinute) {
        const waitMs = this.windowMs - (now - this.stamps[0]) + 50;
        this.waits++;
        await sleep(Math.max(50, waitMs));
        continue;
      }
      this.stamps.push(now);
      this.lastRequestAt = now;
      this.requests++;
      return;
    }
  }

  /** Called after a 429: block all subsequent requests for `seconds`. */
  blockFor(seconds) {
    const ms = Math.max(1, Number(seconds) || 0) * 1000;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
  }

  snapshot() {
    return { requests: this.requests, waits: this.waits };
  }
}

const gate = new RateGate();

/* ------------------------------------------------------------------ */
/* GraphQL transport                                                   */
/* ------------------------------------------------------------------ */

function tokenOrThrow() {
  try {
    return config.getHardcoverToken();
  } catch (err) {
    if (err && err.code === 'HARDCOVER_TOKEN_MISSING') {
      throw new HardcoverError(
        'Hardcover-токен не настроен (HARDCOVER_API_TOKEN или config/hardcover-token).',
        'hardcover_token_missing'
      );
    }
    throw err;
  }
}

function parseRetryAfter(response) {
  const raw = response.headers.get('retry-after');
  if (raw != null && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  }
  return 5;
}

/**
 * One guarded GraphQL request. `query` is a document string, `variables` an
 * object. Returns `data` on success and throws HardcoverError otherwise.
 */
async function graphql(query, variables, options = {}) {
  const token = tokenOrThrow();
  const label = options.label || 'query';
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_TRANSPORT_ATTEMPTS) {
    attempt++;
    await gate.acquire();
    let response;
    try {
      response = await fetch(HARDCOVER_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables: variables || {} }),
        signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = err;
      if (attempt >= MAX_TRANSPORT_ATTEMPTS) {
        throw new HardcoverError(
          `Hardcover недоступен (${label}): ${err.message}`,
          'hardcover_network_error'
        );
      }
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 429) {
      const seconds = parseRetryAfter(response);
      gate.blockFor(seconds);
      console.warn(
        `[hardcover] 429 on ${label} (token ${maskToken(token)}); waiting ${seconds}s`
      );
      lastError = new HardcoverError('Hardcover rate limit (429).', 'hardcover_rate_limited');
      if (attempt >= MAX_TRANSPORT_ATTEMPTS) throw lastError;
      continue;
    }

    if (response.status >= 500) {
      lastError = new HardcoverError(
        `Hardcover ответил HTTP ${response.status} (${label}).`,
        'hardcover_http_error'
      );
      if (attempt >= MAX_TRANSPORT_ATTEMPTS) throw lastError;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    let body;
    try {
      body = await response.json();
    } catch (err) {
      lastError = new HardcoverError(
        `Hardcover вернул не-JSON ответ (${label}, HTTP ${response.status}).`,
        'hardcover_bad_response'
      );
      if (attempt >= MAX_TRANSPORT_ATTEMPTS) throw lastError;
      continue;
    }

    if (!response.ok) {
      const message =
        body && body.error ? String(body.error) : `HTTP ${response.status}`;
      throw new HardcoverError(`Hardcover: ${message} (${label})`, 'hardcover_http_error');
    }
    if (body && Array.isArray(body.errors) && body.errors.length) {
      const message = body.errors
        .map((entry) => (entry && entry.message ? entry.message : String(entry)))
        .join('; ');
      throw new HardcoverError(`Hardcover GraphQL: ${message} (${label})`, 'hardcover_graphql_error');
    }
    if (!body || !body.data) {
      throw new HardcoverError(`Hardcover вернул пустой ответ (${label}).`, 'hardcover_empty');
    }
    return body.data;
  }

  throw lastError || new HardcoverError(`Hardcover request failed (${label}).`, 'hardcover_error');
}

/* ------------------------------------------------------------------ */
/* Owner / user resolution                                             */
/* ------------------------------------------------------------------ */

let meCache = null;

async function getMe() {
  if (meCache) return meCache;
  const data = await graphql('query { me { id username } }', {}, { label: 'me' });
  const me = Array.isArray(data.me) ? data.me[0] : data.me;
  if (!me || !Number.isFinite(Number(me.id))) {
    throw new HardcoverError('Hardcover не вернул пользователя токена.', 'hardcover_no_me');
  }
  meCache = { id: Number(me.id), username: me.username || null };
  return meCache;
}

/**
 * Resolve the journal owner. A PAT only reads its own journal, so a requested
 * username can only be verified, never substituted: `null` / "me" / the
 * owner's own id or username resolve to the owner; anything else is an error.
 */
async function resolveUser(input) {
  const me = await getMe();
  const raw = input == null ? '' : String(input).trim();
  if (!raw || raw.toLowerCase() === 'me') return me;
  if (/^\d+$/.test(raw)) {
    if (Number(raw) === me.id) return me;
    throw new HardcoverError(
      `Токен принадлежит пользователю ${me.id}, а запрошен ${raw}. PAT читает только свой журнал.`,
      'hardcover_foreign_user'
    );
  }
  if (raw.replace(/^@/, '').toLowerCase() === String(me.username || '').toLowerCase()) {
    return me;
  }
  throw new HardcoverError(
    `Токен принадлежит @${me.username}; журнал другого пользователя этим PAT не читается.`,
    'hardcover_foreign_user'
  );
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

/**
 * `user_books.status_id` -> internal status. Mapping is the P0 spike reading
 * (КНИГИ-АРХИТЕКТУРА.md §2.2): 1 want, 2 reading, 3 read, 4 paused, 5 dnf.
 */
const HARDCOVER_STATUS_LABELS = {
  1: 'wish',
  2: 'reading',
  3: 'read',
  4: 'paused',
  5: 'dnf',
};

/**
 * Statuses that belong to the *reading profile*: finished books (3) and books
 * the user abandoned (5, "did not finish"). `1`/`2`/`4` are shelf state, not
 * reading history — importing them inflated bookCount with books that were
 * never read (user report, 27.10.2026).
 */
const HARDCOVER_KEEP_STATUS_IDS = [3, 5];

function keepStatus(statusId) {
  return HARDCOVER_KEEP_STATUS_IDS.includes(Number(statusId));
}

/** Fresh skip counter for one import pass: total + per-status breakdown. */
function createStatusFilterCounter() {
  return { skippedNonFinished: 0, byStatus: {} };
}

function recordSkipped(counter, statusId, status) {
  if (!counter) return;
  counter.skippedNonFinished = (counter.skippedNonFinished || 0) + 1;
  if (!counter.byStatus) counter.byStatus = {};
  const key = `${Number(statusId)}:${status || 'unknown'}`;
  counter.byStatus[key] = (counter.byStatus[key] || 0) + 1;
}

const JOURNAL_PAGE_QUERY = `
query JournalPage($userId: Int!, $limit: Int!, $offset: Int!, $withTotal: Boolean!) {
  total: user_books_aggregate(where: { user_id: { _eq: $userId } }) @include(if: $withTotal) {
    aggregate { count }
  }
  rows: user_books(
    where: { user_id: { _eq: $userId } }
    order_by: { id: asc }
    limit: $limit
    offset: $offset
  ) {
    id
    book_id
    edition_id
    rating
    status_id
    read_count
    first_read_date
    last_read_date
    date_added
    book {
      id
      title
      slug
      pages
      release_date
      release_year
      rating
      ratings_count
      cached_image
      contributions {
        author { id name }
        contribution
      }
      book_series {
        position
        series { id name }
      }
      taggings(limit: 30) {
        tag { id tag slug tag_category_id }
      }
    }
    edition {
      id
      isbn_13
      isbn_10
      language_id
      pages
      publisher_id
      release_year
      release_date
      publisher { id name }
      language { id language }
    }
    user_book_reads(order_by: { id: asc }) {
      id
      started_at
      finished_at
      finished_at_precision
      progress_pages
      edition_id
    }
  }
}`;

function yearOf(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const year = Number(value.slice(0, 4));
      if (year > 0) return year;
    }
    const year = Number(value);
    if (Number.isFinite(year) && year > 0) return year;
  }
  return null;
}

function dateOnly(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return null;
}

function imageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.url === 'string') return value.url;
    if (Array.isArray(value)) return value.find((entry) => entry && typeof entry.url === 'string')
      ? value.find((entry) => entry && typeof entry.url === 'string').url
      : null;
  }
  return null;
}

/** Author names from contributions; "Author" role first, all roles as fallback. */
function authorsOf(book) {
  const contributions = Array.isArray(book && book.contributions) ? book.contributions : [];
  const seen = new Set();
  const authors = [];
  const others = [];
  for (const entry of contributions) {
    const author = entry && entry.author;
    if (!author || !author.id || seen.has(author.id)) continue;
    const role = String(entry.contribution || '').toLowerCase();
    if (role === 'author') {
      seen.add(author.id);
      authors.push({ hcId: Number(author.id), name: String(author.name || '').trim() });
    } else {
      others.push({ hcId: Number(author.id), name: String(author.name || '').trim(), role });
    }
  }
  return authors.length ? authors : others.map(({ hcId, name }) => ({ hcId, name }));
}

function genresOf(book) {
  const taggings = Array.isArray(book && book.taggings) ? book.taggings : [];
  const seen = new Set();
  const genres = [];
  for (const entry of taggings) {
    const tag = entry && entry.tag;
    if (!tag || Number(tag.tag_category_id) !== GENRE_TAG_CATEGORY_ID) continue;
    const name = String(tag.tag || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    genres.push(name);
  }
  return genres;
}

function seriesOf(book) {
  const rows = Array.isArray(book && book.book_series) ? book.book_series : [];
  const series = [];
  for (const row of rows) {
    const value = row && row.series;
    if (!value || !value.id) continue;
    series.push({
      hcId: Number(value.id),
      name: String(value.name || '').trim(),
      position:
        Number.isFinite(Number(row.position)) && Number(row.position) > 0
          ? Number(row.position)
          : null,
    });
  }
  return series;
}

/** Build the canonical details document for one work (schemaVersion 1). */
function detailsFromBook(book, edition, fetchedAt) {
  if (!book || !book.id) return null;
  const authors = authorsOf(book);
  return {
    schemaVersion: 1,
    hcWorkId: Number(book.id),
    hcEditionId: edition && edition.id ? Number(edition.id) : null,
    title: book.title || null,
    slug: book.slug || null,
    authors,
    series: seriesOf(book),
    genres: genresOf(book),
    pages: Number.isFinite(Number(book.pages))
      ? Number(book.pages)
      : edition && Number.isFinite(Number(edition.pages))
      ? Number(edition.pages)
      : null,
    publicationYear: yearOf(book.release_year, book.release_date, edition && edition.release_year, edition && edition.release_date),
    isbn13: (edition && edition.isbn_13) || null,
    isbn10: (edition && edition.isbn_10) || null,
    publisher:
      (edition && edition.publisher && edition.publisher.name) || null,
    editionLanguage:
      (edition && edition.language && edition.language.language) || null,
    editionLanguageId: edition && edition.language_id != null ? Number(edition.language_id) : null,
    rating: book.rating == null ? null : Number(book.rating),
    ratingsCount: Number.isFinite(Number(book.ratings_count)) ? Number(book.ratings_count) : null,
    coverUrl: imageUrl(book.cached_image),
    partial: false,
    fetchedAt: fetchedAt || new Date().toISOString(),
  };
}

/**
 * Convert one user_books row into profile events (one per user_book_read, plus
 * a synthetic undated event when a user_book has no reads at all).
 *
 * Rows whose `status_id` is not in HARDCOVER_KEEP_STATUS_IDS yield no events;
 * when `counter` is passed, the skip is recorded there (total + per status).
 * "Did not finish" rows keep their event (it is part of the profile) but never
 * carry `finishedAt`: an abandoned book must not enter timeline/streaks.
 */
function eventsFromRow(row, counter) {
  if (!row || !row.book) return [];
  const statusId = Number(row.status_id);
  const status = HARDCOVER_STATUS_LABELS[statusId] || 'read';
  if (!keepStatus(statusId)) {
    recordSkipped(counter, statusId, status);
    return [];
  }
  const dated = status !== 'dnf';
  const finishDate = (value) => (dated ? dateOnly(value) : null);
  const rating = row.rating == null ? null : Number(row.rating);
  const bookId = String(row.book_id != null ? row.book_id : row.book.id);
  const editionId = row.edition_id == null ? null : String(row.edition_id);
  const authors = authorsOf(row.book).map((author) => author.name).filter(Boolean);
  const edition = row.edition || {};
  const editionPayload = {
    publisher: (edition.publisher && edition.publisher.name) || null,
    year: yearOf(edition.release_year, edition.release_date, row.book.release_year, row.book.release_date),
    isbn: edition.isbn_13 || edition.isbn_10 || null,
    language: (edition.language && edition.language.language) || null,
  };
  const reads = Array.isArray(row.user_book_reads) ? row.user_book_reads : [];
  const base = {
    source: 'hardcover',
    sourceBookId: bookId,
    editionId,
    sourceUrl: `https://hardcover.app/books/${row.book.slug || bookId}`,
    workId: `hc:${bookId}`,
    title: row.book.title || null,
    authors,
    rating,
    ratingScale: 5,
    rating10: rating == null ? null : Math.round(rating * 2),
    status,
    // Raw journal keys: stats re-applies the status filter to persisted
    // profiles, so an event must carry enough data to be filtered again
    // without a network call (`status` alone is a presentation label).
    statusId: Number.isFinite(statusId) ? statusId : null,
    userBookId: Number.isFinite(Number(row.id)) ? Number(row.id) : null,
    readCount: Number(row.read_count) || 0,
    edition: editionPayload,
    coverUrl: imageUrl(row.book.cached_image),
    firstReadDate: dateOnly(row.first_read_date),
    lastReadDate: dateOnly(row.last_read_date),
  };

  if (reads.length === 0) {
    return [
      {
        ...base,
        id: `hc:ub:${row.id}`,
        startedAt: null,
        finishedAt: finishDate(row.last_read_date),
        reread: Number(row.read_count) > 1,
        readIndex: Number(row.read_count) > 1 ? Number(row.read_count) : 1,
      },
    ];
  }

  const sorted = [...reads].sort((a, b) => {
    const left = dateOnly(a.finished_at) || dateOnly(a.started_at) || '';
    const right = dateOnly(b.finished_at) || dateOnly(b.started_at) || '';
    if (left !== right) return left < right ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
  return sorted.map((read, index) => ({
    ...base,
    id: `hc:read:${read.id}`,
    startedAt: dateOnly(read.started_at),
    finishedAt: finishDate(read.finished_at),
    reread: index > 0,
    readIndex: index + 1,
    readEditionId: read.edition_id == null ? null : String(read.edition_id),
  }));
}

/**
 * Fetch the whole journal and persist canonical work metadata.
 *
 * Returns { events, works, totals, eventsWithDate, statusFilter, keepStatusIds }.
 * `onProgress({page,pageTotal,events})` is called after every page.
 */
async function fetchJournal(userId, options = {}) {
  const owner = await resolveUser(userId);
  const limit = Math.min(Math.max(Number(options.pageSize) || 100, 1), 100);
  const maxPages = Number(options.maxPages) || 50;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const fetchedAt = new Date().toISOString();

  const events = [];
  const works = new Map();
  const seenEventIds = new Set();
  const statusFilter = createStatusFilterCounter();
  let offset = 0;
  let page = 0;
  let total = null;
  let eventsWithDate = 0;

  for (;;) {
    page++;
    const withTotal = total === null;
    const data = await graphql(
      JOURNAL_PAGE_QUERY,
      { userId: owner.id, limit, offset, withTotal },
      { label: `journal page ${page}` }
    );
    if (withTotal) {
      total = Number(
        data.total && data.total.aggregate ? data.total.aggregate.count : 0
      );
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];

    for (const row of rows) {
      // Metadata is independent of the journal role: a "want to read" work can
      // still be the canonical Hardcover work for a LiveLib event, so details
      // are persisted even when the row yields no events (status filter).
      const details = detailsFromBook(row.book, row.edition, fetchedAt);
      if (details && !works.has(details.hcWorkId)) {
        works.set(details.hcWorkId, details);
      }
      for (const event of eventsFromRow(row, statusFilter)) {
        if (seenEventIds.has(event.id)) continue;
        seenEventIds.add(event.id);
        if (event.finishedAt) eventsWithDate++;
        events.push(event);
      }
    }

    if (onProgress) onProgress({ page, pageTotal: null, events: events.length, total });
    console.log(
      `[hardcover ${owner.id}] journal page ${page}: rows=${rows.length} events=${events.length}` +
        (total == null ? '' : `/${total}`) +
        (statusFilter.skippedNonFinished
          ? ` skipped=${statusFilter.skippedNonFinished}`
          : '')
    );

    if (rows.length < limit) break;
    offset += limit;
    if (offset >= (total || 0) && total != null) break;
    if (page >= maxPages) {
      console.warn(`[hardcover ${owner.id}] page cap ${maxPages} reached; journal may be truncated`);
      break;
    }
  }

  // Metadata is only useful when it is on disk; writes are atomic, so a crash
  // mid-import leaves a consistent (if incomplete) cache.
  for (const details of works.values()) {
    await bookCache.saveDetails(details.hcWorkId, details);
  }

  events.sort((a, b) => {
    const left = a.finishedAt || '';
    const right = b.finishedAt || '';
    if (left === right) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return left < right ? 1 : -1;
  });

  return {
    owner,
    events,
    works,
    totals: { userBooks: total, pages: page },
    eventsWithDate,
    statusFilter,
    keepStatusIds: [...HARDCOVER_KEEP_STATUS_IDS],
    fetchedAt,
  };
}

/** Build the persisted profile document (schemaVersion 1, doc §3.3). */
function buildProfile(owner, journal, warnings) {
  return {
    schemaVersion: 1,
    source: 'hardcover',
    userKey: String(owner.id),
    sourceUserId: owner.id,
    sourceUsername: owner.username || null,
    importedAt: new Date().toISOString(),
    events: journal.events,
    warnings: warnings || [],
  };
}

module.exports = {
  HARDCOVER_URL,
  GENRE_TAG_CATEGORY_ID,
  HARDCOVER_STATUS_LABELS,
  HARDCOVER_KEEP_STATUS_IDS,
  HardcoverError,
  RateGate,
  gate,
  maskToken,
  graphql,
  getMe,
  resolveUser,
  fetchJournal,
  buildProfile,
  eventsFromRow,
  createStatusFilterCounter,
  keepStatus,
  detailsFromBook,
  authorsOf,
  genresOf,
  seriesOf,
  yearOf,
  dateOnly,
  resetCaches() {
    meCache = null;
  },
};
