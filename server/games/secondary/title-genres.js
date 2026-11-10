'use strict';

const { parseWbDate, pickDate } = require('../franchise');

const gameCache = require('../game-cache');
const { sanitizeEpicGenres } = require('./normalize');
const { normalizeSlug, titleVariants, collectSlugs } = require('./identity');
const { escapeLiteral, sparqlRequest, chunk, BATCH_SIZE, fetchSecondaryLinks } = require('./bridge');
const { readCache, writeCache, isSettledTitleEntry, ttlMs } = require('./cache');

/**
 * The title fallback query. It is deliberately exact-literal: the title (and
 * its bounded Roman/Arabic variants) is a `VALUES` constant on both
 * `rdfs:label` and `skos:altLabel`, restricted to video-game items
 * (`P31/P279* Q7889`). It is used **only** for Epic works whose store/catalog
 * metadata has no date — or, since 03.11.2026, no genre line either (a stale
 * CMS page such as Alan Wake 2's). `wdt:P136` (genre) is `OPTIONAL` and only
 * labels the QID the title already resolved: it never creates an identity and
 * never turns an ambiguous title into a link.
 */
function buildTitleQuery(titles) {
  const values = new Set();
  for (const title of Array.isArray(titles) ? titles : []) {
    for (const variant of titleVariants(title)) {
      const literal = escapeLiteral(variant);
      for (const lang of ['en', 'ru', 'mul']) values.add(`"${literal}"@${lang}`);
    }
  }
  if (!values.size) return null;
  return `SELECT ?item ?matched ?appid ?date ?precision ?genreLabel WHERE {
  VALUES ?matched { ${[...values].join(' ')} }
  { ?item rdfs:label ?matched } UNION { ?item skos:altLabel ?matched }
  ?item wdt:P31/wdt:P279* wd:Q7889 .
  OPTIONAL { ?item wdt:P1733 ?appid . }
  OPTIONAL {
    ?item p:P577 ?st .
    ?st psv:P577 ?val .
    ?val wikibase:timeValue ?date .
    ?val wikibase:timePrecision ?precision .
  }
  OPTIONAL {
    ?item wdt:P136 ?genre .
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ru". }
  }
}`;
}

/**
 * Wikidata P136 labels are lowercase («survival horror», «third-person
 * shooter», «role-playing video game»), while the genre wall draws store
 * genres capitalized («Horror», «Turn-Based»). Only the generic «video game»
 * suffix is dropped and the first letter is capitalized: no renaming, no
 * invented umbrella genre.
 */
function wikidataGenreName(label) {
  let text = String(label == null ? '' : label).trim();
  if (!text) return null;
  // The generic class itself is not a genre chip.
  if (/^(?:video\s+)?games?$/i.test(text)) return null;
  text = text.replace(/\s+video\s+games?$/i, '').replace(/\s+games?$/i, '').trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One entry per candidate (`epic:<normalised slug>`), but only when the exact
 * title matched **exactly one** Wikidata item. Several different QIDs for the
 * same label are the «Prey (2006) vs Prey (2017)» case: no link, recorded as
 * `titleMatched: 'ambiguous'` so the pass does not ask again while the cache is
 * fresh. A plain miss is stored the same way (`'miss'`) — in the **title map**,
 * never in `entries`, so it cannot suppress a later `P6278` match.
 */
function parseTitleResponse(data, candidates) {
  const bindings =
    data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  const byLabel = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const variant of titleVariants(candidate.title)) {
      if (!byLabel.has(variant)) byLabel.set(variant, []);
      byLabel.get(variant).push(candidate);
    }
  }
  const acc = new Map();
  for (const row of bindings) {
    const item = row && row.item && row.item.value ? String(row.item.value) : null;
    const qid = item ? item.slice(item.lastIndexOf('/') + 1) : null;
    const matched = row && row.matched && row.matched.value ? String(row.matched.value) : null;
    if (!qid || !matched || !byLabel.has(matched)) continue;
    for (const candidate of byLabel.get(matched)) {
      const key = `${candidate.store}:${normalizeSlug(candidate.slug)}`;
      let entry = acc.get(key);
      if (!entry) {
        entry = {
          candidate,
          qids: new Set(),
          appid: null,
          dates: [],
          genres: [],
          matchedLabel: matched,
        };
        acc.set(key, entry);
      }
      entry.qids.add(qid);
      const appid = row.appid && row.appid.value ? String(row.appid.value) : null;
      if (appid && !entry.appid) entry.appid = appid;
      const genre = wikidataGenreName(row.genreLabel && row.genreLabel.value);
      if (genre && !entry.genres.includes(genre)) entry.genres.push(genre);
      if (row.date && row.date.value) {
        const date = parseWbDate(row.date.value, row.precision && row.precision.value);
        if (
          date &&
          !entry.dates.some((known) => known.iso === date.iso && known.precision === date.precision)
        ) {
          entry.dates.push(date);
        }
      }
    }
  }
  const entries = {};
  for (const [key, entry] of acc) {
    const ambiguous = entry.qids.size !== 1;
    const qid = ambiguous ? null : [...entry.qids][0];
    const date = qid ? pickDate(entry.dates) : null;
    entries[key] = {
      qid,
      appid: qid ? entry.appid : null,
      store: entry.candidate.store,
      slug: entry.candidate.slug,
      title: entry.candidate.title,
      matchedLabel: entry.matchedLabel,
      matchedBy: 'title',
      confidence: qid ? 'medium' : 'none',
      titleMatched: ambiguous ? 'ambiguous' : qid ? 'unique' : 'miss',
      releaseYear: date ? date.year : null,
      releasePrecision: date ? date.precision : null,
      releaseDate: date && date.precision === 'day' ? date.iso : null,
      releaseDateSource: date ? 'wikidata' : null,
      // P136 labels are a **metadata** answer of the resolved QID, never an
      // identity: they live in this map only (the P6278 entry stays untouched).
      genres: qid ? sanitizeEpicGenres(entry.genres) : [],
    };
  }
  return entries;
}

