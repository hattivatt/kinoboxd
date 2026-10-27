'use strict';

/**
 * LiveLib -> Hardcover resolve.
 *
 * LiveLib events arrive with edition-level ids and Russian titles; Hardcover is
 * the canonical work namespace (`books.id` = work id, `hc:{id}`). Matching is
 * deliberately asymmetric — hardcover events need no matching at all.
 *
 * Order (КНИГИ-АРХИТЕКТУРА.md §4.0, v2 multi-source chain):
 *   1. cached link `links/{livelibBookId}.json` (positive results only);
 *   2. ISBN-13/ISBN-10 bulk lookup against Hardcover `editions` (batches of 100);
 *   3. strict title + first-author surname + year (±1) over the local corpus;
 *   4. fuzzy token-Jaccard with the film-lesson guards
 *      (author hit mandatory, 0.80-0.90 needs year ±1 and ratings_count >= 50);
 *   5. provider chain for the rest: Google Books ISBN -> Open Library ISBN ->
 *      LiveLib card (genres/ISBN/pages for RU editions);
 *   6. events without an ISBN start with the LiveLib card (it supplies the
 *      ISBN), then the card's ISBN goes through the Hardcover bulk lookup,
 *      then Google Books/Open Library;
 *   7. otherwise unmatched (NOT cached: a later import may resolve it).
 *
 * Provider negatives are memoised per run only (soft TTL, no disk cache) so a
 * growing source is queried again on the next run. All broad decisions are
 * appended to match-log.jsonl.
 */

const hardcover = require('./hardcover');
const bookCache = require('./book-cache');
const {
  cleanText,
  normalizeTitle,
  tokensOf,
  tokenJaccard,
  surnameOf,
  normalizeIsbn,
  isbn10to13,
  isbn10Of,
} = require('./normalize');
const {
  ISBN_BATCH_SIZE,
  ISBN_QUERY,
  lookupIsbns,
} = require('./hardcover-editions');
const providers = require('./providers');
const livelibCard = require('./providers/livelib-card');
const litres = require('./providers/litres');

const FUZZY_ACCEPT = 0.9;
const FUZZY_GUARDED = 0.8;
const RATINGS_FLOOR = 50;

const AUTHOR_ALIASES = {
  'джоан роулинг': ['j. k. rowling', 'jk rowling', 'robert galbraith'],
  'joanne rowling': ['j. k. rowling', 'jk rowling'],
  'стивен кинг': ['stephen king', 'richard bachman'],
  'борис акунин': ['boris akunin', 'анатолий брусникин', 'анна борисова'],
  'макс фрай': ['макс фрай', 'светлана мартынчик'],
};

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */
/* cleanText/normalizeTitle/tokenJaccard/surnameOf/ISBN helpers live in
 * ./normalize so providers can reuse them without a require-cycle. */

function authorKeySet(names) {
  const keys = new Set();
  for (const name of names || []) {
    const surname = surnameOf(name);
    if (!surname) continue;
    keys.add(surname);
    const full = cleanText(name).toLowerCase().replace(/ё/g, 'е');
    for (const [canonical, aliases] of Object.entries(AUTHOR_ALIASES)) {
      if (canonical === full || aliases.includes(full) || surnameOf(canonical) === surname) {
        keys.add(surnameOf(canonical));
        for (const alias of aliases) keys.add(surnameOf(alias));
      }
    }
  }
  return keys;
}

