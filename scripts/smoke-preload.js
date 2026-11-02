'use strict';

/**
 * Smoke preload (`NODE_OPTIONS=--require`): seed the in-memory film upload.
 *
 * Why: `GET /api/stats` needs an `uploadId` that only `POST /api/upload`
 * creates, and a finished enrich job. A real upload would call TMDB over the
 * network, which the smoke run must not do. This preload (loaded BEFORE
 * `server/index.js`) registers the golden upload in the same in-memory store
 * and replaces `enrich.getJob` with a fixed, already-done job. `server/stats.js`
 * destructures `getJob` at require time, so patching the export here is enough
 * and no production file is touched.
 *
 * The upload id is written to `$SMOKE_TMP/upload-id` for the shell script.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const outDir = process.env.SMOKE_TMP;

try {
  const { createUpload } = require(path.join(ROOT, 'server/upload'));
  const enrich = require(path.join(ROOT, 'server/enrich'));
  const seed = require(path.join(ROOT, 'test/golden/seed'));

  const { upload: dataset, job } = seed.filmsInput();
  const upload = createUpload(dataset);

  const originalGetJob = enrich.getJob;
  enrich.getJob = function smokeGetJob(uploadId) {
    if (uploadId === upload.uploadId) return job;
    return originalGetJob.call(enrich, uploadId);
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'upload-id'), upload.uploadId, 'utf8');
  }
  console.log(`[smoke-preload] film upload seeded: ${upload.uploadId}`);
} catch (err) {
  // Never break the server start: the smoke script reports films as blocked.
  console.error(`[smoke-preload] disabled: ${err && err.message ? err.message : err}`);
}
