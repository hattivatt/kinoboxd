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
    iconUrl: firstString(item.iconUrl, item.icon) || '',
    headerImage: /^https?:\/\//i.test(text(item.headerImage)) ? text(item.headerImage) : '',
    verticalCapsule: text(item.verticalCapsule),
    verticalCapsuleKnown:
      item.verticalCapsuleKnown === true || item.verticalCapsuleKnown === false
        ? item.verticalCapsuleKnown
        : null,
    iconFallbackUrl: text(item.iconFallbackUrl),
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

  const libraryPartial = boolOrNull(summaryRaw.libraryPartial)
    ?? boolOrNull(source.libraryPartial)
    ?? boolOrNull(sourcesBlock.libraryPartial)
    ?? boolOrNull(profileRaw && profileRaw.libraryPartial)
    ?? null;
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
    unmatchedCount: toCount(source.unmatchedCount),
    excluded: normalizeExcluded(source.meta && source.meta.excluded),
    completion: normalizeCompletion(summaryRaw.completion),
    achievements: normalizeAchievements(summaryRaw.achievements),
    modes: normalizeModes(summaryRaw.modes),
    earlyAccess: normalizeAccessBlock(summaryRaw.earlyAccess, summaryRaw),
    freeToPlay: normalizeAccessBlock(summaryRaw.freeToPlay, summaryRaw),
    metadata: normalizeMetadata(summaryRaw.metadata, summaryRaw),
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

  const genres = normalizeWeightItems(source.genres);
  const tags = normalizeWeightItems(source.tags);
  const scores = normalizeScores(source.scores);
  const reviewScore = normalizeReviewScoreBlock(summaryRaw.reviewScore ?? source.reviewScore);
  const dlc = normalizeDlcSummary(summaryRaw.dlc ?? source.dlc);
  const franchises = normalizeFranchises(source.franchises);
  const decades = normalizeDecades(source.decades);
  const years = normalizeYears(source.years);
  const unknownYear = normalizeUnknownYear(source.years);
  const studios = normalizeStudios(source.studios);
  const personnelTop = normalizePersonnelTop(source.personnelTop);
  const timeline = normalizeTimeline(source.timeline);
  const achievementDays = normalizeAchievementDays(source.achievementDays);
  const streaks = normalizeGameStreaks(source.streaks, achievementDays);
  const filters = normalizeFilters(source.meta && source.meta.filters)
    || normalizeFilters(summaryRaw.filters);
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
    sources: sourcesBlock,
    secondaryWorks: arr(source.secondaryWorks)
      .map((entry) => normalizeSecondaryWork(entry, secondaryContext))
      .filter(Boolean),
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
