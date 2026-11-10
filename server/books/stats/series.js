'use strict';

/**
 * Series and file-export metadata of the books stats payload: series list
 * shape, the Литрес pseudo-series filter, bibliographic columns carried by a
 * `livelib-backup` export, series-level manga/comics propagation and the
 * sub-series dedupe.
 *
 * R12 «god module» split: moved out of `books/stats.js` unchanged.
 */

const { saneYear } = require('./numeric');
const { FILE_METADATA_SOURCE } = require('./constants');

function detailsSeries(details) {
  if (!details || !Array.isArray(details.series)) return [];
  const out = [];
  for (const entry of details.series) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ hcId: null, name: entry.trim(), position: null });
      continue;
    }
    if (entry.name) {
      out.push({
        hcId: entry.hcId == null ? null : entry.hcId,
        name: entry.name,
        position: entry.position == null ? null : entry.position,
        ...(entry.source ? { source: String(entry.source) } : {}),
      });
    }
  }
  return out;
}

function metadataSourcesOf(details) {
  if (!details) return [];
  if (Array.isArray(details.metadataSources) && details.metadataSources.length) {
    return [...new Set(details.metadataSources.filter(Boolean))];
  }
  if (Array.isArray(details.sources) && details.sources.length) {
    return [...new Set(details.sources.map((entry) => entry && entry.source).filter(Boolean))];
  }
  return details.hcWorkId != null ? ['hardcover'] : [];
}

/** Identity of a genre/series name for dedupe (case, «ё», punctuation). */
function nameKeyOf(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Union of series entries: the chain knows ids/positions, the file knows the
 * RU series label (`edition.series`). Same name → the richer entry (one with a
 * position/hcId) wins; a file-only name is kept as a positionless entry.
 */
function mergeSeriesLists(primary, extra) {
  const out = [];
  const index = new Map();
  for (const entry of Array.isArray(primary) ? primary : []) {
    if (!entry || !entry.name) continue;
    const key = nameKeyOf(entry.name);
    if (!key || index.has(key)) continue;
    index.set(key, out.length);
    out.push({ ...entry });
  }
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (!entry || !entry.name) continue;
    const key = nameKeyOf(entry.name);
    if (!key) continue;
    if (index.has(key)) {
      const current = out[index.get(key)];
      if (current.position == null && entry.position != null) current.position = entry.position;
      if (current.hcId == null && entry.hcId != null) current.hcId = entry.hcId;
      continue;
    }
    index.set(key, out.length);
    out.push({ ...entry });
  }
  return out;
}

/**
 * Metadata carried by `livelib-backup` file events themselves.
 *
 * The export can include «Жанры», «Издатель», «Дата издания», «Язык»,
 * «Серия», «ISBN» — the same fields the resolve chain would fetch. When they
 * are present they are used directly: a file-imported profile renders genres,
 * series and publishers without a single network request (the point of the
 * safe path). When the chain resolves a work too, the two corpora are unioned
 * (`mergeGenreLists`/`mergeSeriesLists`) and `metadataSources` lists both.
 *
 * Two flags, because "the file was parsed" and "the file says something about
 * this book" are different questions:
 *   - `present` — at least one bibliographic value was extracted (genres,
 *     series, publisher, year, ISBN or language); it drives
 *     `metadataSources: ['livelib-file']`;
 *   - `coverage` — the fields the «Метадата: N%» badge speaks about
 *     (genres, series, year — exactly what its hint lists). A minimal export
 *     (title + date only, or a publisher column without genres) leaves the
 *     profile genuinely unenriched, so it must count as unresolved instead of
 *     pretending to be 100% covered.
 */
function fileMetadataOf(events) {
  const empty = {
    present: false,
    coverage: false,
    genres: [],
    series: [],
    publisher: null,
    year: null,
    isbn13: null,
    isbn10: null,
    language: null,
  };
  const rows = (events || []).filter((event) => event && event.origin === FILE_METADATA_SOURCE);
  if (!rows.length) return empty;

  const genres = [];
  const series = [];
  let publisher = null;
  let year = null;
  let isbn13 = null;
  let isbn10 = null;
  let language = null;
  for (const event of rows) {
    for (const name of Array.isArray(event.genres) ? event.genres : []) {
      const clean = String(name || '').trim();
      if (clean && !genres.includes(clean)) genres.push(clean);
    }
    const edition = event.edition && typeof event.edition === 'object' ? event.edition : {};
    const seriesName = String(edition.series || '').trim();
    if (seriesName && !series.some((entry) => entry.name === seriesName)) {
      series.push({ hcId: null, name: seriesName, position: null });
    }
    const publisherName = String(edition.publisher || '').trim();
    if (!publisher && publisherName) publisher = publisherName;
    if (year == null) year = saneYear(edition.year);
    if (!isbn13 && edition.isbn13) isbn13 = String(edition.isbn13);
    if (!isbn13 && edition.isbn) isbn13 = String(edition.isbn);
    if (!isbn10 && edition.isbn10) isbn10 = String(edition.isbn10);
    if (!language && edition.language) language = String(edition.language);
  }
  const coverage = genres.length > 0 || series.length > 0 || year != null;
  const present =
    coverage || Boolean(publisher) || Boolean(isbn13) || Boolean(isbn10) || Boolean(language);
  return { present, coverage, genres, series, publisher, year, isbn13, isbn10, language };
}

