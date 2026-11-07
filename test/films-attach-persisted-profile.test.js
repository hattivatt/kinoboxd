'use strict';

/**
 * Letterboxd attachment after a server restart.
 *
 * The in-memory upload store forgets its ids on restart, but the KinoPoisk
 * profile (cache/kp/{userId}.json) and the attachment
 * (cache/profile-lb/{userId}.json) are persistent. The browser keeps showing
 * the cached dashboard and remembers the stale uploadId, so both routes must
 * accept the persistent owner (`kpUserId`) as a fallback:
 *
 *   GET  /api/stats?uploadId=<stale>&kpUserId=<id>  -> 200 rebuilt payload
 *   POST /api/attach/lbzip (uploadId=<stale>&kpUserId=<id>) -> 200
 *
 * Without the fallback the UI says «Выгрузка не найдена на сервере» right
 * after the user picks the ZIP, which is the bug this suite pins.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const env = require('./helpers/env');
const tmp = env.makeTmpCache('films-attach-persisted', { budgets: true });

const express = require('express');
const AdmZip = require('adm-zip');
const { errorMiddleware } = require('../server/core/errors');

const cache = require('../server/cache');
const filmsRouter = require('../server/films/routes');

const KP_USER = '15702206';
const STALE_UPLOAD = 'deadbeefdeadbeefdeadbeef';

function seedProfile() {
  const dir = path.join(tmp.cacheDir, 'kp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${KP_USER}.json`),
    JSON.stringify({
      fetchedAt: '2026-10-26T13:30:00.000Z',
      kpNick: 'tester',
      entries: [
        {
          kpId: 1,
          type: 'film',
          titleRu: 'Альфа',
          titleEn: 'Alpha',
          year: 2001,
          ratedAt: '2025-01-01T00:00:00.000Z',
          rating: 8,
        },
        {
          kpId: 2,
          type: 'film',
          titleRu: 'Бета',
          titleEn: 'Beta',
          year: 2002,
          ratedAt: '2025-02-01T00:00:00.000Z',
          rating: 7,
        },
      ],
    }),
    'utf8'
  );

  // Known misses: no TMDB request is made while matching the archive.
  for (const title of ['Alpha', 'Beta']) {
    cache.setIndexValue(cache.makeKindKey(title, title === 'Alpha' ? 2001 : 2002, 'movie'), false);
    cache.setIndexValue(cache.makeKindKey(title, title === 'Alpha' ? 2001 : 2002, 'tv'), false);
  }
  cache.flushIndex();
}

function letterboxdZip() {
  const zip = new AdmZip();
  zip.addFile(
    'diary.csv',
    Buffer.from(
      [
        'Letterboxd URI,Date,Name,Year,Watched Date,Rating,Rewatch',
        'https://boxd.it/alpha,2025-01-02,Alpha,2001,2025-01-01,4,No',
        'https://boxd.it/beta,2025-02-02,Beta,2002,2025-02-01,3.5,Yes',
        '',
      ].join('\n'),
      'utf8'
    )
  );
  zip.addFile(
    'watched.csv',
    Buffer.from(
      [
        'Date,Name,Year,Letterboxd URI',
        '2025-01-02,Alpha,2001,https://boxd.it/alpha',
        '2025-02-02,Beta,2002,https://boxd.it/beta',
        '',
      ].join('\n'),
      'utf8'
    )
  );
  return zip.toBuffer();
}

let server;
let baseUrl;

test.before(async () => {
  seedProfile();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', filmsRouter);
  app.use(errorMiddleware);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  tmp.cleanup();
});

test('GET /api/stats rebuilds a forgotten upload from the persistent profile', async () => {
  const response = await fetch(
    `${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}&kpUserId=${KP_USER}`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.summary.source.type, 'kinopoisk');
  assert.equal(String(payload.summary.source.kpUserId), KP_USER);
  assert.equal(payload.summary.filmCount, 2);
  assert.equal(payload.summary.ratedCount, 2);
  // No attachment yet (`attachedLb` is omitted by summary.js when absent).
  assert.ok(!payload.summary.attachedLb);
});

test('GET /api/stats still 404s without the persistent fallback', async () => {
  const response = await fetch(`${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}`);
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.code, 'unknown_upload');
});

test('POST /api/attach/lbzip attaches to a cached profile by kpUserId', async () => {
  const form = new FormData();
  form.append('uploadId', STALE_UPLOAD);
  form.append('kpUserId', KP_USER);
  form.append(
    'file',
    new Blob([letterboxdZip()], { type: 'application/zip' }),
    'letterboxd-export.zip'
  );

  const response = await fetch(`${baseUrl}/api/attach/lbzip`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.attached, true);
  assert.equal(String(payload.kpUserId), KP_USER);
  assert.equal(payload.events, 2);
  assert.equal(payload.diaryEvents, 2);

  const stored = JSON.parse(
    fs.readFileSync(path.join(tmp.cacheDir, 'profile-lb', `${KP_USER}.json`), 'utf8')
  );
  assert.equal(stored.events.length, 2);
  assert.equal(stored.fileName, 'letterboxd-export.zip');
});

test('the rebuilt stats payload picks the fresh attachment up immediately', async () => {
  const response = await fetch(
    `${baseUrl}/api/stats?uploadId=${STALE_UPLOAD}&kpUserId=${KP_USER}`
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.summary.attachedLb, 'attachment must be in the rebuilt summary');
  assert.equal(payload.summary.attachedLb.fileName, 'letterboxd-export.zip');
  // `events` counts archive events applied to MATCHED films. Both test
  // films are deliberate TMDB misses, so the field is 0 by design; presence
  // of the block is what proves the attachment reached the stats build.
  assert.equal(typeof payload.summary.attachedLb.events, 'number');
});

test('an unknown kpUserId is a clear 404, not a fake attach', async () => {
  const form = new FormData();
  form.append('kpUserId', '999999999');
  form.append(
    'file',
    new Blob([letterboxdZip()], { type: 'application/zip' }),
    'letterboxd-export.zip'
  );

  const response = await fetch(`${baseUrl}/api/attach/lbzip`, {
    method: 'POST',
    body: form,
  });
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.code, 'unknown_profile');
});

test('the client sends the persistent kpUserId with stats and attach', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const publicDir = path.join(__dirname, '..', 'public', 'js');
  const api = fs.readFileSync(path.join(publicDir, 'api.js'), 'utf8');
  const attach = fs.readFileSync(path.join(publicDir, 'attach.js'), 'utf8');
  const main = fs.readFileSync(path.join(publicDir, 'main.js'), 'utf8');

  // Dashboard: the stale uploadId is paired with the owner id.
  assert.match(api, /params\.set\('kpUserId', String\(kpUserId\)\)/);
  // Attach: the multipart form carries the owner fallback.
  assert.match(api, /form\.append\('kpUserId', String\(kpUserId\)\)/);
  assert.match(attach, /attachLbZip\(uploadId, file, \{ kpUserId \}\)/);
  // The modal may open on a profile even when uploadId is gone.
  assert.match(attach, /if \(!uploadId && !kpUserId\)/);
  // main.js supplies the owner from the active KinoPoisk profile.
  assert.match(main, /getKpUserId: \(\) => activeKpUserId\(\)/);
});