/**
 * Candidate list for the title pass: only an Epic work with a slug and a title
 * whose store/catalog/known year is still empty — or, when the caller already
 * knows the genre axis (`genres` property present, even empty), whose genre
 * line is empty too (the «Public» bucket case: the stale cached document is
 * sanitized to `[]` on read and the real P136 genres are asked for once).
 * `releaseYear`/`releaseDate`/`genres` are optional hints the caller already
 * knows. A card without a `genres` key is judged by the year axis only, so the
 * Epic import (which has no detail documents at hand) does not grow the pass.
 */
function collectTitleCandidates(epicGames) {
  const out = [];
  const seen = new Set();
  for (const game of Array.isArray(epicGames) ? epicGames : []) {
    if (!game) continue;
    const slug = String(game.slug == null ? '' : game.slug).trim();
    const title = String(game.title == null ? '' : game.title).trim();
    if (!slug || !title) continue;
    const hasYear = game.releaseYear != null || game.releaseDate;
    const knowsGenres = Object.prototype.hasOwnProperty.call(game, 'genres');
    const hasGenres = Array.isArray(game.genres) && game.genres.length > 0;
    if (hasYear && (!knowsGenres || hasGenres)) continue;
    const key = normalizeSlug(slug);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ store: 'epic', slug, title });
  }
  return out;
}

/**
 * Resolve Epic titles to Wikidata items when the store slug has no `P6278`
 * identity (or no date). The answer goes to `titleEntries`; a miss/ambiguity
 * is cached there with `qid: null` so it is not re-asked while fresh.
 */
