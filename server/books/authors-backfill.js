'use strict';

/**
 * Author-alias backfill (optional, bounded).
 *
 *   node server/books/authors-backfill.js --profile=livelib-Margaret [--wikidata] [--limit=100]
 *
 * Without `--wikidata` it only reports the groups the offline rule (normalise +
 * transliteration + author ids) would merge. With `--wikidata` it asks WDQS for
 * the *unresolved* spellings and persists the result into
 * `cache-book/authors.json`; the stats payload then applies the table on every
 * read without any network request.
 *
 * The bridge is opt-in on purpose: WDQS is rate-limited and the offline rule is
 * enough for most pairs. Tests mock `fetch`; this script is the only place that
 * would ever talk to Wikidata.
 */

const bookCache = require('./book-cache');
const authors = require('./authors');
const wd = require('./authors-wikidata');

function parseArgs(argv) {
  const out = { profile: null, wikidata: false, limit: null, dryRun: false };
  for (const arg of argv) {
    if (arg === '--wikidata') out.wikidata = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length)) || null;
  }
  return out;
}

function collectEntries(profile) {
  const entries = [];
  for (const event of profile.events || []) {
    if (!event) continue;
    const linkKey = event.sourceBookId
      ? String(event.sourceBookId)
      : event.fileKey
      ? `file:${event.fileKey}`
      : null;
    const link = linkKey ? bookCache.getLink(linkKey) : null;
    const details = link && link.workId ? bookCache.getWorkDetails(link.workId) : null;
    const ids = new Map();
    for (const author of (details && Array.isArray(details.authors) ? details.authors : [])) {
      const name = author && typeof author === 'object' ? author.name : author;
      const id = author && typeof author === 'object' ? author.hcId : null;
      if (name && id != null) ids.set(authors.normalizeAuthorName(name), String(id));
    }
    for (const name of event.authors || []) {
      if (!name) continue;
      entries.push({ name, id: ids.get(authors.normalizeAuthorName(name)) || null, workId: event.id });
    }
  }
  return entries;
}

function profileFromArgs(options) {
  const raw = options.profile || process.env.KINOBOXD_BOOKS_PROFILE || '';
  const match = /^([a-z-]+)-(.+)$/.exec(raw);
  if (!match) {
    const error = new Error(
      'Pass --profile=<source>-<userKey>, e.g. --profile=livelib-Margaret.'
    );
    error.code = 'profile_required';
    throw error;
  }
  const [, source, userKey] = match;
  const profile = bookCache.getProfile(source, userKey);
  if (!profile) {
    throw new Error(`Profile ${source}-${userKey} is not imported yet.`);
  }
  return { source, userKey, profile };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { profile } = profileFromArgs(options);
  const entries = collectEntries(profile);
  const persisted = bookCache.getAuthorsMap();
  const base = authors.groupAuthors(entries, persisted);
  const merged = [...base.groups]
    .filter((group) => group.names.length > 1)
    .map((group) => ({ name: group.name, aliases: group.names.filter((name) => name !== group.name) }));
  console.log(
    `[authors] profile events=${(profile.events || []).length} names=${entries.length} ` +
      `groups merged=${base.mergedGroups} (offline rule)`
  );
  for (const group of merged.slice(0, 40)) {
    console.log(`  ${group.name}  <-  ${group.aliases.join(' / ')}`);
  }

  if (!options.wikidata) {
    console.log('[authors] Wikidata bridge not requested (pass --wikidata to opt in).');
    return;
  }

  const wikidata = await wd.resolveWikidataAliases(entries, {
    persisted,
    limit: options.limit,
  });
  console.log(`[authors] Wikidata queries=${wikidata.queries} merged=${wikidata.merged.length}`);
  for (const item of wikidata.merged.slice(0, 40)) {
    console.log(`  ${item.name} (${item.qid})  <-  ${item.aliases.join(' / ')}`);
  }
  if (options.dryRun) {
    console.log('[authors] dry run: authors.json not written.');
    return;
  }
  const canonical = { ...Object.fromEntries(base.canonicalOf), ...wikidata.canonical };
  await bookCache.saveAuthorsMap({
    fingerprint: authors.fingerprintOfNames(entries.map((entry) => entry.name)),
    canonical,
  });
  console.log(`[authors] saved ${Object.keys(canonical).length} aliases to ${bookCache.AUTHORS_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[authors] ${error.code || 'error'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { collectEntries, parseArgs };
