'use strict';

/**
 * Author identity for the books tab (КНИГИ-АРХИТЕКТУРА §7.2).
 *
 * A LiveLib profile lists authors in the Russian spelling the user saw
 * («Агата Кристи»), while the metadata chain returns the canonical English one
 * («Agatha Christie»). Counting them as two people doubles the authors widget
 * and splits one author's works across two rows.
 *
 * The merge is deliberately conservative — a false merge is worse than a
 * missed one:
 *
 *   1. exact normalized identity (case, «ё», punctuation, diacritics);
 *   2. the Hardcover author id (`hcId` in a details document) when both sides
 *      carry one;
 *   3. a length-aware Levenshtein distance ≤ 2 between the *transliterated*
 *      surnames (ISO-9/GOST table) **plus** a mandatory given-name signal:
 *      - full given names must be within the same distance,
 *      - an abbreviated side (`J. K.`) must have every initial covered by the
 *        full side (`Джон Рональд Руэл` → J. R. R.).
 *      The name check is what kills the known traps: Сьюзан Кинг vs Стивен
 *      Кинг (surname equal, given `syuzan` vs `stiven` = 4), Марджори Ролингс
 *      vs J. K. Rowling (m vs j/k), Шарль де Костер vs G. B. Oster (sharl vs
 *      gb), Георг Эберс vs Giulia Enders (given names far apart).
 *
 * A transliteration never catches an established exonym (Кристи → Christie,
 * Шекспир → Shakespeare, Моэм → Maugham, Лавкрафт → Lovecraft): those need the
 * optional Wikidata bridge in `authors-wikidata.js`, and the persisted map
 * below so a manual/one-off merge survives a rebuild.
 *
 * The result is persisted in `cache-book/authors.json`
 * (`{ schemaVersion, canonical: {normalizedName: displayName}, aliases }`);
 * `canonical` is the durable alias table, `fingerprint` only says which corpus
 * produced it. Manual entries are kept on every save.
 */

