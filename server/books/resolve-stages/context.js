'use strict';

const livelibCard = require('../providers/livelib-card');
const litres = require('../providers/litres');
const googlebooks = require('../providers/googlebooks');
const wikidata = require('../providers/wikidata');
const { lookupIsbns } = require('../hardcover-editions');
const bookCache = require('../book-cache');

function createBookkeeping() {
  return {
    attemptedKeys: new Set(),
    providerErrorKeys: new Set(),
    budgetBlockedKeys: new Set(),
    askedKeys: new Set(),
    missedByKey: new Map(),
  };
}

function createContext(llProfile, options = {}) {
  const force = Boolean(options.force);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const now = options.now || new Date().toISOString();
  const cardBudget = options.cardBudget || livelibCard.budgetFromEnv();
  const litresBudget = options.litresBudget || litres.budgetFromEnv();
  const gbBudget = options.gbBudget || googlebooks.budgetFromEnv();
  const negativeMemo = options.negativeMemo || {
    googlebooks: new Map(),
    openlibrary: new Map(),
    litres: new Map(),
  };
  const lookupFn = options.lookupIsbns || lookupIsbns;
  const wikidataBudget = options.wikidataBudget || wikidata.budgetFromEnv();
  const state = createBookkeeping();

  options = {
    ...options,
    attemptedKeys: state.attemptedKeys,
    providerErrorKeys: state.providerErrorKeys,
    missedByKey: state.missedByKey,
    askedKeys: state.askedKeys,
    budgetBlockedKeys: state.budgetBlockedKeys,
  };

  return {
    profiles: {
      source: (llProfile && llProfile.source) || 'livelib',
      userKey: (llProfile && llProfile.userKey) || null,
      events: Array.isArray(llProfile && llProfile.events) ? llProfile.events : [],
    },
    options,
    force,
    onProgress,
    now,
    budget: { card: cardBudget, litres: litresBudget, gb: gbBudget, wikidata: wikidataBudget },
    negativeMemo,
    lookupFn,
    state,
    cache: bookCache,
    lookupErrors: [],
    lookup: null,
    plan: null,
    report: null,
    chain: null,
    isbnToBookIds: new Map(),
  };
}

module.exports = {
  createContext,
};
