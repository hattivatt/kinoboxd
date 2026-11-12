'use strict';

/**
 * String/number primitives of the edition matcher (ИГРЫ-АРХИТЕКТУРА §4.1, M5-B).
 *
 * Pure functions only: every helper here turns a raw Steam/Wikidata string into
 * tokens, or compares two already-normalized values. Nothing in this module
 * touches disk, the network or another file of the package.
 *
 * False-positive guards start here: the numeric signature (`2`, `III`, `IV`)
 * is the part that must never differ between editions, and edition/region
 * wrappers are stripped once, by `coreTokens`. The guards built on top of it
 * (type, developers, franchise key, release year) live in `match.js`.
 */

/** Words that are an edition wrapper wherever they appear in a title. */
const EDITION_WORDS = new Set([
  'edition',
  'remastered',
  'remaster',
  'warmastered',
  'enhanced',
  'definitive',
  'deluxe',
  'ultimate',
  'complete',
  'extended',
  'anniversary',
  'special',
  'classic',
  'hd',
  'goty',
]);

/** Multi-word wrappers, removed before the single words above. */
const EDITION_PHRASES = [
  ['game', 'of', 'the', 'year'],
  ['director', 's', 'cut'],
  ['directors', 'cut'],
  ['gold', 'classic'],
  ['black', 'edition'],
  ['steam', 'edition'],
  ['legacy', 'edition'],
  ['reloaded', 'edition'],
];

/** Region wrappers: only stripped when trailing or parenthesized. */
const REGION_WORDS = new Set([
  'ru',
  'rhcp',
  'pcr',
  'cis',
  'row',
  'eur',
  'eu',
  'us',
  'jp',
  'kr',
  'cn',
  'br',
  'pl',
  'cz',
]);

function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/[™®©]/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»“”„"']/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRomanNumber(token) {
  return /^[ivxlcdm]+$/.test(token) && token.length <= 6;
}

/** `2`, `III`, `IV` — the part that must never differ between editions. */
function numericSignature(tokens) {
  return tokens
    .filter((token) => /^\d+$/.test(token) || isRomanNumber(token))
    .join(',');
}

function dropPhrases(tokens) {
  let current = tokens;
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of EDITION_PHRASES) {
      for (let index = 0; index + phrase.length <= current.length; index++) {
        let hit = true;
        for (let offset = 0; offset < phrase.length; offset++) {
          if (current[index + offset] !== phrase[offset]) {
            hit = false;
            break;
          }
        }
        if (hit) {
          current = [...current.slice(0, index), ...current.slice(index + phrase.length)];
          changed = true;
          index = -1;
        }
      }
    }
  }
  return current;
}

function hasEditionMarker(raw) {
  const value = cleanName(raw);
  if (!value) return false;
  if (/\([^)]*\)/.test(value)) {
    const inner = value.replace(/^.*\(([^)]*)\).*$/, '$1').trim();
    if (inner && (REGION_WORDS.has(inner) || inner.split(' ').some((word) => EDITION_WORDS.has(word)))) {
      return true;
    }
  }
  const tokens = value.split(' ').filter(Boolean);
  return tokens.some((token) => EDITION_WORDS.has(token) || REGION_WORDS.has(token)) ||
    EDITION_PHRASES.some((phrase) =>
      tokens.some((_, index) => phrase.every((word, offset) => tokens[index + offset] === word))
    );
}

/**
 * Normalized title tokens: edition/region wrappers removed, punctuation gone.
 * The numeric part is kept, because it is the main false-positive guard.
 *
 * Region wrappers are only dropped when they are unambiguously wrappers:
 * `(RU)`, or a trailing ALL-CAPS token (`Max Payne RU`, `… PCR`). A trailing
 * lowercase word is part of the title — otherwise `The Last of Us` would
 * become `the last of`.
 */
function coreTokens(name) {
  const raw = String(name == null ? '' : name);
  // Parenthesized wrappers: `(Classic)`, `(RU)` — but never `(2016)`, `(Obsolete)`.
  const parenWrappers = [];
  raw.replace(/\(([^)]*)\)/g, (match, inner) => {
    const text = String(inner || '').trim();
    if (!text) return match;
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (REGION_WORDS.has(lower) && text === text.toUpperCase()) parenWrappers.push(text);
    else if (words.length && words.every((word) => EDITION_WORDS.has(word))) parenWrappers.push(text);
    return match;
  });

  let value = cleanName(raw);
  if (!value) return [];
  for (const wrapper of parenWrappers) {
    const cleaned = cleanName(wrapper);
    if (!cleaned) continue;
    value = value.replace(new RegExp(`(?:^|\\s)${cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), ' ');
  }
  let tokens = value.split(' ').filter(Boolean);

  // Trailing region token, only when the original spelled it in caps.
  const trailing = raw.match(/([A-Za-z]{2,5})\s*\)?\s*$/);
  if (trailing && trailing[1] === trailing[1].toUpperCase()) {
    const region = trailing[1].toLowerCase();
    if (REGION_WORDS.has(region)) {
      while (tokens.length && tokens[tokens.length - 1] === region) tokens.pop();
    }
  }

  tokens = dropPhrases(tokens);
  tokens = tokens.filter((token) => !EDITION_WORDS.has(token));
  // `Legacy` is a real word (`Legacy of Kain`), so only a trailing one is a wrapper.
  while (tokens.length && tokens[tokens.length - 1] === 'legacy') tokens.pop();
  return tokens;
}

function coreTitle(name) {
  return coreTokens(name).join(' ');
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

function normalizedDevelopers(doc) {
  if (!doc || !Array.isArray(doc.developers)) return [];
  const out = [];
  for (const raw of doc.developers) {
    const name = cleanName(raw);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function developersOverlap(left, right) {
  if (!left.length || !right.length) return null;
  return left.some((name) => right.includes(name));
}

module.exports = {
  EDITION_WORDS,
  EDITION_PHRASES,
  REGION_WORDS,
  cleanName,
  isRomanNumber,
  numericSignature,
  dropPhrases,
  hasEditionMarker,
  coreTokens,
  coreTitle,
  levenshtein,
  normalizedDevelopers,
  developersOverlap,
};
