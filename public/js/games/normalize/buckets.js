import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { resolveReviewBucket, toCount } from './common.js';
import { normalizePersonGames } from './graph.js';

export function normalizeHistogram(raw) {
  return arr(raw)
    .map((item) => {
      const bucket = firstString(item && (item.bucket ?? item.label ?? item.key));
      if (!bucket) return null;
      return {
        bucket,
        count: toCount(item && item.count),
        hours: numOrNull(item && item.hours),
      };
    })
    .filter((item) => item && item.count > 0);
}

export function normalizeWeightItems(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') {
        const name = text(item);
        return name ? { name, count: 0, hours: null, share: null, weight: null, source: '' } : null;
      }
      const name = firstString(item.name, item.label, item.title, item.genre, item.tag);
      if (!name) return null;
      return {
        name,
        count: toCount(item.count ?? item.games ?? item.gameCount),
        hours: numOrNull(item.hours ?? item.playtimeHours ?? item.hoursTotal),
        share: numOrNull(item.share),
        weight: numOrNull(item.weight),
        source: text(item.source),
      };
    })
    .filter(Boolean);
}

export function normalizeDecades(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const decadeRaw = numOrNull(item.decade ?? item.value ?? item.start);
      const key = text(item.key);
      const unknown = decadeRaw == null && (key === 'unknown' || item.unknown === true || !key);
      const decade = unknown ? null : decadeRaw;
      const label = firstString(item.label)
        || (decade != null ? `${decade}-е` : 'год неизвестен');
      return {
        decade,
        key: key || (decade != null ? String(decade) : 'unknown'),
        label,
        count: toCount(item.count),
        hours: numOrNull(item.hours),
        unknown,
      };
    })
    .filter(Boolean);
}

export function normalizeYears(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const year = numOrNull(item.year ?? item.value);
      if (year == null || year <= 0) return null;
      return {
        year: Math.round(year),
        count: toCount(item.count),
        hours: numOrNull(item.hours),
      };
    })
    .filter(Boolean);
}

export function normalizeUnknownYear(raw) {
  const unknown = arr(raw).filter((item) => item && typeof item === 'object' && item.unknown);
  if (!unknown.length) return null;
  const count = unknown.reduce((sum, item) => sum + toCount(item.count), 0);
  const hours = unknown.map((item) => numOrNull(item.hours)).filter((value) => value != null);
  return {
    count,
    hours: hours.length ? hours.reduce((sum, value) => sum + value, 0) : null,
  };
}

export function normalizeScores(raw) {
  const merged = new Map();
  for (const item of arr(raw)) {
    if (!item || typeof item !== 'object') continue;
    const bucket = resolveReviewBucket(
      item.bucket ?? item.score ?? item.key ?? item.reviewScore ?? item.desc ?? item.label,
    );
    if (bucket == null) continue;
    const prev = merged.get(bucket) || { bucket, count: 0, hours: null };
    prev.count += toCount(item.count);
    const hours = numOrNull(item.hours);
    if (hours != null) prev.hours = (prev.hours || 0) + hours;
    merged.set(bucket, prev);
  }
  return [...merged.values()].sort((a, b) => b.bucket - a.bucket);
}

export function normalizeFranchises(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray(raw.franchises) ? raw.franchises : []);
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = firstString(item.label, item.name, item.title, item.key);
      if (!label) return null;
      const appids = arr(item.appids)
        .map((value) => numOrNull(value))
        .filter((value) => value != null);
      const workKeys = arr(item.workKeys).map((value) => text(value)).filter(Boolean);
      const spreadRaw = item.yearsSpread ?? item.years;
      const yearsSpread = spreadRaw && typeof spreadRaw === 'object'
        ? numOrNull(spreadRaw.span)
        : numOrNull(spreadRaw);
      return {
        key: text(item.key) || label,
        label,
        gamesCount: toCount(item.gamesCount ?? item.count ?? item.games),
        hoursSum: numOrNull(item.hoursSum ?? item.hours ?? item.totalHours),
        yearsSpread,
        appids,
        workKeys,
      };
    })
    .filter(Boolean);
}

export function normalizeStudios(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = firstString(item.name, item.studio, item.label);
      if (!name) return null;
      const roles = arr(item.roles).map((role) => text(role)).filter(Boolean);
      const single = text(item.role);
      return {
        id: firstString(item.id, item.qid, item.key),
        name,
        qid: firstString(item.qid),
        roles: roles.length ? roles : (single ? [single] : []),
        count: toCount(item.count ?? item.gameCount),
        hours: numOrNull(item.hours ?? item.playtimeHours),
        avgCompletion: numOrNull(item.avgCompletion),
        games: normalizePersonGames(item.games),
        sources: arr(item.sources).map((source) => text(source)).filter(Boolean),
      };
    })
    .filter(Boolean);
}

export function normalizePersonnelTop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let any = false;
  for (const [role, items] of Object.entries(raw)) {
    const list = arr(items)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const name = firstString(item.name, item.label);
        if (!name) return null;
        return {
          id: firstString(item.id, item.qid),
          name,
          count: toCount(item.count),
          hours: numOrNull(item.hours),
        };
      })
      .filter(Boolean);
    if (list.length) any = true;
    out[role] = list;
  }
  return any ? out : null;
}

export function normalizeAchievementDays(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const date = text(item.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return {
        date,
        count: toCount(item.count),
        appids: arr(item.appids).map((appid) => numOrNull(appid)).filter((appid) => appid != null),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeTimeline(raw) {
  return arr(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const month = text(item.month).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return null;
      return {
        month,
        unlocked: toCount(item.unlocked ?? item.count),
        games: toCount(item.games),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.month.localeCompare(b.month));
}