const { cleanText } = require('./normalize');

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/** Lowercase, «ё»→«е», strip diacritics and punctuation, collapse spaces. */
function normalizeAuthorName(name) {
  return cleanText(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasCyrillic(value) {
  return /[\u0400-\u04ff]/.test(String(value || ''));
}

function hasLatin(value) {
  return /[a-z]/i.test(String(value || ''));
}

/** Tokens of a normalized name. */
function tokensOf(name) {
  return normalizeAuthorName(name).split(' ').filter(Boolean);
}

/** Surname = last token; "Джефф Вандермеер" → "вандермеер". */
function surnameKey(name) {
  const tokens = tokensOf(name);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

/** Given-name tokens (everything before the surname). */
function givenTokens(name) {
  const tokens = tokensOf(name);
  return tokens.slice(0, Math.max(0, tokens.length - 1));
}

/* ------------------------------------------------------------------ */
/* Transliteration                                                     */
/* ------------------------------------------------------------------ */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Rough ISO-9/GOST transliteration, then a light phonetic fold so the same
 * sound spelled by two traditions compares equal: `дж`→`j` (Джоан/Joan),
 * `ch`→`k` (Christie/Кристи), `ph`→`f`, `x`→`ks`.
 */
function translit(value) {
  const text = normalizeAuthorName(value);
  let out = '';
  for (const char of text) {
    if (TRANSLIT[char] != null) out += TRANSLIT[char];
    else if (char === ' ') out += ' ';
    else if (/[a-z0-9]/.test(char)) out += char;
    // Unknown punctuation is already gone in normalizeAuthorName.
  }
  return out
    .replace(/dzh/g, 'j')
    .replace(/ck/g, 'k')
    .replace(/ch/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/kh/g, 'h')
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/c/g, 'k')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** A short word allows one edit, a longer one two (research: ≤2 length-aware). */
function maxDistanceFor(value) {
  return String(value || '').length <= 4 ? 1 : 2;
}

/** `J. K.` → ['j','k']; `Джон` → ['j']; `J.R.R.` → ['j','r','r']. */
function initialsOfGiven(tokens) {
  const out = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.length === 1) {
      out.push(token);
      continue;
    }
    // A full first name still contributes its initial for the abbreviated
    // comparison (`Джон` → j).
    out.push(token[0]);
  }
  return out;
}

function isAbbreviated(token) {
  return token.length === 1;
}

/**
 * Do two given-name sequences describe the same person? Full names are
 * compared with the same length-aware distance; an abbreviated side only needs
 * its initials covered by the full side.
 */
function givenNamesCompatible(left, right) {
  if (!left.length || !right.length) return false;
  const leftShort = left.every(isAbbreviated);
  const rightShort = right.every(isAbbreviated);
  const leftInitials = initialsOfGiven(left);
  const rightInitials = initialsOfGiven(right);
  if (leftShort || rightShort) {
    const short = leftShort && rightShort ? (left.length <= right.length ? leftInitials : rightInitials) : leftShort ? leftInitials : rightInitials;
    const full = leftShort && rightShort ? (left.length <= right.length ? rightInitials : leftInitials) : leftShort ? rightInitials : leftInitials;
    // The abbreviated side may omit a middle name, never invent one.
    if (short.length > full.length) return false;
    return short.every((initial) => full.includes(initial));
  }
  const a = left.join(' ');
  const b = right.join(' ');
  if (a === b) return true;
  // Given names are allowed the full two edits (Джоан/Joanne), only very
  // short ones are held to one.
  const limit = (a.length <= 3 || b.length <= 3) ? 1 : 2;
  return levenshtein(a, b) <= limit;
}

/** Transliterated-name compatibility of two Cyrillic/Latin spellings. */
function namesLookAlike(left, right) {
  const leftSurname = translit(surnameKey(left));
  const rightSurname = translit(surnameKey(right));
  if (!leftSurname || !rightSurname) return false;
  if (leftSurname === rightSurname) {
    // The surname alone is not enough: the given name must also agree.
    return givenNamesCompatible(
      givenTokens(left).map(translit).filter(Boolean),
      givenTokens(right).map(translit).filter(Boolean)
    );
  }
  const limit = maxDistanceFor(leftSurname.length <= rightSurname.length ? leftSurname : rightSurname);
  if (levenshtein(leftSurname, rightSurname) > limit) return false;
  return givenNamesCompatible(
    givenTokens(left).map(translit).filter(Boolean),
    givenTokens(right).map(translit).filter(Boolean)
  );
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

function displayPreference(name, stats) {
  // Canonical English spelling wins when both exist (the metadata chain's
  // namespace is English), then an author with a Hardcover id, then the most
  // used spelling.
  const latin = hasLatin(name) && !hasCyrillic(name);
  return [
    latin ? 1 : 0,
    stats && stats.ids && stats.ids.size ? 1 : 0,
    stats ? stats.count : 0,
    -name.length,
  ];
}

function comparePreference(left, right) {
  const a = displayPreference(left.name, left.stats);
  const b = displayPreference(right.name, right.stats);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return left.name.localeCompare(right.name, 'ru');
}

/**
 * @param {Array<{name: string, id?: string|null, workId?: string}>} entries
 *        every author occurrence (one per work);
 * @param {{canonical?: object, manual?: object}} [persisted]
 * @returns {{groups: Array, canonicalOf: Map<string,string>, aliases: object,
 *            mergedGroups: number, mergedNames: number}}
 */
function groupAuthors(entries, persisted = {}) {
  const statsByKey = new Map();
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    const key = normalizeAuthorName(entry.name);
    if (!key) continue;
    if (!statsByKey.has(key)) {
      statsByKey.set(key, { key, name: cleanText(entry.name), count: 0, ids: new Set(), workIds: new Set() });
    }
    const stats = statsByKey.get(key);
    stats.count++;
    if (entry.id != null && entry.id !== '') stats.ids.add(String(entry.id));
    if (entry.workId) stats.workIds.add(String(entry.workId));
  }

  const keys = [...statsByKey.keys()];
  const parent = new Map(keys.map((key) => [key, key]));
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(key) !== key) {
      const next = parent.get(key);
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left === right) return;
    // Keep the lexicographically smaller key as the root for determinism.
    if (left < right) parent.set(right, left);
    else parent.set(left, right);
  };

  // 1. Hardcover author id: same id → same person, whatever the spelling.
  const byId = new Map();
  for (const stats of statsByKey.values()) {
    for (const id of stats.ids) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(stats.key);
    }
  }
  for (const list of byId.values()) {
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }

  // 2. Persisted alias table (manual edits included): a display name anchors
  //    every spelling mapped to it.
  const persistedCanonical = persisted && typeof persisted.canonical === 'object' && persisted.canonical
    ? persisted.canonical
    : {};
  const manual = persisted && typeof persisted.manual === 'object' && persisted.manual
    ? persisted.manual
    : {};
  const anchorByDisplay = new Map();
  for (const [key, display] of Object.entries(persistedCanonical)) {
    if (!statsByKey.has(key)) continue;
    const anchor = normalizeAuthorName(display);
    if (!anchorByDisplay.has(anchor)) anchorByDisplay.set(anchor, []);
    anchorByDisplay.get(anchor).push(key);
  }
  for (const list of anchorByDisplay.values()) {
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }
  for (const [key, display] of Object.entries(manual)) {
    if (!statsByKey.has(key)) continue;
    const anchorKey = normalizeAuthorName(display);
    if (!statsByKey.has(anchorKey)) {
      // The canonical spelling is not in the corpus: keep the mapping for the
      // output name but no union is possible.
      continue;
    }
    union(key, anchorKey);
  }

  // 3. Transliteration + given-name guard, only across scripts.
  const cyrillic = keys.filter((key) => hasCyrillic(key));
  const latin = keys.filter((key) => hasLatin(key) && !hasCyrillic(key));
  for (const leftKey of cyrillic) {
    for (const rightKey of latin) {
      if (find(leftKey) === find(rightKey)) continue;
      if (!namesLookAlike(statsByKey.get(leftKey).name, statsByKey.get(rightKey).name)) continue;
      union(leftKey, rightKey);
    }
  }

  const groupMap = new Map();
  for (const key of keys) {
    const root = find(key);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(statsByKey.get(key));
  }

  const canonicalOf = new Map();
  const aliases = {};
  const groups = [];
  let mergedGroups = 0;
  let mergedNames = 0;
  for (const list of groupMap.values()) {
    list.sort(comparePreference);
    const preferred = list[0].name;
    const manualDisplay = list
      .map((stats) => manual[stats.key])
      .find((value) => value && cleanText(value));
    const display = cleanText(manualDisplay) || preferred;
    const names = list.map((stats) => stats.name);
    for (const name of names) canonicalOf.set(normalizeAuthorName(name), display);
    if (list.length > 1) {
      mergedGroups++;
      mergedNames += list.length - 1;
      aliases[display] = names.filter((name) => name !== display);
    }
    groups.push({ name: display, names, workIds: [...new Set(list.flatMap((stats) => [...stats.workIds]))] });
  }
  return { groups, canonicalOf, aliases, mergedGroups, mergedNames };
}

/** Fingerprint of the corpus (sort of normalized names) for the cache file. */
function fingerprintOfNames(names) {
  const list = [...new Set((names || []).map(normalizeAuthorName).filter(Boolean))].sort();
  return list.join('|');
}

module.exports = {
  normalizeAuthorName,
  surnameKey,
  givenTokens,
  translit,
  levenshtein,
  maxDistanceFor,
  namesLookAlike,
  groupAuthors,
  fingerprintOfNames,
  hasCyrillic,
  hasLatin,
};
