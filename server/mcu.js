'use strict';

/**
 * Marvel Cinematic Universe membership.
 *
 * TMDB has no single "Marvel Cinematic Universe" collection: the MCU is split
 * into many sub-collections (Avengers, Captain America, Thor, …) plus
 * standalone films. Sony's Venom / Spider-Verse films and the pre-MCU
 * Spider-Man trilogy live in their own collections and must NOT be folded into
 * the MCU row.
 *
 * The canonical list below is the released MCU filmography (Iron Man 2008 →
 * Spider-Man: Brand New Day 2026), validated against Wikidata: every member of
 * Q642878 (Marvel Cinematic Universe) via P179 (`part of the series`) that is a
 * film matches this list, and none of the Sony titles does. The static list is
 * the primary signal at request time: stats must stay deterministic and
 * offline, and a TMDB/Wikidata outage must not change the dashboard.
 *
 * `backfill:mcu` is the update path. It runs one WDQS query, writes
 * cache/mcu.json, and stats merges that file over the static list (union)
 * without a server restart. A missing/broken file is harmless.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const cache = require('./cache');

const MCU_ITEM = 'Q642878';
const MCU_NAME = 'Marvel Cinematic Universe';
const MCU_PATH = path.join(cache.CACHE_DIR, 'mcu.json');

/* Released MCU films, chronological. `imdb` is the stable key (P345); `tmdb`
 * is kept as a fallback for cache entries where the IMDb backfill has not
 * run yet. Keep this list in sync with `npm run backfill:mcu` when a new MCU
 * film is released. */
const STATIC_MEMBERS = [
  { imdb: 'tt0371746', tmdb: 1726, title: 'Iron Man', year: 2008 },
  { imdb: 'tt0800080', tmdb: 1724, title: 'The Incredible Hulk', year: 2008 },
  { imdb: 'tt1228705', tmdb: 10138, title: 'Iron Man 2', year: 2010 },
  { imdb: 'tt0800369', tmdb: 10195, title: 'Thor', year: 2011 },
  { imdb: 'tt0458339', tmdb: 1771, title: 'Captain America: The First Avenger', year: 2011 },
  { imdb: 'tt0848228', tmdb: 24428, title: 'The Avengers', year: 2012 },
  { imdb: 'tt1300854', tmdb: 68721, title: 'Iron Man 3', year: 2013 },
  { imdb: 'tt1981115', tmdb: 76338, title: 'Thor: The Dark World', year: 2013 },
  { imdb: 'tt1843866', tmdb: 100402, title: 'Captain America: The Winter Soldier', year: 2014 },
  { imdb: 'tt2015381', tmdb: 118340, title: 'Guardians of the Galaxy', year: 2014 },
  { imdb: 'tt2395427', tmdb: 99861, title: 'Avengers: Age of Ultron', year: 2015 },
  { imdb: 'tt0478970', tmdb: 102899, title: 'Ant-Man', year: 2015 },
  { imdb: 'tt3498820', tmdb: 271110, title: 'Captain America: Civil War', year: 2016 },
  { imdb: 'tt1211837', tmdb: 284052, title: 'Doctor Strange', year: 2016 },
  { imdb: 'tt3896198', tmdb: 283995, title: 'Guardians of the Galaxy Vol. 2', year: 2017 },
  { imdb: 'tt2250912', tmdb: 315635, title: 'Spider-Man: Homecoming', year: 2017 },
  { imdb: 'tt3501632', tmdb: 284053, title: 'Thor: Ragnarok', year: 2017 },
  { imdb: 'tt1825683', tmdb: 284054, title: 'Black Panther', year: 2018 },
  { imdb: 'tt4154756', tmdb: 299536, title: 'Avengers: Infinity War', year: 2018 },
  { imdb: 'tt5095030', tmdb: 363088, title: 'Ant-Man and the Wasp', year: 2018 },
  { imdb: 'tt4154664', tmdb: 299537, title: 'Captain Marvel', year: 2019 },
  { imdb: 'tt4154796', tmdb: 299534, title: 'Avengers: Endgame', year: 2019 },
  { imdb: 'tt6320628', tmdb: 429617, title: 'Spider-Man: Far from Home', year: 2019 },
  { imdb: 'tt3480822', tmdb: 497698, title: 'Black Widow', year: 2021 },
  { imdb: 'tt9032400', tmdb: 524434, title: 'Eternals', year: 2021 },
  { imdb: 'tt9376612', tmdb: 566525, title: 'Shang-Chi and the Legend of the Ten Rings', year: 2021 },
  { imdb: 'tt10872600', tmdb: 634649, title: 'Spider-Man: No Way Home', year: 2021 },
  { imdb: 'tt9114286', tmdb: 505642, title: 'Black Panther: Wakanda Forever', year: 2022 },
  { imdb: 'tt9419884', tmdb: 453395, title: 'Doctor Strange in the Multiverse of Madness', year: 2022 },
  { imdb: 'tt10648342', tmdb: 616037, title: 'Thor: Love and Thunder', year: 2022 },
  { imdb: 'tt10954600', tmdb: 640146, title: 'Ant-Man and the Wasp: Quantumania', year: 2023 },
  { imdb: 'tt6791350', tmdb: 447365, title: 'Guardians of the Galaxy Vol. 3', year: 2023 },
  { imdb: 'tt10676048', tmdb: 609681, title: 'The Marvels', year: 2023 },
  { imdb: 'tt6263850', tmdb: 533535, title: 'Deadpool & Wolverine', year: 2024 },
  { imdb: 'tt14513804', tmdb: 822119, title: 'Captain America: Brave New World', year: 2025 },
  { imdb: 'tt10676052', tmdb: 617126, title: 'The Fantastic Four: First Steps', year: 2025 },
  { imdb: 'tt20969586', tmdb: 986056, title: 'Thunderbolts*', year: 2025 },
  { imdb: 'tt22084616', tmdb: 969681, title: 'Spider-Man: Brand New Day', year: 2026 },
];

