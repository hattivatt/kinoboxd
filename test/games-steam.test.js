'use strict';

/**
 * Steam client (M1): parsers of the three real payloads + politeness rules.
 *
 * All network calls are faked (or a localhost server); `npm test` never talks
 * to Steam (ИГРЫ §10.3). Fixtures are trimmed real responses from 01.11.2026
 * with the steamid64 replaced by a fake one and no key anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const steam = require('../server/games/steam');
const { readFixture } = require('./fixtures/games/fake-client');

const profileXml = readFixture('profile.xml');
const ownedJson = JSON.parse(readFixture('owned-games.json'));
const achievementsXml = readFixture('achievements.xml');
const globalJson = JSON.parse(readFixture('global-percentages.json'));

function memoryBreakerStore(initial = {}) {
  let state = initial;
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
    snapshot: () => state,
  };
}

function fakeRequest(handler) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options, calls.length);
  };
  request.calls = calls;
  return request;
}

test('parseProfileXml: vanity → steamid64, privacy, persona and the most recent games', () => {
  const profile = steam.parseProfileXml(profileXml);
  assert.equal(profile.steamId64, '76561198000000001');
  assert.equal(profile.customUrl, 'test-player');
  assert.equal(profile.personaName, 'test-player');
  assert.equal(profile.privacyState, 'public');
  assert.equal(profile.visibilityState, 3);
  assert.equal(profile.memberSince, 'February 19, 2011');
  assert.equal(profile.memberSinceAt, '2011-02-19T00:00:00.000Z');
  assert.equal(profile.mostPlayedGames.length, 2);
  assert.equal(profile.mostPlayedGames[0].appid, 1313140);
  assert.equal(profile.mostPlayedGames[0].hoursOnRecord, 13.8);
  // The XML `hoursPlayed2Wk` is stale; it is parsed but never aggregated.
  assert.equal(profile.hoursPlayed2Wk, 0);
});

test('parseOwnedGamesResponse: counts, minutes, optional fields and fingerprint', () => {
  const owned = steam.parseOwnedGamesResponse(ownedJson);
  assert.equal(owned.empty, false);
  assert.equal(owned.gameCount, 10);
  assert.equal(owned.games.length, 10);
  assert.equal(owned.totalMinutes, 36973);
  assert.equal(owned.fingerprint, steam.libraryFingerprint(owned.games, 10));

  const cyberpunk = owned.games.find((game) => game.appid === 1091500);
  assert.equal(cyberpunk.playtime_2weeks, 108);
  assert.equal(cyberpunk.rtime_last_played, 1793295251);

  // Absence of an optional field = "unknown"/"no activity", never a fake 0.
  const halfLife = owned.games.find((game) => game.appid === 70);
  assert.equal(halfLife.playtime_2weeks, null);
  assert.equal(halfLife.has_community_visible_stats, null);

  // The fingerprint ignores a stable snapshot and changes with playtime.
  const same = steam.parseOwnedGamesResponse(ownedJson);
  assert.equal(same.fingerprint, owned.fingerprint);
  const changed = {
    response: {
      game_count: 10,
      games: ownedJson.response.games.map((game) =>
        game.appid === 70 ? { ...game, playtime_forever: game.playtime_forever + 1 } : game
      ),
    },
  };
  assert.notEqual(steam.parseOwnedGamesResponse(changed).fingerprint, owned.fingerprint);
});

test('parseOwnedGamesResponse: missing/empty response means private, not "0 games"', () => {
  assert.equal(steam.parseOwnedGamesResponse({}).empty, true);
  assert.equal(steam.parseOwnedGamesResponse({ response: {} }).empty, true);
  assert.equal(steam.parseOwnedGamesResponse({ response: { game_count: 0, games: [] } }).empty, true);
});

test('parseAchievementsXml: closed flags, unlockTimestamp and fingerprint', () => {
  const parsed = steam.parseAchievementsXml(achievementsXml);
  assert.equal(parsed.privacyState, 'public');
  assert.equal(parsed.appid, 620);
  assert.equal(parsed.gameName, 'Portal 2');
  assert.equal(parsed.totalCount, 5);
  assert.equal(parsed.unlockedCount, 3);
  assert.equal(parsed.achievements.filter((entry) => !entry.achieved).length, 2);
  const first = parsed.achievements.find((entry) => entry.achieved);
  assert.equal(first.apiname, 'ach.survive_container_ride');
  assert.equal(first.unlockTimestamp, 1438886614);
  assert.equal(first.unlockAt, '2015-08-06T18:43:34.000Z');
  const locked = parsed.achievements.find((entry) => !entry.achieved);
  assert.equal(locked.unlockTimestamp, null);
  assert.equal(parsed.fingerprint.length, 40);
});

test('parseGlobalPercentages: numeric percent and case-insensitive lookup', () => {
  const parsed = steam.parseGlobalPercentages(globalJson, 620);
  assert.equal(parsed.appid, 620);
  assert.equal(parsed.achievements.length, 5);
  assert.equal(parsed.byName['ACH.SURVIVE_CONTAINER_RIDE'], 74);
  assert.equal(parsed.byName['ach.survive_container_ride'], 74);
  assert.equal(parsed.byName['ACH.SPEED_RUN_LEVEL'], 4);
});

test('normalizeTarget accepts steamid64, vanity and profile URLs', () => {
  assert.deepEqual(steam.normalizeTarget('76561198000000001').id64, '76561198000000001');
  assert.deepEqual(steam.normalizeTarget('whitefiercewolf').vanity, 'whitefiercewolf');
  assert.deepEqual(
    steam.normalizeTarget('https://steamcommunity.com/id/whitefiercewolf/').vanity,
    'whitefiercewolf'
  );
  assert.deepEqual(
    steam.normalizeTarget('https://steamcommunity.com/profiles/76561198000000001').id64,
    '76561198000000001'
  );
  assert.throws(() => steam.normalizeTarget(''), /steamid64|vanity/i);
  assert.throws(() => steam.normalizeTarget('12345'), (err) => err.code === 'invalid_steamid');
  assert.throws(
    () => steam.normalizeTarget('https://example.com/id/foo'),
    (err) => err.code === 'invalid_steamid'
  );
});

test('maskSecrets never leaks the key from a URL', () => {
  const masked = steam.maskSecrets(
    'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=SECRET123&steamid=1'
  );
  assert.equal(masked.includes('SECRET123'), false);
  assert.match(masked, /key=\*\*\*/);
});

