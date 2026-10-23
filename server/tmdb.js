'use strict';

const { normalizeTitle } = require('./cache');
const { getTmdbToken } = require('./config');

const API_BASE = 'https://api.themoviedb.org/3';
const MAX_CONCURRENCY = 12;

function readToken() {
  return getTmdbToken();
}

/* ------------------------------------------------------------------ */
/* Concurrency limiter                                                 */
/* ------------------------------------------------------------------ */

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      // hand the slot over directly
      next();
    } else {
      this.active--;
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const limiter = new Semaphore(MAX_CONCURRENCY);

const counters = { requests: 0, retries: 0, errors: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * GET a TMDB endpoint withBearer auth, global 12-request limit and 429
 * handling (up to 5 retries, Retry-After respected).
 */
async function tmdbGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt <= 5; attempt++) {
    let response;
    try {
      response = await limiter.run(() => {
        counters.requests++;
        return fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${readToken()}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(20000),
        });
      });
    } catch (err) {
      counters.errors++;
      lastError = err;
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw new Error(`TMDB request failed (${pathname}): ${err.message}`);
    }

    if (response.status === 429) {
      counters.retries++;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const backoff = retryAfter != null ? retryAfter : Math.min(1000 * 2 ** attempt, 30000);
      console.warn(
        `[tmdb] 429 on ${pathname}; retry ${attempt + 1}/5 in ${Math.round(backoff)}ms`
      );
      await sleep(backoff);
      continue;
    }

    if (response.status === 404) return null;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      lastError = new Error(`TMDB HTTP ${response.status} (${pathname}): ${body.slice(0, 200)}`);
      counters.errors++;
      if (response.status >= 500 && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    return response.json();
  }

  throw new Error(`TMDB rate limit not resolved (${pathname}): ${lastError ? lastError.message : ''}`);
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function releaseYear(movie) {
  const raw = movie && (movie.release_date || movie.first_air_date);
  if (!raw) return null;
  const n = parseInt(String(raw).slice(0, 4), 10);
  return Number.isFinite(n) ? n : null;
}

function matchesYear(movie, year) {
  if (!year) return false;
  const ry = releaseYear(movie);
  return ry !== null && Math.abs(ry - year) <= 1;
}

function normalizedNames(movie) {
  return [normalizeTitle(movie.title), normalizeTitle(movie.original_title)].filter(Boolean);
}

function normalizedTvNames(show) {
  return [normalizeTitle(show.name), normalizeTitle(show.original_name)].filter(Boolean);
}

function isExactTitle(movie, title) {
  const wanted = normalizeTitle(title);
  if (!wanted) return false;
  return normalizedNames(movie).includes(wanted);
}

// Punctuation-insensitive comparison, used only as a fallback (e.g.
// "The Mitchells vs the Machines" vs TMDB's "... vs. the Machines").
// "ё" is folded to "е" because KinoPoisk often drops the diaeresis while
// TMDB keeps it ("Слезы капали" vs "Слёзы капали"); otherwise the search
// engine treats them as different strings.
function looseTitle(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function isExactTitleLoose(movie, title) {
  const wanted = looseTitle(title);
  if (!wanted) return false;
  return [movie.title, movie.original_title]
    .map(looseTitle)
    .filter(Boolean)
    .includes(wanted);
}

function isExactTvTitle(show, title) {
  const wanted = normalizeTitle(title);
  if (!wanted) return false;
  return normalizedTvNames(show).includes(wanted);
}

function isExactTvTitleLoose(show, title) {
  const wanted = looseTitle(title);
  if (!wanted) return false;
  return [show.name, show.original_name]
    .map(looseTitle)
    .filter(Boolean)
    .includes(wanted);
}

/**
 * Strict-stage pick. Only an item whose (localized or original) title equals
 * the query after normalization — or after punctuation folding — is accepted.
 * The year filter alone must never decide a match: TMDB's year-scoped search
 * happily returns unrelated films ("Send Help" 2025 -> "POSH (Please only
 * Send help)").
 */
function findExactTitle(items, title, isTv) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const exact = isTv ? isExactTvTitle : isExactTitle;
  const loose = isTv ? isExactTvTitleLoose : isExactTitleLoose;
  return items.find((item) => exact(item, title)) ||
    items.find((item) => loose(item, title)) ||
    null;
}

