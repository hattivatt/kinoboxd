import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { normalizeGameStreaks } from '../../core/streaks.js';
import { boolOrNull, normalizeGenres, normalizeHours, normalizeHours2w, toCount } from './common.js';
import {
  normalizeAchievementDays, normalizeDecades, normalizeFranchises, normalizeHistogram,
  normalizePersonnelTop, normalizeScores, normalizeStudios, normalizeTimeline, normalizeUnknownYear,
  normalizeWeightItems, normalizeYears,
} from './buckets.js';
import { normalizeGameIndexEntry } from './graph.js';
import { normalizeProfile } from './profile.js';
import { normalizeSecondaryWork, secondaryChartStatus } from './secondary.js';
import {
  normalizeAccessBlock, normalizeAchievements, normalizeCompletion, normalizeDlcSummary,
  normalizeExcluded, normalizeFilters, normalizeMetadata, normalizeModes,
  normalizeReviewScoreBlock,
} from './summary.js';

function normalizeTopGame(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    hours: normalizeHours(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    releaseYear: numOrNull(item.releaseYear),
    completion: numOrNull(item.completion),
    genres: normalizeGenres(item.genres),
    cover: text(item.cover || item.coverUrl || item.headerImage),
    icon: text(item.icon || item.iconUrl || item.img_icon_url),
  };
}

function normalizeRecent(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    hours2w: normalizeHours2w(item),
    hoursTotal: normalizeHours(item),
    lastPlayed: item.lastPlayed ?? item.rtime_last_played ?? null,
    // The top strip paints the Steam capsule icon; the index may not have it
    // for entries the payload already carries.
    iconUrl: firstString(item.iconUrl, item.icon) || '',
    // M7/vertical posters: the store header carries the per-asset hash of the
    // post-2024 `store_item_assets` schema, so the strip can ask the proxy for
    // the real vertical `library_600x900.jpg` instead of the landscape header.
    headerImage: /^https?:\/\//i.test(text(item.headerImage)) ? text(item.headerImage) : '',
    verticalCapsule: text(item.verticalCapsule),
    verticalCapsuleKnown:
      item.verticalCapsuleKnown === true || item.verticalCapsuleKnown === false
        ? item.verticalCapsuleKnown
        : null,
    iconFallbackUrl: text(item.iconFallbackUrl),
    // M6c: cross-store ownership of the same work (GOG today) and an optional
    // store-provided poster for rows that are not on the Steam CDN.
    sources: arr(item.sources).map((value) => String(value)).filter(Boolean),
    hoursBySource:
      item.hoursBySource && typeof item.hoursBySource === 'object' ? item.hoursBySource : null,
    coverUrl: firstString(item.verticalCoverUrl, item.coverUrl) || '',
  };
}

function normalizeBacklogItem(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const name = firstString(item.name, item.title);
  if (!name) return null;
  return {
    appid: numOrNull(item.appid),
    name,
    releaseYear: numOrNull(item.releaseYear ?? item.year),
    genres: normalizeGenres(item.genres),
  };
}

/**
 * `GET /api/games/stats` → the view model `games.js` renders.
 *
 * Keeps the raw-ish numbers next to their labels so the dashboard can decide
 * what to hide. `summary.has*` flags are derived, not assumed: a payload
 * without `topGames` must not produce an empty «Топ по часам» widget.
 */
