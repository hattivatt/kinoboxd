'use strict';

const { cleanText } = require('./normalize');

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

function tokensOf(name) {
  return normalizeAuthorName(name).split(' ').filter(Boolean);
}

function surnameKey(name) {
  const tokens = tokensOf(name);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function givenTokens(name) {
  const tokens = tokensOf(name);
  return tokens.slice(0, Math.max(0, tokens.length - 1));
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(value) {
  const text = normalizeAuthorName(value);
  let out = '';
  for (const char of text) {
    if (TRANSLIT[char] != null) out += TRANSLIT[char];
    else if (char === ' ') out += ' ';
    else if (/[a-z0-9]/.test(char)) out += char;
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

function maxDistanceFor(value) {
  return String(value || '').length <= 4 ? 1 : 2;
}

function initialsOfGiven(tokens) {
  const out = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.length === 1) {
      out.push(token);
      continue;
    }
    out.push(token[0]);
  }
  return out;
}

function isAbbreviated(token) {
  return token.length === 1;
}

function givenNamesCompatible(left, right) {
  if (!left.length || !right.length) return false;
  const leftShort = left.every(isAbbreviated);
  const rightShort = right.every(isAbbreviated);
  const leftInitials = initialsOfGiven(left);
  const rightInitials = initialsOfGiven(right);
  if (leftShort || rightShort) {
    const short = leftShort && rightShort ? (left.length <= right.length ? leftInitials : rightInitials) : leftShort ? leftInitials : rightInitials;
    const full = leftShort && rightShort ? (left.length <= right.length ? rightInitials : leftInitials) : leftShort ? rightInitials : leftInitials;
    if (leftShort && rightShort) {
      return short.length === full.length && short.every((initial) => full.includes(initial));
    }
    if (short.length > full.length) {
      if (!short.length || !full.length || short[0] !== full[0]) return false;
      return short.slice(0, full.length).every((initial, index) => initial === full[index]);
    }
    return short.every((initial) => full.includes(initial));
  }
  const a = left.join(' ');
  const b = right.join(' ');
  if (a === b) return true;
  const limit = (a.length <= 3 || b.length <= 3) ? 1 : 2;
  return levenshtein(a, b) <= limit;
}

function namesLookAlike(left, right) {
  const leftSurname = translit(surnameKey(left));
  const rightSurname = translit(surnameKey(right));
  if (!leftSurname || !rightSurname) return false;
  if (leftSurname === rightSurname) {
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

function displayPreference(name, stats) {
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
    if (left < right) parent.set(right, left);
    else parent.set(left, right);
  };

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
      continue;
    }
    union(key, anchorKey);
  }

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
