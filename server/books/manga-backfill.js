'use strict';

/**
 * Manga/comics signal backfill for details documents that are weak on their
 * own (mostly Hardcover-only works: genres `[]`, publisher `null`, no tags).
 *
 * It is a *targeted* enrichment, not a full metadata refresh:
 *   - candidates are volume-like works whose effective flag is not `true`
 *     (title/series contains Vol/Book/Tome/N volumes/Single Issues), or explicit
 *     ids passed on the command line;
 *   - one title lookup per provider (Open Library, then Google Books) by ISBN
 *     with a base-title retry (`Crossed, Vol. 14: Badlands` -> `Crossed`);
 *   - provider genres/subjects/publisher are merged into `details.mangaTexts`,
 *     re-detected locally and persisted atomically; provider pages are not
 *     copied into `links` and `metadataSources` is left untouched;
 *   - the LiveLib/card never enters this path, so there is no scraping risk.
 *
 * Usage:
 *   node server/books/manga-backfill.js --dry-run --limit 10
 *   node server/books/manga-backfill.js --ids hc:1874719,hc:473173 --dry-run
 *   node server/books/manga-backfill.js --ids hc:1874719,hc:473173
 *
 * Respect:
 *   - `--limit` defaults to 20 (0 = no cap);
 *   - `--pause` ms between provider lookups (default 600);
 *   - Google Books is skipped while its 429 breaker is open.
 */

const fs = require('fs');

const bookCache = require('./book-cache');
const googlebooks = require('./providers/googlebooks');
const openlibrary = require('./providers/openlibrary');
const { detectManga } = require('./providers/manga');

const DEFAULT_LIMIT = 20;
const DEFAULT_PAUSE_MS = 600;

/** "Crossed, Vol. 14: Badlands" -> "Crossed"; "Old Boy, Vol. 8" -> "Old Boy". */
function baseTitle(title) {
  return String(title == null ? '' : title)
    .replace(/\s*[,:]\s*(?:vol(?:ume)?\.?|book|tome|том|часть|книга)\s*(?:\d+|[a-z]+)\b.*$/iu, '')
    .replace(/\s+-\s+(?:tome|vol(?:ume)?\.?|book|том|часть)\s*\d+\b.*$/iu, '')
    .trim();
}

/** "Trigun (3 volumes)" -> "Trigun"; "Crossed (Single Issues)" -> "Crossed". */
function seriesBase(name) {
  return String(name == null ? '' : name)
    .replace(/\s*\([^)]*\)\s*$/u, '')
    .trim();
}

const VOLUME_LIKE =
  /(?:[,:]\s*|\s+)(?:vol(?:ume)?\.?|tome|book|том|часть|книга)\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b|\(\s*\d+\s+volumes?\s*\)|single[\s-]?issues?|collected[\s-]?editions?/iu;

function isVolumeLike(doc) {
  const texts = [doc && doc.title];
  for (const entry of Array.isArray(doc && doc.series) ? doc.series : []) {
    texts.push(typeof entry === 'string' ? entry : entry && entry.name);
  }
  return texts.some((value) => value && VOLUME_LIKE.test(String(value)));
}

function workIdOf(doc) {
  if (!doc) return null;
  if (doc.workId) return String(doc.workId);
  if (doc.hcWorkId != null) return `hc:${doc.hcWorkId}`;
  return null;
}

