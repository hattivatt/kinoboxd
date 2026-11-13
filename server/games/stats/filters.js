'use strict';

const { detailOf } = require('./documents');

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

function normalizeMinHours(raw, fallback = -1) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -1) return fallback;
  return value;
}

function hoursFilterPass(minutes, minHours) {
  if (minHours < 0) return true;
  if (minHours === 0) return minutes > 0;
  return minutes >= minHours * 60;
}

module.exports = { applyDetailFilters, normalizeMinHours, hoursFilterPass };
