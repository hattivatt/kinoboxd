'use strict';

/**
 * K5 / task 2: LiveLib 403 — browser-like bootstrap + anonymous cookie jar.
 *
 * The reported failure: a user's server got a DDoS-Guard 403 within ~0.3 s on
 * the very first LiveLib request, because the import used to start with a bare
 * POST (no session cookies, no navigation headers).
 *
 * Pinned here:
 *   - bootstrap GET carries the full Chrome header set and keeps every
 *     `Set-Cookie` from every hop, including a 403 challenge page;
 *   - subsequent bulk/RSC/card requests send that jar back and refresh it;
 *   - a 403 *after* the bootstrap still fails loudly (`livelib_blocked`) with a
 *     message pointing at the cookie plan B;
 *   - `cookieHeader` seeds the jar (plan B) end to end;
 *   - diagnostics are masked (counts/statuses/title, never cookie values).
 *
 * No network access: a fake fetch reproduces the shapes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

process.env.KINOBOXD_CACHE_BOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-book-bootstrap-'));

const livelib = require('../server/books/livelib');

const FIXTURES = path.join(__dirname, 'fixtures');
const PAGE_HTML = zlib
  .gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-read-page1.html.gz')))
  .toString('utf8');
const BULK_JSON = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, 'livelib-bulk-page1.json.gz'))).toString('utf8')
);

const CHALLENGE_HTML = `<!DOCTYPE html><html><head>
<title>DDoS-Guard</title></head><body>
<script>window.__ddg1_ = "x";</script><p>Checking your browser before accessing.</p>
</body></html>`;

function response(status, options = {}) {
  const headers = new Map();
  for (const [name, value] of Object.entries(options.headers || {})) {
    headers.set(name.toLowerCase(), value);
  }
  return {
    status,
    url: options.url,
    headers,
    text: async () => options.body || '',
  };
}

/** Fake fetch that records every request and answers from a URL router. */
function fakeFetch(route) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options, headers: options.headers || {} });
    return route(String(url), options || {});
  };
  impl.calls = calls;
  return impl;
}

function cookieOf(call) {
  return (call.headers && call.headers.Cookie) || '';
}

test('bootstrap keeps the challenge cookies and reports masked diagnostics', async () => {
  const fetchImpl = fakeFetch(() =>
    response(403, {
      body: CHALLENGE_HTML,
      headers: {
        'set-cookie': ['__ddg1_=one; Path=/; HttpOnly', '__ddg2_=two; Path=/'],
        'content-type': 'text/html',
      },
    })
  );

  const session = await livelib.bootstrapSession('Margaret', { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  const headers = fetchImpl.calls[0].headers;
  assert.match(headers['User-Agent'], /Chrome\/140/);
  assert.match(headers['Accept-Language'], /ru-RU/);
  assert.equal(headers['Sec-Fetch-Mode'], 'navigate');
  assert.match(headers['Sec-Ch-Ua'], /Chromium/);
  assert.equal(headers.Cookie, undefined); // first request is cookie-less

  assert.equal(session.status, 403);
  assert.equal(session.challenge, true);
  assert.equal(session.blocked, true);
  assert.equal(session.cookieCount, 2);
  assert.equal(session.title, 'DDoS-Guard');
  assert.deepEqual(session.hops.map((hop) => hop.cookieCount), [2]);

  // Diagnostics are masked: no cookie name/value anywhere in the object.
  const serialised = JSON.stringify(session);
  assert.equal(serialised.includes('__ddg1_'), false);
  assert.equal(serialised.includes('one'), false);
});

test('bootstrap follows redirects manually and carries cookies between hops', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.includes('/reader/Margaret/read')) {
      return response(308, {
        url,
        headers: {
          location: '/users/50064/books/read',
          'set-cookie': '__ddg1_=hop1; Path=/',
        },
      });
    }
    return response(200, {
      url,
      body: PAGE_HTML,
      headers: { 'set-cookie': '__ddg8_=hop2; Path=/' },
    });
  });

  const session = await livelib.bootstrapSession('Margaret', { fetchImpl });

  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /\/users\/50064\/books\/read$/);
  assert.match(cookieOf(fetchImpl.calls[1]), /__ddg1_=hop1/);
  assert.equal(session.status, 200);
  assert.equal(session.challenge, false);
  assert.equal(session.cookieCount, 2); // hop1 + hop2
  assert.deepEqual(session.hops.map((hop) => hop.status), [308, 200]);
});

test('a 403 after the bootstrap fails loudly and points at the cookie plan B', async () => {
  const fetchImpl = fakeFetch(() =>
    response(403, {
      body: CHALLENGE_HTML,
      headers: { 'set-cookie': '__ddg1_=still-blocked; Path=/' },
    })
  );

  await assert.rejects(
    () =>
      livelib.importLivelib('Margaret', {
        fetchImpl,
        delayMs: 0,
        bootstrapDelayMs: 0,
      }),
    (err) => {
      assert.equal(err.code, 'livelib_blocked');
      assert.match(err.message, /ограничил доступ/);
      assert.match(err.message, /cookieHeader/);
      return true;
    }
  );
  // bootstrap GET + one bulk POST, then stop: no hammering.
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].options.method, 'POST');
  assert.match(cookieOf(fetchImpl.calls[1]), /__ddg1_=still-blocked/);
});

