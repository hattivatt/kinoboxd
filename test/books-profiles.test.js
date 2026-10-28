'use strict';

/* Pure helpers of the local books-profile registry.
 *
 * The IndexedDB part is exercised by the Playwright mock run; here we cover
 * the logic that decides *what* is sent to the server and what is accepted
 * from the user:
 *  - profile normalisation (dedupe, ordering, no invented defaults);
 *  - `profiles=livelib-X,hardcover-Y` query building;
 *  - first-run migration from the old localStorage accounts;
 *  - cookie-header sanitising (the value must never be echoed/stored);
 *  - LiveLib 403 detection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProfile, profileKeys, profileQuery, profileSources, profileSummary,
  withSource, sourceAccount, migrateLegacyAccounts, adoptServerProfiles,
  isValidLivelibUsername, isValidHardcoverUser, sanitizeCookieHeader,
  looksLikeCookieHeader, isLivelibBlocked, normalizeSource, MAX_PROFILES,
} = require('../public/js/books-profiles.js');

test('normalizeProfile keeps valid sources, dedupes and orders LiveLib → Hardcover', () => {
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
  assert.deepEqual(profileKeys(profile), ['livelib-Margaret', 'hardcover-999']);
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

test('profileQuery builds the CSV the backend expects', () => {
  const profile = normalizeProfile({
    label: 'Оба',
    sources: [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '34748' },
    ],
  });
  assert.equal(profileQuery(profile), 'livelib-Margaret,hardcover-34748');
  assert.equal(profileQuery({ sources: [] }), '');
  assert.equal(profileSummary(profile), 'LiveLib @Margaret · Hardcover 34748');
});

test('withSource replaces one source and keeps the other', () => {
  const base = normalizeProfile({
    label: 'Дом',
    sources: [
      { source: 'livelib', username: 'Margaret' },
      { source: 'hardcover', userId: '34748' },
    ],
  });
  const next = withSource(base, 'hardcover', '555');
  assert.equal(sourceAccount(next, 'hardcover'), '555');
  assert.equal(sourceAccount(next, 'livelib'), 'Margaret');
  assert.equal(sourceAccount(base, 'hardcover'), '34748', 'input record is not mutated');

  const rejected = withSource(base, 'livelib', '');
  assert.equal(sourceAccount(rejected, 'livelib'), 'Margaret');
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

test('legacy accounts migration only carries really remembered accounts', () => {
  assert.equal(migrateLegacyAccounts(null), null);
  assert.equal(migrateLegacyAccounts({}), null);
  assert.equal(migrateLegacyAccounts({ livelib: '  ', hardcover: '' }), null);
  assert.equal(migrateLegacyAccounts({ hardcover: 'abc' }), null);

  const both = migrateLegacyAccounts({ livelib: 'Margaret', hardcover: '34748' });
  assert.equal(both.label, 'Мой профиль');
  assert.deepEqual(profileKeys(both), ['livelib-Margaret', 'hardcover-34748']);

  const onlyLivelib = migrateLegacyAccounts({ livelib: 'Margaret' });
  assert.deepEqual(profileKeys(onlyLivelib), ['livelib-Margaret']);
  assert.ok(!profileKeys(onlyLivelib).some((key) => key.includes('34748')),
    'no hardcoded hardcover owner is invented');
});

test('adoptServerProfiles turns /api/books/profiles rows into one profile', () => {
  const adopted = adoptServerProfiles([
    { source: 'livelib', userKey: 'Margaret', eventCount: 1245 },
    { source: 'hardcover', userKey: '34748', eventCount: 681 },
    { source: 'livelib', userKey: 'other' }, // same source, deduped by validator order
    { source: 'storygraph', userKey: 'sg' },
  ]);
  assert.equal(adopted.label, 'Сохранённый на сервере');
  assert.deepEqual(profileKeys(adopted), ['livelib-other', 'hardcover-34748']);
  assert.equal(adoptServerProfiles([]), null);
  assert.equal(adoptServerProfiles([{ source: 'livelib', userKey: 'bad name' }]), null);
});

test('adoptServerProfiles prefers the latest import when a source has two accounts', () => {
  const adopted = adoptServerProfiles([
    { source: 'livelib', userKey: 'Margaret', importedAt: '2026-10-20T10:00:00.000Z' },
    { source: 'livelib', userKey: 'readingwitch', importedAt: '2026-10-27T09:00:00.000Z' },
    { source: 'hardcover', userKey: '34748', importedAt: '2026-10-25T10:00:00.000Z' },
  ]);
  assert.deepEqual(profileKeys(adopted), ['livelib-readingwitch', 'hardcover-34748']);
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
