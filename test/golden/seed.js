'use strict';

/**
 * Golden fixtures seeder (P0 «страховочная сетка»).
 *
 * The three payload goldens (`test/golden.test.js`) and `scripts/smoke.sh`
 * share this module: it copies the static fixture documents from
 * `test/fixtures/golden/**` into the *tmp* cache roots the env helper points
 * at. Nothing here touches the production `app/cache*` directories — the
 * caller must call `helpers/env.makeTmpCache()` (or set the four env vars)
 * BEFORE requiring this module, because the cache modules resolve their roots
 * at load time.
 *
 * Fixture layout:
 *
 *   test/fixtures/golden/films/upload.json        upload dataset (films/events/…)
 *   test/fixtures/golden/films/job.json           enrich job result (slug → tmdbId)
 *   test/fixtures/golden/films/details/{id}.json  TMDB details + credits
 *
 *   test/fixtures/golden/books/profiles/*.json    one LiveLib profile document
 *   test/fixtures/golden/books/links.json         LiveLib → Hardcover links
 *   test/fixtures/golden/books/details/{id}.json  Hardcover work metadata
 *
 *   test/fixtures/golden/games/profile.json       Steam profile document
 *   test/fixtures/golden/games/library.json       parsed owned-games snapshot
 *   test/fixtures/golden/games/achievements/*.json  parsed achievements XML
 *   test/fixtures/golden/games/global/*.json      global achievement percentages
 *   test/fixtures/golden/games/details/*.json     parsed Steam store appdetails
 *   test/fixtures/golden/games/spy/*.json         parsed SteamSpy document
 *   test/fixtures/golden/games/reviews/*.json     parsed review summary
 *
 * The fixtures are *static*: no parser runs at seed time, so a parser
 * refactor changes the payload (and the golden fails) instead of silently
 * changing the input too.
 */

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'golden');

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, ...parts), 'utf8'));
}

function listJson(dir) {
  try {
    return fs
      .readdirSync(path.join(FIXTURE_DIR, dir))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (err) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Films                                                               */
/* ------------------------------------------------------------------ */

/** Upload dataset + the completed-enrich job that `buildStats` needs. */
function filmsInput() {
  const upload = readJson('films', 'upload.json');
  const jobSpec = readJson('films', 'job.json');
  const job = {
    done: true,
    started: true,
    total: jobSpec.total,
    matched: jobSpec.matched,
    failed: jobSpec.failed,
    // The real enrich job keeps a Map: slug -> { tmdbId, kind }.
    films: new Map(
      Object.entries(jobSpec.films).map(([slug, value]) => [
        slug,
        { ...value, slug, matched: true },
      ])
    ),
  };
  return {
    upload,
    job,
  };
}

/** Write the TMDB details files into `KINOBOXD_CACHE_DIR/details/`. */
async function seedFilms(cache) {
  for (const name of listJson(path.join('films', 'details'))) {
    const id = name.replace(/\.json$/, '');
    const doc = readJson('films', 'details', name);
    await cache.saveDetails(Number(id), doc);
  }
  return { details: listJson(path.join('films', 'details')).length };
}

/* ------------------------------------------------------------------ */
/* Books                                                               */
/* ------------------------------------------------------------------ */

/** Write one LiveLib profile, its metadata links and Hardcover details. */
async function seedBooks(bookCache, { profileKey = 'livelib-golden' } = {}) {
  const [source, ...rest] = profileKey.split('-');
  const userKey = rest.join('-');
  const profile = readJson('books', 'profiles', `${profileKey}.json`);
  await bookCache.saveProfile(source, userKey, profile);

  const links = readJson('books', 'links.json');
  for (const link of links.links) {
    await bookCache.saveLink(link.livelibBookId, {
      schemaVersion: 1,
      livelibBookId: link.livelibBookId,
      workId: link.workId,
      method: link.method,
      score: link.score,
      evidence: link.evidence,
    });
  }
  for (const work of links.workLinks) {
    bookCache.setWorkLink(work.workId, { livelib: work.livelib });
  }
  bookCache.flushLinks();

  for (const name of listJson(path.join('books', 'details'))) {
    const id = name.replace(/\.json$/, '');
    await bookCache.saveDetails(id, readJson('books', 'details', name));
  }
  return { profile: profileKey, links: links.links.length, details: listJson(path.join('books', 'details')).length };
}

/* ------------------------------------------------------------------ */
/* Games                                                               */
/* ------------------------------------------------------------------ */

/** Write a Steam profile, library snapshot, details, achievements, spy, reviews. */
async function seedGames(gameCache) {
  const profile = readJson('games', 'profile.json');
  const library = readJson('games', 'library.json');
  const userKey = String(profile.userKey);
  await gameCache.saveProfile(profile);
  await gameCache.saveLibrary(userKey, library);

  for (const name of listJson(path.join('games', 'details'))) {
    const appid = name.replace(/\.json$/, '');
    await gameCache.saveDetails(Number(appid), readJson('games', 'details', name));
  }
  for (const name of listJson(path.join('games', 'spy'))) {
    const appid = name.replace(/\.json$/, '');
    await gameCache.saveSpy(Number(appid), readJson('games', 'spy', name));
  }
  for (const name of listJson(path.join('games', 'reviews'))) {
    const appid = name.replace(/\.json$/, '');
    await gameCache.saveReviews(Number(appid), readJson('games', 'reviews', name));
  }
  for (const name of listJson(path.join('games', 'achievements'))) {
    const appid = name.replace(/\.json$/, '');
    await gameCache.saveAchievements(userKey, Number(appid), readJson('games', 'achievements', name));
  }
  for (const name of listJson(path.join('games', 'global'))) {
    const appid = name.replace(/\.json$/, '');
    await gameCache.saveGlobal(Number(appid), readJson('games', 'global', name));
  }
  return {
    profileKey: `steam-${userKey}`,
    libraryGames: library.game_count,
    details: listJson(path.join('games', 'details')).length,
  };
}

module.exports = {
  FIXTURE_DIR,
  readJson,
  filmsInput,
  seedFilms,
  seedBooks,
  seedGames,
};