test('bootstrap 403 -> jar -> bulk/RSC 200 imports the profile end to end', async () => {
  const bulk = JSON.parse(JSON.stringify(BULK_JSON));
  bulk.last_page = true; // keep the fixture to a single page

  const fetchImpl = fakeFetch((url, options) => {
    const method = options.method || 'GET';
    if (method === 'POST' && url.includes('/listview/biglist')) {
      return response(200, { url, body: JSON.stringify(bulk) });
    }
    // The public alias 308-redirects to the numeric collection URL, exactly as
    // the live site does; the redirect must keep the jar.
    if (url.includes('/reader/Margaret/read?')) {
      return response(308, {
        url,
        headers: { location: '/users/50064/books/read?ordering=read_at_desc' },
      });
    }
    if (url.includes('/users/50064/books/read')) {
      return response(200, { url, body: PAGE_HTML });
    }
    // The bootstrap document request (no ?ordering, i.e. a cold visit).
    return response(403, {
      url,
      body: CHALLENGE_HTML,
      headers: { 'set-cookie': ['__ddg1_=jartoken1; Path=/', '__ddg2_=jartoken2; Path=/'] },
    });
  });

  const result = await livelib.importLivelib('Margaret', {
    fetchImpl,
    delayMs: 0,
    bootstrapDelayMs: 0,
    maxRscPages: 2,
  });

  // The bootstrap went first, then every following request carried the jar.
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.match(fetchImpl.calls[0].url, /\/reader\/Margaret\/read$/);
  for (const call of fetchImpl.calls.slice(1)) {
    assert.match(cookieOf(call), /__ddg1_=jartoken1/, `cookie missing on ${call.url}`);
  }

  assert.equal(result.session.bootstrap.status, 403);
  assert.equal(result.session.bootstrap.challenge, true);
  assert.equal(result.session.seededCookies, 0);
  assert.ok(result.session.cookiesUsed >= 2);

  // 20 RSC rows with exact dates + 80 bulk-only rows without a date.
  assert.equal(result.profile.events.length, 100);
  assert.equal(result.totals.dated, 20);
  assert.equal(result.totals.undated, 0);
  assert.equal(result.totals.monthOnly, 80);
  assert.equal(result.totals.events, 100);
  assert.equal(result.profile.source, 'livelib');
  assert.equal(result.profile.userKey, 'Margaret');
  assert.equal(result.profile.sourceUserId, '50064');
  assert.ok(result.warnings.some((warning) => /bootstrap/i.test(warning)));

  // Masked session block: counts and statuses only.
  const serialised = JSON.stringify(result.session);
  assert.equal(serialised.includes('__ddg'), false);
  assert.equal(serialised.includes('jartoken'), false);
});

test('cookieHeader (plan B) seeds the jar before the bootstrap', async () => {
  const bulk = JSON.parse(JSON.stringify(BULK_JSON));
  bulk.last_page = true;
  const fetchImpl = fakeFetch((url, options) => {
    const method = options.method || 'GET';
    if (method === 'POST' && url.includes('/listview/biglist')) {
      return response(200, { url, body: JSON.stringify(bulk) });
    }
    if (url.includes('ordering=read_at_desc')) {
      return response(200, { url, body: PAGE_HTML });
    }
    return response(200, { url, body: PAGE_HTML });
  });

  const result = await livelib.importLivelib('Margaret', {
    fetchImpl,
    cookieHeader: 'Cookie: __ddg1_=frombrowser; sessionid=secret-value',
    delayMs: 0,
    bootstrapDelayMs: 0,
    maxRscPages: 1,
  });

  // Seeded cookie is present on the bootstrap request itself.
  assert.match(cookieOf(fetchImpl.calls[0]), /__ddg1_=frombrowser/);
  assert.match(cookieOf(fetchImpl.calls[0]), /sessionid=secret-value/);
  for (const call of fetchImpl.calls.slice(1)) {
    assert.match(cookieOf(call), /__ddg1_=frombrowser/);
  }
  assert.equal(result.session.seededCookies, 2);
  assert.ok(result.session.cookiesUsed >= 2);
  assert.equal(result.profile.events.length, 100);
});

test('request() stores refreshed cookies and rejects 403/429 without retrying', async () => {
  const jar = livelib.makeJar('__ddg1_=old');
  const fetchImpl = fakeFetch(() =>
    response(403, {
      body: CHALLENGE_HTML,
      headers: { 'set-cookie': '__ddg1_=new; Path=/' },
    })
  );

  await assert.rejects(
    () => livelib.request('https://www.livelib.ru/book/1', { jar, fetchImpl }, 'card 1'),
    /ограничил доступ/
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(cookieOf(fetchImpl.calls[0]), /__ddg1_=old/);
  assert.equal(livelib.cookieHeaderOf(jar), '__ddg1_=new');
});

test('cookie attributes are not stored as cookie pairs', () => {
  const jar = livelib.makeJar();
  livelib.storeCookies(jar, {
    headers: new Map([
      [
        'set-cookie',
        '__ddg1_=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Path=/; Secure; HttpOnly',
      ],
    ]),
  });
  assert.equal(livelib.cookieHeaderOf(jar), '__ddg1_=abc');

  // Deletion via Max-Age=0 and via an empty value.
  livelib.storeCookies(jar, {
    headers: new Map([['set-cookie', '__ddg1_=; Max-Age=0; Path=/']]),
  });
  assert.equal(jar.size, 0);
});

test('challenge detection distinguishes a real page from an interstitial', () => {
  assert.equal(livelib.isChallengeHtml(CHALLENGE_HTML), true);
  assert.equal(livelib.isChallengeHtml('<html><title>DDoS-Guard</title></html>'), true);
  assert.equal(livelib.isChallengeHtml('<div class="g-recaptcha"></div>'), true);
  assert.equal(livelib.isChallengeHtml('<html><title>Проверка браузера</title></html>'), true);
  assert.equal(livelib.isChallengeHtml(PAGE_HTML), false);
  assert.equal(livelib.isChallengeHtml(''), false);
});
