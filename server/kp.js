'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const net = require('net');
const cheerio = require('cheerio');

try {
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(10000);
  }
} catch (err) {
}

const { HttpError, createUpload } = require('./upload');
const cache = require('./cache');
const enrich = require('./enrich');
const { createJobs } = require('./core/jobs');
const { fetchOnce, defaultSleep } = require('./core/http');
const sources = require('./core/sources');

const KP_ORIGIN = 'https://www.kinopoisk.ru';
const KP_DIR = path.join(cache.CACHE_DIR, 'kp');

const USER_AGENT = sources.userAgent('kinopoisk');

const REQUEST_TIMEOUT_MS = sources.timeoutMs('kinopoisk');
const MIN_PAGE_DELAY_MS = sources.SOURCES.kinopoisk.pauseMs;
const MAX_PAGE_DELAY_MS = sources.SOURCES.kinopoisk.pauseMaxMs;
const MAX_SCOPE = 60;

const REFRESH_MAX_PAGES = 5;

const PER_PAGE = 200;
const PER_PAGE_COOKIE = 'my_perpages';
const PER_PAGE_COOKIE_KEY = '79votes';

const jobs = createJobs({
  name: 'films-kp',
  idPrefix: 'films-kp',
  maxJobs: 0,
  keyOf: (job) => job.uploadId,
});

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

const sleep = defaultSleep;

function randomPageDelay() {
  return MIN_PAGE_DELAY_MS + Math.floor(Math.random() * (MAX_PAGE_DELAY_MS - MIN_PAGE_DELAY_MS + 1));
}

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
    response = await fetchOnce(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: 'kp',
    });
  } catch (err) {
    throw new KpError(
      `Не удалось связаться с Кинопоиском: ${err.message}`,
      'kp_network_error'
    );
  }
  storeCookies(jar, response);
  return { status: response.status, headers: response.headers, body: response.body, url };
}

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

async function openVotesSession(userId) {
  const votesRoot = votesPageUrl(userId, 1);
  const pageUrl = (page) => votesPageUrl(userId, page);

  const jar = makeJar();
  const state = { bootstrapAttempts: 0 };

  let boot;
  try {
    boot = await bootstrap(jar, votesRoot);
    state.bootstrapAttempts = 1;
  } catch (err) {
    state.bootstrapAttempts = 1;
    console.warn(
      `[kp ${userId}] bootstrap failed (${err.message}); retrying once`
    );
    await sleep(randomPageDelay());
    boot = await bootstrap(jar, votesRoot);
    state.bootstrapAttempts = 2;
  }

  jar.set(PER_PAGE_COOKIE, perPageCookieValue());

  return { votesRoot, pageUrl, jar, state, boot };
}

async function fetchFirstVotesPage(session, userId) {
  let parsed = null;
  const boot = session.boot;

  if (boot.status === 200 && boot.body.includes('profileFilmsList')) {
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

function newestRatedAt(entries) {
  let newest = null;
  for (const entry of entries || []) {
    if (!entry || !entry.ratedAt) continue;
    const value = String(entry.ratedAt);
    if (!newest || value > newest) newest = value;
  }
  return newest;
}

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

async function refreshVotes(userId, cached, onProgress) {
  const cachedEntries = Array.isArray(cached.entries) ? cached.entries : [];
  const cachedIds = new Set();
  for (const entry of cachedEntries) {
    const kpId = Number(entry && entry.kpId);
    if (Number.isFinite(kpId)) cachedIds.add(kpId);
  }

  if (cachedIds.size === 0) {
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

function startImport(rawUrl) {
  const userId = parseUserId(rawUrl);
  if (!userId) {
    throw new HttpError(
      400,
      'URL должен содержать идентификатор пользователя Кинопоиска (/user/{id}/).',
      'invalid_kinopoisk_url'
    );
  }

  for (const existingJob of jobs.list()) {
    const existingId = existingJob.uploadId;
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

  const job = jobs.createJob({
    id: upload.uploadId,
    uploadId: upload.uploadId,
    userId,
    stage: cached ? 'refresh' : 'scrape',
    page: cached ? 1 : 0,
    pageTotal: cached ? 1 : null,
    total: 0,
    error: null,
    warning: null,
    startedAt: Date.now(),
  });
  jobs.remember(job);

  if (cached) {
    console.log(
      `[kp ${userId}] cache hit (${cached.entries.length} entries, fetched ${cached.fetchedAt}); refreshing delta`
    );
  }

  jobs.run(job, () => runImport(upload, job, cached), {
    finish: false,
    onError: (self, err) => {
      console.error('[kp] import queue error:', err);
      if (self.stage !== 'done' && self.stage !== 'failed') {
        self.stage = 'failed';
        self.error = `Не удалось импортировать профиль Кинопоиска: ${
          err && err.message ? err.message : 'неизвестная ошибка'
        }`;
      }
      self.status = self.stage === 'done' ? 'done' : 'failed';
      self.finishedAt = Date.now();
    },
    onFinish: (self) => {
      if (self.stage === 'done' || self.stage === 'failed') {
        self.status = self.stage === 'done' ? 'done' : 'failed';
        if (self.finishedAt == null) self.finishedAt = Date.now();
      } else {
        self.status = 'running';
      }
    },
  });

  return { uploadId: upload.uploadId, userId, ...getStatus(upload.uploadId) };
}

async function runImport(upload, job, cached) {
  if (!cached) return runScrape(upload, job);

  job.stage = 'refresh';
  job.page = 1;
  job.pageTotal = 1;
  job.setProgress(1, 1);
  job.total = Array.isArray(cached.entries) ? cached.entries.length : 0;

  let result;
  try {
    result = await refreshVotes(job.userId, cached, (progress) => {
      job.page = progress.page;
      if (progress.pageTotal != null) job.pageTotal = progress.pageTotal;
      job.setProgress(job.page, job.pageTotal);
    });
  } catch (err) {
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
    console.log(
      `[kp ${job.userId}] delta refresh: no new votes, cache unchanged ` +
        `(${cached.entries.length} entries)`
    );
  }

  applyDataset(upload, buildDataset(job.userId, data));
  job.page = result.pagesFetched || 1;
  job.pageTotal = job.page;
  job.setProgress(job.page, job.pageTotal);
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
      job.setProgress(job.page, job.pageTotal);
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
    job.setProgress(job.page, job.pageTotal);
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
  if (stage === 'done' && job.status !== 'done') {
    job.status = 'done';
    if (job.finishedAt == null) job.finishedAt = Date.now();
  }

  const snapshot = jobs.snapshot(job);
  if (!job.error) delete snapshot.error;
  const status = {
    ...snapshot,
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