function detailDocs() {
  let names = [];
  try {
    names = fs.readdirSync(bookCache.DETAILS_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch (err) {
    return [];
  }
  const docs = [];
  for (const name of names) {
    const doc = bookCache.getDetails(name.slice(0, -5));
    if (doc) docs.push({ key: name.slice(0, -5), doc });
  }
  return docs;
}

/** Current effective flag of a details doc (no manual override involved). */
function detectDoc(doc) {
  return detectManga({
    genres: doc.genres,
    tags: doc.tags,
    texts: doc.mangaTexts,
    series: doc.series,
    publisher: doc.publisher,
  });
}

function collectTexts(doc, results) {
  const out = [];
  const push = (value) => {
    const text = String(value == null ? '' : value).trim();
    if (text && !out.includes(text)) out.push(text);
  };
  for (const value of Array.isArray(doc.mangaTexts) ? doc.mangaTexts : []) push(value);
  for (const value of Array.isArray(doc.genres) ? doc.genres : []) push(value);
  for (const value of Array.isArray(doc.tags) ? doc.tags : []) push(value);
  for (const entry of Array.isArray(doc.series) ? doc.series : []) {
    push(typeof entry === 'string' ? entry : entry && entry.name);
  }
  push(doc.publisher);
  for (const result of results) {
    if (!result) continue;
    for (const value of Array.isArray(result.mangaTexts) ? result.mangaTexts : []) push(value);
    for (const value of Array.isArray(result.genres) ? result.genres : []) push(value);
    if (result.publisher) push(result.publisher);
    if (result.series && result.series.name) push(result.series.name);
  }
  return out;
}

/**
 * Enrich one details document with provider detection text.
 * Returns `{changed, mangaComics, texts, results}`.
 */
async function enrichDoc(doc, options = {}) {
  const pause = options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const providers = Array.isArray(options.providers)
    ? options.providers
    : [openlibrary, googlebooks];
  const authors = (Array.isArray(doc.authors) ? doc.authors : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.name : entry))
    .filter(Boolean);
  const titles = [];
  const primary = baseTitle(doc.title);
  if (primary) titles.push(primary);
  for (const entry of Array.isArray(doc.series) ? doc.series : []) {
    const name = seriesBase(typeof entry === 'string' ? entry : entry && entry.name);
    if (name && !titles.includes(name)) titles.push(name);
  }

  const results = [];
  for (const title of titles) {
    for (const provider of providers) {
      if (typeof provider.isBreakerOpen === 'function' && provider.isBreakerOpen()) continue;
      let result = null;
      try {
        result = await provider.getWork(
          { isbn13: doc.isbn13 || null, isbn10: doc.isbn10 || null, title, authors },
          { requestDelayMs: pause, sleep }
        );
      } catch (err) {
        result = null;
      }
      if (result) results.push(result);
      // A provider that already proves comics is enough; otherwise try the
      // next one (OL subjects and GB categories cover different editions).
      if (result && result.mangaComics === true) break;
    }
    if (results.some((result) => result.mangaComics === true)) break;
  }

  const texts = collectTexts(doc, results);
  const providerFlag = results.some((result) => result.mangaComics === true);
  const detected = detectDoc({ ...doc, mangaTexts: texts });
  const mangaComics = providerFlag
    ? true
    : detected === true
    ? true
    : detected === false
    ? false
    : typeof doc.mangaComics === 'boolean'
    ? doc.mangaComics
    : null;

  const beforeTexts = Array.isArray(doc.mangaTexts) ? doc.mangaTexts : [];
  const changed =
    texts.length !== beforeTexts.length || mangaComics !== doc.mangaComics || results.length > 0;
  return { changed, mangaComics, texts, results };
}

async function backfill(options = {}) {
  const dryRun = options.dryRun === true;
  const limit = options.limit == null ? DEFAULT_LIMIT : Number(options.limit);
  const ids = Array.isArray(options.ids) ? new Set(options.ids.map(String)) : null;
  const includeAll = options.all === true;
  const pause = options.pause == null ? DEFAULT_PAUSE_MS : Number(options.pause);
  const log = typeof options.log === 'function' ? options.log : console.log;

  const docs = detailDocs();
  const candidates = [];
  for (const { key, doc } of docs) {
    const workId = workIdOf(doc);
    const matchesId =
      ids &&
      [...ids].some(
        (id) => id === workId || id === key || id === String(doc.hcWorkId) || id === doc.workId
      );
    if (ids && !matchesId) continue;
    if (!ids && !includeAll && !isVolumeLike(doc)) continue;
    if (!ids && detectDoc(doc) === true) continue;
    if (!workId) continue;
    candidates.push({ key, doc, workId });
  }

  const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
  const report = {
    scanned: docs.length,
    candidates: candidates.length,
    selected: selected.length,
    checked: 0,
    detected: [],
    unchanged: [],
    errors: [],
  };

  for (const { doc, workId } of selected) {
    report.checked++;
    try {
      const enriched = await enrichDoc(doc, { ...options, pause });
      const detected = enriched.mangaComics === true;
      if (detected) {
        report.detected.push({
          workId,
          title: doc.title,
          publishers: enriched.results.map((result) => result.publisher).filter(Boolean),
          signals: enriched.texts.filter((text) =>
            /manga|manhwa|manhua|comics?|graphic[\s-]?novel|single[\s-]?issues|collected[\s-]?editions|манга|комикс|glenat|image comics|dark horse|avatar/i.test(text)
          ).slice(0, 6),
        });
      } else {
        report.unchanged.push({ workId, title: doc.title });
      }
      if (!dryRun && (enriched.changed || detected)) {
        const next = {
          ...doc,
          mangaTexts: enriched.texts,
          mangaSources: [
            ...new Set([
              ...(Array.isArray(doc.mangaSources) ? doc.mangaSources : []),
              ...enriched.results.map((result) => result.source),
            ]),
          ],
          mangaComics: enriched.mangaComics,
          mangaCheckedAt: new Date().toISOString(),
        };
        await bookCache.saveDetails(bookCache.detailsKeyForWork(workId), next);
      }
      log(
        `${detected ? 'COMICS' : '—'} ${workId} ${doc.title || ''}` +
          (detected ? ` :: ${enriched.texts.slice(-4).join(' | ')}` : '')
      );
    } catch (err) {
      report.errors.push({ workId, error: err && err.message ? err.message : String(err) });
      log(`ERROR ${workId}: ${err && err.message}`);
    }
  }
  return report;
}

function parseArgs(argv) {
  const options = { ids: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--pause') options.pause = Number(argv[++i]);
    else if (arg === '--ids') {
      options.ids = String(argv[++i] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  backfill(options)
    .then((report) => {
      const summary = {
        scanned: report.scanned,
        candidates: report.candidates,
        selected: report.selected,
        checked: report.checked,
        detected: report.detected.length,
        unchanged: report.unchanged.length,
        errors: report.errors.length,
      };
      console.log(JSON.stringify({ summary, detected: report.detected }, null, 2));
      if (report.errors.length) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_PAUSE_MS,
  baseTitle,
  seriesBase,
  isVolumeLike,
  workIdOf,
  detectDoc,
  collectTexts,
  enrichDoc,
  backfill,
  parseArgs,
};
