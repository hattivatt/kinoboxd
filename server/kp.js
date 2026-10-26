'use strict';

/**
 * KinoPoisk ("Кинопоиск") import.
 *
 * Scrapes the public votes list of a KinoPoisk user profile
 * (https://www.kinopoisk.ru/user/{id}/votes/list/vs/vote/page/{n}/),
 * caches the result in cache/kp/{userId}.json and then feeds the entries
 * through the very same TMDB enrichment pipeline that is used for the
 * Letterboxd uploads (server/enrich.js).
 *
 * When the profile is already cached, an import first checks the newest page
 * (sorted by rating date) and merges only the votes added since the last
 * scrape; a full re-scrape is used when the profile shrank or changed too
 * much. If that check fails (captcha/network) the cached data is used as-is
 * and the job reports a warning.
 *
 * Only one request at a time is made to KinoPoisk, with a 1.5-2.5 s delay
 * between page requests.
 *
 * Pages are requested with 200 entries per page, not the default 50. The
 * legacy list ignores ?per_page=200 / ?navigator_per_page=200; the working
 * form is the one produced by the page's own "показывать" selector:
 *
 *   /user/{id}/votes/list/vs/vote/perpage/200/
 *   /user/{id}/votes/list/vs/vote/perpage/200/page/{n}/
 *
 * ("perpage/200/" must precede "page/{n}/"). The server also stores the
 * setting in the anonymous cookie my_perpages={"79votes":200}; returning to
 * a plain page/{n}/ URL keeps 200 per page as long as that cookie survives.
 * A profile with 1371 votes therefore needs 7 page requests instead of 28.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const cheerio = require('cheerio');

// Yandex frontends can take several seconds to accept a TCP connection.
// Node 20+ "Happy Eyeballs" aborts each address after 250 ms by default,
// which makes fetch() time out on such hosts while curl works. Give the
// connection attempt more time (harmless for the TMDB requests too).
try {
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(10000);
  }
} catch (err) {
  // Older Node versions do not have this hook; nothing to do.
}

const { HttpError, createUpload } = require('./upload');
const cache = require('./cache');
const enrich = require('./enrich');

const KP_ORIGIN = 'https://www.kinopoisk.ru';
const KP_DIR = path.join(cache.CACHE_DIR, 'kp');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 30000;
const MIN_PAGE_DELAY_MS = 1500;
const MAX_PAGE_DELAY_MS = 2500;
const MAX_SCOPE = 60; // hard stop for pagination loops

// A delta refresh normally needs exactly one page: the votes list is sorted by
// rating date (newest first), so every new rating is at the top. If page 1 is
// entirely new (the cached profile is very stale) we walk further pages until
// an entry from the cache is seen, but never more than this many pages — past
// that a full re-scrape is cheaper and safer.
const REFRESH_MAX_PAGES = 5;

// The list page offers 10/25/50/75/100/200 per page. 200 is applied through
// the path segment built by the page's own selector (see the file header).
const PER_PAGE = 200;
const PER_PAGE_COOKIE = 'my_perpages';
const PER_PAGE_COOKIE_KEY = '79votes'; // KinoPoisk's list type id for "оценки"

const jobs = new Map(); // uploadId -> kp job

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class KpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KpError';
    this.code = code || 'kp_error';
  }
}

function blockedError() {
  return new KpError(
    'Кинопоиск закрыл доступ: капча/лимит запросов, повторите позже.',
    'kp_blocked'
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomPageDelay() {
  return MIN_PAGE_DELAY_MS + Math.floor(Math.random() * (MAX_PAGE_DELAY_MS - MIN_PAGE_DELAY_MS + 1));
}

/**
 * URL of a votes page with the per-page setting applied. Page 1 is
 * ".../perpage/200/", later pages ".../perpage/200/page/{n}/"; both were
 * verified against the live site (200 entries, numbering 1..200, 201..400).
 */
function votesPageUrl(userId, page) {
  const base = `${KP_ORIGIN}/user/${userId}/votes/list/vs/vote/perpage/${PER_PAGE}/`;
  return page > 1 ? `${base}page/${page}/` : base;
}

function perPageCookieValue() {
  return encodeURIComponent(JSON.stringify({ [PER_PAGE_COOKIE_KEY]: PER_PAGE }));
}

