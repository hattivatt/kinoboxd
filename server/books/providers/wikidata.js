'use strict';

const { fetchOnce, defaultSleep, createSourceClient } = require('./http');
const sources = require('../../core/sources');
const { normalizeAuthorName, namesLookAlike } = require('../authors');
const { surnameSimilarity, FUZZY_SURNAME_SIM, FUZZY_SURNAME_MIN_LEN } = require('./match');
const { wikidataEnabled } = require('../wikidata-flag');
const { firstYearOf, saneFirstYearClaim } = require('./claim');
const { titleVariants, partVariants } = require('./title-variants');
const { lookupByAuthorWorks } = require('./wikidata-author-works');

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

function isDisabled() {
  return !wikidataEnabled();
}

function coreTimeToYear(value) {
  const text = String(value == null ? '' : value).trim();
  const match = /^([+-]?)(\d+)-/.exec(text);
  if (!match) return null;
  const year = Number(match[2]);
  if (!Number.isFinite(year)) return null;
  return match[1] === '-' ? -year : year;
}

function precisionLabelOf(value) {
  const precision = Number(value);
  if (precision === 11 || precision === 10 || precision === 9) return 'year';
  if (precision === 8) return 'decade';
  if (precision === 7) return 'century';
  if (precision === 6) return 'millennium';
  return null;
}