export function normalizeGamesPayload(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourcesBlock = source.sources && typeof source.sources === 'object' ? source.sources : {};
  const profileRaw = sourcesBlock.profile && typeof sourcesBlock.profile === 'object'
    ? sourcesBlock.profile
    : (source.profile && typeof source.profile === 'object' ? source.profile : null);
  const summaryRaw = source.summary && typeof source.summary === 'object' ? source.summary : {};

  const profile = normalizeProfile(profileRaw);
  const gameCount = toCount(summaryRaw.gameCount);
  const ownedCount = toCount(summaryRaw.ownedCount);
  const playedCount = toCount(summaryRaw.playedCount);
  const unplayedCount = toCount(summaryRaw.unplayedCount);

  // The backend puts `libraryPartial` at the top level (§5.1); older drafts
  // nested it under `summary`/`sources`. Accept all three spellings.
  const libraryPartial = boolOrNull(summaryRaw.libraryPartial)
    ?? boolOrNull(source.libraryPartial)
    ?? boolOrNull(sourcesBlock.libraryPartial)
    ?? boolOrNull(profileRaw && profileRaw.libraryPartial)
    ?? null;
  // «ключ настроен?» is a boolean indicator only — the value never leaves the
  // server, and the UI prints «настроен / не настроен», never the token.
  // `/api/games/stats` reports it as `meta.keyConfigured`, `/profiles` as
  // `steamKey: { configured }`.
  const steamKeyConfigured = boolOrNull(summaryRaw.steamKeyConfigured)
    ?? boolOrNull(summaryRaw.steamKey)
    ?? boolOrNull(sourcesBlock.steamKeyConfigured)
    ?? boolOrNull(source.meta && source.meta.keyConfigured)
    ?? boolOrNull(source.steamKey && source.steamKey.configured)
    ?? boolOrNull(source.steamKeyConfigured);

  const summary = {
    gameCount,
    ownedCount: ownedCount || gameCount,
    playedCount,
    unplayedCount,
    totalHours: numOrNull(summaryRaw.totalHours),
    meanHours: numOrNull(summaryRaw.meanHours),
    medianHours: numOrNull(summaryRaw.medianHours),
    top10HoursShare: numOrNull(summaryRaw.top10HoursShare),
    recent2wHours: numOrNull(summaryRaw.recent2wHours ?? summaryRaw.recent2w),
    lastPlayedAt: summaryRaw.lastPlayedAt ?? null,
    libraryPartial,
    steamKeyConfigured,
    // «Не типизированы» (unmatched): Steam отдал запись библиотеки, но
    // appdetails ещё нет, поэтому тип/год/жанры неизвестны. `meta.excluded`
    // говорит, сколько записей отброшено как не-игры — это не то же число.
    unmatchedCount: toCount(source.unmatchedCount),
    excluded: normalizeExcluded(source.meta && source.meta.excluded),
    completion: normalizeCompletion(summaryRaw.completion),
    achievements: normalizeAchievements(summaryRaw.achievements),
    // M2 blocks (§5.1). Each stays `null` when the server did not send it:
    // the widget is hidden instead of printing an invented zero.
    modes: normalizeModes(summaryRaw.modes),
    earlyAccess: normalizeAccessBlock(summaryRaw.earlyAccess, summaryRaw),
    freeToPlay: normalizeAccessBlock(summaryRaw.freeToPlay, summaryRaw),
    metadata: normalizeMetadata(summaryRaw.metadata, summaryRaw),
    // M6a: per-source numbers (never summed). Kept raw-tolerant: a Steam-only
    // payload has no GOG keys and the widget simply does not print GOG rows.
    hoursBySource:
      summaryRaw.hoursBySource && typeof summaryRaw.hoursBySource === 'object'
        ? summaryRaw.hoursBySource
        : null,
    ownedBySource:
      summaryRaw.ownedBySource && typeof summaryRaw.ownedBySource === 'object'
        ? summaryRaw.ownedBySource
        : null,
    worksTotal: numOrNull(summaryRaw.worksTotal),
    secondaryOnlyWorks: toCount(summaryRaw.secondaryOnlyWorks),
    // Which counters the server actually sent. A missing field and a real
    // zero look identical after `toCount`, so the UI must not print «0 игр»
    // for a payload that simply has no `gameCount`.
    present: {
      gameCount: numOrNull(summaryRaw.gameCount) != null || numOrNull(summaryRaw.ownedCount) != null,
      playedCount: numOrNull(summaryRaw.playedCount) != null,
      unplayedCount: numOrNull(summaryRaw.unplayedCount) != null,
      totalHours: numOrNull(summaryRaw.totalHours) != null,
      meanHours: numOrNull(summaryRaw.meanHours) != null,
      medianHours: numOrNull(summaryRaw.medianHours) != null,
      top10HoursShare: numOrNull(summaryRaw.top10HoursShare) != null,
      recent2wHours: numOrNull(summaryRaw.recent2wHours ?? summaryRaw.recent2w) != null,
      completion: Boolean(normalizeCompletion(summaryRaw.completion)),
      modes: Boolean(normalizeModes(summaryRaw.modes)),
      access: Boolean(summaryRaw.earlyAccess || summaryRaw.freeToPlay),
      metadata: Boolean(normalizeMetadata(summaryRaw.metadata, summaryRaw)),
      unmatched: numOrNull(source.unmatchedCount) != null,
    },
  };

  const topGames = arr(source.topGames)
    .map(normalizeTopGame)
    .filter(Boolean)
    .sort((a, b) => (b.hours || 0) - (a.hours || 0));

  const recentlyPlayed = arr(source.recentlyPlayed ?? source.recent)
    .map(normalizeRecent)
    .filter(Boolean);

  const backlogRaw = source.backlog && typeof source.backlog === 'object' ? source.backlog : null;
  const backlog = {
    count: backlogRaw ? toCount(backlogRaw.count) : unplayedCount,
    share: numOrNull(backlogRaw && backlogRaw.share),
    items: arr(backlogRaw && backlogRaw.items).map(normalizeBacklogItem).filter(Boolean),
    present: Boolean(backlogRaw),
  };

  const gamesIndex = {};
  if (source.gamesIndex && typeof source.gamesIndex === 'object' && !Array.isArray(source.gamesIndex)) {
    for (const [appid, entry] of Object.entries(source.gamesIndex)) {
      if (!entry || typeof entry !== 'object') continue;
      gamesIndex[appid] = normalizeGameIndexEntry(entry, appid);
    }
  }

  const histogram = normalizeHistogram(source.hoursHistogram ?? source.histogram);

  // M2/M3 buckets. Empty arrays from an M1 server are normal: the widgets
  // disappear, the dashboard keeps working.
  const genres = normalizeWeightItems(source.genres);
  const tags = normalizeWeightItems(source.tags);
  // M4: Steam community scores (NOT personal), DLC summary and franchises.
  // `franchises` normally comes from `/api/games/franchises`, but a payload
  // that already carries the block is accepted instead of ignored.
  const scores = normalizeScores(source.scores);
  const reviewScore = normalizeReviewScoreBlock(summaryRaw.reviewScore ?? source.reviewScore);
  const dlc = normalizeDlcSummary(summaryRaw.dlc ?? source.dlc);
  const franchises = normalizeFranchises(source.franchises);
  const decades = normalizeDecades(source.decades);
  const years = normalizeYears(source.years);
  // «Год неизвестен» is a payload bucket, not a year: kept aside so the years
  // card can print «29 без года» after normalisation drops the null-year entry.
  const unknownYear = normalizeUnknownYear(source.years);
  const studios = normalizeStudios(source.studios);
  const personnelTop = normalizePersonnelTop(source.personnelTop);
  const timeline = normalizeTimeline(source.timeline);
  const achievementDays = normalizeAchievementDays(source.achievementDays);
  const streaks = normalizeGameStreaks(source.streaks, achievementDays);
  const filters = normalizeFilters(source.meta && source.meta.filters)
    || normalizeFilters(summaryRaw.filters);
  // `playtimeFetchedAt` is present-but-null when a secondary library was
  // imported without its playtime snapshot; that is what lets 0 h mean
  // «часы не получены» instead of a confident «не запущена».
  const playtimeFlag = (block) => {
    if (!block || typeof block !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(block, 'playtimeFetchedAt')) return null;
    return Boolean(block.playtimeFetchedAt);
  };
  const secondaryContext = {
    gogPlaytimeKnown: playtimeFlag(sourcesBlock.gog),
    epicPlaytimeKnown: playtimeFlag(sourcesBlock.epic),
  };

  return {
    profile,
    summary,
    topGames,
    recentlyPlayed,
    backlog,
    histogram,
    gamesIndex,
    genres,
    tags,
    scores,
    reviewScore,
    dlc,
    franchises,
    decades,
    years,
    unknownYear,
    studios,
    personnelTop,
    timeline,
    achievementDays,
    streaks,
    filters,
    // M6a: raw source state + GOG/Epic-only works (chart drilldowns and the
    // client-side union card). Both stay empty for a Steam-only payload, so
    // existing widgets are unchanged.
    sources: sourcesBlock,
    secondaryWorks: arr(source.secondaryWorks)
      .map((entry) => normalizeSecondaryWork(entry, secondaryContext))
      .filter(Boolean),
    // Whether the server counted secondary-only works in genres/years/decades.
    // The raw buckets are read here because normalisation drops unknown flags.
    secondaryChart: secondaryChartStatus(source),
    has: {
      profile: Boolean(profile),
      games: gameCount > 0 || ownedCount > 0,
      hours: summary.totalHours != null,
      topGames: topGames.length > 0,
      backlog: backlog.count > 0,
      recently: recentlyPlayed.length > 0,
      histogram: histogram.length > 0,
      completion: Boolean(summary.completion),
      genres: genres.length > 0,
      tags: tags.length > 0,
      scores: scores.length > 0,
      reviewScore: Boolean(reviewScore),
      dlc: Boolean(dlc),
      franchises: franchises.length > 0,
      decades: decades.length > 0,
      years: years.length > 0,
      modes: Boolean(summary.modes),
      access: Boolean(summary.earlyAccess || summary.freeToPlay),
      metadata: Boolean(summary.metadata),
      filters: Boolean(filters),
      studios: studios.length > 0,
      personnelTop: Boolean(personnelTop),
      calendar: achievementDays.length > 0,
      streaks: Boolean(streaks && (streaks.best > 0 || streaks.lastUnlockDate)),
      unmatched: summary.unmatchedCount > 0,
      gamesIndex: Object.keys(gamesIndex).length > 0,
    },
  };
}
