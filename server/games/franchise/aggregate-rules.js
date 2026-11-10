'use strict';

const { round1: roundNumber } = require('../../core/stats');

const round1 = (value) => roundNumber(value, 'numeric');

const MIN_HEURISTIC_GAMES = 2;
const EDITION_SUFFIXES = [
  'enhanced edition',
  'complete edition',
  'definitive edition',
  'ultimate edition',
  'deluxe edition',
  'game of the year edition',
  'goty edition',
  'remastered',
  'legacy',
];
/** Bases that are too generic to be a franchise on their own. */
const STOP_BASES = new Set(['the', 'a', 'an', 'game', 'games', 'collection', 'series']);
/** False pairs from ИГРЫ §2.5/§4.4 — never merge even if a future fuzzy pass tries. */
const BLACKLIST_PAIRS = [
  ['dark souls', 'darkest dungeon'],
  ['hitman', "hitman's bodyguard"],
];

function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[™®©]/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripEdition(text) {
  let out = text;
  for (const suffix of EDITION_SUFFIXES) {
    if (out.endsWith(` ${suffix}`)) {
      out = out.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return out;
}

/**
 * Normalised franchise head of a game title:
 *   "The Witcher 3: Wild Hunt"        → "the-witcher"
 *   "Fallout: New Vegas PCR"          → "fallout"
 *   "Sid Meier's Civilization V"      → "sid-meier-s-civilization"
 *   "Half-Life 2: Deathmatch"         → "half-life"
 * Returns null when the head is too short/generic to be a franchise.
 */
function heuristicBase(name) {
  let text = normalizeTitle(name);
  if (!text) return null;
  // Subtitle cut: ":" and spaced dashes. «Half-Life» keeps its hyphen.
  text = text.split(/\s*:\s*|\s+[\u2013\u2014]\s+|\s+-\s+/)[0].trim();
  text = stripEdition(text);
  // Trailing sequence marker: "Civilization IV", "Fallout 4", "Grand Theft Auto V".
  const stripped = text.replace(/\s+(?:[ivxlcdm]+|\d{1,3})$/i, '').trim();
  if (stripped && stripped.length >= 3) text = stripped;
  if (!text || text.length < 3) return null;
  const slug = text
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || STOP_BASES.has(slug)) return null;
  return slug;
}

const SMALL_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'to', 'for', 'a', 'an']);

function humanizeBase(slug) {
  const words = String(slug || '').split('-').filter(Boolean);
  return words
    .map((word, index) =>
      index > 0 && SMALL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');
}

function blacklisted(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  return BLACKLIST_PAIRS.some(
    ([x, y]) => (left.includes(x) && right.includes(y)) || (left.includes(y) && right.includes(x))
  );
}

function groupIsBlacklisted(members) {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (blacklisted(members[i].name, members[j].name)) return true;
    }
  }
  return false;
}

function applyTitleHeuristic(games) {
  // ---- minimal title heuristic (only for games Wikidata did not place) ----
  const groups = new Map();
  for (const game of games) {
    if (game.wdKey || !game.name) continue;
    const base = heuristicBase(game.name);
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(game);
  }
  for (const [base, members] of groups) {
    if (members.length < MIN_HEURISTIC_GAMES) continue;
    if (groupIsBlacklisted(members)) continue;
    for (const game of members) {
      game.heuristicKey = `title:${base}`;
      game.heuristicLabel = humanizeBase(base);
    }
  }
}

module.exports = {
  MIN_HEURISTIC_GAMES,
  STOP_BASES,
  BLACKLIST_PAIRS,
  round1,
  normalizeTitle,
  heuristicBase,
  humanizeBase,
  groupIsBlacklisted,
  applyTitleHeuristic,
};
