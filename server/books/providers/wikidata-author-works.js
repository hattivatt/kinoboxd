'use strict';

const { titleVariants, partVariants } = require('./title-variants');

const NAMES_PER_QUERY = 40;
const AUTHORS_PER_QUERY = 15;
const MATCH_FLOOR = 0.75;
const STOP_WORDS = new Set(['и', 'в', 'на', 'с', 'о', 'the', 'a', 'an', 'of', 'or', 'или', 'and']);

const NAMES_QUERY = `
SELECT ?name ?human ?sitelinks WHERE {
  VALUES ?name { __NAMES__ }
  { ?human rdfs:label ?name } UNION { ?human skos:altLabel ?name }
  ?human wdt:P31 wd:Q5 .
  ?human wikibase:sitelinks ?sitelinks .
  FILTER EXISTS { ?anyWork wdt:P50 ?human }
}`;

const WORKS_QUERY = `
SELECT ?human ?humanBirth ?work ?label ?p577 ?p577Prec ?p571 ?p571Prec WHERE {
  VALUES ?human { __HUMANS__ }
  ?work wdt:P50 ?human .
  FILTER NOT EXISTS { ?work wdt:P629 ?canonicalWork }
  { ?work rdfs:label ?label FILTER(LANG(?label) = "ru" || LANG(?label) = "en") }
  UNION { ?work skos:altLabel ?label FILTER(LANG(?label) = "ru") }
  OPTIONAL { ?human wdt:P569 ?humanBirth }
  OPTIONAL {
    ?work p:P577 ?st577 . ?st577 psv:P577 ?v577 .
    ?v577 wikibase:timeValue ?p577 ; wikibase:timePrecision ?p577Prec .
  }
  OPTIONAL {
    ?work p:P571 ?st571 . ?st571 psv:P571 ?v571 .
    ?v571 wikibase:timeValue ?p571 ; wikibase:timePrecision ?p571Prec .
  }
  FILTER(BOUND(?p577) || BOUND(?p571))
}`;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function quoted(value) {
  return `"${String(value).replace(/["\\]/g, '')}"`;
}

function nameForms(name) {
  const raw = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (raw.length < 3) return [];
  const forms = new Set([raw]);
  const tokens = raw.split(' ');
  if (tokens.length === 2) forms.add(`${tokens[1]} ${tokens[0]}`);
  const noDots = raw.replace(/ё/g, 'е');
  forms.add(noDots);
  return [...forms];
}

function stem(word) {
  if (word.length > 5) return word.slice(0, -2);
  if (word.length > 3) return word.slice(0, -1);
  return word;
}

function titleTokens(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stem);
}

function titleSimilarity(left, right) {
  const a = new Set(titleTokens(left));
  const b = new Set(titleTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.max(a.size, b.size);
}

function claimOfRow(row) {
  const pick = (time, precision, kind) =>
    time && time.year != null ? { year: time.year, precision: precision || 'year', kind } : null;
  const publication = pick(row.publication, row.publicationPrecision, 'publication');
  const composition = pick(row.inception, row.inceptionPrecision, 'composition');
  if (publication && composition) return composition.year < publication.year ? composition : publication;
  return publication || composition;
}

async function resolveAuthors(names, deps) {
  const byName = new Map();
  const forms = new Map();
  for (const name of names) {
    for (const form of nameForms(name)) {
      if (!forms.has(form)) forms.set(form, new Set());
      forms.get(form).add(name);
    }
  }
  const allForms = [...forms.keys()];
  for (const chunk of chunks(allForms, NAMES_PER_QUERY)) {
    const values = chunk.map((form) => `${quoted(form)}@ru ${quoted(form)}@en`).join(' ');
    const rows = await deps.query(NAMES_QUERY.replace('__NAMES__', values));
    for (const row of rows) {
      const qid = deps.qidOf(row.human && row.human.value);
      const sitelinks = Number(row.sitelinks && row.sitelinks.value) || 0;
      const form = row.name && row.name.value;
      if (!qid || !form) continue;
      for (const name of forms.get(form) || []) {
        const current = byName.get(name);
        if (!current || current.sitelinks < sitelinks) byName.set(name, { qid, sitelinks });
      }
    }
  }
  return byName;
}

async function worksOf(qids, deps) {
  const byAuthor = new Map();
  for (const chunk of chunks(qids, AUTHORS_PER_QUERY)) {
    const values = chunk.map((qid) => `wd:${qid}`).join(' ');
    const rows = await deps.query(WORKS_QUERY.replace('__HUMANS__', values));
    for (const row of rows) {
      const value = (name) => (row[name] ? row[name].value : null);
      const human = deps.qidOf(value('human'));
      const work = deps.qidOf(value('work'));
      if (!human || !work || !value('label')) continue;
      const claim = claimOfRow({
        publication: { year: deps.timeYear(value('p577')) },
        publicationPrecision: deps.precisionOf(value('p577Prec')),
        inception: { year: deps.timeYear(value('p571')) },
        inceptionPrecision: deps.precisionOf(value('p571Prec')),
      });
      if (!claim) continue;
      const list = byAuthor.get(human) || [];
      list.push({
        human,
        work,
        label: value('label'),
        claim,
        authorBirthYear: deps.timeYear(value('humanBirth')),
      });
      byAuthor.set(human, list);
    }
  }
  return byAuthor;
}

function bestWork(entry, works) {
  const parts = partVariants(entry.title, entry.authors);
  const tiers = [titleVariants(entry.title), parts.subtitle, parts.whole];
  for (const [tier, variants] of tiers.entries()) {
    let best = null;
    for (const work of works) {
      for (const variant of variants) {
        const similarity = titleSimilarity(variant, work.label);
        if (similarity < MATCH_FLOOR) continue;
        const better =
          !best ||
          similarity > best.similarity ||
          (similarity === best.similarity && work.claim.year < best.work.claim.year);
        if (better) best = { work, similarity, tier };
      }
    }
    if (best) return best;
  }
  return null;
}

async function lookupByAuthorWorks(entries, deps) {
  const found = new Map();
  const named = entries.filter((entry) => Array.isArray(entry.authors) && entry.authors.length);
  if (!named.length) return found;
  const names = [...new Set(named.flatMap((entry) => entry.authors))];
  const authors = await resolveAuthors(names, deps);
  const qids = [...new Set([...authors.values()].map((entry) => entry.qid))];
  if (!qids.length) return found;
  const works = await worksOf(qids, deps);
  for (const entry of named) {
    const pool = [];
    const seen = new Set();
    for (const name of entry.authors) {
      const author = authors.get(name);
      if (!author || seen.has(author.qid)) continue;
      seen.add(author.qid);
      pool.push(...(works.get(author.qid) || []));
    }
    const best = bestWork(entry, pool);
    if (best) found.set(String(entry.key), { ...best, authorName: entry.authors[0] });
  }
  return found;
}

module.exports = {
  NAMES_QUERY,
  WORKS_QUERY,
  nameForms,
  titleSimilarity,
  bestWork,
  lookupByAuthorWorks,
};