function authorsOverlap(llAuthors, hcAuthors) {
  const left = authorKeySet(llAuthors);
  if (left.size === 0) return false;
  for (const key of authorKeySet(hcAuthors)) {
    if (left.has(key)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

const COLLECTION_MARKERS = /сборник|антолог|избранн|полное собрание|собрание сочинений/i;
const ADAPTATION_MARKERS = /иллюстрированн|подарочн|адаптац|краткое содержание|пересказ|сокращ/i;
const POSITION_MARKERS = /(?<![\p{L}])(?:том|часть|книга|кн\.)\s*(\d+)/iu;

function positionOf(title) {
  const match = String(title || '').match(POSITION_MARKERS);
  return match ? Number(match[1]) : null;
}

/**
 * Reject obvious traps: collection/adaptation markers on one side only, and
 * volume markers that contradict the candidate's series position.
 */
function guardReject(llEvent, candidate) {
  const llTitle = String(llEvent.title || '');
  const hcTitle = String(candidate.title || '');
  if (COLLECTION_MARKERS.test(llTitle) && !COLLECTION_MARKERS.test(hcTitle)) {
    return 'collection-marker';
  }
  if (ADAPTATION_MARKERS.test(llTitle) && !ADAPTATION_MARKERS.test(hcTitle)) {
    return 'adaptation-marker';
  }
  const llPosition = positionOf(llTitle);
  const hcPosition =
    Array.isArray(candidate.series) && candidate.series.length
      ? candidate.series.find((entry) => entry && entry.position != null)?.position
      : null;
  if (llPosition != null && hcPosition != null && Number(llPosition) !== Number(hcPosition)) {
    return 'series-position';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Candidate scoring                                                   */
/* ------------------------------------------------------------------ */

function yearDelta(llYear, hcYear) {
  if (!Number.isFinite(Number(llYear)) || !Number.isFinite(Number(hcYear))) return null;
  return Math.abs(Number(llYear) - Number(hcYear));
}

/**
 * Score one livelib event against one hardest-cover work.
 * Returns { score, method, evidence } or null when the pair is rejected.
 */
function scoreCandidate(event, candidate) {
  const titleSim = tokenJaccard(event.title, candidate.title);
  const authorHit = authorsOverlap(event.authors, (candidate.authors || []).map((author) => author.name));
  const eventYear = event.edition && event.edition.year ? Number(event.edition.year) : null;
  const candidateYear = candidate.publicationYear || null;
  const delta = yearDelta(eventYear, candidateYear);
  const ratingsCount = Number.isFinite(Number(candidate.ratingsCount))
    ? Number(candidate.ratingsCount)
    : 0;
  const exactTitle = normalizeTitle(event.title) === normalizeTitle(candidate.title) && normalizeTitle(event.title) !== '';

  const evidence = { titleSim: Number(titleSim.toFixed(3)), authorHit, yearDelta: delta, ratingsCount };

  const guard = guardReject(event, candidate);
  if (guard) return { score: 0, method: 'rejected', evidence: { ...evidence, guard } };

  if (exactTitle && authorHit && delta != null && delta <= 1) {
    return { score: 1, method: 'title-author-year', evidence };
  }
  if (exactTitle && authorHit && delta == null) {
    return { score: 0.95, method: 'title-author', evidence };
  }
  if (titleSim >= FUZZY_ACCEPT && authorHit) {
    return { score: Number((0.9 + titleSim * 0.1).toFixed(3)), method: 'title-author-fuzzy', evidence };
  }
  if (
    titleSim >= FUZZY_GUARDED &&
    authorHit &&
    delta != null &&
    delta <= 1 &&
    ratingsCount >= RATINGS_FLOOR
  ) {
    return { score: Number(titleSim.toFixed(3)), method: 'title-author-fuzzy', evidence };
  }
  return null;
}

/**
 * Pick the single best candidate deterministically.
 * Returns { candidate, score, method, evidence } or null.
 */
function bestCandidate(event, candidates) {
  const scored = [];
  for (const candidate of candidates) {
    const result = scoreCandidate(event, candidate);
    if (result && result.score > 0) {
      scored.push({ candidate, ...result });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const left = Number(a.candidate.hcWorkId) || 0;
    const right = Number(b.candidate.hcWorkId) || 0;
    return left - right;
  });
  const best = scored[0];
  // Two equally good, different works are ambiguous: refuse to guess.
  if (scored.length > 1 && scored[1].score === best.score) {
    return { ambiguous: true, score: best.score, evidence: best.evidence };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Corpus                                                              */
/* ------------------------------------------------------------------ */

function listDetailsFiles() {
  try {
    const fs = require('fs');
    const path = require('path');
    const names = fs.readdirSync(bookCache.DETAILS_DIR).filter((name) => name.endsWith('.json'));
    const works = [];
    for (const name of names) {
      const found = bookCache.readJsonWithFingerprint(path.join(bookCache.DETAILS_DIR, name));
      if (found && found.data && found.data.hcWorkId) works.push(found.data);
    }
    return works;
  } catch (err) {
    return [];
  }
}

/** normalized title -> details[] for the title/author strategies. */
function buildCorpus(works) {
  const byTitle = new Map();
  for (const work of works) {
    const key = normalizeTitle(work.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(work);
  }
  return { works, byTitle };
}

function corpusCandidates(corpus, title) {
  const exact = corpus.byTitle.get(normalizeTitle(title));
  if (exact && exact.length) return exact;
  // Fuzzy: candidate titles that share at least one token. Small corpus
  // (hundreds of works), so a linear scan is cheaper than an index per token.
  return corpus.works.filter((work) => tokenJaccard(title, work.title) >= FUZZY_GUARDED);
}

/* ------------------------------------------------------------------ */
/* Multi-source provider chain                                         */
/* ------------------------------------------------------------------ */

const CHAIN_NAMES = ['hardcover', 'litres', 'googlebooks', 'openlibrary', 'livelib-card'];
const CYRILLIC_TITLE = /[а-яё]/i;

function createChainReport(providerList) {
  const report = {};
  for (const provider of providerList) {
    report[provider.NAME] = {
      name: provider.NAME,
      calls: 0,
      hits: 0,
      errors: 0,
      skipped: 0,
      methods: {},
      lastError: null,
    };
  }
  return report;
}

function isbnOfEvent(event) {
  return normalizeIsbn(event && event.edition && event.edition.isbn);
}

function chainInput(event, extra) {
  const isbn = isbnOfEvent(event);
  return {
    isbn13: isbn,
    isbn10: isbn ? isbn10Of(isbn) : null,
    title: (event && event.title) || null,
    authors: Array.isArray(event && event.authors) ? event.authors : [],
    year:
      event && event.edition && Number.isFinite(Number(event.edition.year))
        ? Number(event.edition.year)
        : null,
    llBookId: event && event.sourceBookId ? String(event.sourceBookId) : null,
    coverUrl: (event && event.coverUrl) || null,
    ...(extra || {}),
  };
}

function providerOptionsFor(options, provider) {
  return {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    negativeMemo:
      options.negativeMemo && options.negativeMemo[provider.NAME]
        ? options.negativeMemo[provider.NAME]
        : null,
    lookupIsbns: options.lookupIsbns,
    budget: provider.NAME === 'litres' ? options.litresBudget : options.cardBudget,
    cardPauseMs: options.cardPauseMs,
    requestDelayMs: options.requestDelayMs,
    onProgress: options.onProgress,
  };
}

async function tryProvider(provider, input, options, chain) {
  if (!provider) return null;
  const stat = chain[provider.NAME];
  if (!stat) return null;
  if (typeof provider.isBreakerOpen === 'function' && provider.isBreakerOpen()) {
    stat.skipped++;
    return null;
  }
  stat.calls++;
  try {
    const result = await provider.getWork(input, providerOptionsFor(options, provider));
    if (result) {
      stat.hits++;
      const method = (result.match && result.match.method) || 'unknown';
      stat.methods[method] = (stat.methods[method] || 0) + 1;
    } else if (typeof provider.isBreakerOpen === 'function' && provider.isBreakerOpen()) {
      stat.skipped++;
    }
    return result;
  } catch (err) {
    stat.errors++;
    stat.lastError = (err && err.code) || 'provider_error';
    if (typeof provider.noteError === 'function') provider.noteError(err);
    return null;
  }
}

function linkMethodFor(result) {
  if (result.source === 'hardcover') return 'isbn';
  const method = result.match && result.match.method;
  if (method === 'title') return `${result.source}-title`;
  return `${result.source}-isbn`;
}

function countResolution(report, result) {
  if (result.source === 'googlebooks') report.resolvedGoogle++;
  else if (result.source === 'openlibrary') report.resolvedOpenLibrary++;
  else if (result.source === 'hardcover') report.resolvedHardcoverCard++;
  else if (result.source === 'litres') report.resolvedLitres++;
}

async function saveProviderWork(merged, now) {
  const details = providers.resultToDetails(merged, { now });
  if (!details) return null;
  const workId = merged.workId || `${merged.source}:${merged.sourceId}`;
  await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), details);
  return { workId, details };
}

function makeLink(bookId, merged, now) {
  const workId = merged.workId || `${merged.source}:${merged.sourceId}`;
  return {
    schemaVersion: 2,
    livelibBookId: bookId,
    workId,
    method: linkMethodFor(merged),
    score: Number(merged.confidence) || 0.5,
    evidence: {
      provider: merged.source,
      sourceId: merged.sourceId == null ? null : String(merged.sourceId),
      isbn: merged.isbn13 || merged.isbn10 || null,
      match: merged.match || null,
    },
    resolvedAt: now,
  };
}

async function saveCardMetadata(event, card, now) {
  const bookId = String(event.sourceBookId);
  const doc = providers.resultToDetails(
    {
      ...card,
      workId: `ll:${bookId}`,
      metadataSources: ['livelib-card'],
      sources: [
        {
          source: 'livelib-card',
          sourceId: bookId,
          url: (card.links && card.links.pageUrl) || null,
          confidence: 1,
        },
      ],
    },
    { now }
  );
  await bookCache.saveDetails(bookCache.detailsKeyForWork(`ll:${bookId}`), doc);
  return doc;
}

/* ------------------------------------------------------------------ */
/* Resolve job                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve all livelib events of one profile.
 *
 * Returns a report:
 *   { total, cached, resolvedIsbn, resolvedTitle, resolvedGoogle,
 *     resolvedOpenLibrary, resolvedLitres, resolvedLivelibCard,
 *     resolvedHardcoverCard, resolvedHardcoverFromLitres, enriched,
 *     withMetadata, ambiguous, unmatched, requests, corpusSize,
 *     resolvedWorkIds, providerChain, cardBudget, litresBudget }
 */
async function resolveProfile(llProfile, options = {}) {
  const force = Boolean(options.force);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const events = Array.isArray(llProfile && llProfile.events) ? llProfile.events : [];
  const now = options.now || new Date().toISOString();
  const cardBudget = options.cardBudget || livelibCard.budgetFromEnv();
  const litresBudget = options.litresBudget || litres.budgetFromEnv();
  const negativeMemo = options.negativeMemo || {
    googlebooks: new Map(),
    openlibrary: new Map(),
    litres: new Map(),
  };
  const lookupFn = options.lookupIsbns || lookupIsbns;

  const report = {
    total: events.length,
    cached: 0,
    resolvedIsbn: 0,
    resolvedTitle: 0,
    resolvedGoogle: 0,
    resolvedOpenLibrary: 0,
    resolvedLitres: 0,
    resolvedLivelibCard: 0,
    resolvedHardcoverCard: 0,
    resolvedHardcoverFromLitres: 0,
    enriched: 0,
    withMetadata: 0,
    ambiguous: 0,
    unmatched: 0,
    requests: 0,
    corpusSize: 0,
    resolvedWorkIds: 0,
    methods: {},
    providerChain: {},
    cardBudget: { limit: cardBudget.limit, used: 0, remaining: cardBudget.limit },
    litresBudget: { limit: litresBudget.limit, used: 0, remaining: litresBudget.limit },
  };

  // 1. Existing positive links.
  const links = new Map(); // bookId -> link doc
  const pending = [];
  for (const event of events) {
    const bookId = event && event.sourceBookId ? String(event.sourceBookId) : null;
    if (!bookId) continue;
    if (!force) {
      const cached = bookCache.getLink(bookId);
      if (cached && cached.workId) {
        links.set(bookId, cached);
        report.cached++;
        continue;
      }
    }
    pending.push(event);
  }

  // Works known from previous imports (journal metadata on disk).
  const works = new Map();
  for (const details of listDetailsFiles()) {
    works.set(String(details.hcWorkId), details);
  }

  // 2. ISBN bulk lookup (only events that have an ISBN and no cached link).
  const isbnToBookIds = new Map();
  for (const event of pending) {
    const isbn = isbnOfEvent(event);
    if (!isbn) continue;
    if (!isbnToBookIds.has(isbn)) isbnToBookIds.set(isbn, new Set());
    isbnToBookIds.get(isbn).add(String(event.sourceBookId));
  }

  if (isbnToBookIds.size > 0) {
    const lookup = await lookupFn([...isbnToBookIds.keys()], { onProgress });
    report.requests += lookup.requests;
    for (const [isbn, entry] of lookup.byIsbn) {
      const workId = `hc:${entry.details.hcWorkId}`;
      works.set(String(entry.details.hcWorkId), entry.details);
      for (const bookId of isbnToBookIds.get(isbn) || []) {
        if (links.has(bookId)) continue;
        const link = {
          schemaVersion: 1,
          livelibBookId: bookId,
          workId,
          method: 'isbn',
          score: 1,
          evidence: { isbn },
          resolvedAt: now,
        };
        links.set(bookId, link);
        report.resolvedIsbn++;
      }
    }
    // Persist freshly discovered works once.
    for (const details of lookup.works.values()) {
      await bookCache.saveDetails(details.hcWorkId, details);
    }
  }

  // 3. Strict/fuzzy title + author over the local corpus.
  const corpus = buildCorpus([...works.values()]);
  report.corpusSize = corpus.works.length;

  for (const event of pending) {
    const bookId = String(event.sourceBookId);
    if (links.has(bookId)) continue;
    const candidates = corpusCandidates(corpus, event.title);
    if (candidates.length === 0) continue;
    const best = bestCandidate(event, candidates);
    if (!best) continue;
    if (best.ambiguous) {
      report.ambiguous++;
      bookCache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        decision: 'ambiguous',
        score: best.score,
        evidence: best.evidence,
        candidates: candidates.slice(0, 5).map((work) => work.hcWorkId),
      });
      continue;
    }
    const workId = `hc:${best.candidate.hcWorkId}`;
    const link = {
      schemaVersion: 1,
      livelibBookId: bookId,
      workId,
      method: best.method,
      score: best.score,
      evidence: best.evidence,
      resolvedAt: now,
    };
    links.set(bookId, link);
    report.resolvedTitle++;
    if (best.method !== 'title-author-year') {
      bookCache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        candidateId: best.candidate.hcWorkId,
        score: best.score,
        titleSim: best.evidence.titleSim,
        authorHit: best.evidence.authorHit,
        yearDelta: best.evidence.yearDelta,
        ratingsCount: best.evidence.ratingsCount,
        decision: 'match',
      });
    }
  }

  // 4. Provider chain for everything still unresolved.
  const providerList = providers.selectProviders(options.providers);
  const chain = createChainReport(providerList);
  const chainByName = new Map(providerList.map((provider) => [provider.NAME, provider]));
  const chainOptions = { ...options, cardBudget, litresBudget, negativeMemo };
  const cardProvider = chainByName.get('livelib-card');
  const litresProvider = chainByName.get('litres');
  const googleProvider = chainByName.get('googlebooks');
  const openLibraryProvider = chainByName.get('openlibrary');
  const hardcoverProvider = require('./providers/hardcover');
  let remaining = pending.filter((event) => !links.has(String(event.sourceBookId)));

  // 4. Litres first for Cyrillic titles: Hardcover does not know RU editions,
  // but the litres card returns an ISBN that can still close a Hardcover work.
  if (litresProvider) {
    const ruEvents = remaining.filter((event) => CYRILLIC_TITLE.test(String(event.title || '')));
    const litresByBook = new Map();
    for (const event of ruEvents) {
      const bookId = String(event.sourceBookId);
      const result = await tryProvider(litresProvider, chainInput(event), chainOptions, chain);
      if (result) litresByBook.set(bookId, result);
    }

    const litresIsbns = new Set();
    for (const result of litresByBook.values()) {
      const isbn = normalizeIsbn(result.isbn13) || normalizeIsbn(result.isbn10);
      if (isbn) litresIsbns.add(isbn);
    }
    const hardcoverByLitresIsbn = new Map();
    if (litresIsbns.size > 0 && chainByName.has('hardcover')) {
      const lookup = await lookupFn([...litresIsbns], { onProgress });
      report.requests += lookup.requests;
      for (const [isbn, entry] of lookup.byIsbn) hardcoverByLitresIsbn.set(isbn, entry);
      for (const details of lookup.works.values()) {
        await bookCache.saveDetails(details.hcWorkId, details);
      }
    }

    for (const event of ruEvents) {
      const bookId = String(event.sourceBookId);
      if (links.has(bookId)) continue;
      const litresResult = litresByBook.get(bookId);
      if (!litresResult) continue;
      const isbn =
        normalizeIsbn(litresResult.isbn13) || normalizeIsbn(litresResult.isbn10);

      // ISBN feedback: the paper ISBN from litres may exist in Hardcover even
      // when the LiveLib ISBN did not.
      if (isbn && hardcoverByLitresIsbn.has(isbn)) {
        const entry = hardcoverByLitresIsbn.get(isbn);
        const hcResult = hardcoverProvider.normalizeDetails(entry.details, entry.editionId);
        if (hcResult) {
          const merged = providers.mergeResults(hcResult, [litresResult]);
          const saved = await saveProviderWork(merged, now);
          if (saved) {
            links.set(bookId, makeLink(bookId, merged, now));
            report.resolvedHardcoverFromLitres++;
            continue;
          }
        }
      }

      // Litres is the RU canonical card; GB/OL may only fill missing fields.
      const extraInput = isbn
        ? chainInput(event, { isbn13: isbn, isbn10: isbn10Of(isbn) })
        : chainInput(event);
      let extra = await tryProvider(googleProvider, extraInput, chainOptions, chain);
      if (!extra) extra = await tryProvider(openLibraryProvider, extraInput, chainOptions, chain);
      const merged = providers.mergeResults(litresResult, extra ? [extra] : []);
      const saved = await saveProviderWork(merged, now);
      if (saved) {
        links.set(bookId, makeLink(bookId, merged, now));
        report.resolvedLitres++;
      }
    }
  }

  remaining = pending.filter((event) => !links.has(String(event.sourceBookId)));
  const withIsbn = [];
  const withoutIsbn = [];
  for (const event of remaining) {
    if (isbnOfEvent(event)) withIsbn.push(event);
    else withoutIsbn.push(event);
  }

  // 4a. No ISBN: the LiveLib card supplies the ISBN + RU metadata. The card is
  // budgeted (default 300/run) and pauses 2 s between requests.
  const cardByBook = new Map();
  if (cardProvider) {
    for (const event of withoutIsbn) {
      const bookId = String(event.sourceBookId);
      // Positive card metadata is persisted at ll:{bookId}; never re-fetch it.
      if (!force && bookCache.getWorkDetails(`ll:${bookId}`)) continue;
      const card = await tryProvider(cardProvider, chainInput(event), chainOptions, chain);
      if (card) cardByBook.set(bookId, card);
    }
  }

  // 4b. Card-derived ISBNs -> one batched Hardcover lookup.
  const cardIsbns = new Set();
  for (const card of cardByBook.values()) {
    const isbn = normalizeIsbn(card.isbn13) || normalizeIsbn(card.isbn10);
    if (isbn) cardIsbns.add(isbn);
  }
  const hardcoverByIsbn = new Map();
  if (cardIsbns.size > 0 && chainByName.has('hardcover')) {
    const lookup = await lookupFn([...cardIsbns], { onProgress });
    report.requests += lookup.requests;
    for (const [isbn, entry] of lookup.byIsbn) hardcoverByIsbn.set(isbn, entry);
    for (const details of lookup.works.values()) {
      await bookCache.saveDetails(details.hcWorkId, details);
    }
  }

  for (const event of withoutIsbn) {
    const bookId = String(event.sourceBookId);
    if (links.has(bookId)) continue;
    if (!force && bookCache.getWorkDetails(`ll:${bookId}`)) {
      report.enriched++;
      report.resolvedLivelibCard++;
      continue;
    }
    const card = cardByBook.get(bookId) || null;
    const isbn = card ? normalizeIsbn(card.isbn13) || normalizeIsbn(card.isbn10) : null;

    if (isbn && hardcoverByIsbn.has(isbn)) {
      const entry = hardcoverByIsbn.get(isbn);
      const hcResult = hardcoverProvider.normalizeDetails(entry.details, entry.editionId);
      if (hcResult) {
        const merged = providers.mergeResults(hcResult, card ? [card] : []);
        const saved = await saveProviderWork(merged, now);
        if (saved) {
          links.set(bookId, makeLink(bookId, merged, now));
          report.resolvedHardcoverCard++;
          continue;
        }
      }
    }

    let result = null;
    if (isbn) {
      const isbnInput = chainInput(event, { isbn13: isbn, isbn10: isbn10Of(isbn) });
      result = await tryProvider(googleProvider, isbnInput, chainOptions, chain);
      if (!result) result = await tryProvider(openLibraryProvider, isbnInput, chainOptions, chain);
    }
    if (!result) {
      result = await tryProvider(googleProvider, chainInput(event), chainOptions, chain);
      if (!result) result = await tryProvider(openLibraryProvider, chainInput(event), chainOptions, chain);
    }
    if (result) {
      const merged = providers.mergeResults(result, card ? [card] : []);
      const saved = await saveProviderWork(merged, now);
      if (saved) {
        links.set(bookId, makeLink(bookId, merged, now));
        countResolution(report, merged);
        continue;
      }
    }

    if (card) {
      await saveCardMetadata(event, card, now);
      report.enriched++;
      report.resolvedLivelibCard++;
      continue;
    }

    // No chain hit: leave the event unresolved (negatives are not persisted).
    if (isbn && isbnToBookIds.size > 0) {
      bookCache.appendMatchLog({
        ts: now,
        source: 'livelib',
        livelibBookId: bookId,
        query: event.title,
        decision: 'provider-miss',
        evidence: { isbn, providers: chainNamesOf(providerList) },
      });
    }
  }

  // 4c. Events with an ISBN: Google Books -> Open Library -> LiveLib card.
  for (const event of withIsbn) {
    const bookId = String(event.sourceBookId);
    if (links.has(bookId)) continue;
    if (!force && bookCache.getWorkDetails(`ll:${bookId}`)) {
      report.enriched++;
      report.resolvedLivelibCard++;
      continue;
    }
    const isbnInput = chainInput(event);
    let result = await tryProvider(googleProvider, isbnInput, chainOptions, chain);
    if (!result) result = await tryProvider(openLibraryProvider, isbnInput, chainOptions, chain);
    if (result) {
      const merged = providers.mergeResults(result, []);
      const saved = await saveProviderWork(merged, now);
      if (saved) {
        links.set(bookId, makeLink(bookId, merged, now));
        countResolution(report, merged);
        continue;
      }
    }
    if (cardProvider) {
      const card = await tryProvider(cardProvider, chainInput(event), chainOptions, chain);
      if (card) {
        await saveCardMetadata(event, card, now);
        report.enriched++;
        report.resolvedLivelibCard++;
        continue;
      }
    }
  }

  report.providerChain = chain;
  report.cardBudget = {
    limit: cardBudget.limit,
    used: cardBudget.used,
    remaining: cardBudget.remaining,
  };
  report.litresBudget = {
    limit: litresBudget.limit,
    used: litresBudget.used,
    remaining: litresBudget.remaining,
  };

  // 5. Persist links + index + links.json.
  for (const [bookId, link] of links) {
    const previous = bookCache.getLink(bookId);
    if (previous && previous.workId === link.workId && !force) {
      // Still record the method of an already-cached link for the report.
      report.methods[link.method] = (report.methods[link.method] || 0) + 1;
      continue;
    }
    await bookCache.saveLink(bookId, link);
    const hcNumeric = /^hc:(\d+)$/.exec(String(link.workId || ''));
    if (hcNumeric) {
      bookCache.setIndexValue(`ll:${bookId}`, Number(hcNumeric[1]));
      if (link.method === 'isbn' && link.evidence && link.evidence.isbn) {
        bookCache.setIndexValue(`isbn:${link.evidence.isbn}`, Number(hcNumeric[1]));
      }
    } else if (link.workId) {
      bookCache.setIndexValue(`ll:${bookId}`, link.workId);
    } else {
      bookCache.setIndexValue(`ll:${bookId}`, false);
    }
    bookCache.setWorkLink(link.workId, { livelib: [bookId] });
    report.methods[link.method] = (report.methods[link.method] || 0) + 1;
  }
  bookCache.flushIndex();
  bookCache.flushLinks();

  report.resolvedWorkIds = new Set(
    [...links.values()].filter((link) => link.workId).map((link) => link.workId)
  ).size;
  report.resolved =
    report.cached + report.resolvedIsbn + report.resolvedTitle +
    report.resolvedGoogle + report.resolvedOpenLibrary + report.resolvedLitres +
    report.resolvedHardcoverCard + report.resolvedHardcoverFromLitres;
  report.withMetadata = report.resolved + report.enriched;
  report.unmatched = pending.filter((event) => {
    const bookId = String(event.sourceBookId);
    return !links.has(bookId) && !bookCache.getWorkDetails(`ll:${bookId}`);
  }).length;

  if (onProgress) {
    onProgress({ stage: 'resolve', resolved: report.withMetadata, total: report.total });
  }
  const providerSummary = Object.values(chain)
    .map((stat) => `${stat.name}=${stat.hits}/${stat.calls}${stat.errors ? `e${stat.errors}` : ''}`)
    .join(' ');
  console.log(
    `[resolve] ${report.withMetadata}/${report.total} livelib event(s) with metadata ` +
      `(cached=${report.cached}, isbn=${report.resolvedIsbn}, title=${report.resolvedTitle}, ` +
      `google=${report.resolvedGoogle}, openlibrary=${report.resolvedOpenLibrary}, ` +
      `litres=${report.resolvedLitres}, litres-hc=${report.resolvedHardcoverFromLitres}, ` +
      `card=${report.resolvedLivelibCard}, hc-card=${report.resolvedHardcoverCard}, ` +
      `ambiguous=${report.ambiguous}, unmatched=${report.unmatched}, requests=${report.requests}) ` +
      `[${providerSummary}] card-budget=${cardBudget.used}/${cardBudget.limit} ` +
      `litres-budget=${litresBudget.used}/${litresBudget.limit}`
  );
  return report;
}

function chainNamesOf(providerList) {
  return providerList.map((provider) => provider.NAME);
}

module.exports = {
  AUTHOR_ALIASES,
  ISBN_BATCH_SIZE,
  ISBN_QUERY,
  CHAIN_NAMES,
  CYRILLIC_TITLE,
  providers,
  createChainReport,
  createCardBudget: livelibCard.createBudget,
  createLitresBudget: litres.createBudget,
  normalizeTitle,
  tokensOf,
  tokenJaccard,
  surnameOf,
  authorKeySet,
  authorsOverlap,
  normalizeIsbn,
  isbn10to13,
  isbn10Of,
  positionOf,
  guardReject,
  scoreCandidate,
  bestCandidate,
  buildCorpus,
  lookupIsbns,
  resolveProfile,
  listDetailsFiles,
};
