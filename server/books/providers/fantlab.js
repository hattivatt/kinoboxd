'use strict';

const { fetchJson, defaultSleep, createSourceClient } = require('./http');
const sources = require('../../core/sources');
const { fantlabEnabled } = require('../fantlab-flag');
const { titleVariants, partVariants, withoutNoise } = require('./title-variants');
const { authorHit } = require('./wikidata');
const { normalizeAuthorName } = require('../authors');
const { saneFirstYearClaim } = require('./claim');

const NAME = 'fantlab';
const SOURCE_ID = 'fantlab';
const API_BASE = 'https://api.fantlab.ru';
const source = createSourceClient({ name: SOURCE_ID });
const { isBreakerOpen, tripBreaker, resetBreaker, createBudget, budgetFromEnv } = source;
const DEFAULT_PAUSE_MS = sources.pauseMs(SOURCE_ID);
const DEFAULT_TIMEOUT_MS = sources.timeoutMs(SOURCE_ID);
const USER_AGENT = sources.userAgent(SOURCE_ID);
const SKIPPED_TYPES = new Set(['cycle', 'article', 'review', 'interview', 'other']);

function isDisabled() {
  return !fantlabEnabled();
}

function titleKey(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function namesOf(item) {
  const names = [item.rusname, item.name, ...String(item.altname || '').split(';')];
  return new Set(names.map(titleKey).filter(Boolean));
}

function authorsOf(item) {
  return [item.all_autor_rusname, item.all_autor_name, item.autor_rusname]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function queryOf(entry) {
  const title = withoutNoise(entry.title);
  const author = (entry.authors || []).find(Boolean);
  const surname = author ? normalizeAuthorName(author).split(' ').filter(Boolean).pop() : '';
  return [title, surname].filter(Boolean).join(' ');
}

function tiersOf(entry) {
  const parts = partVariants(entry.title, entry.authors);
  return [titleVariants(entry.title), parts.subtitle, parts.whole].map(
    (list) => new Set(list.map(titleKey).filter(Boolean))
  );
}

function pickItem(entry, items) {
  const authors = (entry.authors || []).filter(Boolean);
  const tiers = tiersOf(entry);
  for (const [tier, wanted] of tiers.entries()) {
    if (!wanted.size) continue;
    const matched = items.filter((item) => {
      const year = Number(item.year);
      if (!Number.isFinite(year) || year === 0) return false;
      if (SKIPPED_TYPES.has(String(item.name_eng || ''))) return false;
      if (![...namesOf(item)].some((name) => wanted.has(name))) return false;
      if (!authors.length) return tier === 0;
      return authorsOf(item).some((name) => authorHit(name, authors));
    });
    if (!matched.length) continue;
    if (!authors.length && matched.length > 1) return null;
    const earliest = matched.reduce((best, item) =>
      Number(item.year) < Number(best.year) ? item : best
    );
    return { item: earliest, tier };
  }
  return null;
}

function toResult(entry, picked) {
  const { item, tier } = picked;
  const claim = saneFirstYearClaim({
    year: Number(item.year),
    precision: 'year',
    kind: 'publication',
    source: NAME,
  });
  if (!claim) return null;
  const wholeWork = tier === 2;
  return {
    source: NAME,
    sourceId: String(item.work_id),
    workId: `fl:${item.work_id}`,
    title: entry.title,
    authors: authorsOf(item).slice(0, 1),
    year: null,
    firstPublishedYear: claim.year,
    firstPublishedYearPrecision: claim.precision,
    firstPublishedYearKind: claim.kind,
    fantlabWorkId: wholeWork ? null : Number(item.work_id),
    originalTitle: item.name ? String(item.name) : null,
    links: { pageUrl: `https://fantlab.ru/work${item.work_id}` },
    confidence: 0.6,
    match: {
      method: 'title',
      exact: tier === 0,
      authorHit: Boolean((entry.authors || []).length),
      wholeWork,
      fuzzy: false,
      label: item.rusname || item.name || null,
    },
  };
}

async function search(entry, options) {
  const url = `${API_BASE}/search-works?q=${encodeURIComponent(queryOf(entry))}&page=1&onlymatches=1`;
  try {
    const data = await fetchJson(url, {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      userAgent: USER_AGENT,
      label: 'fantlab search',
    });
    if (Array.isArray(data)) return data;
    return data && Array.isArray(data.matches) ? data.matches : [];
  } catch (err) {
    const status = Number(err && err.status);
    if (status === 403 || status === 429) tripBreaker();
    throw err;
  }
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
  const budget = options.budget === undefined ? null : options.budget;
  const pause = options.pauseMs == null ? DEFAULT_PAUSE_MS : Number(options.pauseMs);
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  for (const entry of list) {
    if (isBreakerOpen()) {
      result.skipped = 'breaker';
      break;
    }
    if (budget && typeof budget.take === 'function' && !budget.take()) {
      result.skipped = 'budget';
      break;
    }
    if (pause > 0) await sleep(pause);
    result.queries++;
    let items;
    try {
      items = await search(entry, options);
    } catch (err) {
      result.skipped = isBreakerOpen() ? 'breaker' : 'error';
      break;
    }
    result.asked.add(String(entry.key));
    const picked = pickItem(entry, items);
    result.byKey.set(String(entry.key), picked ? toResult(entry, picked) : null);
  }
  return result;
}

module.exports = {
  NAME,
  titleKey,
  queryOf,
  pickItem,
  lookupTitles,
  isDisabled,
  isBreakerOpen,
  tripBreaker,
  resetBreaker,
  createBudget,
  budgetFromEnv,
};
