'use strict';

const { normalizeTitle } = require('./cache');
const { getTmdbToken } = require('./config');
const { fetchOnce } = require('./core/http');
const sources = require('./core/sources');

const API_BASE = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3')
  .replace(/\/+$/, '');
const MAX_CONCURRENCY = sources.SOURCES.tmdb.concurrency;
const REQUEST_TIMEOUT_MS = sources.SOURCES.tmdb.timeoutMs;
const RETRY_DELAYS = sources.SOURCES.tmdb.retryDelaysMs;
const MAX_RATE_LIMIT_RETRIES = sources.SOURCES.tmdb.rateLimitRetries;

function readToken() {
  return getTmdbToken();
}

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

const counters = {
  requests: 0,
  retries: 0,
  transportRetries: 0,
  serverRetries: 0,
  rateLimitRetries: 0,
  errors: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function tmdbGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError = null;
  let transportAttempt = 0;
  let rateLimitHits = 0;

  while (true) {
    let response;
    try {
      response = await limiter.run(() => {
        counters.requests++;
        return fetchOnce(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${readToken()}`,
            Accept: 'application/json',
          },
          timeoutMs: REQUEST_TIMEOUT_MS,
          label: 'tmdb',
        });
      });
    } catch (err) {
      counters.errors++;
      lastError = err;
      if (transportAttempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[transportAttempt++];
        counters.retries++;
        counters.transportRetries++;
        if (process.env.DEBUG_RETRY) {
          console.warn(
            `[tmdb] transport error on ${pathname} (${err.message}); ` +
              `retry ${transportAttempt}/${RETRY_DELAYS.length} in ${delay}ms`
          );
        }
        await sleep(delay);
        continue;
      }
      throw new Error(`TMDB request failed (${pathname}): ${err.message}`);
    }

    if (response.status === 429) {
      counters.retries++;
      counters.rateLimitRetries++;
      rateLimitHits++;
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const backoff =
        retryAfter != null ? retryAfter : Math.min(1000 * 2 ** (rateLimitHits - 1), 30000);
      if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
        throw new Error(`TMDB rate limit not resolved (${pathname})`);
      }
      if (process.env.DEBUG_RETRY || rateLimitHits === 1 || rateLimitHits % 10 === 0) {
        console.warn(
          `[tmdb] 429 on ${pathname}; retry ${rateLimitHits}/${MAX_RATE_LIMIT_RETRIES} ` +
            `in ${Math.round(backoff)}ms`
        );
      }
      await sleep(backoff);
      continue;
    }

    if (response.status === 404) return null;

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      const body = String(response.body || '');
      lastError = new Error(`TMDB HTTP ${response.status} (${pathname}): ${body.slice(0, 200)}`);
      counters.errors++;
      if (response.status >= 500 && transportAttempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[transportAttempt++];
        counters.retries++;
        counters.serverRetries++;
        if (process.env.DEBUG_RETRY) {
          console.warn(
            `[tmdb] HTTP ${response.status} on ${pathname}; ` +
              `retry ${transportAttempt}/${RETRY_DELAYS.length} in ${delay}ms`
          );
        }
        await sleep(delay);
        continue;
      }
      throw lastError;
    }

    try {
      return JSON.parse(response.body);
    } catch (err) {
      throw new Error(`TMDB returned non-JSON (${pathname})`);
    }
  }
}

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

function looseTitle(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const EPISODE_ORDINALS = new Set([
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
]);

function titleWords(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function titleTokens(value) {
  const tokens = titleWords(value);
  const stripped = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      (token === 'episode' || token === 'эпизод') &&
      i + 1 < tokens.length &&
      EPISODE_ORDINALS.has(tokens[i + 1])
    ) {
      i++;
      continue;
    }
    stripped.push(token);
  }
  return stripped.length >= 3 ? stripped : tokens;
}

function titleKey(value) {
  return titleTokens(value).join('');
}

function titleTokenSet(value) {
  return new Set(titleTokens(value));
}

function isExactTitle(movie, title) {
  const wanted = normalizeTitle(title);
  if (!wanted) return false;
  if (normalizedNames(movie).includes(wanted)) return true;
  const wantedKey = titleKey(title);
  return Boolean(wantedKey) &&
    [movie.title, movie.original_title]
      .map(titleKey)
      .filter(Boolean)
      .includes(wantedKey);
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
  if (normalizedTvNames(show).includes(wanted)) return true;
  const wantedKey = titleKey(title);
  return Boolean(wantedKey) &&
    [show.name, show.original_name]
      .map(titleKey)
      .filter(Boolean)
      .includes(wantedKey);
}

function isExactTvTitleLoose(show, title) {
  const wanted = looseTitle(title);
  if (!wanted) return false;
  return [show.name, show.original_name]
    .map(looseTitle)
    .filter(Boolean)
    .includes(wanted);
}

function findExactTitle(items, title, isTv) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const exact = isTv ? isExactTvTitle : isExactTitle;
  const loose = isTv ? isExactTvTitleLoose : isExactTitleLoose;
  return items.find((item) => exact(item, title)) ||
    items.find((item) => loose(item, title)) ||
    null;
}

function exactMatchRank(item, title, isTv) {
  const names = isTv
    ? [item.name, item.original_name]
    : [item.title, item.original_title];
  const wanted = normalizeTitle(title);
  if (wanted && names.map(normalizeTitle).includes(wanted)) return 0;
  const wantedLoose = looseTitle(title);
  if (wantedLoose && names.map(looseTitle).includes(wantedLoose)) return 1;
  const wantedKey = titleKey(title);
  if (wantedKey && names.map(titleKey).includes(wantedKey)) return 2;
  return null;
}

function pickExactCandidate(candidates, year) {
  if (!candidates || candidates.length === 0) return null;
  const ranked = candidates.map((candidate) => {
    const release = releaseYear(candidate.item);
    const yearDelta =
      year && release != null ? Math.abs(release - year) : Number.MAX_SAFE_INTEGER;
    const yearBucket = yearDelta <= 1 ? 0 : yearDelta === 2 ? 1 : 2;
    return { ...candidate, yearDelta, yearBucket };
  });
  ranked.sort((a, b) => {
    if (a.yearBucket !== b.yearBucket) return a.yearBucket - b.yearBucket;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.voteCount !== b.voteCount) return b.voteCount - a.voteCount;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.yearDelta - b.yearDelta;
  });
  return ranked[0].item;
}

function collectExactCandidates(list, items, title, isTv, priority) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const rank = exactMatchRank(item, title, isTv);
    if (rank == null) continue;
    list.push({
      item,
      rank,
      priority,
      voteCount: Number(item.vote_count) || 0,
    });
  }
}

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

function titleMatchScore(names, canonical) {
  const wanted = Array.isArray(canonical) ? canonical : [canonical];
  let best = 0;
  for (const query of wanted) {
    const wantedKey = titleKey(query);
    const wantedSet = titleTokenSet(query);
    if (!wantedKey) continue;
    for (const raw of names) {
      const nameKey = titleKey(raw);
      if (!nameKey) continue;
      if (nameKey === wantedKey) return 1;
      const nameSet = titleTokenSet(raw);

      let queryInName = true;
      for (const token of wantedSet) {
        if (!nameSet.has(token)) {
          queryInName = false;
          break;
        }
      }
      const extra = nameSet.size - wantedSet.size;
      const suffixBoost =
        queryInName && extra > 0 && extra <= 2 && nameKey.startsWith(wantedKey)
          ? 0.85 + 0.15 * (wantedSet.size / nameSet.size)
          : 0;

      let score = 0;
      if (nameKey.includes(wantedKey) || wantedKey.includes(nameKey)) {
        score = Math.min(nameKey.length, wantedKey.length) /
          Math.max(nameKey.length, wantedKey.length);
      } else {
        let intersection = 0;
        for (const token of wantedSet) {
          if (nameSet.has(token)) intersection++;
        }
        const union = wantedSet.size + nameSet.size - intersection;
        score = union > 0 ? intersection / union : 0;
        score = Math.max(score, diceSimilarity(nameKey, wantedKey));
      }
      best = Math.max(best, score, suffixBoost);
    }
  }
  return best;
}

function scoreCandidate(kind, item, canonical, year, resultCount) {
  const names =
    kind === 'tv'
      ? [item.name, item.original_name]
      : [item.title, item.original_title];
  const titleScore = titleMatchScore(names, canonical);
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
  const voteCountRaw = Number(item.vote_count);
  const voteCount = Number.isFinite(voteCountRaw) && voteCountRaw > 0 ? voteCountRaw : 0;

  return {
    item,
    titleScore,
    yearScore,
    resultCount,
    voteCount,
    total: titleScore * 1000 + yearScore * 20 + popularity * 3 + vote * 2,
  };
}

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

    const compact = String(base).replace(/[\s'’`".,!?():;\-–—]+/g, '');
    if (compact) push(compact);

    const parts = String(base)
      .split(/\s*[:–—]\s*|\s+-\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    if (parts.length > 1) {
      for (const part of parts) push(part);
    }

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
  const canonical = [];
  for (const value of [title, opts.fallbackTitle]) {
    const text = String(value || '').trim();
    if (!text) continue;
    if (canonical.some((seen) => normalizeTitle(seen) === normalizeTitle(text))) continue;
    canonical.push(text);
  }
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
        canonical,
        numericYear,
        results.length
      );
      const yearOk = !numericYear || scored.yearScore >= 0.8;
      const exact = scored.titleScore >= 0.99;
      const close = scored.titleScore >= 0.9 && yearOk;
      const partial = scored.titleScore >= 0.85 && yearOk && scored.voteCount >= 200;
      const single =
        scored.resultCount === 1 &&
        scored.titleScore >= 0.5 &&
        yearOk &&
        scored.voteCount >= 200;
      const acceptable = exact || close || partial || single;
      if (acceptable && (!best || scored.total > best.total)) best = scored;
    }
  }

  if (!best) return null;

  console.log(
    `[tmdb] broad match: "${title}" (${year || '?'}) -> ` +
      `${best.item.id} "${best.item.title || best.item.name}" ` +
      `(title=${best.titleScore.toFixed(2)} year=${best.yearScore.toFixed(2)} ` +
      `votes=${best.voteCount})`
  );
  return best.item;
}

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

  const fallbackTitle = String(opts.fallbackTitle || '').trim();
  const hasFallback =
    fallbackTitle && normalizeTitle(fallbackTitle) !== normalizeTitle(query);

  const firstParams = { query, language };
  if (numericYear) firstParams.year = numericYear;
  const firstResults = await search(firstParams);

  if (!numericYear) {
    const candidates = [];
    collectExactCandidates(candidates, firstResults, title, false, 0);
    if (hasFallback) {
      const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
      collectExactCandidates(candidates, fallbackResults, fallbackTitle, false, 1);
    }
    const exact = pickExactCandidate(candidates, numericYear);
    if (exact) return exact;
    return null;
  }

  const withinYear = firstResults.filter((movie) => matchesYear(movie, numericYear));
  const firstCandidates = [];
  collectExactCandidates(firstCandidates, withinYear, title, false, 0);
  const firstExact = pickExactCandidate(firstCandidates, numericYear);
  if (firstExact) return firstExact;

  const candidates = [];
  if (hasFallback) {
    const fallbackYearResults = await search({
      query: fallbackTitle,
      language: 'ru-RU',
      year: numericYear,
    });
    collectExactCandidates(candidates, fallbackYearResults, fallbackTitle, false, 1);
  }
  const secondResults = await search({ query, language });
  collectExactCandidates(candidates, secondResults, title, false, 0);
  if (hasFallback) {
    const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
    collectExactCandidates(candidates, fallbackResults, fallbackTitle, false, 1);
  }
  const exact = pickExactCandidate(candidates, numericYear);
  if (exact) return exact;

  return broadSearch('movie', title, year, opts);
}

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

  const hasFallback =
    fallbackTitle && normalizeTitle(fallbackTitle) !== normalizeTitle(query);

  if (numericYear) {
    const withinYear = firstResults.filter((show) => matchesYear(show, numericYear));
    const firstCandidates = [];
    collectExactCandidates(firstCandidates, withinYear, query, true, 0);
    const exact = pickExactCandidate(firstCandidates, numericYear);
    if (exact) return exact;
  } else {
    const candidates = [];
    collectExactCandidates(candidates, firstResults, query, true, 0);
    if (hasFallback) {
      const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
      collectExactCandidates(candidates, fallbackResults, fallbackTitle, true, 1);
    }
    return pickExactCandidate(candidates, numericYear);
  }

  const candidates = [];
  if (hasFallback) {
    const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
    collectExactCandidates(candidates, fallbackResults, fallbackTitle, true, 1);
  }
  const secondResults = await search({ query, language });
  collectExactCandidates(candidates, secondResults, query, true, 0);
  const exact = pickExactCandidate(candidates, numericYear);
  if (exact) return exact;

  return broadSearch('tv', title, year, opts);
}

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

function normalizeCollection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    poster_path: raw.poster_path || null,
    backdrop_path: raw.backdrop_path || null,
  };
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
      belongs_to_collection: normalizeCollection(details.belongs_to_collection),
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
  normalizeCollection,
  searchMovie,
  searchTv,
  searchCatalog,
  fetchMovieData,
  fetchTvData,
  releaseYear,
  titleMatchScore,
  titleKey,
  counters,
  MAX_CONCURRENCY,
  API_BASE,
};
