import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import {
  boolOrNull, normalizeFranchiseRef, normalizeGenres, normalizeHours, normalizeHours2w,
  normalizeTagsList, resolveReviewBucket, toCount,
} from './common.js';
import { normalizeSourceKey } from './secondary.js';

export function normalizePersonGames(raw) {
  return arr(raw)
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'number' || /^\d+$/.test(text(item))) {
        const appid = Number(item);
        return Number.isFinite(appid) ? { appid, name: '', hours: null, completion: null, roles: [] } : null;
      }
      if (typeof item !== 'object') return null;
      const name = firstString(item.name, item.title);
      const appid = numOrNull(item.appid);
      if (!name && appid == null) return null;
      const workKey = firstString(item.workKey, item.work_key);
      return {
        appid,
        workKey: workKey || null,
        secondaryOnly: item.secondaryOnly === true || (appid == null && Boolean(workKey)),
        name,
        hours: numOrNull(item.hours ?? item.playtimeHours),
        completion: numOrNull(item.completion),
        roles: arr(item.roles).map((role) => text(role)).filter(Boolean),
      };
    })
    .filter(Boolean);
}

export function normalizeIndexAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  const percent = numOrNull(raw.percent);
  if (unlocked == null && total == null && percent == null) return null;
  return { unlocked, total, percent };
}

export function normalizeGameIndexEntry(entry, appid) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const releaseYear = numOrNull(item.releaseYear ?? item.year);
  return {
    appid: numOrNull(item.appid) ?? numOrNull(appid),
    name: firstString(item.name, item.title),
    hours: normalizeHours(item),
    hours2w: normalizeHours2w(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    iconUrl: /^https?:\/\//i.test(text(item.iconUrl)) ? text(item.iconUrl) : '',
    headerImage: /^https?:\/\//i.test(text(item.headerImage)) ? text(item.headerImage) : '',
    verticalCapsule: text(item.verticalCapsule),
    verticalCapsuleKnown:
      item.verticalCapsuleKnown === true || item.verticalCapsuleKnown === false
        ? item.verticalCapsuleKnown
        : null,
    iconFallbackUrl: text(item.iconFallbackUrl),
    type: text(item.type).toLowerCase(),
    releaseYear,
    year: releaseYear,
    genres: normalizeGenres(item.genres),
    developers: normalizeGenres(item.developers),
    publishers: normalizeGenres(item.publishers),
    categories: normalizeGenres(item.categories),
    isFree: boolOrNull(item.isFree),
    earlyAccess: boolOrNull(item.earlyAccess),
    metacritic: numOrNull(item.metacritic),
    dlcCount: numOrNull(item.dlcCount),
    completion: numOrNull(item.completion),
    tags: normalizeTagsList(item.tags),
    reviewScore: resolveReviewBucket(
      item.reviewScore ?? item.review_score ?? item.review?.score
      ?? item.reviewDesc ?? item.review_score_desc ?? item.review?.desc,
    ),
    reviewDesc: firstString(item.reviewDesc, item.review_score_desc, item.review?.desc),
    franchise: normalizeFranchiseRef(item.franchise ?? item.collection ?? arr(item.franchises)[0]),
    achievements: normalizeIndexAchievements(item.achievements),
    metadataSources: arr(item.metadataSources).map((source) => text(source)).filter(Boolean),
    canonicalWorkKey: firstString(item.canonicalWorkKey, item.canonical_work_key),
    primaryAppid: numOrNull(item.primaryAppid ?? item.primary_appid),
    isPrimary: item.isPrimary == null && item.is_primary == null
      ? null
      : Boolean(item.isPrimary ?? item.is_primary),
    editionCount: toCount(item.editionCount ?? item.edition_count) || 1,
    canonicalHours: numOrNull(item.canonicalHours ?? item.canonical_hours),
    sources: arr(item.sources).map((value) => text(value)).filter(Boolean),
    storeIds: item.storeIds && typeof item.storeIds === 'object' ? item.storeIds : null,
    hoursBySource:
      item.hoursBySource && typeof item.hoursBySource === 'object' ? item.hoursBySource : null,
    workKey: firstString(item.workKey, item.work_key),
    secondaryOnly: item.secondaryOnly === true,
    source: normalizeSourceKey(item.source),
    gog: item.gog && typeof item.gog === 'object' ? item.gog : null,
    epic: item.epic && typeof item.epic === 'object' ? item.epic : null,
    releaseDate: firstString(item.releaseDate, item.release_date),
    hoursUnknown: item.hoursUnknown == null ? null : Boolean(item.hoursUnknown),
    hoursStatus: item.hoursStatus && typeof item.hoursStatus === 'object' ? item.hoursStatus : null,
  };
}
