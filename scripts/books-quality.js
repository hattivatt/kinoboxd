'use strict';

const fs = require('fs');
const path = require('path');

const EXAMPLE_LIMIT = 3;
const TITLE_LIMIT = 40;

function parseArgs(argv) {
  const args = { cache: null, profiles: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const take = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };
    if (name === '--json') args.json = true;
    else if (name === '--cache') args.cache = take();
    else if (name === '--profile') {
      const raw = take();
      if (raw) {
        for (const part of String(raw).split(',')) {
          if (part.trim()) args.profiles.push(part.trim());
        }
      }
    } else {
      process.stderr.write(`unknown argument: ${token}\n`);
      process.stderr.write('usage: node scripts/books-quality.js [--cache <dir>] [--profile <key>] [--json]\n');
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cacheRoot = path.resolve(
  args.cache
    || process.env.KINOBOXD_CACHE_BOOK_DIR
    || path.join(__dirname, '..', 'cache-book')
);
process.env.KINOBOXD_CACHE_BOOK_DIR = cacheRoot;

const bookCache = require('../server/books/book-cache');
const {
  buildBooksStats,
  resolveProfileScope,
  profileKeyOf,
  canonicalKeyOf,
  prepareEvents,
} = require('../server/books/stats');
const { normalizeSeriesName } = require('../server/books/stats/series');
const { eventLinkKeyOf } = require('../server/books/stats/events');
const { normalizeTitle, normalizeIsbn } = require('../server/books/normalize');

bookCache.saveAuthorsMap = async () => bookCache.getAuthorsMap();

function clip(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT)}…` : text;
}

function bump(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function sortedCounts(map, noneLast = false) {
  const keys = Object.keys(map).sort((a, b) => {
    if (noneLast) {
      const an = a === '(none)' ? 1 : 0;
      const bn = b === '(none)' ? 1 : 0;
      if (an !== bn) return an - bn;
    }
    return a.localeCompare(b, 'en');
  });
  const out = {};
  for (const key of keys) out[key] = map[key];
  return out;
}

function emptyYearSources() {
  return { first: 0, manual: 0, edition: 0, none: 0 };
}

function emptySeriesMetrics() {
  return {
    total: 0,
    singletons: 0,
    splitGroups: 0,
    splitSeries: 0,
    splitExamples: [],
    internalDup: 0,
    internalDupExamples: [],
    mixedScript: 0,
    mixedScriptExamples: [],
    defective: 0,
  };
}

function emptyOverMatch() {
  return { count: 0, examples: [] };
}

function emptyProfileMetrics() {
  return {
    works: 0,
    events: 0,
    unresolved: 0,
    yearSources: emptyYearSources(),
    claimSources: {},
    dupGroups: 0,
    dupExtra: 0,
    dupExamples: [],
    sameTitleGroups: 0,
    sameTitleExamples: [],
    series: emptySeriesMetrics(),
    overMatch: emptyOverMatch(),
  };
}

function canonicalDupMetrics(entries) {
  const groups = new Map();
  for (const work of entries) {
    const key = canonicalKeyOf(work);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(work);
  }
  const dup = [];
  let extra = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    extra += group.length - 1;
    dup.push(group);
  }
  dup.sort((a, b) => b.length - a.length || String(a[0].workId).localeCompare(String(b[0].workId)));
  return {
    groups: dup.length,
    extra,
    examples: dup
      .slice(0, EXAMPLE_LIMIT)
      .map((group) => `${clip(group[0].title || group[0].titleRu)} ×${group.length}`),
  };
}

function sameTitleMetrics(entries) {
  const groups = new Map();
  for (const work of entries) {
    const key = normalizeTitle(work.title || work.titleRu || '');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(work);
  }
  const dup = [...groups.values()].filter((group) => group.length > 1);
  dup.sort((a, b) => b.length - a.length || String(a[0].workId).localeCompare(String(b[0].workId)));
  return {
    groups: dup.length,
    examples: dup
      .slice(0, EXAMPLE_LIMIT)
      .map((group) => `${clip(group[0].title || group[0].titleRu)} ×${group.length}`),
  };
}

function seriesMetrics(payload) {
  const metrics = emptySeriesMetrics();
  const entries = Array.isArray(payload.series) ? payload.series : [];
  metrics.total = entries.length;
  const cyrillic = /[\p{Script=Cyrillic}]/u;
  const latin = /[\p{Script=Latin}]/u;
  const byNorm = new Map();
  for (const entry of entries) {
    if (entry.count < 2) metrics.singletons += 1;
    const norm = normalizeSeriesName(entry.name);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(entry);
  }
  const splitGroups = [...byNorm.values()].filter((list) => list.length > 1);
  metrics.splitGroups = splitGroups.length;
  const splitMembers = new Set();
  for (const list of splitGroups) {
    metrics.splitSeries += list.length;
    for (const entry of list) splitMembers.add(entry);
  }
  metrics.splitExamples = splitGroups
    .slice(0, EXAMPLE_LIMIT)
    .map((list) => list.map((entry) => clip(entry.name)).join(' / '));
  for (const entry of entries) {
    const titles = (entry.works || []).map((work) => String(work.title || '')).filter(Boolean);
    const seen = new Map();
    for (const title of titles) {
      const norm = normalizeTitle(title);
      if (norm) seen.set(norm, (seen.get(norm) || 0) + 1);
    }
    const internalDup = [...seen.values()].some((count) => count > 1);
    const mixed =
      titles.some((title) => cyrillic.test(title)) && titles.some((title) => latin.test(title));
    if (internalDup) {
      metrics.internalDup += 1;
      if (metrics.internalDupExamples.length < EXAMPLE_LIMIT) {
        metrics.internalDupExamples.push(clip(entry.name));
      }
    }
    if (mixed) {
      metrics.mixedScript += 1;
      if (metrics.mixedScriptExamples.length < EXAMPLE_LIMIT) {
        metrics.mixedScriptExamples.push(clip(entry.name));
      }
    }
    if (splitMembers.has(entry) || internalDup || mixed) metrics.defective += 1;
  }
  return metrics;
}

function overMatchMetrics(meta) {
  const metrics = emptyOverMatch();
  const doc = bookCache.getProfile(meta.source, meta.userKey);
  if (!doc || !Array.isArray(doc.events)) return metrics;
  const prepared = prepareEvents([doc], {
    yearOverrides: bookCache.getYearOverrides(meta.source, meta.userKey),
  });
  const byWork = new Map();
  for (const event of prepared.events) {
    const title = normalizeTitle(event.title);
    if (!title) continue;
    if (!byWork.has(event.workId)) byWork.set(event.workId, new Map());
    const titles = byWork.get(event.workId);
    titles.set(title, (titles.get(title) || 0) + 1);
  }
  const hits = [];
  for (const [workId, titles] of byWork) {
    if (titles.size < 2) continue;
    hits.push([workId, [...titles.keys()]]);
  }
  hits.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  metrics.count = hits.length;
  metrics.examples = hits
    .slice(0, EXAMPLE_LIMIT)
    .map(([workId, titles]) => `${workId}: ${titles.slice(0, 2).map(clip).join(' / ')}`);
  return metrics;
}

function eventIsbnOf(raw) {
  if (!raw) return null;
  const edition = raw.edition && typeof raw.edition === 'object' ? raw.edition : {};
  return raw.isbn13 || raw.isbn || edition.isbn13 || edition.isbn10 || edition.isbn || null;
}

function linksMetrics(profileDocs) {
  const metrics = {
    total: 0,
    methods: {},
    lowScore: 0,
    lowScoreExamples: [],
    isbnMismatch: 0,
    isbnMismatchExamples: [],
    orphans: 0,
    orphansExamples: [],
  };
  const eventKeys = new Map();
  for (const doc of profileDocs) {
    for (const raw of Array.isArray(doc && doc.events) ? doc.events : []) {
      const key = eventLinkKeyOf(raw);
      if (key && !eventKeys.has(key)) eventKeys.set(key, raw);
    }
  }
  let names = [];
  try {
    names = fs.readdirSync(bookCache.LINKS_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const key = name.slice(0, -5);
    const found = bookCache.readJsonWithFingerprint(path.join(bookCache.LINKS_DIR, name));
    const doc = found && found.data;
    if (!doc || typeof doc !== 'object') continue;
    metrics.total += 1;
    const method = doc.method == null || doc.method === '' ? '(none)' : String(doc.method);
    bump(metrics.methods, method);
    const score = doc.score == null ? null : Number(doc.score);
    if (score != null && Number.isFinite(score) && score < 0.9) {
      metrics.lowScore += 1;
      if (metrics.lowScoreExamples.length < EXAMPLE_LIMIT) {
        metrics.lowScoreExamples.push(`${key} score=${score}`);
      }
    }
    const raw = eventKeys.get(key);
    if (!raw) {
      metrics.orphans += 1;
      if (metrics.orphansExamples.length < EXAMPLE_LIMIT) {
        metrics.orphansExamples.push(`${key} -> ${doc.workId == null ? '?' : doc.workId}`);
      }
      continue;
    }
    const evidenceIsbn = normalizeIsbn(doc.evidence && doc.evidence.isbn);
    const eventIsbn = normalizeIsbn(eventIsbnOf(raw));
    if (evidenceIsbn && eventIsbn && eventIsbn !== evidenceIsbn) {
      metrics.isbnMismatch += 1;
      if (metrics.isbnMismatchExamples.length < EXAMPLE_LIMIT) {
        metrics.isbnMismatchExamples.push(`${key} event=${eventIsbn} evidence=${evidenceIsbn}`);
      }
    }
  }
  metrics.methods = sortedCounts(metrics.methods);
  return metrics;
}

function metricsForProfile(meta) {
  const profileKey = profileKeyOf(meta);
  const payload = buildBooksStats({ profile: profileKey });
  const metrics = emptyProfileMetrics();
  const entries = Object.values(payload.booksIndex);
  metrics.works = entries.length;
  metrics.events = payload.summary.eventCount;
  metrics.unresolved = payload.unmatchedCount;
  const claimCounts = {};
  for (const work of entries) {
    const source = work.yearSource;
    if (source === 'first' || source === 'manual' || source === 'edition') {
      metrics.yearSources[source] += 1;
    } else {
      metrics.yearSources.none += 1;
    }
    const claim =
      work.firstPublishedYearSource == null || work.firstPublishedYearSource === ''
        ? '(none)'
        : String(work.firstPublishedYearSource);
    bump(claimCounts, claim);
  }
  metrics.claimSources = sortedCounts(claimCounts, true);
  const dup = canonicalDupMetrics(entries);
  metrics.dupGroups = dup.groups;
  metrics.dupExtra = dup.extra;
  metrics.dupExamples = dup.examples;
  const sameTitle = sameTitleMetrics(entries);
  metrics.sameTitleGroups = sameTitle.groups;
  metrics.sameTitleExamples = sameTitle.examples;
  metrics.series = seriesMetrics(payload);
  metrics.overMatch = overMatchMetrics(meta);
  return metrics;
}

function mergeExamples(target, extra) {
  for (const item of extra) {
    if (target.length >= EXAMPLE_LIMIT) break;
    target.push(item);
  }
}

function mergeInto(total, metrics) {
  total.works += metrics.works;
  total.events += metrics.events;
  total.unresolved += metrics.unresolved;
  for (const key of Object.keys(total.yearSources)) {
    total.yearSources[key] += metrics.yearSources[key] || 0;
  }
  for (const [key, value] of Object.entries(metrics.claimSources)) {
    total.claimSources[key] = (total.claimSources[key] || 0) + value;
  }
  total.dupGroups += metrics.dupGroups;
  total.dupExtra += metrics.dupExtra;
  mergeExamples(total.dupExamples, metrics.dupExamples);
  total.sameTitleGroups += metrics.sameTitleGroups;
  mergeExamples(total.sameTitleExamples, metrics.sameTitleExamples);
  const totalSeries = total.series;
  const series = metrics.series;
  totalSeries.total += series.total;
  totalSeries.singletons += series.singletons;
  totalSeries.splitGroups += series.splitGroups;
  totalSeries.splitSeries += series.splitSeries;
  mergeExamples(totalSeries.splitExamples, series.splitExamples);
  totalSeries.internalDup += series.internalDup;
  mergeExamples(totalSeries.internalDupExamples, series.internalDupExamples);
  totalSeries.mixedScript += series.mixedScript;
  mergeExamples(totalSeries.mixedScriptExamples, series.mixedScriptExamples);
  totalSeries.defective += series.defective;
  total.overMatch.count += metrics.overMatch.count;
  mergeExamples(total.overMatch.examples, metrics.overMatch.examples);
}

function finalize(total) {
  total.claimSources = sortedCounts(total.claimSources, true);
  return total;
}

function countsLine(map) {
  const entries = Object.entries(map);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(' ') : '(none)';
}

function examplesSuffix(list) {
  return list.length ? ` | ${list.join('; ')}` : '';
}

function parenExamples(list) {
  return list.length ? ` (${list.join('; ')})` : '';
}

function renderProfile(key, m) {
  const lines = [];
  lines.push(`profile ${key}`);
  lines.push(`  works ${m.works} | events ${m.events} | unresolved ${m.unresolved}`);
  lines.push(`  years ${countsLine(m.yearSources)} | claims ${countsLine(m.claimSources)}`);
  lines.push(
    `  dup-canonical groups=${m.dupGroups} extra=${m.dupExtra}${examplesSuffix(m.dupExamples)}`
  );
  lines.push(`  same-title groups=${m.sameTitleGroups}${examplesSuffix(m.sameTitleExamples)}`);
  const s = m.series;
  const seriesExamples = [];
  if (s.splitExamples.length) seriesExamples.push(`split: ${s.splitExamples.join('; ')}`);
  if (s.internalDupExamples.length) seriesExamples.push(`dup-in: ${s.internalDupExamples.join('; ')}`);
  if (s.mixedScriptExamples.length) seriesExamples.push(`mixed: ${s.mixedScriptExamples.join('; ')}`);
  lines.push(
    `  series total=${s.total} singletons=${s.singletons} split-groups=${s.splitGroups}`
      + ` split-series=${s.splitSeries} dup-in=${s.internalDup} mixed=${s.mixedScript}`
      + ` defective=${s.defective}${seriesExamples.length ? ` | ${seriesExamples.join(' | ')}` : ''}`
  );
  lines.push(`  over-match ${m.overMatch.count}${examplesSuffix(m.overMatch.examples)}`);
  return lines;
}

function renderHuman(report) {
  const lines = [`books-quality ${report.cache}`];
  for (const [key, metrics] of Object.entries(report.profiles)) {
    lines.push(...renderProfile(key, metrics));
  }
  const links = report.links;
  lines.push(
    `links total=${links.total} | methods ${countsLine(links.methods)}`
      + ` | low-score=${links.lowScore}${parenExamples(links.lowScoreExamples)}`
      + ` | isbn-mismatch=${links.isbnMismatch}${parenExamples(links.isbnMismatchExamples)}`
      + ` | orphans=${links.orphans}${parenExamples(links.orphansExamples)}`
  );
  const total = report.total;
  lines.push(
    `total works=${total.works} events=${total.events} unresolved=${total.unresolved}`
      + ` dup-groups=${total.dupGroups} dup-extra=${total.dupExtra}`
      + ` same-title=${total.sameTitleGroups} series=${total.series.total}`
      + ` defective-series=${total.series.defective} over-match=${total.overMatch.count}`
  );
  return `${lines.join('\n')}\n`;
}

const diskProfiles = bookCache.listProfiles();
const available = new Map(diskProfiles.map((meta) => [profileKeyOf(meta).toLowerCase(), meta]));
let selected;
if (args.profiles.length) {
  selected = [];
  const missing = [];
  for (const token of args.profiles) {
    const hit = available.get(token.toLowerCase());
    if (hit) selected.push(hit);
    else missing.push(token);
  }
  if (missing.length) {
    process.stderr.write(`unknown profile(s): ${missing.join(', ')}\n`);
    process.stderr.write(`available: ${[...available.keys()].sort().join(', ') || '(none)'}\n`);
    process.exit(1);
  }
} else {
  selected = [...available.values()];
}
selected.sort((a, b) => profileKeyOf(a).localeCompare(profileKeyOf(b)));

const profiles = {};
const total = emptyProfileMetrics();
for (const meta of selected) {
  const metrics = metricsForProfile(meta);
  profiles[profileKeyOf(meta)] = metrics;
  mergeInto(total, metrics);
}
const profileDocs = selected.map((meta) => bookCache.getProfile(meta.source, meta.userKey));
const report = {
  cache: cacheRoot,
  profiles,
  links: linksMetrics(profileDocs),
  total: finalize(total),
};

if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(renderHuman(report));