/**
 * Series entries of a details document, with the Литрес pseudo-series trap
 * removed (§7.4, 28.10.2026).
 *
 * Литрес exposes its catalogue tags in the same `series` array as a real
 * literary series: «Книга на все времена», «Азбука-классика» are shelves, not
 * series. A real series carries a volume order (`art_order` ≥ 1); a positionless
 * Литрес entry is kept only when the user's own export names the same series
 * (the file column is the authority). Hardcover/LiveLib-card series are never
 * filtered by this rule.
 */
function filterDetailsSeries(details, fileSeriesNames) {
  const list = detailsSeries(details);
  const sourceNames = metadataSourcesOf(details);
  const litresOnly = sourceNames.length === 1 && sourceNames[0] === 'litres';
  const fileKeys = new Set(
    (Array.isArray(fileSeriesNames) ? fileSeriesNames : [])
      .map((name) => nameKeyOf(name))
      .filter(Boolean)
  );
  return list.filter((entry) => {
    const fromLitres = entry.source === 'litres' || (entry.source == null && litresOnly);
    if (!fromLitres) return true;
    const position = Number(entry.position);
    if (Number.isFinite(position) && position >= 1) return true;
    return fileKeys.has(nameKeyOf(entry.name));
  });
}

/* ------------------------------------------------------------------ */
/* Series-level aggregation and dedupe                                 */
/* ------------------------------------------------------------------ */