test('getProfile: vanity request URL, pause between community calls, parsed result', async () => {
  let clock = 1_000_000;
  const sleepCalls = [];
  const request = fakeRequest(() => ({ status: 200, body: profileXml }));
  const client = steam.createClient({
    request,
    pauseMs: 2000,
    now: () => clock,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      clock += ms;
    },
    breakerStore: memoryBreakerStore(),
  });
  const profile = await client.getProfile('whitefiercewolf');
  assert.equal(profile.steamId64, '76561198000000001');
  assert.equal(request.calls[0].url, 'https://steamcommunity.com/id/whitefiercewolf/?xml=1');
  await client.getProfile('76561198000000001');
  assert.deepEqual(sleepCalls, [2000]);
  assert.match(request.calls[1].url, /\/profiles\/76561198000000001\/\?xml=1$/);
});

test('403/429 trips a 30-minute breaker and blocks further community requests', async () => {
  let clock = 5_000_000;
  const store = memoryBreakerStore();
  const request = fakeRequest(() => ({ status: 429, body: 'Too Many Requests' }));
  const client = steam.createClient({
    request,
    pauseMs: 0,
    now: () => clock,
    breakerStore: store,
  });
  await assert.rejects(
    () => client.getProfile('whitefiercewolf'),
    (err) => err.code === 'steam_rate_limited'
  );
  assert.equal(request.calls.length, 1);
  const breaker = store.snapshot()['steamcommunity.com'];
  assert.equal(breaker.until, clock + 30 * 60 * 1000);

  // While open: fail fast, no new request.
  await assert.rejects(
    () => client.getProfile('whitefiercewolf'),
    (err) => err.code === 'steam_rate_limited' && Boolean(err.retryAt)
  );
  assert.equal(request.calls.length, 1);

  // After the window the client may try again.
  clock = breaker.until + 1;
  const okRequest = fakeRequest(() => ({ status: 200, body: profileXml }));
  const client2 = steam.createClient({
    request: okRequest,
    pauseMs: 0,
    now: () => clock,
    breakerStore: store,
  });
  const profile = await client2.getProfile('whitefiercewolf');
  assert.equal(profile.steamId64, '76561198000000001');
  assert.equal(okRequest.calls.length, 1);
});