/* ------------------------------------------------------------------ */
/* Broad fallback matching (only after the strict stage failed)        */
/* ------------------------------------------------------------------ */

/*
 * Some KinoPoisk titles do not match TMDB even with ±1 year because:
 *  - the release year differs by more than one (premiere vs wide release),
 *  - KinoPoisk transliterates the original title differently
 *    ("Geu nomida" vs "Geunomida", "Yongpari" vs "Yong Pal"),
 *  - KinoPoisk appends a subtitle after a colon that TMDB treats
 *    differently ("Ён-пхаль: Подпольный доктор" vs "Ён Паль. Подпольный
 *    доктор"),
 *  - KinoPoisk drops "ё" ("Слезы капали" vs "Слёзы капали").
 *
 * For those (and only those) titles we repeat the search WITHOUT a year and
 * rank the candidates: exact / near-exact normalized title first, then year
 * proximity (a bonus, not a hard filter), then vote_average/popularity.
 */

function isCyrillic(value) {
  return /[\u0400-\u04FF]/.test(String(value || ''));
}

function bigrams(value) {
  const s = String(value || '');
  if (s.length < 2) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map();
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1);
  let common = 0;
  for (const gram of right) {
    const available = counts.get(gram) || 0;
    if (available > 0) {
      common++;
      counts.set(gram, available - 1);
    }
  }
  return (2 * common) / (left.length + right.length);
}

/**
 * 1.0 = exact after lowercasing/punctuation/ё-folding, 0.8-0.95 = one title
 * is a prefix/containment of the other, otherwise Dice bigram similarity.
 */
function titleMatchScore(names, query) {
  const wanted = looseTitle(query);
  if (!wanted) return 0;
  let best = 0;
  for (const raw of names) {
    const name = looseTitle(raw);
    if (!name) continue;
    if (name === wanted) return 1;
    const min = Math.min(name.length, wanted.length);
    const max = Math.max(name.length, wanted.length);
    if (min >= 4 && (name.startsWith(wanted) || wanted.startsWith(name))) {
      best = Math.max(best, 0.8 + 0.15 * (min / max));
    } else if (min >= 5 && (name.includes(wanted) || wanted.includes(name))) {
      best = Math.max(best, 0.7 + 0.15 * (min / max));
    } else {
      best = Math.max(best, diceSimilarity(name, wanted));
    }
  }
  return best;
}

function scoreCandidate(kind, item, query, year, resultCount) {
  const names =
    kind === 'tv'
      ? [item.name, item.original_name]
      : [item.title, item.original_title];
  const titleScore = titleMatchScore(names, query);
  const release = releaseYear(item);
  let yearScore = 0;
  if (year && release) {
    const delta = Math.abs(release - year);
    yearScore = delta === 0 ? 1 : delta === 1 ? 0.8 : delta === 2 ? 0.4 : 0;
  }
  const popularityRaw = Number(item.popularity);
  const popularity =
    Number.isFinite(popularityRaw) && popularityRaw > 0
      ? Math.min(1, Math.log10(popularityRaw + 1) / 2)
      : 0;
  const voteRaw = Number(item.vote_average);
  const vote = Number.isFinite(voteRaw) ? Math.max(0, Math.min(1, voteRaw / 10)) : 0;

  return {
    item,
    titleScore,
    yearScore,
    resultCount,
    total: titleScore * 1000 + yearScore * 20 + popularity * 3 + vote * 2,
  };
}

