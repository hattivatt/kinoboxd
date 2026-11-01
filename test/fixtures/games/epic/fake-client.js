'use strict';

/**
 * Offline Epic client for the games tests. Returns the trimmed fixtures from
 * `test/fixtures/games/epic/` and records every call. Live requests are never
 * made from `npm test` (§14.5: only mocks/fixtures).
 *
 * Failure injection: `options.fail` is keyed by method name and the value is
 * thrown as-is (tests pass `new epic.EpicError(..., { deferred: true })`).
 */

const fs = require('fs');
const path = require('path');

const epic = require('../../../../server/games/epic');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeEpicClient(options = {}) {
  const calls = [];
  const state = {
    accountId: options.accountId || 'epic-account-1',
    displayName: options.displayName || 'EpicTester',
    entitlements: options.entitlements || readJson('entitlements.json').entitlements,
    libraryPages:
      options.libraryPages || [
        readJson('library-items-page1.json'),
        readJson('library-items-page2.json'),
      ],
    playtime: options.playtime || readJson('playtime.json'),
    catalog: options.catalog || readJson('catalog-bulk.json'),
    productMapping: options.productMapping || readJson('productmapping.json'),
    fail: options.fail || {},
  };

  function failFor(name) {
    if (state.fail[name]) throw state.fail[name];
  }

  return {
    calls,
    state,
    async getAccount(accountId) {
      calls.push('account');
      failFor('getAccount');
      return { accountId, displayName: state.displayName, country: 'US' };
    },
    async getEntitlements(accountId) {
      calls.push('entitlements');
      failFor('getEntitlements');
      return { entitlements: clone(state.entitlements), pages: 1 };
    },
    async getLibraryItems(accountId) {
      calls.push('library');
      failFor('getLibraryItems');
      const records = state.libraryPages.flatMap((page) => clone(page.records || []));
      return {
        records,
        pages: state.libraryPages.length,
        truncated: false,
        nextCursor: null,
      };
    },
    async getPlaytime(accountId) {
      calls.push('playtime');
      failFor('getPlaytime');
      return epic.normalizePlaytimeResponse(clone(state.playtime));
    },
    async getCatalogBulk(namespace, ids) {
      calls.push(`catalog:${namespace}`);
      failFor('getCatalogBulk');
      const items = {};
      for (const id of ids) {
        if (state.catalog[id]) items[id] = epic.normalizeCatalogItem(state.catalog[id], id);
      }
      return { items, requests: 1, failures: [] };
    },
    async getProductMapping() {
      calls.push('productmapping');
      failFor('getProductMapping');
      return epic.normalizeProductMapping(clone(state.productMapping));
    },
    async killSession() {
      calls.push('killSession');
      return true;
    },
  };
}

module.exports = { createFakeEpicClient, readJson };
