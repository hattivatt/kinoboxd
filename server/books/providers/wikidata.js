'use strict';

/**
 * Wikidata provider — the year claim for works nobody else dates.
 *
 * Why it exists: Hardcover, Литрес and Open Library answer with an *edition*
 * year for a translated reprint, and none of them knows the work behind it.
 * Wikidata does, and for a Russian library it is the only source that has the
 * Russian title of a foreign work («Убийство в доме викария» → 1930,
 * «Ребекка» → 1938, «Скупой» → 1668). Measured on the live cache: 43 of 97
 * undated Russian titles resolved to an author-verified work with a date.
 *
 * The provider is a *year-only* source. It returns no ISBN, pages, genres or
 * cover, so it must never become the primary result of a resolve; it is asked
 * by `resolve-stages/year-stage.js` and `years-backfill.js`, batched.
 *
 * Contract (`lookupTitles(entries, options)`):
 *   entries  [{ key, title, authors: [names] }]
 *   returns  { byKey: Map<key, result>, asked: Set<key>,
 *              skipped: null|'budget'|'breaker'|'disabled', queries }
 * A key present in `byKey` with a `null` value means «asked, no claim» — an
 * answer. A key absent from `byKey` was never asked (budget/breaker) and must
 * not be written into the negative cache.
 *
 * Matching rules (each one is a measured failure mode):
 *   - the item must be a literary work (`P31` → subclass of `Q7725634`); an
 *     edition item is only usable through its `P629` canonical work, whose date
 *     is the one that counts — otherwise «Одиссея» (1997 translation) is read
 *     as a 1997 work;
 *   - a claim without an author match is only accepted when it is the single
 *     candidate and the title matched exactly: «Бретёр» by Ю. Яковлева must
 *     not become Turgenev's 1847 novella;
 *   - two author-verified candidates are never averaged: the one with more
 *     sitelinks wins, ties fall back to the earliest year (the merge rule);
 *   - `P577` (publication) is preferred over `P571` (inception/composition);
 *     the century/millennium precision and the `composition` kind travel with
 *     the claim, so an ancient text is not dressed up as an exact year.
 *
 * Politeness (measured on WDQS): one batch costs TWO queries — the label
 * search (~2 s for 12 titles) and a `VALUES`-bound follow-up for the canonical
 * works of the matched items (~0.5 s). The obvious single query (a `P629`
 * UNION with the canonical dates inside the label search) times out server-side
 * with HTTP 504 after 60 s, so it is not an option. 1.2 s pause between
 * queries, 3 attempts with backoff, `429`/`502`/`503`/`504` honour
 * `Retry-After`, a failed query trips the 30 min breaker. The per-run budget
 * (`BOOKS_WIKIDATA_BUDGET`, default 300) counts *books*, not queries.
 */

const { fetchOnce, defaultSleep, createSourceClient } = require('./http');
const sources = require('../../core/sources');
const { normalizeAuthorName, namesLookAlike } = require('../authors');
const { surnameSimilarity, FUZZY_SURNAME_SIM, FUZZY_SURNAME_MIN_LEN } = require('./match');
const { wikidataEnabled } = require('../wikidata-flag');
const { firstYearOf, saneFirstYearClaim } = require('./claim');

const NAME = 'wikidata';
const SOURCE_ID = 'wikidataBooks';
const ENDPOINT = 'https://query.wikidata.org/sparql';
const source = createSourceClient({ name: SOURCE_ID });
const { isBreakerOpen, tripBreaker, resetBreaker, createBudget, budgetFromEnv } = source;
const DEFAULT_PAUSE_MS = sources.pauseMs(SOURCE_ID);
const DEFAULT_TIMEOUT_MS = sources.timeoutMs(SOURCE_ID);
const DEFAULT_BATCH_SIZE = sources.getSource(SOURCE_ID).batchSize;
const MAX_ATTEMPTS = sources.getSource(SOURCE_ID).maxAttempts;
const BASE_BACKOFF_MS = sources.getSource(SOURCE_ID).baseBackoffMs;
const MAX_BACKOFF_MS = sources.getSource(SOURCE_ID).maxBackoffMs;
const USER_AGENT = sources.userAgent(SOURCE_ID);

