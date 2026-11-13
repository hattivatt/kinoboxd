'use strict';

const { normalizeAuthorName, hasCyrillic, hasLatin, groupAuthors } = require('./authors');
const { fetchOnce, responseFacade, defaultSleep } = require('../core/http');

const WDQS = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 450;
const DEFAULT_PAUSE_MS = 1100;
const USER_AGENT = 'kinoboxd/1.0 (books author alias backfill)';

function sparql(query, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (!fetchImpl && typeof globalThis.fetch !== 'function') {
    return Promise.reject(new Error('fetch is not available'));
  }
  return fetchOnce(options.endpoint || process.env.KINOBOXD_WDQS_ENDPOINT || WDQS, {
    fetchImpl,
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ query, format: 'json' }).toString(),
    timeoutMs: 0,
    label: 'authors-wikidata',
  }).then(responseFacade);
}

function valuesClause(names) {
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

async function resolveWikidataAliases(entries, options = {}) {
  const pauseMs = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const sleep = options.sleep || defaultSleep;
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
    if (pauseMs > 0 && i + BATCH_SIZE < candidates.length) await sleep(pauseMs);
  }

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