/** Search variants that are cheap to derive from a KinoPoisk title. */
function buildBroadQueries(title, options) {
  const opts = options || {};
  const primary = String(title || '').trim();
  const fallback = String(opts.fallbackTitle || '').trim();
  const language = opts.language === 'ru-RU' ? 'ru-RU' : 'en-US';
  const queries = [];
  const seen = new Set();

  const add = (query, lang) => {
    const value = String(query || '').trim();
    if (!value) return;
    const key = `${value.toLowerCase()}|${lang}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ query: value, language: lang });
  };

  const expand = (base) => {
    const variants = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (!text) return;
      if (variants.some((v) => v.toLowerCase() === text.toLowerCase())) return;
      variants.push(text);
    };
    push(base);

    // Romanized KinoPoisk titles are often split differently ("Geu nomida").
    const compact = String(base).replace(/[\s'’`".,!?():;\-–—]+/g, '');
    if (compact) push(compact);

    // "Main title: subtitle" -> search each meaningful part separately.
    const parts = String(base)
      .split(/\s*[:–—]\s*|\s+-\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    if (parts.length > 1) {
      for (const part of parts) push(part);
    }

    // KinoPoisk frequently writes "е" where TMDB stores "ё".
    if (!/[ёЁ]/.test(base) && /[еЕ]/.test(base)) {
      push(base.replace(/е/g, 'ё').replace(/Е/g, 'Ё'));
    }
    return variants;
  };

  for (const variant of expand(primary)) {
    add(variant, isCyrillic(variant) ? 'ru-RU' : language);
  }
  if (fallback && normalizeTitle(fallback) !== normalizeTitle(primary)) {
    for (const variant of expand(fallback)) {
      add(variant, 'ru-RU');
    }
  }
  return queries;
}

async function broadSearch(kind, title, year, options) {
  const opts = options || {};
  const numericYear = Number(year) > 0 ? Number(year) : null;
  const pathname = kind === 'tv' ? '/search/tv' : '/search/movie';
  const queries = buildBroadQueries(title, opts);
  let best = null;

  for (const entry of queries) {
    let data = await tmdbGet(pathname, {
      include_adult: 'false',
      query: entry.query,
      language: entry.language,
    });
    let results = (data && data.results) || [];
    if (results.length === 0) {
      const otherLanguage = entry.language === 'ru-RU' ? 'en-US' : 'ru-RU';
      data = await tmdbGet(pathname, {
        include_adult: 'false',
        query: entry.query,
        language: otherLanguage,
      });
      results = (data && data.results) || [];
    }
    if (process.env.DEBUG_BROAD) {
      console.log(
        `[tmdb:debug] broad query ${pathname} ${JSON.stringify(entry)} -> ${results.length}`
      );
    }
    for (const item of results) {
      const scored = scoreCandidate(
        kind,
        item,
        entry.query,
        numericYear,
        results.length
      );
      // Guardrails per candidate: an exact title is accepted even when the
      // year is off (premiere vs release); a partial title requires a
      // plausible year; a sole search hit is accepted only when it also has a
      // plausible title (a lone unrelated result must not win just because
      // TMDB returned one item). Candidates that do not pass never become the
      // best match, even if another query ranks them higher.
      const acceptable =
        scored.titleScore >= 0.99 ||
        (scored.titleScore >= 0.85 &&
          (!numericYear || scored.yearScore >= 0.8)) ||
        (scored.resultCount === 1 &&
          scored.titleScore >= 0.5 &&
          (!numericYear || scored.yearScore >= 0.8));
      if (acceptable && (!best || scored.total > best.total)) best = scored;
    }
  }

  if (!best) return null;

  console.log(
    `[tmdb] broad match: "${title}" (${year || '?'}) -> ` +
      `${best.item.id} "${best.item.title || best.item.name}" ` +
      `(title=${best.titleScore.toFixed(2)} year=${best.yearScore.toFixed(2)})`
  );
  return best.item;
}

/**
 * Find a TMDB movie id for a title/year.
 *
 * Search is done with language=en-US by default: Letterboxd exports English
 * titles and TMDB's localized search ranking can bury the right film (e.g.
 * query "Flow" 2024 with ru-RU returns a 8-minute short first, while en-US
 * returns the 2024 animated feature). KinoPoisk entries without an English
 * title pass `language: 'ru-RU'` instead. Details are always requested with
 * language=ru-RU.
 *
 * Rule: first result whose release year is within ±1, preferring an exact
 * normalized title match; if nothing has a matching year, search without a
 * year and accept an exact title match. If the strict stage fails entirely,
 * broadSearch() repeats the query without a year using title variants
 * (transliteration spacing, "Main: subtitle", ё) and ranks candidates.
 */
async function searchMovie(title, year, options) {
  const query = String(title || '').trim();
  if (!query) return null;
  const opts = options || {};
  const language = opts.language === 'ru-RU' ? 'ru-RU' : 'en-US';
  const numericYear = Number(year) > 0 ? Number(year) : null;

  async function search(params) {
    const data = await tmdbGet('/search/movie', {
      include_adult: 'false',
      ...params,
    });
    let results = (data && data.results) || [];
    // Cyrillic/localized titles: retry with the other language if the first
    // one found nothing.
    if (results.length === 0) {
      const otherLanguage = params.language === 'ru-RU' ? 'en-US' : 'ru-RU';
      const localized = await tmdbGet('/search/movie', {
        include_adult: 'false',
        ...params,
        language: otherLanguage,
      });
      results = (localized && localized.results) || [];
    }
    return results;
  }

  const firstParams = { query, language };
  if (numericYear) firstParams.year = numericYear;
  const firstResults = await search(firstParams);

  if (numericYear) {
    const withinYear = firstResults.filter((movie) => matchesYear(movie, numericYear));
    const exact = findExactTitle(withinYear, title, false);
    if (exact) return exact;
    // No title match in the year-scoped results: do NOT fall back to the
    // first hit. Continue to the year-less exact search and then broadSearch.
  } else {
    const exact =
      firstResults.find((movie) => isExactTitle(movie, title)) ||
      firstResults.find((movie) => isExactTitleLoose(movie, title));
    if (exact) return exact;
    // Without a year we accept the first exact match only, otherwise report
    // "not found" and let the cache hold false.
    return null;
  }

  const secondResults = await search({ query, language });
  const exact =
    secondResults.find((movie) => isExactTitle(movie, title)) ||
    secondResults.find((movie) => isExactTitleLoose(movie, title));
  if (exact) return exact;

  // KinoPoisk's "original title" field often contains a romanized title
  // (e.g. "Geung see sin sang" for Mr. Vampire) that TMDB does not index by.
  // Retry with the Russian title, which TMDB does have.
  const fallbackTitle = String(opts.fallbackTitle || '').trim();
  if (fallbackTitle && normalizeTitle(fallbackTitle) !== normalizeTitle(query)) {
    const fallbackParams = { query: fallbackTitle, language: 'ru-RU' };
    if (numericYear) fallbackParams.year = numericYear;
    let fallbackResults = await search(fallbackParams);
    if (numericYear) {
      const withinYear = fallbackResults.filter((movie) => matchesYear(movie, numericYear));
      // Same strict rule for the localized title: exact title only.
      const exactFallback = findExactTitle(withinYear, fallbackTitle, false);
      if (exactFallback) return exactFallback;
    }
    fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
    const fallbackExact =
      fallbackResults.find((movie) => isExactTitle(movie, fallbackTitle)) ||
      fallbackResults.find((movie) => isExactTitleLoose(movie, fallbackTitle));
    if (fallbackExact) return fallbackExact;
  }

  // Strict matching failed: one broad, year-less pass with title variants.
  return broadSearch('movie', title, year, opts);
}

/**
 * Find a TMDB TV id. Same rules as searchMovie, but the year is compared
 * against first_air_date and `options.fallbackTitle` (usually the Russian
 * title when the primary query is English) is used for a year-less retry.
 */
async function searchTv(title, year, options) {
  const query = String(title || '').trim();
  if (!query) return null;
  const opts = options || {};
  const language = opts.language === 'ru-RU' ? 'ru-RU' : 'en-US';
  const fallbackTitle = String(opts.fallbackTitle || '').trim();
  const numericYear = Number(year) > 0 ? Number(year) : null;

  async function search(params) {
    const data = await tmdbGet('/search/tv', {
      include_adult: 'false',
      ...params,
    });
    let results = (data && data.results) || [];
    if (results.length === 0) {
      const otherLanguage = params.language === 'ru-RU' ? 'en-US' : 'ru-RU';
      const localized = await tmdbGet('/search/tv', {
        include_adult: 'false',
        ...params,
        language: otherLanguage,
      });
      results = (localized && localized.results) || [];
    }
    return results;
  }

  const firstParams = { query, language };
  if (numericYear) firstParams.first_air_date_year = numericYear;
  const firstResults = await search(firstParams);

  if (numericYear) {
    const withinYear = firstResults.filter((show) => matchesYear(show, numericYear));
    const exact = findExactTitle(withinYear, query, true);
    if (exact) return exact;
    // No exact title in the year-scoped results: fall through to the
    // year-less exact retries and finally broadSearch.
  } else {
    const exact =
      firstResults.find((show) => isExactTvTitle(show, query)) ||
      firstResults.find((show) => isExactTvTitleLoose(show, query));
    if (exact) return exact;
    return null;
  }

  // Year-less retries: the localized (Russian) title first, then the English
  // query. Only an exact normalized title match is accepted.
  const candidates = [];
  if (fallbackTitle && normalizeTitle(fallbackTitle) !== normalizeTitle(query)) {
    candidates.push({ query: fallbackTitle, language: 'ru-RU' });
  }
  candidates.push({ query, language });

  for (const params of candidates) {
    const results = await search(params);
    const exact = findExactTitle(results, params.query, true);
    if (exact) return exact;
  }

  // No lenient year-only fallback here: a same-year show with a different
  // title is not a match. broadSearch ranks exact titles across years.
  return broadSearch('tv', title, year, opts);
}

/* Production metadata is kept for the country filter (filmsIndex.countries)
 * and the studios category (persons.studio). Both TMDB movie and TV payloads
 * expose the same two arrays, so they share this normalizer. */
function normalizeCountries(list) {
  return Array.isArray(list)
    ? list
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          iso_3166_1: typeof c.iso_3166_1 === 'string' ? c.iso_3166_1 : '',
          name: typeof c.name === 'string' ? c.name : '',
        }))
    : [];
}

