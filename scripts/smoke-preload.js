'use strict';

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
  console.error(`[smoke-preload] disabled: ${err && err.message ? err.message : err}`);
}
