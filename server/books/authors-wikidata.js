'use strict';

/**
 * Wikidata bridge for author names the transliteration rule cannot connect
 * (Кристи → Christie, Моэм → Maugham, Лавкрафт → Lovecraft …).
 *
 * This module is the *transport*: it knows how to ask WDQS and how to merge two
 * spellings that share a QID. The *policy* (when to ask, which names are still
 * unresolved, cooldown, persistence) lives in `authors-bridge.js`, which runs
 * automatically after a stats build and only pays for names the offline rule
 * could not connect. `/api/books/stats` never waits for WDQS: the bridge is
 * fire-and-forget and its result lands in `cache-book/authors.json`, so the
 * next payload applies it.
 *
 * Politeness: batches of ≤450 values, one query per batch, `sleep` between
 * requests, respect `429`/`Retry-After` by giving up (a missed merge is cheap;
 * hammering WDQS is not). Tests inject `fetchImpl` and never touch the network.
 */

const { normalizeAuthorName, hasCyrillic, hasLatin, groupAuthors } = require('./authors');

const WDQS = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 450;
const DEFAULT_PAUSE_MS = 1100;
const USER_AGENT = 'kinoboxd/1.0 (books author alias backfill)';

function sparql(query, options = {}) {
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return Promise.reject(new Error('fetch is not available'));
  // POST, not GET: a batch of 450 labels does not fit an URL (WDQS answers
  // `414 URI Too Long` around ~8 KB). The endpoint accepts a form-encoded
  // `query=` body for exactly this case.
  return fetchImpl(options.endpoint || process.env.KINOBOXD_WDQS_ENDPOINT || WDQS, {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
  });
}