function normalizeCompanies(list) {
  return Array.isArray(list)
    ? list
        .filter((c) => c && typeof c === 'object' && c.id != null)
        .map((c) => ({
          id: c.id,
          name: typeof c.name === 'string' ? c.name : '',
          logo_path: c.logo_path || null,
        }))
    : [];
}

/* TMDB keyword lists use `keywords` for movies and `results` for TV; the
 * cache stores both as a flat [{ id, name }] array. An empty array is
 * meaningful: it tells the backfill script the entry was already refreshed
 * (`Array.isArray` is the idempotency marker). */
function normalizeKeywords(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.keywords)) list = raw.keywords;
    else if (Array.isArray(raw.results)) list = raw.results;
  }
  return list
    .filter((keyword) => keyword && typeof keyword === 'object')
    .map((keyword) => ({
      id: keyword.id != null ? keyword.id : null,
      name: typeof keyword.name === 'string' ? keyword.name : '',
    }))
    .filter((keyword) => keyword.name);
}

function normalizeImdbId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^tt\d{5,}$/.test(id) ? id : null;
}

function normalizeDetailsPayload(details, credits) {
  return {
    kind: 'movie',
    details: {
      id: details.id,
      title: details.title || details.original_title || '',
      original_title: details.original_title || '',
      release_date: details.release_date || null,
      runtime: Number.isFinite(details.runtime) ? details.runtime : null,
      imdb_id: normalizeImdbId(details.imdb_id),
      genres: Array.isArray(details.genres)
        ? details.genres.map((g) => ({ id: g.id, name: g.name }))
        : [],
      poster_path: details.poster_path || null,
      vote_average: Number.isFinite(details.vote_average) ? details.vote_average : null,
      overview: details.overview || '',
      production_countries: normalizeCountries(details.production_countries),
      production_companies: normalizeCompanies(details.production_companies),
      keywords: normalizeKeywords(details.keywords),
    },
    credits: {
      cast: Array.isArray(credits && credits.cast)
        ? credits.cast.map((c) => ({
            id: c.id,
            name: c.name,
            profile_path: c.profile_path || null,
            character: c.character || '',
            order: Number.isFinite(c.order) ? c.order : null,
          }))
        : [],
      crew: Array.isArray(credits && credits.crew)
        ? credits.crew.map((c) => ({
            id: c.id,
            name: c.name,
            profile_path: c.profile_path || null,
            job: c.job || '',
            department: c.department || '',
          }))
        : [],
    },
  };
}

