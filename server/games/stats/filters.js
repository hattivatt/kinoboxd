'use strict';

/**
 * Input filters of the games payload: the `includeDlc`/`includeFree` type
 * split (M2) and the `minHours` work filter (M5-B).
 *
 * S1 «распил god-функции»: the filter chain is the first thing the payload
 * does and it is a pure function of the library + details maps. `excluded`
 * keeps the same key order (`dlc`, `otherType`, `free`, `unknownType`) because
 * `meta.excluded` is serialized as-is.
 */

const { detailOf } = require('./documents');

/**
 * Split the library into games the payload keeps and the audit counters.
 *
 * Filter semantics (M2): DLC/demo/software/video are not games; a DLC is
 * included only with `includeDlc=1`. Unknown type (no details yet) is kept —
 * it must never be silently dropped. `includeFree=0` removes F2P games.
 * These run BEFORE edition grouping and `minHours` (the order is part of the
 * contract: `includeFree=1&minHours=1` means "paid-or-free works with ≥1 h",
 * not "paid works + every free work with ≥1 h").
 */
function applyDetailFilters(games, details, { includeFree, includeDlc }) {
  const detailsCount = games.filter((game) => detailOf(details, game.appid)).length;
  const hasDetails = detailsCount > 0;
  const excluded = { dlc: 0, otherType: 0, free: 0, unknownType: 0 };
  const keptGames = [];
  for (const game of games) {
    const doc = detailOf(details, game.appid);
    const type = doc && doc.type ? String(doc.type) : null;
    const isFree = doc && typeof doc.is_free === 'boolean' ? doc.is_free : null;
    if (type && type !== 'game') {
      const keepAsDlc = includeDlc && type === 'dlc';
      if (!keepAsDlc) {
        if (type === 'dlc') excluded.dlc++;
        else excluded.otherType++;
        continue;
      }
    }
    if (isFree === null) excluded.unknownType++;
    if (!includeFree && isFree === true) {
      excluded.free++;
      continue;
    }
    keptGames.push(game);
  }
  return { detailsCount, hasDetails, excluded, keptGames };
}

/**
 * `minHours`: -1 = every game (0-hour backlog included), 0 = only played
 * works, N≥1 = works with at least N hours. Invalid values fall back to the
 * caller's default (the route rejects them before this point).
 */
function normalizeMinHours(raw, fallback = -1) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -1) return fallback;
  return value;
}

/** Does a canonical work (raw minutes) pass the hours filter? */
function hoursFilterPass(minutes, minHours) {
  if (minHours < 0) return true;
  if (minHours === 0) return minutes > 0;
  return minutes >= minHours * 60;
}

module.exports = { applyDetailFilters, normalizeMinHours, hoursFilterPass };