const STATIC_IMDB = new Set(STATIC_MEMBERS.map((item) => item.imdb));
const STATIC_TMDB = new Set(STATIC_MEMBERS.map((item) => item.tmdb));

/* WDQS query used by `npm run backfill:mcu`. One request, no per-film
 * lookups: the full P179 membership of the MCU item. */
const MCU_QUERY = `SELECT ?film ?filmLabel ?imdb ?tmdb WHERE {
  ?film wdt:P179 wd:${MCU_ITEM} .
  OPTIONAL { ?film wdt:P345 ?imdb . }
  OPTIONAL { ?film wdt:P4947 ?tmdb . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,ru". }
}`;

function normalizeImdb(value) {
  const text = String(value == null ? '' : value).trim();
  return /^tt\d+$/.test(text) ? text : null;
}

function normalizeTmdb(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function fingerprintOf(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    return `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

let dynamicFingerprint = null;
let dynamicImdb = new Set();
let dynamicTmdb = new Set();

function replaceDynamic(payload) {
  const imdb = new Set();
  const tmdb = new Set();
  for (const member of Array.isArray(payload && payload.members) ? payload.members : []) {
    if (!member || typeof member !== 'object') continue;
    const imdbId = normalizeImdb(member.imdbId || member.imdb);
    const tmdbId = normalizeTmdb(member.tmdbId || member.tmdb);
    if (imdbId) imdb.add(imdbId);
    if (tmdbId) tmdb.add(tmdbId);
  }
  dynamicImdb = imdb;
  dynamicTmdb = tmdb;
}

/** Pick up cache/mcu.json written by a backfill process. */
function reloadIfChanged() {
  const fingerprint = fingerprintOf(MCU_PATH);
  if (fingerprint === dynamicFingerprint) return;
  dynamicFingerprint = fingerprint;
  if (!fingerprint) {
    replaceDynamic(null);
    return;
  }
  try {
    replaceDynamic(JSON.parse(fs.readFileSync(MCU_PATH, 'utf8')));
  } catch (err) {
    // A half-written/foreign file must never break /api/stats.
    console.warn(`[mcu] Could not read ${MCU_PATH} (${err.message})`);
    replaceDynamic(null);
  }
}

/**
 * True when a TMDB movie belongs to the MCU. `kind` defaults to movie; TV
 * entries never match. `imdbId` comes from the cached details, `tmdbId` from
 * the enrich job.
 */
function isMcuFilm({ imdbId, tmdbId, kind } = {}) {
  if (kind && kind !== 'movie') return false;
  reloadIfChanged();
  const imdb = normalizeImdb(imdbId);
  if (imdb && (STATIC_IMDB.has(imdb) || dynamicImdb.has(imdb))) return true;
  const tmdb = normalizeTmdb(tmdbId);
  if (tmdb && (STATIC_TMDB.has(tmdb) || dynamicTmdb.has(tmdb))) return true;
  return false;
}

async function writeMembers(members) {
  const payload = {
    version: 1,
    item: MCU_ITEM,
    updatedAt: new Date().toISOString(),
    members,
  };
  const tmp = `${MCU_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, MCU_PATH);
  dynamicFingerprint = null;
  reloadIfChanged();
  return payload;
}

/**
 * Refresh cache/mcu.json from Wikidata. Filters the P179 membership down to
 * rows that carry an IMDb or TMDB id; TV entries are kept in the file (the
 * runtime accepts movies only) so a later enrichment can classify them.
 */
async function backfill({ log = console.log } = {}) {
  const wikidata = require('./wikidata');
  const result = await wikidata.querySparql(MCU_QUERY, log);
  const bindings = (result && result.results && result.results.bindings) || [];
  const members = [];
  const seen = new Set();
  for (const row of bindings) {
    if (!row || !row.film) continue;
    const imdbId = normalizeImdb(row.imdb && row.imdb.value);
    const tmdbId = normalizeTmdb(row.tmdb && row.tmdb.value);
    if (!imdbId && !tmdbId) continue;
    const key = imdbId || `tmdb:${tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      qid: String(row.film.value || '').split('/').pop() || null,
      imdbId,
      tmdbId,
      title: (row.filmLabel && row.filmLabel.value) || null,
    });
  }
  members.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'en'));
  await writeMembers(members);
  log(`[backfill:mcu] ${members.length} members from Wikidata ${MCU_ITEM}`);
  return { total: members.length, item: MCU_ITEM, path: MCU_PATH };
}

module.exports = {
  MCU_ITEM,
  MCU_NAME,
  MCU_PATH,
  STATIC_MEMBERS,
  isMcuFilm,
  reloadIfChanged,
  backfill,
};