/**
 * Fetch movie details (ru-RU) and credits in parallel.
 * Throws on network/API failure so the caller does not cache a bad result.
 */
async function fetchMovieData(tmdbId) {
  const [details, credits] = await Promise.all([
    tmdbGet(`/movie/${tmdbId}`, { language: 'ru-RU', append_to_response: 'keywords' }),
    tmdbGet(`/movie/${tmdbId}/credits`, {}),
  ]);
  if (!details || !credits) {
    throw new Error(`TMDB returned no details/credits for movie ${tmdbId}`);
  }
  return normalizeDetailsPayload(details, credits);
}

/* ------------------------------------------------------------------ */
/* TV                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Convert TMDB TV details + aggregate credits into the same shape the movie
 * pipeline uses, so stats.js does not need a separate code path.
 *
 * aggregate_credits returns cast with `roles[]` and crew with `jobs[]`; the
 * latter is flattened into one crew record per (person, job) so the job
 * categories in stats.js (Director / Writer / Composer) keep working.
 */
function normalizeTvPayload(details, credits, externalIds) {
  const cast = Array.isArray(credits && credits.cast) ? credits.cast : [];
  const crew = Array.isArray(credits && credits.crew) ? credits.crew : [];

  const normalizedCast = cast.map((person, index) => {
    const role =
      (Array.isArray(person.roles) && person.roles[0]) ||
      (Array.isArray(person.jobs) && person.jobs[0]) ||
      null;
    return {
      id: person.id,
      name: person.name,
      profile_path: person.profile_path || null,
      character:
        (role && role.character) ||
        person.character ||
        '',
      order: Number.isFinite(person.order) ? person.order : index,
    };
  });

  const normalizedCrew = [];
  const seen = new Set();
  for (const person of crew) {
    const jobs =
      Array.isArray(person.jobs) && person.jobs.length > 0
        ? person.jobs
        : [{ job: person.job || '' }];
    for (const jobEntry of jobs) {
      const jobName = jobEntry && jobEntry.job ? jobEntry.job : '';
      if (!jobName) continue;
      const dedupeKey = `${person.id}|${jobName}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      normalizedCrew.push({
        id: person.id,
        name: person.name,
        profile_path: person.profile_path || null,
        job: jobName,
        department: person.department || '',
      });
    }
  }

  const episodeRunTime = Array.isArray(details.episode_run_time)
    ? details.episode_run_time.find((n) => Number.isFinite(n) && n > 0)
    : null;

  return {
    kind: 'tv',
    details: {
      id: details.id,
      title: details.name || details.original_name || '',
      original_title: details.original_name || '',
      release_date: details.first_air_date || null,
      runtime: episodeRunTime || 0,
      // TV details do not carry imdb_id; it only comes from /external_ids.
      imdb_id:
        normalizeImdbId(externalIds && externalIds.imdb_id) ||
        normalizeImdbId(details.imdb_id) ||
        null,
      genres: Array.isArray(details.genres)
        ? details.genres.map((g) => ({ id: g.id, name: g.name }))
        : [],
      poster_path: details.poster_path || null,
      vote_average: Number.isFinite(details.vote_average) ? details.vote_average : null,
      overview: details.overview || '',
      production_countries: normalizeCountries(details.production_countries),
      production_companies: normalizeCompanies(details.production_companies),
      keywords: normalizeKeywords(details.keywords),
    },
    credits: {
      cast: normalizedCast,
      crew: normalizedCrew,
    },
  };
}

/**
 * Fetch TV details (ru-RU) and aggregate credits in parallel. If the
 * aggregate endpoint is unavailable, fall back to the regular credits
 * endpoint (which has `character`/`job` instead of `roles`/`jobs`).
 */
async function fetchTvData(tmdbId) {
  const [details, aggregate, externalIds] = await Promise.all([
    tmdbGet(`/tv/${tmdbId}`, { language: 'ru-RU', append_to_response: 'keywords' }),
    tmdbGet(`/tv/${tmdbId}/aggregate_credits`, {}),
    tmdbGet(`/tv/${tmdbId}/external_ids`, {}),
  ]);
  if (!details) {
    throw new Error(`TMDB returned no details for tv ${tmdbId}`);
  }
  let credits = aggregate;
  if (!credits) {
    credits = await tmdbGet(`/tv/${tmdbId}/credits`, {});
  }
  if (!credits) {
    throw new Error(`TMDB returned no credits for tv ${tmdbId}`);
  }
  return normalizeTvPayload(details, credits, externalIds);
}

/* ------------------------------------------------------------------ */
/* Catalog search (manual matching UI)                                 */
/* ------------------------------------------------------------------ */

function mapSearchItem(kind, item) {
  if (!item || item.id == null) return null;
  const rawDate = kind === 'tv' ? item.first_air_date : item.release_date;
  let year = null;
  if (rawDate && /^\d{4}/.test(String(rawDate))) {
    const parsed = parseInt(String(rawDate).slice(0, 4), 10);
    if (Number.isFinite(parsed)) year = parsed;
  }
  const title =
    kind === 'tv'
      ? item.name || item.original_name || ''
      : item.title || item.original_title || '';
  const vote = Number(item.vote_average);
  return {
    id: item.id,
    kind,
    title,
    year,
    posterPath: item.poster_path || null,
    voteAverage: Number.isFinite(vote) ? vote : null,
  };
}

/**
 * Search TMDB for the manual-match UI.
 *
 * `kind` is "movie", "tv" or undefined/"all" (both searches in parallel).
 * Results are deduplicated by (kind, id) and sorted by vote_average desc.
 * TMDB is queried with language=ru-RU so the title shown to the user matches
 * the localized details pages.
 */
async function searchCatalog(query, kind) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { results: [] };

  const kinds =
    kind === 'movie' || kind === 'tv' ? [kind] : ['movie', 'tv'];

  const batches = await Promise.all(
    kinds.map(async (mediaKind) => {
      const data = await tmdbGet(
        mediaKind === 'tv' ? '/search/tv' : '/search/movie',
        {
          query: q,
          language: 'ru-RU',
          include_adult: 'false',
        }
      );
      const results = (data && data.results) || [];
      return results
        .map((item) => mapSearchItem(mediaKind, item))
        .filter(Boolean);
    })
  );

  const seen = new Set();
  const results = [];
  for (const item of batches.flat()) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }

  results.sort((a, b) => {
    const voteA = a.voteAverage == null ? -1 : a.voteAverage;
    const voteB = b.voteAverage == null ? -1 : b.voteAverage;
    if (voteB !== voteA) return voteB - voteA;
    const yearA = a.year == null ? 0 : a.year;
    const yearB = b.year == null ? 0 : b.year;
    return yearB - yearA;
  });

  return { results };
}

module.exports = {
  tmdbGet,
  normalizeDetailsPayload,
  normalizeTvPayload,
  normalizeImdbId,
  searchMovie,
  searchTv,
  searchCatalog,
  fetchMovieData,
  fetchTvData,
  releaseYear,
  counters,
  MAX_CONCURRENCY,
};