const SEARCH_QUERY = `
SELECT ?label ?item ?itemLabel ?author ?authorLabel ?authorBirth ?sitelinks
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

function normalizeTitleKey(value) {
  return normalizeAuthorName(value);
}

function authorNamesOf(entry) {
  return (Array.isArray(entry && entry.authors) ? entry.authors : [])
    .filter((name) => name && String(name).trim())
    .map((name) => String(name).trim());
}

function orderedAuthorHit(name, candidateAuthor) {
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
}

function nameOrders(name) {
  const tokens = normalizeAuthorName(name).split(' ').filter(Boolean);
  const forms = [name];
  if (tokens.length >= 2 && tokens.slice(1).every((token) => token.length === 1)) {
    forms.push([...tokens.slice(1), tokens[0]].join(' '));
  }
  return forms;
}

function swappedPair(left, right) {
  const a = normalizeAuthorName(left).split(' ').filter(Boolean);
  const b = normalizeAuthorName(right).split(' ').filter(Boolean);
  if (a.length !== 2 || b.length !== 2) return false;
  if (Math.min(a[0].length, a[1].length, b[0].length, b[1].length) < 3) return false;
  return (
    surnameSimilarity(a[0], b[1]) >= FUZZY_SURNAME_SIM &&
    surnameSimilarity(a[1], b[0]) >= FUZZY_SURNAME_SIM
  );
}

function authorHit(candidateAuthor, authors) {
  if (!candidateAuthor) return false;
  return authors.some(
    (name) =>
      swappedPair(name, candidateAuthor) ||
      nameOrders(name).some((form) => orderedAuthorHit(form, candidateAuthor))
  );
}

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
    if (
      row.authorBirthYear != null &&
      (existing.authorBirthYear == null || row.authorBirthYear < existing.authorBirthYear)
    ) {
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

function variantTiers(entry) {
  const parts = partVariants(entry.title, authorNamesOf(entry));
  return [titleVariants(entry.title), parts.subtitle, parts.whole];
}

function resultForTiers(entry, tiers, rows, canonicalRows) {
  for (const [tier, variants] of tiers.entries()) {
    if (!variants.length) continue;
    const wanted = new Set(variants);
    const collected = rows.filter((row) => row.label && wanted.has(row.label));
    if (!collected.length) continue;
    const candidates = candidatesFor(collected, canonicalRows, {
      title: tier === 0 ? entry.title : variants[0],
      authors: authorNamesOf(entry),
    }).filter((candidate) => tier === 0 || candidate.authorHit);
    const chosen = pickCandidate(candidates);
    const found = chosen ? toResult(chosen, entry, { wholeWork: tier === 2 }) : null;
    if (found) return found;
  }
  return null;
}

function toResult(candidate, entry, options = {}) {
  const wholeWork = options.wholeWork === true;
  const claim = saneFirstYearClaim(
    { ...candidate.claim, source: NAME },
    { authorBirthYear: candidate.authorBirthYear }
  );
  if (!claim) return null;
  const series = wholeWork ? null : candidate.series;
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
    series: series
      ? { name: series.name, position: series.position, source: NAME }
      : null,
    seriesAll: series
      ? [{ name: series.name, position: series.position, source: NAME }]
      : [],
    wikidataWorkId: wholeWork ? null : candidate.workId,
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
      wholeWork,
    },
    mangaComics: null,
    mangaTexts: [],
    authorBirthYear: candidate.authorBirthYear,
  };
}

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
    const tiersByEntry = new Map();
    for (const entry of batch) {
      const tiers = variantTiers(entry);
      tiersByEntry.set(entry, tiers);
      for (const variant of tiers.flat()) {
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
      result.byKey.set(
        String(entry.key),
        resultForTiers(entry, tiersByEntry.get(entry), rows, canonicalRows)
      );
    }
    if (typeof options.onProgress === 'function') {
      options.onProgress({ batch: index + 1, batches: batches.length });
    }
  }
  if (options.authorWorks !== false) await fillFromAuthorWorks(taken, result, options);
  return result;
}

async function fillFromAuthorWorks(taken, result, options) {
  const misses = taken
    .filter((entry) => !result.byKey.get(String(entry.key)))
    .map((entry) => ({ key: entry.key, title: entry.title, authors: authorNamesOf(entry) }))
    .filter((entry) => entry.authors.length);
  if (!misses.length) return;
  const pause = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const sleep = sleepOf(options);
  const deps = {
    qidOf,
    timeYear: coreTimeToYear,
    precisionOf: precisionLabelOf,
    async query(text) {
      if (pause > 0) await sleep(pause);
      result.queries++;
      const payload = await sparql(text, options);
      return payload && payload.results && Array.isArray(payload.results.bindings)
        ? payload.results.bindings
        : [];
    },
  };
  let found;
  try {
    found = await lookupByAuthorWorks(misses, deps);
  } catch (err) {
    for (const entry of misses) result.asked.delete(String(entry.key));
    result.skipped = result.skipped || 'breaker';
    return;
  }
  for (const entry of misses) {
    const best = found.get(String(entry.key));
    const claimed = best ? authorWorkResult(entry, best) : null;
    if (claimed) result.byKey.set(String(entry.key), claimed);
  }
}

function authorWorkResult(entry, best) {
  const { work } = best;
  const claim = saneFirstYearClaim(
    { ...work.claim, source: NAME },
    { authorBirthYear: work.authorBirthYear }
  );
  if (!claim) return null;
  const wholeWork = best.tier === 2;
  const exact = best.tier === 0 && best.similarity === 1;
  return {
    source: NAME,
    sourceId: work.work,
    workId: `wd:${work.work}`,
    title: entry.title,
    authors: entry.authors.slice(0, 1),
    year: null,
    firstPublishedYear: claim.year,
    firstPublishedYearPrecision: claim.precision,
    firstPublishedYearKind: claim.kind,
    publisher: null,
    series: null,
    seriesAll: [],
    wikidataWorkId: wholeWork ? null : work.work,
    wikidataAuthorIds: [{ name: entry.authors[0], qid: work.human }],
    genres: [],
    pages: null,
    isbn13: null,
    isbn10: null,
    cover: null,
    links: { pageUrl: `https://www.wikidata.org/wiki/${work.work}` },
    language: null,
    confidence: 0.55,
    match: {
      method: 'author-works',
      titleSim: best.similarity,
      exact,
      authorHit: true,
      wholeWork,
      fuzzy: !exact,
      label: work.label,
    },
    mangaComics: null,
    mangaTexts: [],
    authorBirthYear: work.authorBirthYear,
  };
}

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
