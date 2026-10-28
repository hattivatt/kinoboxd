'use strict';

/**
 * Author-alias backfill (manual entry point).
 *
 *   node server/books/authors-backfill.js --profile=livelib-Margaret [--wikidata] [--recheck] [--limit=100]
 *
 * Without `--wikidata` it only reports the groups the offline rule (normalise +
 * transliteration + author ids) would merge. With `--wikidata` it runs the same
 * bridge the server now runs on its own (`authors-bridge.js`): the *unresolved*
 * spellings go to WDQS and the result is persisted into `cache-book/authors.json`.
 *
 * Since 28.10.2026 the bridge is DEFAULT-ON in `/api/books/stats`, so this
 * script is a diagnostic/manual tool, not a required deployment step. `--recheck`
 * forgets the "already asked" set and asks for every candidate again.
 */

const bookCache = require('./book-cache');
const authors = require('./authors');
const bridge = require('./authors-bridge');

function parseArgs(argv) {
  const out = { profile: null, wikidata: false, limit: null, dryRun: false, recheck: false };
  for (const arg of argv) {
    if (arg === '--wikidata') out.wikidata = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--recheck') out.recheck = true;
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
    console.log(
      '[authors] Wikidata bridge is default-on in the server; pass --wikidata here for a manual pass.'
    );
    return;
  }

  // `--recheck` forgets what was already asked; `--limit` bounds one pass.
  if (options.recheck) {
    for (const key of Object.keys(persisted.wikidata.checked || {})) delete persisted.wikidata.checked[key];
  }
  const report = await bridge.resolveAuthorsWikidata(entries, {
    persisted,
    force: true,
    persist: !options.dryRun,
    maxNames: options.limit == null ? undefined : options.limit,
  });
  console.log(
    `[authors] Wikidata pending=${report.pending} queries=${report.queries} ` +
      `merged=${report.merged} checked=${report.checked}` +
      (report.skipped ? ` skipped=${report.skipped}` : '') +
      (report.reason ? ` reason=${report.reason}` : '')
  );
  for (const item of (report.names || []).slice(0, 40)) {
    console.log(`  ${item.name} (${item.qid})  <-  ${item.aliases.join(' / ')}`);
  }
  if (options.dryRun) {
    console.log('[authors] dry run: authors.json not written.');
    return;
  }
  console.log(`[authors] aliases now in ${bookCache.AUTHORS_PATH}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[authors] ${error.code || 'error'}: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { collectEntries, parseArgs };
