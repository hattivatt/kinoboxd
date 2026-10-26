'use strict';

const { normalizeTitle } = require('./cache');
const { getTmdbToken } = require('./config');

// `TMDB_API_BASE` lets a local backfill use TMDB's alternate API host when
// the canonical `api.themoviedb.org` endpoint is blocked by the network.
// Production keeps the documented default.
const API_BASE = String(process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3')
  .replace(/\/+$/, '');
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

// The public TMDB endpoint occasionally resets connections in some networks
// (`fetch failed`, ECONNRESET/ETIMEDOUT/EAI_*). Four retries with a 1/2/4/8 s
// exponential backoff turn those transient failures into ordinary successes;
// a persistent outage still fails fast enough for the caller to report it.
const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * GET a TMDB endpoint with Bearer auth, global 12-request limit, four
 * transport/5xx retries (1/2/4/8 s) and 429 handling (up to 5 retries,
 * Retry-After respected). Retry chatter is quiet unless DEBUG_RETRY is set;
 * callers print the aggregate `counters` at the end of a run instead.
 */
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

    if (!response.ok) {
      const body = await response.text().catch(() => '');
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

    return response.json();
  }
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

/**
 * Tokens with a leading "Episode <roman/arabic>" marker removed. TMDB's
 * canonical titles routinely drop the episode number ("Star Wars: Episode
 * VIII - The Last Jedi" is stored as "Star Wars: The Last Jedi"), while
 * KinoPoisk keeps it. Only strip when at least three content tokens remain so
 * a literal "Star Wars: Episode VIII" cannot collapse to "Star Wars".
 */
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

/**
 * Collect exact-title candidates from several year-scoped/year-less searches
 * and pick the one closest to the requested year. This matters for remakes:
 * a year-less "Cinderella" search returns the 2015 film before the 1950 one,
 * while the correct entry for a 1949 KinoPoisk key is the 1950 classic.
 * Ties prefer the primary title over the localized fallback.
 */
function pickExactCandidate(candidates, year) {
  if (!candidates || candidates.length === 0) return null;
  const ranked = candidates.map((candidate) => {
    const release = releaseYear(candidate.item);
    const yearDelta =
      year && release != null ? Math.abs(release - year) : Number.MAX_SAFE_INTEGER;
    // Years 0/1 apart are equally plausible (festival vs wide release). A
    // low-vote same-name short must not beat the real film just because its
    // release_date happens to be one year closer ("The Witch" 2016 vs a
    // 7-vote 2015 namesake).
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
 * Similarity of one candidate title to the *canonical* KinoPoisk titles.
 *
 * `query` is only a search-recall hint ("Star Wars", "Impossible" after the
 * colon expansion); a hit on such a fragment must not become a 1.0 title
 * match. `canonical` therefore holds the full title and its localized
 * fallback; the ranker scores the candidate against those only.
 *
 * Metric:
 *  - exact normalized token key -> 1.0;
 *  - one full string contains the other -> minLen/maxLen (so a fragment such
 *    as "impossible" inside "mission impossible dead reckoning" scores low);
 *  - otherwise token Jaccard (|intersection| / |union|), with a Dice
 *    bigram fallback for transliteration variants ("Yongpari" vs "Yong Pal",
 *    "Слезы" vs "Слёзы");
 *  - a candidate that starts with every canonical token and adds at most two
 *    suffix tokens ("... Part One", "(Целитель)") gets a near-exact boost.
 */
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
  // Score candidates against the real titles, never against a recall-only
  // fragment produced by the "Main: subtitle" expansion.
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
      // Guardrails per candidate:
      //  - an exact title is accepted even when the year is off;
      //  - a very close title (>=0.90, e.g. transliteration + sequel suffix)
      //    needs a plausible year;
      //  - a partial title (0.85-0.90) additionally needs real audience mass
      //    (vote_count >= 200), so an obscure same-name short cannot win;
      //  - a sole search hit needs a plausible title/year and audience mass.
      // Candidates that do not pass never become the best match, even if
      // another query ranks them higher.
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
    // Without a year we accept an exact match only, otherwise report "not
    // found" and let the cache hold false.
    return null;
  }

  // A title that exactly matches inside the year window is the strongest
  // possible signal; no need for more searches.
  const withinYear = firstResults.filter((movie) => matchesYear(movie, numericYear));
  const firstCandidates = [];
  collectExactCandidates(firstCandidates, withinYear, title, false, 0);
  const firstExact = pickExactCandidate(firstCandidates, numericYear);
  if (firstExact) return firstExact;

  // Otherwise collect exact candidates from the localized year-scoped search
  // and both year-less searches, then choose by year proximity. This keeps
  // the 1965 "Красная борода" when a year-less "Akahige" search would return
  // a 1997 namesake, and prefers the exact primary title over a localized
  // namesake with the same year ("Deep Cover" vs "Под прикрытием").
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

  const hasFallback =
    fallbackTitle && normalizeTitle(fallbackTitle) !== normalizeTitle(query);

  if (numericYear) {
    const withinYear = firstResults.filter((show) => matchesYear(show, numericYear));
    const firstCandidates = [];
    collectExactCandidates(firstCandidates, withinYear, query, true, 0);
    const exact = pickExactCandidate(firstCandidates, numericYear);
    if (exact) return exact;
    // No exact title in the year-scoped results: fall through to the
    // year-less exact retries and finally broadSearch.
  } else {
    const candidates = [];
    collectExactCandidates(candidates, firstResults, query, true, 0);
    if (hasFallback) {
      const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
      collectExactCandidates(candidates, fallbackResults, fallbackTitle, true, 1);
    }
    return pickExactCandidate(candidates, numericYear);
  }

  // Year-less retries: the localized (Russian) title and the primary query.
  // Collect both, then choose the candidate closest to the requested year.
  const candidates = [];
  if (hasFallback) {
    const fallbackResults = await search({ query: fallbackTitle, language: 'ru-RU' });
    collectExactCandidates(candidates, fallbackResults, fallbackTitle, true, 1);
  }
  const secondResults = await search({ query, language });
  collectExactCandidates(candidates, secondResults, query, true, 0);
  const exact = pickExactCandidate(candidates, numericYear);
  if (exact) return exact;

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

/**
 * TMDB's `belongs_to_collection` is localized by the request language (ru-RU
 * gives "Железный человек (Коллекция)"). `null` is stored explicitly for
 * standalone films: it is the idempotency marker for the `collections`
 * backfill target, just like `imdb_checked` for the `imdb` target.
 */
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
  normalizeCollection,
  searchMovie,
  searchTv,
  searchCatalog,
  fetchMovieData,
  fetchTvData,
  releaseYear,
  // Exported for the matcher unit tests (pure functions, no network).
  titleMatchScore,
  titleKey,
  counters,
  MAX_CONCURRENCY,
  API_BASE,
};
