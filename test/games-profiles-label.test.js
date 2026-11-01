'use strict';

/**
 * P1b: the owner `label` typed at import reaches the switcher.
 *
 * `POST /api/games/import { label }` has always been stored as
 * `profileDoc.ownerLabel` (`import.js`), but nothing read it back: the form
 * field «Название профиля» was dead. Two owners of one Steam account (or a
 * persona that does not say who it is) could not be told apart. The label is
 * additive — `personaName` keeps its meaning — and arrives in
 *   GET /api/games/profiles  → profiles[].label
 *   GET /api/games/stats     → sources.profile.label
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.KINOBOXD_CACHE_GAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-label-'));
process.env.KINOBOXD_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoboxd-games-label-state-'));
process.env.KINOBOXD_GAMES_WD = 'off';
process.env.KINOBOXD_STEAM_KEY_FILE = path.join(process.env.KINOBOXD_STATE_DIR, 'no-steam-token');
delete process.env.STEAM_API_KEY;

const { createRouter } = require('../server/games/routes');
const importJobs = require('../server/games/import');
const gameCache = require('../server/games/game-cache');
const { createFakeClient } = require('./fixtures/games/fake-client');

const LABELLED = '76561198000000001';
const PLAIN = '76561198000000002';
const PORT = 7066;

function buildApp(client) {
  const app = express();
  app.use(express.json());
  app.use('/api/games', createRouter({ client, autoEnrich: false, autoPersonnel: false }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[test] unhandled', err);
    res.status(500).json({ error: 'internal', code: 'internal_error' });
  });
  return app;
}

test('the import label is served by /profiles and /stats without replacing the persona', async (t) => {
  const client = createFakeClient();
  importJobs.startImport(LABELLED, { client, force: true, label: 'Брат' });
  importJobs.startImport(PLAIN, { client, force: true });
  await importJobs.whenIdle();

  /* cache level */
  const listed = gameCache.listProfiles();
  assert.equal(listed.length, 2);
  const labelled = listed.find((entry) => entry.userKey === LABELLED);
  const plain = listed.find((entry) => entry.userKey === PLAIN);
  assert.equal(labelled.label, 'Брат');
  assert.equal(labelled.personaName, 'test-player', 'the Steam persona is kept as-is');
  assert.equal(plain.label, null, 'an import without a label stays null, not an empty string');

  const server = buildApp(client).listen(PORT);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${PORT}`;

  /* /profiles */
  const profiles = await (await fetch(`${base}/api/games/profiles`)).json();
  const chip = profiles.profiles.find((entry) => entry.key === `steam-${LABELLED}`);
  const plainChip = profiles.profiles.find((entry) => entry.key === `steam-${PLAIN}`);
  assert.equal(chip.label, 'Брат');
  assert.equal(chip.personaName, 'test-player');
  assert.equal(plainChip.label, null);

  /* /stats */
  const stats = await (await fetch(`${base}/api/games/stats?profile=steam-${LABELLED}`)).json();
  assert.equal(stats.sources.profile.label, 'Брат');
  assert.equal(stats.sources.profile.personaName, 'test-player');

  const plainStats = await (await fetch(`${base}/api/games/stats?profile=steam-${PLAIN}`)).json();
  assert.equal(plainStats.sources.profile.label, null);
});