const LITERARY_WORK = 'wd:Q7725634';

const sleepOf = (options) => (typeof options.sleep === 'function' ? options.sleep : defaultSleep);

/**
 * Master switch, shared with the author-alias bridge: `0`/`off` = off.
 *
 * `test/helpers/env.zeroBudgets()` sets `KINOBOXD_BOOKS_WIKIDATA=0`, so a suite
 * that wants an offline process does not have to inject a fake provider.
 */
function isDisabled() {
  return !wikidataEnabled();
}

/**
 * Wikibase time value -> integer year (`1930-10-01T00:00:00Z`,
 * `-0800-00-00T00:00:00Z`).
 */
function coreTimeToYear(value) {
  const text = String(value == null ? '' : value).trim();
  const match = /^([+-]?)(\d+)-/.exec(text);
  if (!match) return null;
  const year = Number(match[2]);
  if (!Number.isFinite(year)) return null;
  return match[1] === '-' ? -year : year;
}

/**
 * Wikibase precision -> the payload vocabulary.
 *
 * 11/10/9 are day/month/year, 8 a decade, 7 a century, 6 a millennium. A
 * coarser value is stored by Wikibase as the start of its period, which is
 * exactly the number the chart wants («VIII в. до н.э.» -> -800).
 */
function precisionLabelOf(value) {
  const precision = Number(value);
  if (precision === 11 || precision === 10 || precision === 9) return 'year';
  if (precision === 8) return 'decade';
  if (precision === 7) return 'century';
  if (precision === 6) return 'millennium';
  return null;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Query 1: the search. Labels are the driving table.
 *
 * The type filter is written as a join (`?item wdt:P31 ?type . ?type wdt:P279*
 * wd:Q7725634`), not as the chained path `wdt:P31/wdt:P279*`: the chained form
 * makes the planner walk the whole literary-work subtree and the server answers
 * 504 after 60 s (measured).
 */
const SEARCH_QUERY = `
SELECT ?label ?item ?itemLabel ?author ?authorLabel ?sitelinks
       ?p577 ?p577Prec ?p571 ?p571Prec ?seriesLabel ?ordinal
WHERE {
  VALUES ?label { __LABELS__ }
  { ?item rdfs:label ?label } UNION { ?item skos:altLabel ?label }
  ?item wdt:P31 ?type . ?type wdt:P279* ${LITERARY_WORK} .
  OPTIONAL {
    ?item wdt:P50 ?author .
    OPTIONAL { ?author wdt:P569 ?authorBirth }
  }
  OPTIONAL {
    ?item p:P577 ?st577 . ?st577 psv:P577 ?v577 .
    ?v577 wikibase:timeValue ?p577 ; wikibase:timePrecision ?p577Prec .
  }
  OPTIONAL {
    ?item p:P571 ?st571 . ?st571 psv:P571 ?v571 .
    ?v571 wikibase:timeValue ?p571 ; wikibase:timePrecision ?p571Prec .
  }
  OPTIONAL {
    ?item wdt:P179 ?series .
    OPTIONAL { ?item p:P179 ?st179 . ?st179 pq:P1545 ?ordinal }
  }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
}
LIMIT 900`;

/**
 * Query 2: are the matched items editions of another work, and when was that
 * work first published? Bound by `VALUES ?item`, so it is a lookup, not a
 * search (~0.5 s regardless of the batch).
 */
const CANONICAL_QUERY = `
SELECT ?item ?canonical ?canonicalLabel
       ?canonicalP577 ?canonicalP577Prec ?canonicalP571 ?canonicalP571Prec
       ?canonicalSeriesLabel ?canonicalOrdinal
WHERE {
  VALUES ?item { __ITEMS__ }
  ?item wdt:P629 ?canonical .
  OPTIONAL {
    ?canonical p:P577 ?cst577 . ?cst577 psv:P577 ?cv577 .
    ?cv577 wikibase:timeValue ?canonicalP577 ; wikibase:timePrecision ?canonicalP577Prec .
  }
  OPTIONAL {
    ?canonical p:P571 ?cst571 . ?cst571 psv:P571 ?cv571 .
    ?cv571 wikibase:timeValue ?canonicalP571 ; wikibase:timePrecision ?canonicalP571Prec .
  }
  OPTIONAL {
    ?canonical wdt:P179 ?canonicalSeries .
    OPTIONAL { ?canonical p:P179 ?cst179 . ?cst179 pq:P1545 ?canonicalOrdinal }
  }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
}
LIMIT 900`;

function escapeLabel(value) {
  return String(value == null ? '' : value).replace(/["\\]/g, '');
}

function qidOf(uri) {
  if (!uri) return null;
  const match = /\/entity\/(Q\d+)$/.exec(String(uri));
  return match ? match[1] : null;
}

/**
 * Search spellings of one title.
 *
 * LiveLib exports carry the reader's spelling: «Властелин Колец» (capital К),
 * «Убийство в "Восточном экспрессе"» (quotes), «Приключения Алисы в стране
 * чудес ; Сквозь зеркало…» (two books in one row). Wikidata's label is one of
 * the normalised variants, so all of them are asked in the same `VALUES`.
 */
function titleVariants(title) {
  const raw = String(title == null ? '' : title)
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length < 2) return [];
  const out = new Set([raw]);
  const noDots = raw.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  out.add(noDots);
  const stripped = noDots.replace(/[«»"'“”„`]/g, '').replace(/\s+/g, ' ').trim();
  out.add(stripped);
  if (stripped) out.add(stripped.charAt(0).toLowerCase() + stripped.slice(1));
  const head = stripped.split(/\s*[;:]\s*/)[0].trim();
  if (head) out.add(head);
  const beforeComma = stripped.split(/,\s*/)[0].trim();
  if (beforeComma) out.add(beforeComma);
  return [...out].filter((value) => value.length >= 2 && value.length <= 160);
}

function seriesClaim(name, ordinal) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return null;
  const raw = String(ordinal == null ? '' : ordinal).trim().replace(',', '.');
  const position = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { name: text, position: position != null && position > 0 ? position : null };
}

function timeClaim(value, precisionValue) {
  const year = firstYearOf(coreTimeToYear(value));
  if (year == null) return null;
  return { year, precision: precisionLabelOf(precisionValue) || 'year' };
}

/**
 * Normalise both query shapes into one row list.
 *
 * A search row carries the item's own dates and author; a canonical row says
 * «this item is an edition of Q…» and carries the dates of that work.
 */
function parseResponse(payload) {
  const bindings =
    payload && payload.results && Array.isArray(payload.results.bindings)
      ? payload.results.bindings
      : [];
  return bindings.map((row) => {
    const value = (name) => (row[name] ? row[name].value : null);
    return {
      label: value('label'),
      item: qidOf(value('item')),
      itemLabel: value('itemLabel'),
      authorLabel: value('authorLabel'),
      authorBirthYear: coreTimeToYear(value('authorBirth')),
      sitelinks: Number(value('sitelinks')) || 0,
      publication: timeClaim(value('p577'), value('p577Prec')),
      inception: timeClaim(value('p571'), value('p571Prec')),
      canonical: qidOf(value('canonical')),
      canonicalLabel: value('canonicalLabel'),
      canonicalPublication: timeClaim(value('canonicalP577'), value('canonicalP577Prec')),
      canonicalInception: timeClaim(value('canonicalP571'), value('canonicalP571Prec')),
      series: seriesClaim(value('seriesLabel'), value('ordinal')),
      canonicalSeries: seriesClaim(value('canonicalSeriesLabel'), value('canonicalOrdinal')),
      author: qidOf(value('author')),
    };
  });
}

function retryAfterOf(response) {
  try {
    const { parseRetryAfter } = require('../../core/http');
    return parseRetryAfter({ headers: response.headers }, MAX_BACKOFF_MS);
  } catch (err) {
    return null;
  }
}

async function sparql(query, options = {}) {
  const sleep = sleepOf(options);
  const fetchImpl = options.fetchImpl;
  const timeoutMs = options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
      const wait = lastError && lastError.retryAfterMs != null ? lastError.retryAfterMs : backoff;
      if (wait > 0) await sleep(wait);
    }
    let response;
    try {
      response = await fetchOnce(ENDPOINT, {
        fetchImpl,
        method: 'POST',
        headers: {
          accept: 'application/sparql-results+json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
        },
        body: new URLSearchParams({ query, format: 'json' }).toString(),
        timeoutMs,
        label: 'wikidata-books',
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = Object.assign(new Error(`wikidata_http_${response.status}`), {
        code: 'wikidata_http_error',
        status: response.status,
        retryAfterMs: retryAfterOf(response),
      });
      continue;
    }
    if (response.status !== 200) {
      lastError = Object.assign(new Error(`wikidata_http_${response.status}`), {
        code: 'wikidata_http_error',
        status: response.status,
      });
      break;
    }
    try {
      return JSON.parse(response.body);
    } catch (err) {
      lastError = Object.assign(new Error('wikidata_bad_json'), { code: 'wikidata_bad_json' });
      break;
    }
  }
  tripBreaker();
  const error = lastError || new Error('wikidata_unavailable');
  error.code = error.code || 'wikidata_error';
  throw error;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function normalizeTitleKey(value) {
  return normalizeAuthorName(value);
}

function authorNamesOf(entry) {
  return (Array.isArray(entry && entry.authors) ? entry.authors : [])
    .filter((name) => name && String(name).trim())
    .map((name) => String(name).trim());
}

function authorHit(candidateAuthor, authors) {
  if (!candidateAuthor) return false;
  return authors.some((name) => {
    if (namesLookAlike(name, candidateAuthor)) return true;
    const a = normalizeAuthorName(name);
    const b = normalizeAuthorName(candidateAuthor);
    if (!a || !b) return false;
    if (a === b) return true;
    const surnameA = a.split(' ').filter(Boolean).pop();
    const surnameB = b.split(' ').filter(Boolean).pop();
    if (!surnameA || !surnameB) return false;
    if (surnameA === surnameB && surnameA.length >= 3) return true;
    if (surnameA.length < FUZZY_SURNAME_MIN_LEN || surnameB.length < FUZZY_SURNAME_MIN_LEN) {
      return false;
    }
    return surnameSimilarity(surnameA, surnameB) >= FUZZY_SURNAME_SIM;
  });
}

/**
 * Collapse search rows (+ canonical rows) into candidate works.
 *
 * An item that `P629`-links another work is an edition/translation: only the
 * canonical work may speak, with its own dates. An edition whose canonical
 * work has no date contributes nothing — the print run in hand is not a
 * first-publication claim.
 */
function candidatesFor(rows, canonicalRows, entry) {
  const canonicalByItem = new Map();
  for (const row of canonicalRows || []) {
    if (row.item && row.canonical) canonicalByItem.set(row.item, row);
  }
  const byWork = new Map();
  for (const row of rows) {
    if (!row.item) continue;
    const edition = canonicalByItem.get(row.item) || null;
    const workId = edition ? edition.canonical : row.item;
    const publication = edition
      ? edition.canonicalPublication
      : row.publication;
    const inception = edition ? edition.canonicalInception : row.inception;
    const existing = byWork.get(workId) || {
      workId,
      label: (edition && edition.canonicalLabel) || row.itemLabel || null,
      authors: [],
      hasAuthor: false,
      authorBirthYear: null,
      sitelinks: 0,
      publication: null,
      inception: null,
      series: null,
      authorIds: new Map(),
    };
    if (row.authorLabel) {
      existing.hasAuthor = true;
      if (!existing.authors.includes(row.authorLabel)) existing.authors.push(row.authorLabel);
      if (row.author) existing.authorIds.set(row.authorLabel, row.author);
    }
    if (existing.authorBirthYear == null && row.authorBirthYear != null) {
      existing.authorBirthYear = row.authorBirthYear;
    }
    existing.sitelinks = Math.max(existing.sitelinks, row.sitelinks || 0);
    if (!existing.publication && publication) existing.publication = publication;
    if (!existing.inception && inception) existing.inception = inception;
    const series = (edition && edition.canonicalSeries) || row.series;
    if (!existing.series && series) existing.series = series;
    byWork.set(workId, existing);
  }
  const target = normalizeTitleKey(entry.title);
  const candidates = [];
  for (const candidate of byWork.values()) {
    const claim = candidate.publication
      ? { year: candidate.publication.year, precision: candidate.publication.precision, kind: 'publication' }
      : candidate.inception
        ? { year: candidate.inception.year, precision: candidate.inception.precision, kind: 'composition' }
        : null;
    if (!claim) continue;
    candidates.push({
      ...candidate,
      claim,
      exact: Boolean(target) && [candidate.label, entry.title].some(
        (value) => normalizeTitleKey(value) === target
      ),
      authorHit: candidate.authors.some((name) => authorHit(name, entry.authors)),
    });
  }
  return candidates;
}

function pickCandidate(candidates) {
  if (!candidates.length) return null;
  const verified = candidates.filter((candidate) => candidate.authorHit);
  // An author claim that does not match the reader's author is a rejection,
  // not a missing signal: Wikidata says this work belongs to someone else
  // («Бретёр» by Turgenev is not the Yakovleva book with the same title).
  // Only an item with no author claim at all may be accepted implicitly.
  const unowned = candidates.filter((candidate) => !candidate.authorHit && !candidate.hasAuthor);
  const pool = verified.length ? verified : unowned;
  if (!pool.length) return null;
  if (!verified.length && pool.length > 1) return null;
  if (!verified.length && !pool[0].exact) return null;
  const sorted = [...pool].sort((a, b) => {
    if (b.sitelinks !== a.sitelinks) return b.sitelinks - a.sitelinks;
    return a.claim.year - b.claim.year;
  });
  return sorted[0];
}

function toResult(candidate, entry) {
  const claim = saneFirstYearClaim(
    { ...candidate.claim, source: NAME },
    { authorBirthYear: candidate.authorBirthYear }
  );
  if (!claim) return null;
  return {
    source: NAME,
    sourceId: candidate.workId,
    workId: `wd:${candidate.workId}`,
    title: entry.title || candidate.label || null,
    authors: candidate.authors.slice(),
    year: null,
    firstPublishedYear: claim.year,
    firstPublishedYearPrecision: claim.precision,
    firstPublishedYearKind: claim.kind,
    publisher: null,
    series: candidate.series
      ? { name: candidate.series.name, position: candidate.series.position, source: NAME }
      : null,
    seriesAll: candidate.series
      ? [{ name: candidate.series.name, position: candidate.series.position, source: NAME }]
      : [],
    wikidataWorkId: candidate.workId,
    wikidataAuthorIds: [...candidate.authorIds.entries()].map(([name, qid]) => ({ name, qid })),
    genres: [],
    pages: null,
    isbn13: null,
    isbn10: null,
    cover: null,
    links: { pageUrl: `https://www.wikidata.org/wiki/${candidate.workId}` },
    language: null,
    confidence: candidate.authorHit ? 0.62 : 0.42,
    match: {
      method: 'title',
      titleSim: candidate.exact ? 1 : null,
      exact: candidate.exact,
      authorHit: candidate.authorHit,
      candidates: candidate.sitelinks,
    },
    mangaComics: null,
    mangaTexts: [],
    authorBirthYear: candidate.authorBirthYear,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Ask Wikidata for the first-publication year of a batch of titles.
 *
 * @param {Array<{key:string, title:string, authors?:string[]}>} entries
 * @param {{budget?:object, sleep?:Function, fetchImpl?:Function, batchSize?:number,
 *          pauseMs?:number, onProgress?:Function}} [options]
 * @returns {Promise<{byKey:Map<string, object|null>, asked:Set<string>,
 *                    skipped:null|'budget'|'breaker'|'disabled', queries:number}>}
 */
async function lookupTitles(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (entry) => entry && entry.key != null && entry.title
  );
  const result = { byKey: new Map(), asked: new Set(), skipped: null, queries: 0 };
  if (!list.length) return result;
  if (isDisabled()) {
    result.skipped = 'disabled';
    return result;
  }
  if (isBreakerOpen()) {
    result.skipped = 'breaker';
    return result;
  }
  const budget = options.budget === undefined ? null : options.budget;
  const taken = [];
  for (const entry of list) {
    if (budget && typeof budget.take === 'function' && !budget.take()) {
      result.skipped = 'budget';
      continue;
    }
    taken.push(entry);
  }
  if (!taken.length) return result;
  for (const entry of taken) result.asked.add(String(entry.key));

  const batchSize = Number(options.batchSize) > 0 ? Number(options.batchSize) : DEFAULT_BATCH_SIZE;
  const pause = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const sleep = sleepOf(options);
  const batches = [];
  let current = [];
  for (const entry of taken) {
    if (current.length >= batchSize) {
      batches.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) batches.push(current);

  for (const [index, batch] of batches.entries()) {
    const values = [];
    const seen = new Set();
    for (const entry of batch) {
      for (const variant of titleVariants(entry.title)) {
        const label = `"${escapeLabel(variant)}"@ru`;
        if (seen.has(label)) continue;
        seen.add(label);
        values.push(label);
      }
    }
    if (!values.length) continue;
    if (pause > 0) await sleep(pause);
    result.queries++;
    const rows = parseResponse(
      await sparql(SEARCH_QUERY.replace('__LABELS__', values.join(' ')), options)
    );

    const items = [...new Set(rows.map((row) => row.item).filter(Boolean))];
    let canonicalRows = [];
    if (items.length) {
      if (pause > 0) await sleep(pause);
      result.queries++;
      canonicalRows = parseResponse(
        await sparql(
          CANONICAL_QUERY.replace(
            '__ITEMS__',
            items.map((qid) => `wd:${qid}`).join(' ')
          ),
          options
        )
      );
    }

    for (const entry of batch) {
      const wanted = new Set(titleVariants(entry.title));
      const collected = rows.filter((row) => row.label && wanted.has(row.label));
      const candidates = candidatesFor(collected, canonicalRows, {
        title: entry.title,
        authors: authorNamesOf(entry),
      });
      const chosen = pickCandidate(candidates);
      result.byKey.set(String(entry.key), chosen ? toResult(chosen, entry) : null);
    }
    if (typeof options.onProgress === 'function') {
      options.onProgress({ batch: index + 1, batches: batches.length });
    }
  }
  return result;
}

/**
 * Chain-compatible single-book lookup. The resolve chain never calls it (the
 * year is asked by the dedicated stages, batched); it exists so the provider
 * satisfies the registry contract and so `years-backfill --ids` can ask one
 * book through the same code path.
 */
async function getWork(input = {}, options = {}) {
  const keyOfInput = options.key || 'single';
  const found = await lookupTitles(
    [{ key: keyOfInput, title: input.title, authors: input.authors }],
    options
  );
  return found.byKey.get(keyOfInput) || null;
}

module.exports = {
  NAME,
  titleVariants,
  candidatesFor,
  pickCandidate,
  authorHit,
  parseResponse,
  coreTimeToYear,
  precisionLabelOf,
  sparql,
  lookupTitles,
  getWork,
  isDisabled,
  isBreakerOpen,
  tripBreaker,
  resetBreaker,
  createBudget,
  budgetFromEnv,
  DEFAULT_BATCH_SIZE,
};