test('Cloudflare challenge body is treated as a block', async () => {
  const store = memoryBreakerStore();
  const client = steam.createClient({
    request: async () => ({ status: 200, body: '<title>Just a moment...</title>' }),
    pauseMs: 0,
    now: () => 1000,
    breakerStore: store,
  });
  await assert.rejects(() => client.getProfile('x'), (err) => err.code === 'steam_rate_limited');
  assert.ok(store.snapshot()['steamcommunity.com']);
});

test('network failures are steam_unreachable and never trip the breaker', async () => {
  const store = memoryBreakerStore();
  const networkError = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  const client = steam.createClient({
    request: async () => {
      throw networkError;
    },
    pauseMs: 0,
    now: () => 1000,
    breakerStore: store,
  });
  await assert.rejects(
    () => client.getProfile('whitefiercewolf'),
    (err) => err.code === 'steam_unreachable' && /DNS|сеть/i.test(err.message)
  );
  assert.deepEqual(store.snapshot(), {});
});

test('the key is masked in errors and never returned in a status', async () => {
  const key = 'SECRETKEY0123456789';
  const request = fakeRequest(() => ({ status: 500, body: 'boom' }));
  const client = steam.createClient({
    request,
    pauseMs: 0,
    now: () => 1000,
    breakerStore: memoryBreakerStore(),
    keyProvider: () => ({ key, source: 'env:STEAM_API_KEY' }),
  });
  await assert.rejects(
    () => client.getOwnedGames('76561198000000001'),
    (err) => {
      assert.equal(err.code, 'steam_http_error');
      assert.equal(err.message.includes(key), false);
      assert.match(err.message, /key=\*\*\*/);
      return true;
    }
  );
});

test('a missing key is steam_key_missing; 401 is steam_key_invalid', async () => {
  const noKey = steam.createClient({
    request: async () => ({ status: 200, body: '{}' }),
    pauseMs: 0,
    breakerStore: memoryBreakerStore(),
    keyProvider: () => ({ key: null, source: null }),
  });
  await assert.rejects(
    () => noKey.getOwnedGames('76561198000000001'),
    (err) => err.code === 'steam_key_missing'
  );

  const badKey = steam.createClient({
    request: async () => ({ status: 401, body: 'Access is denied' }),
    pauseMs: 0,
    breakerStore: memoryBreakerStore(),
    keyProvider: () => ({ key: 'bad', source: 'env:STEAM_API_KEY' }),
  });
  await assert.rejects(
    () => badKey.getOwnedGames('76561198000000001'),
    (err) => err.code === 'steam_key_invalid'
  );
});

test('GetOwnedGames URL carries include_appinfo/include_played_free_games and no pagination', async () => {
  const request = fakeRequest(() => ({ status: 200, body: JSON.stringify(ownedJson) }));
  const client = steam.createClient({
    request,
    pauseMs: 0,
    breakerStore: memoryBreakerStore(),
    keyProvider: () => ({ key: 'k', source: 'env:STEAM_API_KEY' }),
  });
  const owned = await client.getOwnedGames('76561198000000001');
  assert.equal(owned.games.length, 10);
  const url = request.calls[0].url;
  assert.match(url, /include_appinfo=true/);
  assert.match(url, /include_played_free_games=true/);
  assert.equal(/start=|page=/.test(url), false);
});

test('getAchievements: private stats are stats_private, empty game is stats_not_found', async () => {
  const privateXml =
    '<?xml version="1.0"?><playerstats><privacyState>private</privacyState></playerstats>';
  const privateClient = steam.createClient({
    request: async () => ({ status: 200, body: privateXml }),
    pauseMs: 0,
    breakerStore: memoryBreakerStore(),
  });
  await assert.rejects(
    () => privateClient.getAchievements('76561198000000001', 620),
    (err) => err.code === 'stats_private'
  );

  const notFound = steam.createClient({
    request: async () => ({ status: 404, body: '' }),
    pauseMs: 0,
    breakerStore: memoryBreakerStore(),
  });
  await assert.rejects(
    () => notFound.getAchievements('76561198000000001', 620),
    (err) => err.code === 'stats_not_found'
  );
});

test('httpGet follows redirects and reports a refused connection as steam_unreachable', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end('Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await steam.httpGet(`http://127.0.0.1:${port}/start`);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(
    () => steam.httpGet('http://127.0.0.1:1/', { timeoutMs: 2000 }),
    (err) => err.code === 'steam_unreachable'
  );
});