function parseUserId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  const fromUrl = value.match(/\/user\/(\d+)(?:[/?#]|$)/);
  if (fromUrl) return fromUrl[1];
  // Bare numeric id is accepted as a convenience.
  if (/^\d+$/.test(value)) return value;
  return null;
}

function kpCachePath(userId) {
  return path.join(KP_DIR, `${userId}.json`);
}

function readKpCache(userId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(kpCachePath(userId), 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[kp] Could not read cache for user ${userId}: ${err.message}`);
    }
  }
  return null;
}

async function writeKpCache(userId, data) {
  await fsp.mkdir(KP_DIR, { recursive: true });
  const target = kpCachePath(userId);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fsp.rename(tmp, target);
}

/* ------------------------------------------------------------------ */
/* HTTP with an anonymous cookie jar                                   */
/* ------------------------------------------------------------------ */

function makeJar() {
  return new Map();
}

function storeCookies(jar, response) {
  if (!jar) return;
  let list = [];
  if (typeof response.headers.getSetCookie === 'function') {
    list = response.headers.getSetCookie();
  } else {
    const single = response.headers.get('set-cookie');
    if (single) list = [single];
  }
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const rest = String(raw).toLowerCase();
    if (/max-age=0(?:;|$)/.test(rest)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function cookieHeader(jar) {
  if (!jar || jar.size === 0) return null;
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function kpRequest(url, jar) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  const cookie = cookieHeader(jar);
  if (cookie) headers.Cookie = cookie;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new KpError(
      `Не удалось связаться с Кинопоиском: ${err.message}`,
      'kp_network_error'
    );
  }
  storeCookies(jar, response);
  let body = '';
  try {
    body = await response.text();
  } catch (err) {
    body = '';
  }
  return { status: response.status, headers: response.headers, body, url };
}

/** Follow redirects manually so cookies from every hop are collected. */
async function kpRequestFollow(url, jar, maxHops) {
  let current = url;
  const hops = maxHops || 10;
  for (let i = 0; i < hops; i++) {
    const res = await kpRequest(current, jar);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        current = new URL(location, current).toString();
        continue;
      }
    }
    return res;
  }
  throw new KpError('Кинопоиск вернул слишком много редиректов.', 'kp_too_many_redirects');
}

function isRedirectToSso(res) {
  if (res.status < 300 || res.status >= 400) return false;
  const location = res.headers.get('location') || '';
  return /sso\.kinopoisk\.ru|passport\.yandex\.ru|sso\.passport\.yandex\.ru/.test(
    location
  );
}

function isCaptchaHtml(html) {
  if (!html) return false;
  return (
    /<form[^>]+action="[^"]*captcha/i.test(html) ||
    /class="[^"]*SmartCaptcha/i.test(html) ||
    /class="[^"]*CheckboxCaptcha/i.test(html) ||
    /id="[^"]*SmartCaptcha/i.test(html) ||
    /showcaptcha/i.test(html)
  );
}

function extractUuid(location) {
  try {
    const url = new URL(location, KP_ORIGIN);
    return url.searchParams.get('uuid');
  } catch (err) {
    return null;
  }
}

/**
 * Anonymous bootstrap: the votes page redirects to Yandex SSO, which hands
 * out the cookies (yandexuid, _yasc, _csrf, ...) required by KinoPoisk.
 */
async function bootstrap(jar, targetUrl) {
  const first = await kpRequest(targetUrl, jar);
  if (first.status === 200) {
    if (isCaptchaHtml(first.body)) throw blockedError();
    return first;
  }
  if (first.status === 403 || first.status === 429) throw blockedError();
  if (first.status < 300 || first.status >= 400) {
    throw new KpError(
      `Кинопоиск ответил HTTP ${first.status} вместо страницы оценок.`,
      'kp_http_error'
    );
  }

  const location = first.headers.get('location') || '';
  const uuid = extractUuid(location);
  if (!uuid) {
    throw new KpError(
      'Кинопоиск не вернул SSO-идентификатор (возможно, профиль закрыт).',
      'kp_no_uuid'
    );
  }

  const installUrl =
    'https://sso.kinopoisk.ru/install' +
    `?uuid=${encodeURIComponent(uuid)}` +
    `&retpath=${encodeURIComponent(targetUrl)}`;
  const install = await kpRequestFollow(installUrl, jar);
  if (isCaptchaHtml(install.body)) throw blockedError();
  if (install.status === 403 || install.status === 429) throw blockedError();
  if (install.status >= 400) {
    throw new KpError(
      `SSO Кинопоиска ответил HTTP ${install.status}.`,
      'kp_sso_error'
    );
  }
  return install;
}

/**
 * Fetch one votes page, re-bootstrapping at most once (two bootstrap attempts
 * per job in total) if the session cookies are not accepted.
 */
async function fetchVotesPage(url, votesRoot, jar, state) {
  let res = await kpRequest(url, jar);

  const retryWithBootstrap = async () => {
    if (state.bootstrapAttempts >= 2) {
      throw blockedError();
    }
    state.bootstrapAttempts++;
    const boot = await bootstrap(jar, votesRoot);
    if (isCaptchaHtml(boot.body)) throw blockedError();
    await sleep(500);
    return kpRequest(url, jar);
  };

  if (isRedirectToSso(res)) {
    res = await retryWithBootstrap();
  }
  if (isCaptchaHtml(res.body)) {
    res = await retryWithBootstrap();
  }

  if (res.status === 403 || res.status === 429) throw blockedError();
  if (isRedirectToSso(res)) throw blockedError();
  if (res.status !== 200) {
    throw new KpError(
      `Кинопоиск ответил HTTP ${res.status} на странице оценок.`,
      'kp_http_error'
    );
  }
  if (isCaptchaHtml(res.body)) throw blockedError();
  return res.body;
}

/* ------------------------------------------------------------------ */
/* HTML parsing                                                        */
/* ------------------------------------------------------------------ */

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYears(text) {
  const years = [];
  const re = /(?:19|20)\d{2}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const year = Number(match[0]);
    if (year >= 1890 && year <= 2100) years.push(year);
  }
  return years;
}

function stripTrailingYears(text) {
  return cleanText(String(text || '').replace(/\s*\((?:[^()]*\d{4}[^()]*)\)\s*$/, ''));
}

function parseDateToIso(text) {
  const match = String(text || '').match(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/
  );
  if (!match) return null;
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  const year = match[3];
  const hours = (match[4] || '00').padStart(2, '0');
  const minutes = (match[5] || '00').padStart(2, '0');
  // KinoPoisk timestamps are Moscow time (UTC+3).
  const date = new Date(`${year}-${month}-${day}T${hours}:${minutes}:00+03:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function detectNick($) {
  const selectors = [
    '.profile_name a',
    '.profile_name',
    '.profileName',
    '.profile h1',
    '.profile-header h1',
    '.headerProfile h1',
    'h1.profileName',
    '.userName',
  ];
  for (const selector of selectors) {
    const text = cleanText($(selector).first().text());
    if (text && text.length <= 100) return text;
  }
  // <title>Профиль: Axis - Оценки</title>
  const title = cleanText($('title').first().text());
  const titleMatch = title.match(/^Профиль:\s*(.+?)\s*[-–—|]/i);
  if (titleMatch) return cleanText(titleMatch[1]);
  const og = cleanText($('meta[property="og:title"]').attr('content'));
  if (og) {
    const withoutSite = og.replace(/\s*[-—|]\s*Кинопоиск.*$/i, '').trim();
    const match = withoutSite.match(/^(?:Оценки|Профиль|Фильмы|Рецензии)\s+(.+)$/i);
    if (match) return cleanText(match[1]);
  }
  return null;
}

/**
 * Total number of records in the profile, parsed from the pagination line
 * "1—200 из 1371" ("1–200 of 1371"). Returns null when the page does not
 * contain a recognisable summary; callers then skip count-based checks.
 */
function parseTotalCount($) {
  const readNumber = (value) => {
    const digits = String(value == null ? '' : value).replace(/[^\d]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const parseFrom = (text) => {
    const value = cleanText(text);
    if (!value) return null;
    const match = value.match(
      /(\d[\d\s\u00a0]*)\s*[—–-]\s*\d[\d\s\u00a0]*\s*из\s*(\d[\d\s\u00a0]*)/i
    );
    return match ? readNumber(match[2]) : null;
  };

  // Prefer the pagination widget, then fall back to the whole page text.
  const selectors = [
    '.navigator',
    '.pages',
    '.pagination',
    '.paginator',
    '.pageNavigation',
    '.pager',
  ];
  for (const selector of selectors) {
    const node = $(selector).first();
    if (node.length === 0) continue;
    const total = parseFrom(node.text());
    if (total != null) return total;
  }
  return parseFrom($('body').text());
}

function parseVotesPage(html) {
  const $ = cheerio.load(html);
  const entries = [];
  let lastNum = null;
  let firstNum = null;
  let skipped = 0;

  $('.profileFilmsList .item').each((_, element) => {
    const item = $(element);

    const numText = cleanText(item.find('.num').first().text());
    const numMatch = numText.match(/\d+/);
    const num = numMatch ? Number(numMatch[0]) : null;
    if (num != null) {
      if (firstNum == null) firstNum = num;
      lastNum = num;
    }

    const nameLink = item.find('.nameRus a').first();
    let href = nameLink.attr('href') || '';
    if (!href) {
      href =
        item.find('a[href*="/film/"]').first().attr('href') ||
        item.find('a[href*="/series/"]').first().attr('href') ||
        '';
    }
    const linkMatch = String(href).match(/\/(film|series)\/(\d+)\//);
    if (!linkMatch) {
      skipped++;
      return;
    }
    const type = linkMatch[1] === 'series' ? 'tv' : 'film';
    const kpId = Number(linkMatch[2]);

    const nameNode = item.find('.nameRus').first();
    const ruText = cleanText(nameNode.text());
    if (!ruText) {
      skipped++;
      return;
    }
    const years = extractYears(ruText);
    const range = ruText.match(
      /((?:19|20)\d{2})\s*[–—-]\s*((?:19|20)\d{2})/
    );
    // The last year in the node is the release year (titles can contain
    // their own years, e.g. "2012 (2009)"). For series the parenthetical
    // range "(2021 – 2024)" describes the run, so the first year (the start
    // year) is what TMDB's first_air_date_year expects.
    let year = years.length ? years[years.length - 1] : null;
    let yearEnd = null;
    if (type === 'tv' && range) {
      year = Number(range[1]);
      yearEnd = Number(range[2]);
    } else if (range && Number(range[2]) === year) {
      yearEnd = Number(range[2]);
    }

    const titleRu = stripTrailingYears(ruText) || ruText;

    let titleEn = cleanText(item.find('.nameEng').first().text());
    if (titleEn) {
      titleEn = stripTrailingYears(titleEn) || titleEn;
    }

    let rating = null;
    const voteNodes = item.find('div.vote:not(.myvote)');
    voteNodes.each((__, voteElement) => {
      if (rating !== null) return;
      const text = cleanText($(voteElement).text());
      const match = text.match(/\d+(?:[.,]\d+)?/);
      if (!match) return;
      const value = Number(match[0].replace(',', '.'));
      if (Number.isFinite(value) && value >= 1 && value <= 10) {
        rating = Math.round(value);
      }
    });

    const ratedAt = parseDateToIso(cleanText(item.find('.date').first().text()));

    entries.push({
      kpId,
      type,
      titleRu,
      titleEn: titleEn || null,
      year,
      yearEnd,
      ratedAt,
      rating,
    });
  });

  const pages = new Set();
  $('a[href], form[action]').each((_, element) => {
    const href = $(element).attr('href') || $(element).attr('action') || '';
    const match = String(href).match(/\/votes\/list\/vs\/vote\/page\/(\d+)\//);
    if (match) pages.add(Number(match[1]));
  });
  const maxPage = pages.size > 0 ? Math.max(...pages) : null;

  return {
    entries,
    lastNum,
    firstNum,
    skipped,
    maxPage,
    totalCount: parseTotalCount($),
    kpNick: detectNick($),
  };
}

/* ------------------------------------------------------------------ */
/* Scraping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Open an anonymous KinoPoisk session: bootstrap the SSO cookies against the
 * 200-per-page votes root and pin the perpage cookie. Returns the cookie jar
 * and the (possibly already fetched) first page response.
 */
async function openVotesSession(userId) {
  // Bootstrap against the 200-per-page page 1, so the SSO install endpoint
  // redirects straight to a 200-entry page even before the cookie is stored.
  const votesRoot = votesPageUrl(userId, 1);
  const pageUrl = (page) => votesPageUrl(userId, page);

  const jar = makeJar();
  const state = { bootstrapAttempts: 0 };

  let boot;
  try {
    boot = await bootstrap(jar, votesRoot);
    state.bootstrapAttempts = 1;
  } catch (err) {
    // One more bootstrap attempt (cookies from both attempts accumulate).
    state.bootstrapAttempts = 1;
    console.warn(
      `[kp ${userId}] bootstrap failed (${err.message}); retrying once`
    );
    await sleep(randomPageDelay());
    boot = await bootstrap(jar, votesRoot);
    state.bootstrapAttempts = 2;
  }

  // Cold bootstrap responses reset my_perpages to "[]"; pin the setting after
  // the session cookies exist so every subsequent page/{n}/ request keeps
  // 200 entries per page. (The perpage URL already does this server-side —
  // this is a belt-and-braces measure against redirects dropping the path.)
  jar.set(PER_PAGE_COOKIE, perPageCookieValue());

  return { votesRoot, pageUrl, jar, state, boot };
}

/**
 * Parse page 1, reusing the bootstrap response when it is a genuine
 * 200-per-page page 1 and requesting it again otherwise.
 */
async function fetchFirstVotesPage(session, userId) {
  let parsed = null;
  const boot = session.boot;

  if (boot.status === 200 && boot.body.includes('profileFilmsList')) {
    // The install endpoint already redirected to the votes page. Only trust
    // it when it really is a 200-per-page page 1: a 50-entry page 1 with a
    // large pagination would make us crawl the wrong sequence.
    const candidate = parseVotesPage(boot.body);
    const candidatePages = candidate.maxPage || 1;
    if (
      candidate.entries.length > 0 &&
      (candidatePages === 1 || candidate.entries.length >= PER_PAGE)
    ) {
      parsed = candidate;
    } else if (candidate.entries.length > 0) {
      console.warn(
        `[kp ${userId}] bootstrap landed on a ${candidate.entries.length}-entry ` +
          `page (maxPage=${candidatePages}); refetching with perpage=${PER_PAGE}`
      );
    }
  }
  if (!parsed) {
    const html = await fetchVotesPage(
      session.pageUrl(1),
      session.votesRoot,
      session.jar,
      session.state
    );
    parsed = parseVotesPage(html);
  }
  return parsed;
}

async function scrapeVotes(userId, onProgress) {
  const session = await openVotesSession(userId);

  let kpNick = null;
  let pageTotal = null;
  let page = 1;
  let expectedNum = 1;

  let parsed = await fetchFirstVotesPage(session, userId);

  const byKpId = new Map();
  if (parsed.kpNick) kpNick = parsed.kpNick;
  if (parsed.entries.length === 0) {
    throw new KpError(
      'Не удалось разобрать список оценок Кинопоиска (страница пуста).',
      'kp_parse_error'
    );
  }
  if (parsed.firstNum != null && parsed.firstNum !== expectedNum) {
    console.warn(
      `[kp ${userId}] page 1 sequence starts at ${parsed.firstNum}, expected ${expectedNum}`
    );
  }
  if (
    parsed.firstNum != null &&
    parsed.lastNum != null &&
    parsed.lastNum - parsed.firstNum + 1 !== parsed.entries.length
  ) {
    console.warn(
      `[kp ${userId}] page 1 numbering gap: ${parsed.firstNum}..${parsed.lastNum}, ` +
        `parsed ${parsed.entries.length} entries`
    );
  }
  if (parsed.lastNum != null) expectedNum = parsed.lastNum + 1;
  pageTotal = parsed.maxPage || 1;
  if (pageTotal > MAX_SCOPE) pageTotal = MAX_SCOPE;
  for (const entry of parsed.entries) {
    if (!byKpId.has(entry.kpId)) byKpId.set(entry.kpId, entry);
  }
  if (onProgress) {
    onProgress({
      page,
      pageTotal,
      total: byKpId.size,
      lastNum: parsed.lastNum,
    });
  }
  console.log(
    `[kp ${userId}] page 1/${pageTotal} entries=${byKpId.size} lastNum=${parsed.lastNum}`
  );

  const startedAt = Date.now();
  while (page < pageTotal) {
    await sleep(randomPageDelay());
    page++;
    const nextHtml = await fetchVotesPage(
      session.pageUrl(page),
      session.votesRoot,
      session.jar,
      session.state
    );
    parsed = parseVotesPage(nextHtml);
    if (parsed.kpNick && !kpNick) kpNick = parsed.kpNick;
    if (parsed.maxPage && parsed.maxPage > pageTotal) {
      pageTotal = Math.min(parsed.maxPage, MAX_SCOPE);
    }
    if (parsed.entries.length === 0) {
      console.warn(`[kp ${userId}] page ${page} has no entries; stopping.`);
      break;
    }
    if (parsed.firstNum != null && parsed.firstNum !== expectedNum) {
      console.warn(
        `[kp ${userId}] page ${page} sequence starts at ${parsed.firstNum}, expected ${expectedNum}`
      );
    }
    if (
      parsed.firstNum != null &&
      parsed.lastNum != null &&
      parsed.lastNum - parsed.firstNum + 1 !== parsed.entries.length
    ) {
      console.warn(
        `[kp ${userId}] page ${page} numbering gap: ${parsed.firstNum}..${parsed.lastNum}, ` +
          `parsed ${parsed.entries.length} entries`
      );
    }
    if (parsed.lastNum != null) expectedNum = parsed.lastNum + 1;
    for (const entry of parsed.entries) {
      if (!byKpId.has(entry.kpId)) byKpId.set(entry.kpId, entry);
    }
    if (onProgress) {
      onProgress({
        page,
        pageTotal,
        total: byKpId.size,
        lastNum: parsed.lastNum,
      });
    }
    console.log(
      `[kp ${userId}] page ${page}/${pageTotal} entries=${byKpId.size} lastNum=${parsed.lastNum}`
    );
  }

  const entries = [...byKpId.values()];
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[kp ${userId}] scraped ${entries.length} entries from ${page} page(s) ` +
      `in ${seconds}s (skipped=${parsed.skipped})`
  );

  return {
    entries,
    kpNick,
    pageTotal,
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Delta refresh (cached profile -> check KinoPoisk for new votes)      */
/* ------------------------------------------------------------------ */

/**
 * Newest ratedAt in an entry list (ISO strings sort lexicographically).
 * Used only for logging/diagnostics: novelty itself is decided by kpId set
 * membership, because .num is the position at the time of the scrape and
 * shifts whenever a rating is added.
 */
function newestRatedAt(entries) {
  let newest = null;
  for (const entry of entries || []) {
    if (!entry || !entry.ratedAt) continue;
    const value = String(entry.ratedAt);
    if (!newest || value > newest) newest = value;
  }
  return newest;
}

/**
 * Prepend the freshly rated entries to the cached list, newest first, and
 * deduplicate by kpId. Cached entries keep their original order/fields.
 */
function mergeKpEntries(newEntries, cachedEntries) {
  const orderedNew = [...(newEntries || [])].sort((a, b) => {
    const left = a && a.ratedAt ? String(a.ratedAt) : '';
    const right = b && b.ratedAt ? String(b.ratedAt) : '';
    if (left === right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    return left < right ? 1 : -1;
  });

  const seen = new Set();
  const merged = [];
  for (const entry of [...orderedNew, ...(cachedEntries || [])]) {
    const kpId = Number(entry && entry.kpId);
    if (!Number.isFinite(kpId) || seen.has(kpId)) continue;
    seen.add(kpId);
    merged.push(entry);
  }
  return merged;
}

/**
 * Compare the cached profile with KinoPoisk.
 *
 * The votes list is ordered by rating date, newest first, so page 1 holds
 * every rating added since the last scrape. We stop at the first entry that
 * is already in the cache (the intersection point). If page 1 is entirely
 * new (very stale cache) pages 2..REFRESH_MAX_PAGES are fetched until an
 * intersection appears; if it still is not there, a full re-scrape is
 * requested (the delta would be unbounded anyway).
 *
 * A smaller total count than the cache, or a merged size that would exceed
 * KinoPoisk's reported total, means ratings were removed in KinoPoisk. Then
 * merge would silently resurrect deleted entries, so the caller falls back
 * to a full re-scrape as well.
 *
 * Returns { needsFullScrape, reason?, newEntries, pagesFetched, totalCount,
 * kpNick }. Throws KpError when the network/captcha/parse step fails; the
 * caller then keeps the stale cache.
 */
async function refreshVotes(userId, cached, onProgress) {
  const cachedEntries = Array.isArray(cached.entries) ? cached.entries : [];
  const cachedIds = new Set();
  for (const entry of cachedEntries) {
    const kpId = Number(entry && entry.kpId);
    if (Number.isFinite(kpId)) cachedIds.add(kpId);
  }

  if (cachedIds.size === 0) {
    // Nothing to diff against; treat this like a first import.
    return {
      needsFullScrape: true,
      reason: 'cached profile has no entries',
      newEntries: [],
      pagesFetched: 0,
      totalCount: null,
      kpNick: cached.kpNick == null ? null : cached.kpNick,
    };
  }

  const session = await openVotesSession(userId);
  let parsed = await fetchFirstVotesPage(session, userId);
  if (!parsed.entries || parsed.entries.length === 0) {
    throw new KpError(
      'Не удалось разобрать список оценок Кинопоиска (страница пуста).',
      'kp_parse_error'
    );
  }

  let pagesFetched = 1;
  let kpNick = parsed.kpNick || cached.kpNick || null;
  let totalCount = parsed.totalCount;
  let intersection = false;
  const newById = new Map();

  const absorb = (pageParsed) => {
    if (pageParsed.kpNick) kpNick = pageParsed.kpNick;
    if (pageParsed.totalCount != null) totalCount = pageParsed.totalCount;
    for (const entry of pageParsed.entries) {
      const kpId = Number(entry.kpId);
      if (!Number.isFinite(kpId)) continue;
      if (cachedIds.has(kpId)) {
        intersection = true;
        continue;
      }
      if (!newById.has(kpId)) newById.set(kpId, entry);
    }
  };

  absorb(parsed);
  if (onProgress) {
    onProgress({ page: 1, pageTotal: 1, total: newById.size });
  }

  // Page 1 was completely unknown: keep walking until the cached tail is
  // reached. A short page means this was the end of the list, so there is
  // nothing more to compare against anyway.
  while (
    !intersection &&
    pagesFetched < REFRESH_MAX_PAGES &&
    parsed.entries.length >= PER_PAGE
  ) {
    await sleep(randomPageDelay());
    pagesFetched++;
    const html = await fetchVotesPage(
      session.pageUrl(pagesFetched),
      session.votesRoot,
      session.jar,
      session.state
    );
    parsed = parseVotesPage(html);
    if (!parsed.entries || parsed.entries.length === 0) break;
    absorb(parsed);
    if (onProgress) {
      onProgress({
        page: pagesFetched,
        pageTotal: REFRESH_MAX_PAGES,
        total: newById.size,
      });
    }
    console.log(
      `[kp ${userId}] refresh page ${pagesFetched}/${REFRESH_MAX_PAGES} ` +
        `new=${newById.size} intersection=${intersection}`
    );
  }

  const newEntries = [...newById.values()];
  const base = {
    newEntries,
    pagesFetched,
    totalCount,
    kpNick,
  };

  if (!intersection) {
    return {
      ...base,
      needsFullScrape: true,
      reason:
        cachedEntries.length > 0
          ? `no cached entry found in ${pagesFetched} page(s)`
          : 'cache is empty',
    };
  }

  if (
    totalCount != null &&
    (totalCount < cachedIds.size || cachedIds.size + newEntries.length > totalCount)
  ) {
    return {
      ...base,
      needsFullScrape: true,
      reason:
        `count mismatch: KinoPoisk reports ${totalCount}, ` +
        `cache has ${cachedIds.size}, new ${newEntries.length}`,
    };
  }

  console.log(
    `[kp ${userId}] delta refresh: ${newEntries.length} new entry(ies) ` +
      `from ${pagesFetched} page(s), cache=${cachedIds.size}, ` +
      `KP total=${totalCount == null ? '?' : totalCount}, ` +
      `newest cached=${newestRatedAt(cachedEntries) || '?'}`
  );

  return { ...base, needsFullScrape: false };
}

/* ------------------------------------------------------------------ */
/* Dataset + enrichment                                                */
/* ------------------------------------------------------------------ */

function buildDataset(userId, cacheData) {
  const fetchedAt = cacheData.fetchedAt || new Date().toISOString();
  const kpNick = cacheData.kpNick == null ? null : cacheData.kpNick;
  const films = [];
  const events = [];
  const seen = new Set();
  let movieCount = 0;
  let tvCount = 0;

  for (const entry of cacheData.entries || []) {
    if (!entry || entry.kpId == null) continue;
    const kpId = Number(entry.kpId);
    if (!Number.isFinite(kpId) || seen.has(kpId)) continue;
    seen.add(kpId);

    const slug = `kp-${kpId}`;
    const kind = entry.type === 'tv' ? 'tv' : 'movie';
    if (kind === 'tv') tvCount++;
    else movieCount++;

    const date = entry.ratedAt ? String(entry.ratedAt).slice(0, 10) : null;
    const titleEn = entry.titleEn ? cleanText(entry.titleEn) : null;
    const titleRu = entry.titleRu ? cleanText(entry.titleRu) : '';
    const title = titleEn || titleRu;

    films.push({
      slug,
      kpId,
      // Public page of the title: /film/ for movies, /series/ for TV.
      kpUrl: `${KP_ORIGIN}/${kind === 'tv' ? 'series' : 'film'}/${kpId}/`,
      title,
      titleRu,
      titleEn,
      year: Number.isFinite(entry.year) ? entry.year : null,
      kind,
      rating:
        Number.isFinite(entry.rating) && entry.rating >= 1 && entry.rating <= 10
          ? entry.rating
          : null,
      watchedDate: date,
      searchLanguage: titleEn ? 'en-US' : 'ru-RU',
    });

    if (date) {
      events.push({
        slug,
        date,
        rating:
          Number.isFinite(entry.rating) && entry.rating >= 1 && entry.rating <= 10
            ? entry.rating
            : null,
        source: 'kp',
      });
    }
  }

  let dateFrom = null;
  let dateTo = null;
  for (const event of events) {
    if (!dateFrom || event.date < dateFrom) dateFrom = event.date;
    if (!dateTo || event.date > dateTo) dateTo = event.date;
  }

  const ratedFilms = films.filter((film) => film.rating !== null).length;

  return {
    summary: {
      source: {
        type: 'kinopoisk',
        kpUserId: String(userId),
        kpNick,
        fetchedAt,
      },
      films: films.length,
      ratedFilms,
      movieCount,
      tvCount,
      dateFrom,
      dateTo,
    },
    films,
    events,
  };
}

function applyDataset(upload, dataset) {
  upload.summary = dataset.summary;
  upload.films = dataset.films;
  upload.events = dataset.events;
  upload.source = { type: 'kinopoisk' };
}

function startEnrichment(upload, job) {
  job.stage = 'enrich';
  job.total = upload.films.length;
  enrich.startEnrich(upload);
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

// KinoPoisk requests are serialized across all imports so that a second
// import never runs in parallel with the first one.
let scrapeChain = Promise.resolve();

function startImport(rawUrl) {
  const userId = parseUserId(rawUrl);
  if (!userId) {
    throw new HttpError(
      400,
      'URL должен содержать идентификатор пользователя Кинопоиска (/user/{id}/).',
      'invalid_kinopoisk_url'
    );
  }

  // Coalesce concurrent imports of the same profile: do not scrape, refresh
  // (or enrich) one user twice in parallel.
  for (const [existingId, existingJob] of jobs) {
    if (
      existingJob.userId === userId &&
      (existingJob.stage === 'scrape' ||
        existingJob.stage === 'refresh' ||
        existingJob.stage === 'enrich')
    ) {
      return { uploadId: existingId, userId, ...getStatus(existingId) };
    }
  }

  const upload = createUpload({
    summary: {
      source: {
        type: 'kinopoisk',
        kpUserId: String(userId),
        kpNick: null,
        fetchedAt: null,
      },
      films: 0,
      ratedFilms: 0,
      movieCount: 0,
      tvCount: 0,
      dateFrom: null,
      dateTo: null,
    },
    films: [],
    events: [],
  });

  const cached = readKpCache(userId);

  const job = {
    uploadId: upload.uploadId,
    userId,
    stage: cached ? 'refresh' : 'scrape',
    page: cached ? 1 : 0,
    pageTotal: cached ? 1 : null,
    total: 0,
    error: null,
    warning: null,
    startedAt: Date.now(),
  };
  jobs.set(upload.uploadId, job);

  if (cached) {
    console.log(
      `[kp ${userId}] cache hit (${cached.entries.length} entries, fetched ${cached.fetchedAt}); refreshing delta`
    );
  }

  // Both a full scrape and a delta refresh are serialized through the same
  // chain: KinoPoisk requests never run in parallel across imports.
  scrapeChain = scrapeChain
    .then(() => runImport(upload, job, cached))
    .catch((err) => {
      console.error('[kp] import queue error:', err);
      // A throw outside scrapeVotes' own try/catch (e.g. a disk error while
      // merging the delta) must not leave the job stuck in "refresh" forever.
      if (job.stage !== 'done' && job.stage !== 'failed') {
        job.stage = 'failed';
        job.error = `Не удалось импортировать профиль Кинопоиска: ${
          err && err.message ? err.message : 'неизвестная ошибка'
        }`;
      }
    });

  return { uploadId: upload.uploadId, userId, ...getStatus(upload.uploadId) };
}

/**
 * Entry point of a queued import. Without a cached profile this is a plain
 * full scrape; with one, only new votes are fetched and merged into the
 * cache (falling back to a full scrape when the profile shrank or changed
 * too much).
 */
async function runImport(upload, job, cached) {
  if (!cached) return runScrape(upload, job);

  job.stage = 'refresh';
  job.page = 1;
  job.pageTotal = 1;
  job.total = Array.isArray(cached.entries) ? cached.entries.length : 0;

  let result;
  try {
    result = await refreshVotes(job.userId, cached, (progress) => {
      job.page = progress.page;
      if (progress.pageTotal != null) job.pageTotal = progress.pageTotal;
    });
  } catch (err) {
    // KinoPoisk is unavailable (captcha, network, parser): the cached
    // profile is still valid data from the last successful import, so the
    // import succeeds with a warning instead of failing outright.
    const reason = err && err.message ? err.message : 'неизвестная ошибка';
    job.warning = `Обновление профиля не удалось, взяты данные из кэша: ${reason}`;
    console.warn(`[kp ${job.userId}] refresh failed; keeping cache: ${reason}`);
    applyDataset(upload, buildDataset(job.userId, cached));
    job.page = null;
    job.pageTotal = null;
    job.total = Array.isArray(cached.entries) ? cached.entries.length : 0;
    startEnrichment(upload, job);
    return;
  }

  if (result.needsFullScrape) {
    console.log(
      `[kp ${job.userId}] delta refresh -> full re-scrape (${result.reason})`
    );
    return runScrape(upload, job);
  }

  let data = cached;
  if (result.newEntries.length > 0) {
    data = {
      fetchedAt: new Date().toISOString(),
      kpNick:
        result.kpNick != null
          ? result.kpNick
          : cached.kpNick == null
          ? null
          : cached.kpNick,
      entries: mergeKpEntries(result.newEntries, cached.entries),
    };
    await writeKpCache(job.userId, data);
    console.log(
      `[kp ${job.userId}] delta merged: +${result.newEntries.length} new, ` +
        `${data.entries.length} entries total`
    );
  } else {
    // No changes: do not touch the cache file (keep its fetchedAt honest).
    console.log(
      `[kp ${job.userId}] delta refresh: no new votes, cache unchanged ` +
        `(${cached.entries.length} entries)`
    );
  }

  applyDataset(upload, buildDataset(job.userId, data));
  job.page = result.pagesFetched || 1;
  job.pageTotal = job.page;
  job.total = data.entries.length;
  startEnrichment(upload, job);
}

async function runScrape(upload, job) {
  job.stage = 'scrape';
  job.page = 0;
  job.pageTotal = null;
  try {
    const result = await scrapeVotes(job.userId, (progress) => {
      job.page = progress.page;
      if (progress.pageTotal != null) job.pageTotal = progress.pageTotal;
      job.total = progress.total;
    });
    const data = {
      fetchedAt: new Date().toISOString(),
      kpNick: result.kpNick,
      entries: result.entries,
    };
    await writeKpCache(job.userId, data);
    applyDataset(upload, buildDataset(job.userId, data));
    job.page = result.pageTotal;
    job.pageTotal = result.pageTotal;
    job.total = result.entries.length;
    startEnrichment(upload, job);
  } catch (err) {
    job.stage = 'failed';
    job.error =
      err && err.code && err.code.startsWith('kp_')
        ? err.message
        : `Не удалось импортировать профиль Кинопоиска: ${
            err && err.message ? err.message : 'неизвестная ошибка'
          }`;
    console.error(`[kp ${job.userId}] import failed: ${job.error}`);
  }
}

function getStatus(uploadId) {
  const job = jobs.get(uploadId);
  if (!job) return null;

  const enrichJob = enrich.getJob(uploadId);
  let stage = job.stage;
  if (stage === 'enrich' && enrichJob && enrichJob.done) {
    stage = 'done';
    job.stage = 'done';
  }

  const status = {
    stage,
    page: job.page,
    pageTotal: job.pageTotal,
    total: enrichJob ? enrichJob.total : job.total,
    matched: enrichJob ? enrichJob.matched : 0,
    failed: enrichJob ? enrichJob.failed : 0,
    done: stage === 'done',
    warning: job.warning || null,
  };
  if (job.error) status.error = job.error;
  return status;
}

function getJob(uploadId) {
  return jobs.get(uploadId) || null;
}

module.exports = {
  KpError,
  KP_DIR,
  readKpCache,
  parseUserId,
  parseVotesPage,
  mergeKpEntries,
  refreshVotes,
  buildDataset,
  startImport,
  getStatus,
  getJob,
};
