'use strict';

const { normalizeSeriesName } = require('../series-identity');
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

function nameKeyOf(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

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

function seriesEntryKeys(entry) {
  if (!entry) return [];
  const keys = [];
  if (entry.hcId != null && entry.hcId !== '') keys.push(`id:${entry.hcId}`);
  const name = normalizeSeriesName(entry.name);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function seriesKeysOf(work) {
  const keys = [];
  for (const entry of work.series || []) {
    for (const key of seriesEntryKeys(entry)) keys.push(key);
  }
  return [...new Set(keys)];
}

function hasCyrillicTitle(work) {
  return /[\u0400-\u04ff]/.test(String(work.titleRu || work.title || ''));
}

function displayNameOf(aliases, preferCyrillic) {
  const entries = [...aliases.entries()].map(([name, count]) => ({ name, count }));
  entries.sort((a, b) => {
    const parens = (value) => (/\([^()]*\)/u.test(value.name) ? 1 : 0);
    const script = (value) => (preferCyrillic === /[\u0400-\u04ff]/.test(value.name) ? 0 : 1);
    if (parens(a) !== parens(b)) return parens(a) - parens(b);
    if (script(a) !== script(b)) return script(a) - script(b);
    if (a.count !== b.count) return b.count - a.count;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name, 'ru');
  });
  return entries.length ? entries[0].name : null;
}

function seriesIdOf(ids) {
  const numeric = [...ids]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
  if (numeric.length) return numeric[0];
  const text = [...ids].map(String).sort();
  return text.length ? text[0] : null;
}

function seriesGroupsOf(works) {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
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
    if (a !== b) parent.set(a, b);
  };

  const perWork = [];
  for (const work of works.values()) {
    const entries = (Array.isArray(work.series) ? work.series : []).filter(
      (entry) => entry && entry.name
    );
    if (!entries.length) continue;
    const keys = [];
    for (const entry of entries) {
      for (const key of seriesEntryKeys(entry)) if (!keys.includes(key)) keys.push(key);
    }
    if (!keys.length) continue;
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (let index = 1; index < keys.length; index++) union(keys[0], keys[index]);
    perWork.push({ work, entries, keys });
  }

  const groups = new Map();
  for (const item of perWork) {
    const root = find(item.keys[0]);
    if (!groups.has(root)) {
      groups.set(root, { key: root, ids: new Set(), aliases: new Map(), works: [], cyrillic: 0 });
    }
    const group = groups.get(root);
    const positions = [];
    for (const entry of item.entries) {
      if (entry.hcId != null && entry.hcId !== '') group.ids.add(entry.hcId);
      const name = String(entry.name || '').trim();
      if (name) group.aliases.set(name, (group.aliases.get(name) || 0) + 1);
      if (entry.position != null && Number.isFinite(Number(entry.position))) {
        positions.push(Number(entry.position));
      }
    }
    if (hasCyrillicTitle(item.work)) group.cyrillic++;
    group.works.push({
      work: item.work,
      position: positions.length ? Math.min(...positions) : null,
    });
  }

  const out = [];
  for (const group of groups.values()) {
    const preferCyrillic = group.cyrillic * 2 > group.works.length;
    out.push({
      key: group.key,
      seriesId: seriesIdOf(group.ids),
      name: displayNameOf(group.aliases, preferCyrillic) || group.key,
      works: group.works,
    });
  }
  return out;
}

function propagateSeriesManga(works) {
  const parent = new Map();
  const find = (key) => {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
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
  seriesEntryKeys,
  seriesKeysOf,
  seriesGroupsOf,
  propagateSeriesManga,
  applyManualMangaFlags,
  dedupeSeriesSubsets,
};