function normalizeSeriesName(name) {
  return String(name == null ? '' : name)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Hardcover splits one series into several ids with display suffixes:
    // "Crossed", "Crossed (Collected Editions)", "Crossed (Single Issues)"
    // share the same shelf. The suffix is presentation, not identity.
    .replace(/\s*\([^()]*\)\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesKeysOf(work) {
  const keys = [];
  for (const entry of work.series || []) {
    if (!entry) continue;
    if (entry.hcId != null && entry.hcId !== '') keys.push(`id:${entry.hcId}`);
    // Keep the name key even when an id is present: the same series arrives
    // with different Hardcover ids ("Crossed" 4443 vs "Crossed (Collected
    // Editions)" 14693), and an id-only join leaves those volumes behind.
    const name = normalizeSeriesName(entry.name);
    if (name) keys.push(`name:${name}`);
  }
  return [...new Set(keys)];
}

/**
 * Series-level manga/comics propagation.
 *
 * The per-work flag is derived from that work's own genres/series/publisher.
 * Hardcover tags are inconsistent across volumes of the same series: "Fables"
 * has volumes with "Graphic Novels" (flag true) next to volumes tagged only
 * "Fantasy, Adventure" (flag false), and "Homunculus" has volumes with
 * "Comics" next to volumes with no genres at all (null). The user reads one
 * series, so a single comic volume marks the whole series as comics.
 *
 * Rules:
 *   - a work may belong to several series entries (LiveLib name + Hardcover id);
 *     those keys are unioned, so "Fables" and "Fables +" stay one series;
 *   - `true` from any volume wins over per-work `false`/`null`;
 *   - `false` never propagates (an explicit clean genre list says nothing
 *     about the sibling volume).
 * The change is applied to the aggregation copy only (`work.mangaComics`);
 * persisted details files are untouched.
 *
 * Returns the ids of the works it marked.
 */
function propagateSeriesManga(works) {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    // Path compression keeps repeated lookups cheap on long series lists.
    let cursor = key;
    while (parent.has(cursor) && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    parent.set(a, b);
  };

  const keysByWork = new Map();
  for (const work of works.values()) {
    const keys = seriesKeysOf(work);
    keysByWork.set(work.workId, keys);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
  }

  const mangaSeries = new Set();
  for (const work of works.values()) {
    if (work.mangaComics !== true) continue;
    for (const key of keysByWork.get(work.workId) || []) mangaSeries.add(find(key));
  }

  const propagated = new Set();
  if (mangaSeries.size === 0) return propagated;
  for (const work of works.values()) {
    if (work.mangaComics === true) continue;
    const hit = (keysByWork.get(work.workId) || []).some((key) => mangaSeries.has(find(key)));
    if (!hit) continue;
    work.mangaComics = true;
    work.mangaComicsSource = 'series';
    propagated.add(work.workId);
  }
  return propagated;
}

/**
 * Per-work manual override, applied last: after provider detection and after
 * series propagation, before any aggregation. It is the user's word over the
 * detector's, in both directions:
 *   - `mangaComics: true`  hides a work even if all genres look clean;
 *   - `mangaComics: false` keeps a work that the detector/series calls comics
 *     ("показать снова").
 *
 * Dedupe may merge a LiveLib stub into a Hardcover work; an override stored on
 * any of the merged ids applies to the combined work.
 *
 * Returns `Map<workId, {mangaComics, previous}>` for the summary counters.
 */
function applyManualMangaFlags(works, flags) {
  const applied = new Map();
  if (!flags || typeof flags !== 'object') return applied;
  for (const work of works.values()) {
    const ids =
      Array.isArray(work.mergedWorkIds) && work.mergedWorkIds.length
        ? work.mergedWorkIds
        : [work.workId];
    if (work.metadataWorkId && !ids.includes(work.metadataWorkId)) ids.push(work.metadataWorkId);
    let entry = null;
    for (const id of ids) {
      const candidate = flags[id];
      if (candidate && typeof candidate.mangaComics === 'boolean') {
        entry = candidate;
        break;
      }
    }
    if (!entry) continue;
    const previous = work.mangaComics;
    work.mangaComics = entry.mangaComics;
    work.mangaComicsSource = 'manual';
    work.mangaComicsOverride = entry.mangaComics;
    work.mangaComicsUpdatedAt = entry.updatedAt || null;
    applied.set(work.workId, { mangaComics: entry.mangaComics, previous });
  }
  return applied;
}

/**
 * Sub-series dedupe (user rule, 28.10.2026): «если у нас несколько серий с
 * одинаковыми книгами, показываем только ту, в которой книг больше всего».
 *
 * Works are compared by exact book identity, so two volumes of one manga are
 * two works (matching the bookCount contract). Equal sets keep the plain name
 * («The Witcher» beats «The Witcher (Publication order)»); a strict subset is
 * dropped in favour of its superset; a partial overlap keeps both series.
 */
function dedupeSeriesSubsets(list) {
  const entries = (Array.isArray(list) ? list : []).map((entry, index) => ({
    entry,
    index,
    works: new Set((entry.works || []).map((work) => String(work.workId))),
    name: String(entry.name || ''),
  }));
  const dropped = new Set();
  const plainName = (name) => normalizeSeriesName(name);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (dropped.has(entries[i].index) || dropped.has(entries[j].index)) continue;
      const a = entries[i];
      const b = entries[j];
      if (!a.works.size || !b.works.size) continue;
      let aSubset = true;
      let bSubset = true;
      for (const id of a.works) if (!b.works.has(id)) { aSubset = false; break; }
      for (const id of b.works) if (!a.works.has(id)) { bSubset = false; break; }
      if (!aSubset && !bSubset) continue;
      let drop = null;
      if (aSubset && bSubset) {
        // Same books: prefer the plain/shorter name, then the more generic
        // (both names normalize to the same series) one.
        const aPlain = plainName(a.name) === plainName(b.name);
        const aSimple = !/\([^()]*\)\s*$/u.test(a.name);
        const bSimple = !/\([^()]*\)\s*$/u.test(b.name);
        const aBetter = aSimple !== bSimple
          ? aSimple
          : a.name.length !== b.name.length
          ? a.name.length < b.name.length
          : a.name.localeCompare(b.name, 'ru') <= 0 || aPlain;
        drop = aBetter ? b : a;
      } else {
        // Strict subset: keep the series with more books.
        if (a.works.size > b.works.size) drop = b;
        else if (b.works.size > a.works.size) drop = a;
        else drop = b.name.length >= a.name.length ? b : a;
      }
      if (drop) dropped.add(drop.index);
    }
  }
  return entries.filter((entry) => !dropped.has(entry.index)).map((entry) => entry.entry);
}

module.exports = {
  detailsSeries,
  metadataSourcesOf,
  nameKeyOf,
  mergeSeriesLists,
  fileMetadataOf,
  filterDetailsSeries,
  normalizeSeriesName,
  seriesKeysOf,
  propagateSeriesManga,
  applyManualMangaFlags,
  dedupeSeriesSubsets,
};
