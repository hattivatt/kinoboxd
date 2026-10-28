'use strict';

/* Pure helpers of the local books-profile registry.
 *
 * Model (28.10.2026): a profile is ONE source + ONE account. Hardcover-34748
 * and LiveLib-Margaret are different profiles and their statistics never
 * merge. Here we cover the logic that decides *what* is sent to the server and
 * what is accepted from the user:
 *  - profile normalisation (dedupe, ordering, no invented defaults);
 *  - single-token `profile=` building and the K6 two-source migration;
 *  - first-run migration from the old localStorage accounts;
 *  - cookie-header sanitising (the value must never be echoed/stored);
 *  - LiveLib 403 detection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProfile, profileKey, profileKeys, profileQuery, primarySource,
  profileSources, profileSummary, scopeSourceNames, withSource, sourceAccount,
  migrateLegacyAccounts, adoptServerProfiles, splitMultiSourceProfile,
  isValidLivelibUsername, isValidHardcoverUser, sanitizeCookieHeader,
  looksLikeCookieHeader, isLivelibBlocked, normalizeSource, MAX_PROFILES,
} = require('../public/js/books-profiles.js');

test('normalizeProfile keeps valid sources, dedupes and orders LiveLib → Hardcover', () => {
  // `normalizeProfile` is the tolerant reader: it preserves every source of a
  // legacy record so `loadRegistry` can split it. The *single-profile* view is
  // `primarySource` / `profileKey`.
  const profile = normalizeProfile({
    label: '  Дом  ',
    sources: [
      { source: 'hardcover', userId: '34748' },
      { source: 'livelib', username: '@Margaret' },
      { source: 'hardcover', userId: '999' }, // last wins
      { source: 'livelib', username: 'bad name with spaces' },
      { source: 'storygraph', username: 'x' },
      null,
    ],
  });
  assert.equal(profile.label, 'Дом');
  assert.deepEqual(profileSources(profile), [
    { source: 'livelib', username: 'Margaret' },
    { source: 'hardcover', userId: '999' }, // last valid hardcover wins
  ]);
  // The profile stands for ONE account: Hardcover wins on a legacy union.
  assert.deepEqual(primarySource(profile), { source: 'hardcover', userId: '999' });
  assert.equal(profileKey(profile), 'hardcover-999');
});

test('normalizeProfile never invents 34748/Margaret or an empty label', () => {
  const profile = normalizeProfile({ sources: [{ source: 'livelib', username: 'Vasya' }] });
  assert.equal(profile.label, '@Vasya');
  assert.deepEqual(profile.sources, [{ source: 'livelib', username: 'Vasya' }]);

  const empty = normalizeProfile();
  assert.equal(empty.label, 'Книжный профиль');
  assert.deepEqual(empty.sources, []);
  assert.match(empty.id, /^bk:/);
});

test('profileKey builds exactly ONE token for ?profile=', () => {
  const livelib = normalizeProfile({
    label: 'Жена',
    sources: [{ source: 'livelib', username: 'Margaret' }],
  });
  assert.equal(profileKey(livelib), 'livelib-Margaret');
  assert.deepEqual(profileKeys(livelib), ['livelib-Margaret']);
  assert.equal(profileQuery(livelib), 'livelib-Margaret'); // deprecated alias
  assert.equal(profileSummary(livelib), 'LiveLib @Margaret');

  const hardcover = normalizeProfile({
    label: 'Я',
    sources: [{ source: 'hardcover', userId: '34748' }],
  });
  assert.equal(profileKey(hardcover), 'hardcover-34748');
  assert.equal(profileSummary(hardcover), 'Hardcover 34748');

  assert.equal(profileKey({ sources: [] }), '');
  assert.equal(profileQuery({ sources: [] }), '');
  assert.equal(profileSummary({ sources: [] }), '');
});

test('withSource resets the profile to that one source (never unions)', () => {
  const base = normalizeProfile({
    label: 'Дом',
    sources: [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '34748' },
    ],
  });
  const next = withSource(base, 'hardcover', '555');
  assert.equal(sourceAccount(next, 'hardcover'), '555');
  assert.equal(sourceAccount(next, 'livelib'), '');
  assert.deepEqual(profileSources(next), [{ source: 'hardcover', userId: '555' }]);
  assert.equal(sourceAccount(base, 'hardcover'), '34748', 'input record is not mutated');

  const rejected = withSource(base, 'livelib', '');
  assert.equal(sourceAccount(rejected, 'livelib'), 'Margaret');
});

test('splitMultiSourceProfile splits a K6 union into two labelled profiles', () => {
  const legacy = normalizeProfile({
    id: 'bk:legacy',
    label: 'Профиль чтения',
    sources: [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '34748' },
    ],
    savedAt: 123,
  });
  const split = splitMultiSourceProfile(legacy);
  assert.equal(split.unchanged, false);
  assert.equal(split.records.length, 2);
  assert.equal(split.primaryId, 'bk:legacy');

  const primary = split.records.find((record) => record.id === 'bk:legacy');
  assert.deepEqual(profileSources(primary), [{ source: 'hardcover', userId: '34748' }]);
  assert.equal(primary.label, 'Профиль чтения'); // custom label survives
  assert.equal(primary.savedAt, 123);

  const second = split.records.find((record) => record.id !== 'bk:legacy');
  assert.match(second.id, /^bk:/);
  assert.deepEqual(profileSources(second), [{ source: 'livelib', username: 'Margaret' }]);
  assert.equal(second.label, 'LiveLib Margaret');

  // An auto-generated union label is replaced by account labels on both sides.
  const auto = normalizeProfile({
    id: 'bk:auto',
    label: '@Margaret + 34748',
    sources: [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '34748' },
    ],
  });
  const autoSplit = splitMultiSourceProfile(auto);
  assert.deepEqual(
    autoSplit.records.map((record) => record.label).sort(),
    ['Hardcover 34748', 'LiveLib Margaret']
  );

  // A single-source record is returned untouched.
  const single = splitMultiSourceProfile(
    normalizeProfile({ id: 'bk:one', sources: [{ source: 'livelib', username: 'X' }] })
  );
  assert.equal(single.unchanged, true);
  assert.equal(single.records[0].id, 'bk:one');
});

test('account validators reject the values the old UI silently accepted', () => {
  assert.equal(isValidLivelibUsername('Margaret'), true);
  assert.equal(isValidLivelibUsername('margaret.1984_x'), true);
  assert.equal(isValidLivelibUsername('two words'), false);
  assert.equal(isValidLivelibUsername(''), false);
  assert.equal(isValidHardcoverUser('34748'), true);
  assert.equal(isValidHardcoverUser('me'), false);
  assert.equal(isValidHardcoverUser('12a'), false);
  assert.equal(normalizeSource('livelib', 'https://www.livelib.ru/reader/Margaret'), null,
    'the URL form is the server\'s job; the profile stores the username');
});

test('legacy accounts migration creates one profile per remembered account', () => {
  assert.deepEqual(migrateLegacyAccounts(null), []);
  assert.deepEqual(migrateLegacyAccounts({}), []);
  assert.deepEqual(migrateLegacyAccounts({ livelib: '  ', hardcover: '' }), []);
  assert.deepEqual(migrateLegacyAccounts({ hardcover: 'abc' }), []);

  const both = migrateLegacyAccounts({ livelib: 'Margaret', hardcover: '34748' });
  assert.equal(both.length, 2);
  assert.deepEqual(both.map(profileKey).sort(), ['hardcover-34748', 'livelib-Margaret']);
  assert.deepEqual(both.map((record) => record.label).sort(), [
    'Hardcover 34748',
    'LiveLib @Margaret',
  ]);

  const onlyLivelib = migrateLegacyAccounts({ livelib: 'Margaret' });
  assert.equal(onlyLivelib.length, 1);
  assert.equal(profileKey(onlyLivelib[0]), 'livelib-Margaret');
  assert.ok(!profileKey(onlyLivelib[0]).includes('34748'),
    'no hardcoded hardcover owner is invented');
});

test('adoptServerProfiles returns one local profile per server profile', () => {
  const adopted = adoptServerProfiles([
    { source: 'livelib', userKey: 'Margaret', eventCount: 1245 },
    { source: 'hardcover', userKey: '34748', eventCount: 681 },
    { source: 'livelib', userKey: 'other' }, // same source, latest wins
    { source: 'storygraph', userKey: 'sg' },
  ]);
  assert.equal(adopted.length, 2);
  assert.deepEqual(adopted.map(profileKey).sort(), ['hardcover-34748', 'livelib-other']);
  assert.deepEqual(adoptServerProfiles([]), []);
  assert.deepEqual(adoptServerProfiles([{ source: 'livelib', userKey: 'bad name' }]), []);
});

test('adoptServerProfiles prefers the latest import per source', () => {
  const adopted = adoptServerProfiles([
    { source: 'livelib', userKey: 'Margaret', importedAt: '2026-10-20T10:00:00.000Z' },
    { source: 'livelib', userKey: 'readingwitch', importedAt: '2026-10-27T09:00:00.000Z' },
    { source: 'hardcover', userKey: '34748', importedAt: '2026-10-25T10:00:00.000Z' },
  ]);
  assert.deepEqual(adopted.map(profileKey).sort(), ['hardcover-34748', 'livelib-readingwitch']);
});

test('scopeSourceNames reads the server profile scope, tolerates legacy payloads', () => {
  assert.deepEqual(
    scopeSourceNames({ selected: ['livelib-Margaret', 'hardcover-34748'] }),
    ['livelib', 'hardcover'],
  );
  // an Hardcover-only profile must not inherit LiveLib from the cache
  assert.deepEqual(scopeSourceNames({ selected: ['hardcover-34748'] }), ['hardcover']);
  // a dashed username stays one token (source is the first segment only)
  assert.deepEqual(scopeSourceNames({ selected: ['livelib-my-reader'] }), ['livelib']);
  assert.deepEqual(scopeSourceNames({ selected: ['livelib-A', 'livelib-B'] }), ['livelib']);
  assert.deepEqual(scopeSourceNames({ selected: ['storygraph-x'] }), []);
  assert.deepEqual(scopeSourceNames(null), []);
  assert.deepEqual(scopeSourceNames({}), []);
});

test('sanitizeCookieHeader strips the prefix, folds line breaks, rejects junk', () => {
  assert.equal(
    sanitizeCookieHeader('Cookie: __ddg1=abc; __ddg2=def'),
    '__ddg1=abc; __ddg2=def',
  );
  assert.equal(
    sanitizeCookieHeader('  __ddg1=abc;\n__ddg2=def;  '),
    '__ddg1=abc; __ddg2=def',
  );
  assert.equal(sanitizeCookieHeader('__ddg1=abc'), '__ddg1=abc');
  assert.equal(sanitizeCookieHeader(''), '');
  assert.equal(sanitizeCookieHeader('no equals sign'), '');
  assert.equal(sanitizeCookieHeader('{"cookie":"x=1"}'), '');
  assert.equal(sanitizeCookieHeader(`a=${'x'.repeat(9000)}`), '');
  assert.equal(looksLikeCookieHeader('__ddg1=abc'), true);
  assert.equal(looksLikeCookieHeader('__ddg1'), false);
});

test('isLivelibBlocked recognises the 403 contract without false positives', () => {
  assert.equal(isLivelibBlocked({ status: 429, code: 'livelib_blocked' }), true);
  assert.equal(isLivelibBlocked({ status: 502, code: 'livelib_http_error', message: 'LiveLib: 403 Forbidden' }), true);
  assert.equal(isLivelibBlocked('LiveLib заблокировал запросы (403)'), true);
  assert.equal(isLivelibBlocked({ status: 429, code: 'rate_limited' }), false);
  assert.equal(isLivelibBlocked({ status: 500, message: 'внутренняя ошибка' }), false);
  assert.equal(isLivelibBlocked(null), false);
  assert.equal(isLivelibBlocked(''), false);
});

test('registry limits are explicit', () => {
  assert.equal(MAX_PROFILES, 8);
});
