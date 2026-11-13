'use strict';

const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');
const cheerio = require('cheerio');

const config = require('../config');
const gameCache = require('./game-cache');
const { createSourceGate } = require('../core/source-client');
const { nodeRequest } = require('../core/http');
const sources = require('../core/sources');

const COMMUNITY_HOST = 'steamcommunity.com';
const API_HOST = 'api.steampowered.com';

const DEFAULT_TIMEOUT_MS = sources.timeoutMs('steam');
const DEFAULT_COMMUNITY_PAUSE_MS = sources.pauseMs('steamCommunity');
const DEFAULT_BREAKER_MS = sources.breakerMs('steam');
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

class SteamError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SteamError';
    this.code = code || 'steam_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
  }
}

function maskSecrets(value) {
  return String(value == null ? '' : value).replace(/([?&]key=)[^&\s"']+/gi, '$1***');
}

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLookup(dnsServers) {
  const servers = (dnsServers || process.env.GAMES_STEAM_DNS_SERVERS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!servers.length) return undefined;
  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  return function lookup(hostname, options, callback) {
    const opts = typeof options === 'function' ? {} : options || {};
    const cb = typeof options === 'function' ? options : callback;
    resolver.resolve4(hostname, (err4, addresses) => {
      if (!err4 && addresses && addresses.length) {
        return cb(null, opts.all ? addresses.map((address) => ({ address, family: 4 })) : addresses[0], 4);
      }
      resolver.resolve6(hostname, (err6, addresses6) => {
        if (!err6 && addresses6 && addresses6.length) {
          return cb(
            null,
            opts.all ? addresses6.map((address) => ({ address, family: 6 })) : addresses6[0],
            6
          );
        }
        const cause = err4 || err6 || new Error('no addresses');
        return cb(
          new SteamError(
            `Не удалось разрешить ${hostname} через DNS ${servers.join(', ')}: ${cause.code || cause.message}`,
            'steam_unreachable',
            { host: hostname }
          )
        );
      });
    });
  };
}

function networkError(err, target) {
  if (err instanceof SteamError) return err;
  const code = err && err.code ? err.code : 'ENETWORK';
  const host = (() => {
    try {
      return new URL(target).hostname;
    } catch (_) {
      return null;
    }
  })();
  return new SteamError(
    `Steam недоступен (${host || 'steam'}, ${code}): сеть/DNS/TLS не пускает к источнику. ` +
      'Это не повод считать источник мёртвым — проверь резолвер (GAMES_STEAM_DNS_SERVERS) или прокси.',
    'steam_unreachable',
    { host }
  );
}

function httpGet(target, options = {}) {
  const timeoutMs = options.timeoutMs || envInt('GAMES_STEAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const redirectsLeft = options.redirectsLeft == null ? MAX_REDIRECTS : options.redirectsLeft;
  const lookup = options.lookup === undefined ? buildLookup() : options.lookup;
  return nodeRequest(target, {
    timeoutMs,
    lookup,
    maxRedirects: redirectsLeft,
    maxBytes: MAX_BODY_BYTES,
    headers: {
      'User-Agent': 'kinoboxd/1.0 (+games-tab)',
      Accept: 'application/json, text/xml, application/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    label: 'steam',
  }).catch((err) => {
    if (err && err.code === 'invalid_url') {
      throw new SteamError(`Некорректный URL: ${maskSecrets(target)}`, 'steam_invalid_url');
    }
    if (err && err.code === 'too_many_redirects') {
      throw new SteamError(`Слишком много редиректов: ${maskSecrets(target)}`, 'steam_http_error', {
        status: err.status,
      });
    }
    if (err && err.code === 'response_too_large') {
      throw new SteamError(`Ответ Steam больше ${MAX_BODY_BYTES} байт`, 'steam_http_error', {
        status: err.status,
      });
    }
    throw networkError(err, target);
  });
}

function numOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function textOf($, selector) {
  const node = $(selector).first();
  if (!node || node.length === 0) return null;
  const text = node.text();
  return text == null ? null : String(text).trim();
}

function appidFromLink(link) {
  const match = /\/app\/(\d+)/.exec(String(link || ''));
  return match ? Number(match[1]) : null;
}

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function parseMemberSince(value) {
  const text = String(value == null ? '' : value).trim();
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (month != null) {
      return Date.UTC(Number(match[3]), month, Number(match[2]));
    }
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseProfileXml(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const mostPlayedGames = [];
  $('mostPlayedGames mostPlayedGame').each((_, element) => {
    const item = $(element);
    const link = item.find('gameLink').first().text().trim();
    const statsName = item.find('statsName').first().text().trim();
    const appid = appidFromLink(link) || numOrNull(statsName);
    mostPlayedGames.push({
      appid: appid || null,
      name: item.find('gameName').first().text().trim() || null,
      gameLink: link || null,
      iconUrl: item.find('gameIcon').first().text().trim() || null,
      hoursPlayed2w: numOrNull(item.find('hoursPlayed').first().text().trim()),
      hoursOnRecord: numOrNull(item.find('hoursOnRecord').first().text().trim()),
    });
  });
  const memberSince = textOf($, 'profile > memberSince') || textOf($, 'memberSince');
  const memberSinceTs = memberSince ? parseMemberSince(memberSince) : NaN;
  return {
    steamId64: textOf($, 'profile > steamID64') || textOf($, 'steamID64'),
    customUrl: textOf($, 'profile > customURL') || textOf($, 'customURL'),
    personaName: textOf($, 'profile > steamID') || textOf($, 'steamID'),
    privacyState: textOf($, 'profile > privacyState') || textOf($, 'privacyState'),
    visibilityState: numOrNull(textOf($, 'profile > visibilityState') || textOf($, 'visibilityState')),
    memberSince: memberSince || null,
    memberSinceAt: Number.isFinite(memberSinceTs) ? new Date(memberSinceTs).toISOString() : null,
    avatarIcon: textOf($, 'profile > avatarIcon') || null,
    avatarMedium: textOf($, 'profile > avatarMedium') || null,
    avatarFull: textOf($, 'profile > avatarFull') || null,
    vacBanned: numOrNull(textOf($, 'profile > vacBanned')),
    limitedAccount: numOrNull(textOf($, 'profile > isLimitedAccount')),
    hoursPlayed2Wk: numOrNull(textOf($, 'profile > hoursPlayed2Wk')),
    mostPlayedGames,
    groupsCount: $('profile groups group').length,
  };
}

function normalizeOwnedGame(raw) {
  const game = raw && typeof raw === 'object' ? raw : {};
  const appid = Number(game.appid);
  return {
    appid: Number.isFinite(appid) ? appid : null,
    name: game.name == null ? null : String(game.name),
    playtime_forever: numOrNull(game.playtime_forever) || 0,
    playtime_2weeks: numOrNull(game.playtime_2weeks),
    rtime_last_played: numOrNull(game.rtime_last_played) || 0,
    img_icon_url: game.img_icon_url == null ? null : String(game.img_icon_url),
    has_community_visible_stats:
      typeof game.has_community_visible_stats === 'boolean'
        ? game.has_community_visible_stats
        : null,
    has_leaderboards:
      typeof game.has_leaderboards === 'boolean' ? game.has_leaderboards : null,
    playtime_windows_forever: numOrNull(game.playtime_windows_forever) || 0,
    playtime_mac_forever: numOrNull(game.playtime_mac_forever) || 0,
    playtime_linux_forever: numOrNull(game.playtime_linux_forever) || 0,
    playtime_deck_forever: numOrNull(game.playtime_deck_forever) || 0,
    playtime_disconnected: numOrNull(game.playtime_disconnected) || 0,
    content_descriptorids: Array.isArray(game.content_descriptorids)
      ? game.content_descriptorids.map(Number).filter(Number.isFinite)
      : null,
  };
}

function libraryFingerprint(games, gameCount) {
  const list = Array.isArray(games) ? games : [];
  const totalMinutes = list.reduce((sum, game) => sum + (Number(game.playtime_forever) || 0), 0);
  const maxRtime = list.reduce(
    (max, game) => Math.max(max, Number(game.rtime_last_played) || 0),
    0
  );
  const count = gameCount == null ? list.length : Number(gameCount) || list.length;
  return crypto
    .createHash('sha1')
    .update(`${count}:${totalMinutes}:${maxRtime}`)
    .digest('hex');
}

function parseRecentlyPlayedResponse(json) {
  const response = json && typeof json === 'object' ? json.response : null;
  if (!response || typeof response !== 'object' || !Array.isArray(response.games)) {
    return { empty: true, gameCount: 0, games: [], totalMinutes: 0, fingerprint: null };
  }
  const games = response.games.map(normalizeOwnedGame).filter((game) => game.appid != null);
  const gameCount = Number.isFinite(Number(response.total_count))
    ? Number(response.total_count)
    : games.length;
  const totalMinutes = games.reduce((sum, game) => sum + game.playtime_forever, 0);
  return {
    empty: games.length === 0,
    gameCount,
    games,
    totalMinutes,
    fingerprint: libraryFingerprint(games, gameCount),
  };
}

function parseOwnedGamesResponse(json) {
  const response = json && typeof json === 'object' ? json.response : null;
  if (!response || typeof response !== 'object' || !Array.isArray(response.games)) {
    return { empty: true, gameCount: 0, games: [], totalMinutes: 0, fingerprint: null };
  }
  const games = response.games.map(normalizeOwnedGame).filter((game) => game.appid != null);
  const gameCount = Number.isFinite(Number(response.game_count))
    ? Number(response.game_count)
    : games.length;
  const totalMinutes = games.reduce((sum, game) => sum + game.playtime_forever, 0);
  return {
    empty: games.length === 0,
    gameCount,
    games,
    totalMinutes,
    fingerprint: libraryFingerprint(games, gameCount),
  };
}

function parseAchievementsXml(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const achievements = [];
  $('achievements achievement').each((_, element) => {
    const item = $(element);
    const closed = String(item.attr('closed') || '').trim();
    const achieved = closed === '1';
    const unlock = achieved ? numOrNull(item.find('unlockTimestamp').first().text().trim()) : null;
    achievements.push({
      apiname: item.find('apiname').first().text().trim() || null,
      name: item.find('name').first().text().trim() || null,
      description: item.find('description').first().text().trim() || null,
      achieved,
      closed: closed === '' ? null : closed === '1',
      unlockTimestamp: unlock && unlock > 0 ? unlock : null,
      unlockAt: unlock && unlock > 0 ? new Date(unlock * 1000).toISOString() : null,
      iconOpen: item.find('iconOpen').first().text().trim() || null,
      iconClosed: item.find('iconClosed').first().text().trim() || null,
    });
  });
  const unlockedCount = achievements.filter((entry) => entry.achieved).length;
  const maxUnlockTimestamp = achievements.reduce(
    (max, entry) => Math.max(max, entry.unlockTimestamp || 0),
    0
  );
  return {
    privacyState: textOf($, 'playerstats > privacyState') || textOf($, 'privacyState'),
    visibilityState: numOrNull(
      textOf($, 'playerstats > visibilityState') || textOf($, 'visibilityState')
    ),
    steamId64:
      textOf($, 'playerstats player steamID64') ||
      textOf($, 'player steamID64') ||
      textOf($, 'steamID64'),
    customUrl: textOf($, 'player customURL') || null,
    appid:
      appidFromLink(textOf($, 'game gameLink') || textOf($, 'gameLink')) ||
      numOrNull(textOf($, 'game gameFriendlyName') || textOf($, 'gameFriendlyName')),
    gameFriendlyName: textOf($, 'game gameFriendlyName') || null,
    gameName: textOf($, 'game gameName') || textOf($, 'gameName'),
    gameIcon: textOf($, 'game gameIcon') || textOf($, 'gameIcon'),
    statsHoursPlayed: numOrNull(textOf($, 'stats hoursPlayed')),
    achievements,
    unlockedCount,
    totalCount: achievements.length,
    maxUnlockTimestamp: maxUnlockTimestamp || null,
    fingerprint: crypto
      .createHash('sha1')
      .update(`${unlockedCount}:${maxUnlockTimestamp}`)
      .digest('hex'),
  };
}

function parseGlobalPercentages(json, appid) {
  const list =
    (json && json.achievementpercentages && json.achievementpercentages.achievements) || [];
  const achievements = list
    .map((entry) => ({
      name: entry && entry.name != null ? String(entry.name) : null,
      percent: numOrNull(entry && entry.percent),
    }))
    .filter((entry) => entry.name);
  const byName = {};
  for (const entry of achievements) {
    if (entry.percent == null) continue;
    byName[entry.name] = entry.percent;
    byName[entry.name.toLowerCase()] = entry.percent;
  }
  return {
    appid: Number(appid) || null,
    achievements,
    byName,
  };
}

const ID64_RE = /^\d{17}$/;
const VANITY_RE = /^[\w.-]{1,64}$/;

function normalizeTarget(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) {
    throw new SteamError(
      'Укажите steamid64 или vanity-имя профиля Steam.',
      'invalid_steamid'
    );
  }
  let candidate = value;
  if (/^https?:\/\//i.test(candidate)) {
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (err) {
      throw new SteamError(`Некорректный URL профиля: ${value}`, 'invalid_steamid');
    }
    if (!/(^|\.)steamcommunity\.com$/i.test(parsed.hostname)) {
      throw new SteamError(
        'URL должен вести на steamcommunity.com (id/<vanity> или profiles/<steamid64>).',
        'invalid_steamid'
      );
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'id' && parts[1]) candidate = parts[1];
    else if (parts[0] === 'profiles' && parts[1]) candidate = parts[1];
    else throw new SteamError('В URL нет vanity-имени или steamid64.', 'invalid_steamid');
  }
  if (ID64_RE.test(candidate)) return { id64: candidate, input: value };
  if (/^\d+$/.test(candidate)) {
    throw new SteamError(
      `steamid64 должен состоять из 17 цифр, получено ${candidate.length}.`,
      'invalid_steamid'
    );
  }
  if (VANITY_RE.test(candidate)) return { vanity: candidate, input: value };
  throw new SteamError(
    'Vanity-имя Steam: латиница, цифры, точка, дефис, подчёркивание (до 64 символов).',
    'invalid_steamid'
  );
}

function profileKeyOf(steamId64) {
  return `steam-${steamId64}`;
}

function defaultBreakerStore() {
  return {
    read() {
      return gameCache.readBreaker();
    },
    write(state) {
      return gameCache.writeBreaker(state);
    },
  };
}

function createClient(options = {}) {
  const request = options.request || httpGet;
  const sleep = options.sleep || sleepDefault;
  const now = options.now || (() => Date.now());
  const pauseMs =
    options.pauseMs != null
      ? options.pauseMs
      : sources.pauseMs('steamCommunity');
  const breakerMs =
    options.breakerMs != null
      ? options.breakerMs
      : sources.breakerMs('steam');
  const breakerStore = options.breakerStore || defaultBreakerStore();
  const keyProvider =
    options.keyProvider ||
    (() => ({ key: config.loadSteamKey(), source: config.steamKeySource() }));

  function rateLimitedError(host, entry) {
    return new SteamError(
      `Steam (${host}) временно не опрашивается: предыдущий ответ ${entry.reason}. ` +
        `Повтор через ${Math.max(1, Math.ceil((entry.until - now()) / 60000))} мин.`,
      'steam_rate_limited',
      { host, retryAt: new Date(entry.until).toISOString() }
    );
  }

  const breakerGate = createSourceGate({ now, breakerMs, breakerStore, createError: rateLimitedError });
  const lane = (pauseMs) =>
    createSourceGate({
      now,
      sleep,
      pauseMs,
      breaker: breakerGate.breaker,
      createError: rateLimitedError,
      mapTransportError: (err, context) =>
        err instanceof SteamError ? err : networkError(err, context && context.url),
    });
  const communityGate = lane(pauseMs);
  const apiGate = lane(0);

  function breakerFor(host) {
    return breakerGate.breakerFor(host);
  }

  function tripBreaker(host, reason) {
    return breakerGate.tripBreaker(host, reason);
  }

  function assertNotBlocked(host) {
    return breakerGate.assertNotBlocked(host);
  }

  async function communityGet(url) {
    const response = await communityGate.request(
      COMMUNITY_HOST,
      () => request(url, { timeoutMs: envInt('GAMES_STEAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS) }),
      { url }
    );
    const status = Number(response.status) || 0;
    const body = String(response.body || '');
    if (status === 403 || status === 429 || /cf-chl|Just a moment\.\.\./i.test(body)) {
      tripBreaker(COMMUNITY_HOST, status === 429 ? '429 Too Many Requests' : `HTTP ${status}`);
      throw new SteamError(
        `Steam Community ответил ${status}: запросы к community приостановлены на 30 минут ` +
          '(breaker). Это не ошибка профиля — повторите позже.',
        'steam_rate_limited',
        { host: COMMUNITY_HOST, status }
      );
    }
    return { status, body, headers: response.headers || {} };
  }

  function apiKeyOrThrow() {
    const info = keyProvider() || {};
    if (!info.key) {
      throw new SteamError(
        'STEAM_API_KEY не задан: библиотека и часы недоступны. ' +
          'Профиль и достижения работают без ключа; ключ — env STEAM_API_KEY или config/steam-token.',
        'steam_key_missing'
      );
    }
    return info;
  }

  async function apiGet(url) {
    const response = await apiGate.request(
      API_HOST,
      () => request(url, { timeoutMs: envInt('GAMES_STEAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS) }),
      { url }
    );
    const status = Number(response.status) || 0;
    if (status === 401) {
      throw new SteamError(
        'Steam Web API отклонил ключ (401): проверьте STEAM_API_KEY. Значение ключа не печатается.',
        'steam_key_invalid',
        { host: API_HOST, status }
      );
    }
    if (status === 403) {
      throw new SteamError('Steam Web API ответил 403.', 'steam_forbidden', {
        host: API_HOST,
        status,
      });
    }
    if (status === 429) {
      tripBreaker(API_HOST, '429 Too Many Requests');
      throw new SteamError(
        'Steam Web API ответил 429: запросы приостановлены на 30 минут (breaker).',
        'steam_rate_limited',
        { host: API_HOST, status }
      );
    }
    if (status < 200 || status >= 300) {
      throw new SteamError(
        `Steam Web API ответил ${status}: ${maskSecrets(url)}`,
        'steam_http_error',
        { host: API_HOST, status }
      );
    }
    let json;
    try {
      json = JSON.parse(String(response.body || ''));
    } catch (err) {
      throw new SteamError(
        `Steam Web API вернул не JSON (${maskSecrets(url)}).`,
        'steam_http_error',
        { host: API_HOST, status }
      );
    }
    return json;
  }

  async function getProfile(target) {
    const normalized = typeof target === 'string' ? normalizeTarget(target) : target;
    const url = normalized.id64
      ? `https://${COMMUNITY_HOST}/profiles/${normalized.id64}/?xml=1`
      : `https://${COMMUNITY_HOST}/id/${encodeURIComponent(normalized.vanity)}/?xml=1`;
    const response = await communityGet(url);
    if (response.status === 404) {
      throw new SteamError(
        normalized.vanity
          ? `Профиль Steam "${normalized.vanity}" не найден.`
          : `Профиль Steam ${normalized.id64} не найден.`,
        'invalid_steamid',
        { status: 404 }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SteamError(
        `Профиль Steam ответил ${response.status}: ${maskSecrets(url)}`,
        'steam_http_error',
        { status: response.status }
      );
    }
    const profile = parseProfileXml(response.body);
    if (!profile.steamId64) {
      throw new SteamError(
        'В ответе Steam нет steamID64: профиль не существует или скрыт.',
        'invalid_steamid'
      );
    }
    return profile;
  }

  async function getPlayerSummaries(steamId64, keyOverride) {
    const info = keyOverride ? { key: keyOverride, source: 'test' } : apiKeyOrThrow();
    const url =
      `https://${API_HOST}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(info.key)}` +
      `&steamids=${encodeURIComponent(steamId64)}&format=json`;
    const json = await apiGet(url);
    const players = (json && json.response && json.response.players) || [];
    const player = Array.isArray(players) ? players[0] : null;
    if (!player) return null;
    return {
      steamId64: player.steamid ? String(player.steamid) : String(steamId64),
      personaName: player.personaname || null,
      profileUrl: player.profileurl || null,
      avatar: player.avatar || null,
      avatarMedium: player.avatarmedium || null,
      avatarFull: player.avatarfull || null,
      communityVisibilityState: numOrNull(player.communityvisibilitystate),
      profileState: numOrNull(player.profilestate),
      personaState: numOrNull(player.personastate),
      timeCreated: numOrNull(player.timecreated),
      lastLogOff: numOrNull(player.lastlogoff),
      countryCode: player.loccountrycode || null,
    };
  }

  async function getOwnedGames(steamId64, keyOverride) {
    const info = keyOverride ? { key: keyOverride, source: 'test' } : apiKeyOrThrow();
    const url =
      `https://${API_HOST}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(info.key)}` +
      `&steamid=${encodeURIComponent(steamId64)}` +
      '&include_appinfo=true&include_played_free_games=true&format=json';
    const json = await apiGet(url);
    return parseOwnedGamesResponse(json);
  }

  async function getRecentlyPlayedGames(steamId64, keyOverride) {
    const info = keyOverride ? { key: keyOverride, source: 'test' } : apiKeyOrThrow();
    const url =
      `https://${API_HOST}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(info.key)}` +
      `&steamid=${encodeURIComponent(steamId64)}&format=json`;
    const json = await apiGet(url);
    return parseRecentlyPlayedResponse(json);
  }

  async function getAchievements(steamId64, appid) {
    const url =
      `https://${COMMUNITY_HOST}/profiles/${encodeURIComponent(steamId64)}` +
      `/stats/${encodeURIComponent(appid)}?tab=achievements&xml=1`;
    const response = await communityGet(url);
    if (response.status === 404) {
      throw new SteamError(
        `Достижения игры ${appid} не найдены (у игры нет stats).`,
        'stats_not_found',
        { status: 404 }
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SteamError(
        `Достижения игры ${appid}: Steam Community ответил ${response.status}.`,
        'steam_http_error',
        { status: response.status }
      );
    }
    const parsed = parseAchievementsXml(response.body);
    if (parsed.privacyState && parsed.privacyState !== 'public') {
      throw new SteamError(
        `Достижения профиля закрыты (privacyState=${parsed.privacyState}): ` +
          'включите «Game details» → public в настройках приватности Steam.',
        'stats_private'
      );
    }
    if (!parsed.totalCount && !parsed.gameName) {
      throw new SteamError(
        `Steam не отдал достижения игры ${appid} (пустой ответ).`,
        'stats_not_found'
      );
    }
    return parsed;
  }

  async function getGlobalPercentages(appid) {
    const url =
      `https://${API_HOST}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/` +
      `?gameid=${encodeURIComponent(appid)}&format=json`;
    const json = await apiGet(url);
    return parseGlobalPercentages(json, appid);
  }

  return {
    options: { pauseMs, breakerMs },
    getProfile,
    getPlayerSummaries,
    getOwnedGames,
    getRecentlyPlayedGames,
    getAchievements,
    getGlobalPercentages,
    assertNotBlocked,
    tripBreaker,
    breakerFor,
    _keyProvider: keyProvider,
  };
}

module.exports = {
  SteamError,
  COMMUNITY_HOST,
  API_HOST,
  DEFAULT_COMMUNITY_PAUSE_MS,
  DEFAULT_BREAKER_MS,
  createClient,
  httpGet,
  buildLookup,
  maskSecrets,
  normalizeTarget,
  profileKeyOf,
  parseProfileXml,
  parseOwnedGamesResponse,
  parseRecentlyPlayedResponse,
  parseAchievementsXml,
  parseGlobalPercentages,
  normalizeOwnedGame,
  libraryFingerprint,
};
