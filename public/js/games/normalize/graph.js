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
      // M6 follow-up (04.11.2026): a secondary-only work has no appid — its
      // identity is the `workKey`. Dropping it here made the person modal hide
      // exactly the row the aggregate had counted (Remedy: «7 игр · 266 ч» in
      // the header, 6 rows in the list — Alan Wake 2 was lost). The key must
      // survive the view model so `personGames` can find the `gamesIndex` row.
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

/** `gamesIndex[appid].achievements`: `{ unlocked, total, percent }`. */
export function normalizeIndexAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  const percent = numOrNull(raw.percent);
  if (unlocked == null && total == null && percent == null) return null;
  return { unlocked, total, percent };
}

/**
 * One `gamesIndex` entry. The backend already ships the fields needed by the
 * client-side drilldowns (type, year, genres, developers/publishers,
 * categories, is_free, early_access, icon); the old normaliser kept only six
 * of them, which made «клик по жанру/году» impossible without a new request.
 * M4 adds tags / review score / franchise for the new widgets and the card.
 */
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
    // M7: the real store header from `appdetails` (new SKUs live under a
    // per-asset `store_item_assets/.../<hash>/` path, so it cannot be guessed).
    headerImage: /^https?:\/\//i.test(text(item.headerImage)) ? text(item.headerImage) : '',
    // M7-resolve: the server-resolved vertical poster (proxy path or an
    // absolute SteamGridDB URL), the «vertical art exists» verdict and the
    // small-capsule fallback for a broken 32×32 icon. Absent on old payloads.
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
    // M4: tags strip / review badge / franchise label on the card and the
    // three new drilldowns. Missing fields stay null — the widgets hide.
    tags: normalizeTagsList(item.tags),
    reviewScore: resolveReviewBucket(
      item.reviewScore ?? item.review_score ?? item.review?.score
      ?? item.reviewDesc ?? item.review_score_desc ?? item.review?.desc,
    ),
    reviewDesc: firstString(item.reviewDesc, item.review_score_desc, item.review?.desc),
    franchise: normalizeFranchiseRef(item.franchise ?? item.collection ?? arr(item.franchises)[0]),
    achievements: normalizeIndexAchievements(item.achievements),
    metadataSources: arr(item.metadataSources).map((source) => text(source)).filter(Boolean),
    // M5-B editions: identity of the canonical work. Absent on older payloads,
    // in which case every appid stays its own row (the pre-edition behaviour).
    canonicalWorkKey: firstString(item.canonicalWorkKey, item.canonical_work_key),
    primaryAppid: numOrNull(item.primaryAppid ?? item.primary_appid),
    isPrimary: item.isPrimary == null && item.is_primary == null
      ? null
      : Boolean(item.isPrimary ?? item.is_primary),
    editionCount: toCount(item.editionCount ?? item.edition_count) || 1,
    canonicalHours: numOrNull(item.canonicalHours ?? item.canonical_hours),
    // M6c: cross-store ownership of this appid's work (`['steam','gog']`) and
    // its per-source minutes. Absent on a Steam-only payload.
    sources: arr(item.sources).map((value) => text(value)).filter(Boolean),
    storeIds: item.storeIds && typeof item.storeIds === 'object' ? item.storeIds : null,
    hoursBySource:
      item.hoursBySource && typeof item.hoursBySource === 'object' ? item.hoursBySource : null,
    // M6c: secondary-only rows live in `gamesIndex` under their own `workKey`
    // (`appid: null`, `secondaryOnly: true`). Keeping the raw source blocks
    // lets a drilldown row open the same union card as the chart payload.
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