function valuesClause(names) {
  // A Cyrillic spelling lives on the RU label; a Latin one usually lives on the
  // EN label, so asking `@ru` for «Maugham» would only waste the row budget.
  return names
    .map((name) => {
      const clean = String(name).replace(/["\\]/g, '');
      return `"${clean}"@${hasCyrillic(name) ? 'ru' : 'en'}`;
    })
    .join(' ');
}

function itemValues(qids) {
  return qids.map((qid) => `wd:${qid}`).join(' ');
}

function wikidataError(response, stage) {
  const status = response && response.status;
  const retry = response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  const error = new Error(`wikidata_${status}`);
  error.status = status;
  error.retryAfter = retry;
  if (stage) error.stage = stage;
  return error;
}

async function fetchNameQids(names, options = {}) {
  const out = new Map();
  if (!names.length) return out;
  const query = `SELECT ?item ?label WHERE {
  VALUES ?label { ${valuesClause(names)} }
  ?item rdfs:label ?label .
  ?item wdt:P31 wd:Q5 .
}`;
  const response = await sparql(query, options);
  if (!response.ok) throw wikidataError(response, 'names');
  const data = await response.json();
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  for (const row of rows) {
    const qid = row.item && String(row.item.value).split('/').pop();
    const label = row.label && row.label.value;
    if (!qid || !label) continue;
    const key = normalizeAuthorName(label);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(qid);
  }
  return out;
}

/** All RU/EN labels and aliases of the candidate items. */
async function fetchItemNames(qids, options = {}) {
  const out = new Map();
  if (!qids.length) return out;
  const query = `SELECT ?item ?name WHERE {
  VALUES ?item { ${itemValues(qids)} }
  { ?item rdfs:label ?name } UNION { ?item skos:altLabel ?name }
  FILTER(LANG(?name) IN ("ru", "en", "mul"))
}`;
  const response = await sparql(query, options);
  if (!response.ok) throw wikidataError(response, 'items');
  const data = await response.json();
  const rows = data && data.results && Array.isArray(data.results.bindings) ? data.results.bindings : [];
  for (const row of rows) {
    const qid = row.item && String(row.item.value).split('/').pop();
    const name = row.name && row.name.value;
    if (!qid || !name) continue;
    if (!out.has(qid)) out.set(qid, new Set());
    out.get(qid).add(normalizeAuthorName(name));
  }
  return out;
}

/**
 * Merge author spellings through shared Wikidata QIDs.
 *
 * @param {Array<{name:string,id?:string|null,workId?:string}>} entries
 * @param {{persisted?:object, fetchImpl?:Function, sleep?:Function,
 *          pauseMs?:number, limit?:number, names?:string[]}} options
 *        `names` restricts the query to the spellings the offline rule could
 *        not connect (the bridge passes exactly those); omitted = all names.
 * @returns {Promise<{canonical: object, merged: Array, queries: number,
 *                    checked: string[], skipped?: string}>}
 *        `checked` is every spelling actually asked from WDQS, so the caller can
 *        remember them and never pay for the same name twice.
 */
async function resolveWikidataAliases(entries, options = {}) {
  const pauseMs = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = groupAuthors(entries, options.persisted || {});
  const names = [...new Set((entries || []).map((entry) => entry.name).filter(Boolean))];
  const only = Array.isArray(options.names) ? new Set(options.names.map(normalizeAuthorName)) : null;
  const ruNames = names.filter((name) => hasCyrillic(name));
  const latinNames = names.filter((name) => hasLatin(name) && !hasCyrillic(name));
  const budget = options.limit == null ? names.length : Number(options.limit);
  const candidates = [...new Set([...ruNames, ...latinNames])]
    .filter((name) => !only || only.has(normalizeAuthorName(name)))
    .slice(0, Math.max(0, budget));
  if (!candidates.length) return { canonical: {}, merged: [], queries: 0, checked: [] };

  let queries = 0;
  const checked = [];
  const nameToQids = new Map();
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    try {
      const found = await fetchNameQids(batch, options);
      queries++;
      checked.push(...batch);
      for (const [name, qids] of found) nameToQids.set(name, qids);
    } catch (err) {
      // A blocked/quota-hit WDQS must degrade to the translit result.
      if (err && (err.status === 429 || err.status === 403)) {
        // The names in the failed batch were NOT answered: do not remember them
        // as checked, otherwise a transient block would freeze the merge set.
        return {
          canonical: {},
          merged: [],
          queries,
          checked,
          skipped: `wikidata_${err.status}`,
          retryAfter: err.retryAfter == null ? null : Number(err.retryAfter),
        };
      }
      throw err;
    }
    if (pauseMs > 0 && i + BATCH_SIZE < candidates.length) await sleep(pauseMs);
  }

  // A label shared by two people proves nothing: drop the label entirely (not
  // just its lookup) instead of guessing which QID the corpus meant.
  const ambiguous = new Set();
  for (const [name, set] of [...nameToQids]) {
    if (set.size > 1) {
      ambiguous.add(name);
      nameToQids.delete(name);
    }
  }

  const qids = [...new Set([...nameToQids.values()].flatMap((set) => [...set]))];
  const itemNames = new Map();
  for (let i = 0; i < qids.length; i += BATCH_SIZE) {
    const batch = qids.slice(i, i + BATCH_SIZE);
    let found;
    try {
      found = await fetchItemNames(batch, options);
    } catch (err) {
      if (err && (err.status === 429 || err.status === 403)) {
        return {
          canonical: {},
          merged: [],
          queries,
          checked,
          skipped: `wikidata_${err.status}`,
          retryAfter: err.retryAfter == null ? null : Number(err.retryAfter),
        };
      }
      throw err;
    }
    queries++;
    for (const [qid, set] of found) itemNames.set(qid, set);
    if (pauseMs > 0 && i + BATCH_SIZE < qids.length) await sleep(pauseMs);
  }

  // Union by QID: every author name that is a label/alias of the same person.
  const qidToNames = new Map();
  const normalizedNames = new Set(names.map(normalizeAuthorName));
  for (const [qid, set] of itemNames) {
    qidToNames.set(
      qid,
      new Set(
        [...set].filter(
          (name) =>
            !ambiguous.has(name) &&
            (normalizedNames.has(name) || base.canonicalOf.has(name))
        )
      )
    );
  }
  for (const [name, set] of nameToQids) {
    for (const qid of set) {
      if (!qidToNames.has(qid)) qidToNames.set(qid, new Set());
      qidToNames.get(qid).add(name);
    }
  }

  const merged = [];
  const canonical = {};
  for (const [qid, set] of qidToNames) {
    const list = [...set];
    if (list.length < 2) continue;
    // Reuse the base grouping's display name when it already knows this name.
    const display = list
      .map((name) => base.canonicalOf.get(name))
      .filter(Boolean)
      .sort((a, b) => {
        const latin = (value) => (hasLatin(value) && !hasCyrillic(value) ? 1 : 0);
        return latin(b) - latin(a) || b.length - a.length;
      })[0] || list[0];
    for (const name of list) canonical[normalizeAuthorName(name)] = display;
    merged.push({ qid, name: display, aliases: list.filter((name) => name !== display) });
  }
  return { canonical, merged, queries, checked };
}

module.exports = {
  WDQS,
  BATCH_SIZE,
  resolveWikidataAliases,
  fetchNameQids,
  fetchItemNames,
};