async function fetchSecondaryTitleLinks(input = {}, options = {}) {
  const candidates = collectTitleCandidates(
    input.epicGames || input.titles || []
  );
  const cached = readCache();
  const cachedTitleEntries =
    cached && cached.titleEntries && typeof cached.titleEntries === 'object'
      ? cached.titleEntries
      : {};
  const fresh = cached && gameCache.isFresh(cached, options.ttlMs || ttlMs());
  const covered = (candidate) =>
    isSettledTitleEntry(cachedTitleEntries[`${candidate.store}:${normalizeSlug(candidate.slug)}`]);
  const pending = fresh && options.force !== true
    ? candidates.filter((candidate) => !covered(candidate))
    : candidates;
  const result = {
    titleEntries: { ...cachedTitleEntries },
    queries: 0,
    resolved: 0,
    ambiguous: 0,
    cached: candidates.length - pending.length,
    skipped: null,
    errors: [],
  };
  if (!pending.length) return result;

  for (const batch of chunk(pending, BATCH_SIZE)) {
    const query = buildTitleQuery(batch.map((candidate) => candidate.title));
    if (!query) continue;
    result.queries++;
    let response;
    try {
      response = await sparqlRequest(query, options);
    } catch (err) {
      result.errors.push(`wd_network:${(err && err.code) || 'failed'}`);
      result.skipped = 'network';
      continue;
    }
    if (!response || !response.ok) {
      const status = response ? Number(response.status) || 0 : 0;
      result.errors.push(`wd_${status || 'http'}`);
      result.skipped = status === 429 ? 'rate_limited' : 'http';
      continue;
    }
    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      result.errors.push('wd_parse');
      result.skipped = 'parse';
      continue;
    }
    const parsed = parseTitleResponse(data, batch);
    for (const candidate of batch) {
      const key = `${candidate.store}:${normalizeSlug(candidate.slug)}`;
      if (parsed[key]) {
        result.titleEntries[key] = parsed[key];
        if (parsed[key].qid) result.resolved++;
        else if (parsed[key].titleMatched === 'ambiguous') result.ambiguous++;
      } else {
        result.titleEntries[key] = {
          qid: null,
          appid: null,
          store: candidate.store,
          slug: candidate.slug,
          title: candidate.title,
          matchedBy: 'title',
          confidence: 'none',
          titleMatched: 'miss',
          releaseYear: null,
          releasePrecision: null,
          releaseDate: null,
          releaseDateSource: null,
          genres: [],
        };
      }
    }
  }

  if (!result.skipped || result.resolved > 0) {
    writeCache(
      cached && cached.entries && typeof cached.entries === 'object' ? cached.entries : {},
      {
        titleEntries: result.titleEntries,
        stats: {
          ...((cached && cached.stats) || {}),
          epicTitles: candidates.length,
          titleQueries: result.queries,
          titleMatched: result.resolved,
        },
      }
    );
  }
  return result;
}

/**
 * Job-side wrapper: refresh the bridge for the slugs of one import.
 *
 * Runs **only for a real import** (`options.client` absent): a job driven by an
 * injected client is hermetic (tests, diagnostics) and must not touch WDQS.
 * Never throws — the import's own result is what the user asked for; the bridge
 * is an enhancement and a WD outage is reported as `skipped`.
 */
async function refreshForJob({ gogProducts = [], epicGames = [], options = {} } = {}) {
  if (options.client) return { skipped: 'injected_client' };
  if (options.wikidata === false || options.secondaryLinks === false) {
    return { skipped: 'disabled' };
  }
  if (String(process.env.KINOBOXD_GAMES_WD || '').trim().toLowerCase() === 'off') {
    return { skipped: 'disabled' };
  }
  const { gogSlugs, epicSlugs } = collectSlugs({ gogProducts, epicGames });
  const titleCandidates = collectTitleCandidates(epicGames);
  if (!gogSlugs.length && !epicSlugs.length && !titleCandidates.length) {
    return { skipped: 'no_slugs' };
  }
  const common = {
    fetchImpl: options.fetchImpl,
    endpoint: options.wdqsEndpoint,
    force: options.force === true,
  };
  try {
    let report = { queries: 0, resolved: 0, cached: 0, skipped: null, errors: [] };
    if (gogSlugs.length || epicSlugs.length) {
      report = await fetchSecondaryLinks({ gogSlugs, epicSlugs }, common);
    }
    // Separate pass: a title is not a P6278 identity, so it can only fill a
    // year that the slug pass left empty (the Alan Wake 2 case).
    let titleReport = { queries: 0, resolved: 0, ambiguous: 0, skipped: null, errors: [] };
    if (titleCandidates.length && !report.skipped) {
      titleReport = await fetchSecondaryTitleLinks({ epicGames }, common);
    }
    return {
      gogSlugs: gogSlugs.length,
      epicSlugs: epicSlugs.length,
      epicTitles: titleCandidates.length,
      queries: report.queries + titleReport.queries,
      titleQueries: titleReport.queries,
      resolved: report.resolved + titleReport.resolved,
      titleResolved: titleReport.resolved,
      titleAmbiguous: titleReport.ambiguous,
      cached: report.cached,
      skipped: titleReport.skipped || report.skipped || null,
      errors: [...report.errors, ...titleReport.errors].slice(0, 5),
    };
  } catch (err) {
    return { skipped: 'error', errors: [String((err && err.code) || 'failed')] };
  }
}

module.exports = {
  buildTitleQuery,
  wikidataGenreName,
  parseTitleResponse,
  collectTitleCandidates,
  fetchSecondaryTitleLinks,
  refreshForJob,
};
