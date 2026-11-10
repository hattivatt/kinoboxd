import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { boolOrNull, toCount } from './common.js';

export function normalizeCompletion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const avgPercent = numOrNull(raw.avgPercent ?? raw.averagePercent);
  if (avgPercent == null) return null;
  return {
    avgPercent,
    medianPercent: numOrNull(raw.medianPercent),
    perfectCount: toCount(raw.perfectCount),
    gamesWithStats: toCount(raw.gamesWithStats),
    gamesTotal: toCount(raw.gamesTotal),
  };
}

export function normalizeAchievements(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unlocked = numOrNull(raw.unlocked);
  const total = numOrNull(raw.total);
  if (unlocked == null && total == null) return null;
  return {
    unlocked: unlocked == null ? null : Math.max(0, unlocked),
    total: total == null ? null : Math.max(0, total),
    rareUnlocked: numOrNull(raw.rareUnlocked),
    coverage: raw.coverage && typeof raw.coverage === 'object'
      ? {
        gamesWithStats: numOrNull(raw.coverage.gamesWithStats),
        gamesTotal: numOrNull(raw.coverage.gamesTotal),
      }
      : null,
  };
}

/**
 * Steam categories → the six mode counters the dashboard prints. The backend
 * (appdetails → `categories[]`) folds them; the spellings below cover the doc
 * (`onlinePvp`) and the obvious snake/kebab variants so a contract drift does
 * not hide the widget.
 */
export const MODE_DEFS = [
  { key: 'single', label: 'одиночная', title: 'Категория Steam Single-player' },
  { key: 'multi', label: 'мультиплеер', title: 'Категория Steam Multi-player' },
  { key: 'coop', label: 'кооператив', title: 'Категория Steam Co-op' },
  { key: 'onlinePvp', label: 'PvP онлайн', title: 'Категория Steam Online PvP' },
  { key: 'localCoop', label: 'кооп локально', title: 'Категория Steam Shared/Split Screen Co-op' },
  { key: 'mmo', label: 'MMO', title: 'Категория Steam MMO' },
];

const MODE_ALIASES = {
  single: ['singleplayer', 'single_player', 'single-player', 'singlePlayer'],
  multi: ['multiplayer', 'multi_player', 'multi-player', 'multiPlayer'],
  coop: ['coOp', 'co-op', 'co_op', 'cooperative'],
  onlinePvp: ['online_pvp', 'online-pvp', 'onlinePVP', 'pvp'],
  localCoop: ['local_coop', 'local-coop', 'localCoop', 'sharedSplitScreen'],
  mmo: ['massivelyMultiplayer', 'mmo', 'massively_multiplayer'],
};

export function normalizeModes(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = Array.isArray(raw)
    ? raw.reduce((acc, item) => {
      if (!item || typeof item !== 'object') return acc;
      const key = firstString(item.key, item.name, item.label);
      if (key) acc[key] = item;
      return acc;
    }, {})
    : raw;
  const out = {};
  let any = false;
  for (const def of MODE_DEFS) {
    let value = null;
    for (const name of [def.key, ...MODE_ALIASES[def.key]]) {
      if (source[name] != null) {
        value = source[name];
        break;
      }
    }
    if (value == null) continue;
    any = true;
    out[def.key] = value && typeof value === 'object'
      ? { count: toCount(value.count), hours: numOrNull(value.hours) }
      : { count: toCount(value), hours: null };
  }
  return any ? out : null;
}

/** `earlyAccess` / `freeToPlay`: `{ count, hours, share }`, share derived if absent. */
export function normalizeAccessBlock(raw, summary) {
  if (!raw || typeof raw !== 'object') return null;
  const count = numOrNull(raw.count);
  const hours = numOrNull(raw.hours);
  if (count == null && hours == null) return null;
  const games = toCount(summary && (summary.gameCount || summary.ownedCount));
  const share = numOrNull(raw.share) ?? (count != null && games > 0 ? count / games : null);
  return {
    count: count == null ? null : Math.max(0, count),
    hours,
    share,
  };
}

/** `summary.metadata`: honest enrichment coverage, never a fake 100%. */
export function normalizeMetadata(raw, summary) {
  if (!raw || typeof raw !== 'object') return null;
  const games = numOrNull(summary && (summary.gameCount || summary.ownedCount));
  const detailsResolved = numOrNull(raw.detailsResolved ?? raw.resolvedDetails);
  const detailsTotal = numOrNull(raw.detailsTotal ?? raw.totalDetails)
    ?? (detailsResolved != null ? games : null);
  const creditsResolved = numOrNull(raw.creditsResolved ?? raw.resolvedCredits);
  const creditsTotal = numOrNull(raw.creditsTotal ?? raw.totalCredits)
    ?? (creditsResolved != null ? games : null);
  const running = boolOrNull(raw.running ?? raw.enriching);
  if (detailsResolved == null && creditsResolved == null && running !== true) return null;
  const percentOf = (resolved, total, direct) => {
    const explicit = numOrNull(direct);
    if (explicit != null) return explicit;
    return resolved != null && total ? (resolved / total) * 100 : null;
  };
  return {
    detailsResolved,
    detailsTotal,
    detailsPercent: percentOf(detailsResolved, detailsTotal, raw.detailsPercent),
    creditsResolved,
    creditsTotal,
    creditsPercent: percentOf(creditsResolved, creditsTotal, raw.creditsPercent),
    running,
    budgetRemaining: numOrNull(raw.budgetRemaining),
  };
}

/** `meta.excluded`: why records were dropped (DLC, other type, unknown type). */
export function normalizeExcluded(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    dlc: toCount(raw.dlc),
    otherType: toCount(raw.otherType ?? raw.other_type),
    free: toCount(raw.free),
    unknownType: toCount(raw.unknownType ?? raw.unknown_type),
  };
}

/**
 * `meta.filters` (§5.4): what was REQUESTED vs what the server could APPLY.
 * The UI must show the difference — a silent filter is a lie.
 */
function normalizeFilterBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requested = boolOrNull(raw.requested);
  const applied = boolOrNull(raw.applied);
  if (requested == null && applied == null) return null;
  return { requested, applied, reason: text(raw.reason) };
}

/**
 * `meta.filters.minHours` (M5-B) is numeric, so it gets its own block:
 * `requested` is the integer the server understood (-1 all / 0 played only /
 * N hours), `excluded` counts the canonical works the filter dropped.
 */
function normalizeMinHoursFilter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requested = numOrNull(raw.requested);
  if (requested == null) return null;
  return {
    requested: Math.trunc(requested),
    applied: raw.applied == null ? null : Boolean(raw.applied),
    excluded: toCount(raw.excluded),
    excludedAppids: toCount(raw.excludedAppids ?? raw.excluded_appids),
  };
}

export function normalizeFilters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    includeFree: normalizeFilterBlock(raw.includeFree),
    includeDlc: normalizeFilterBlock(raw.includeDlc),
    minHours: normalizeMinHoursFilter(raw.minHours),
  };
  return out.includeFree || out.includeDlc || out.minHours ? out : null;
}

/** `summary.reviewScore` → `{ avg, median }` (null when the block is absent). */
export function normalizeReviewScoreBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const avg = numOrNull(raw.avg ?? raw.mean ?? raw.average);
  const median = numOrNull(raw.median);
  if (avg == null && median == null) return null;
  return { avg, median };
}

/** `summary.dlc` → `{ gamesWithDlc, avgCount, max: [{ name, dlcCount, appid }] }`. */
export function normalizeDlcSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const gamesWithDlc = numOrNull(raw.gamesWithDlc ?? raw.games ?? raw.count);
  const avgCount = numOrNull(raw.avgCount ?? raw.avg ?? raw.average);
  const top = arr(raw.max ?? raw.top ?? raw.items ?? raw.topGames)
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'string') return { name: text(item), dlcCount: null, appid: null };
      if (typeof item !== 'object') return null;
      const name = firstString(item.name, item.title, item.label);
      const appid = numOrNull(item.appid);
      if (!name && appid == null) return null;
      return {
        name: name || (appid != null ? `appid ${appid}` : ''),
        dlcCount: numOrNull(item.dlcCount ?? item.count ?? item.dlc),
        appid,
      };
    })
    .filter(Boolean);
  if (gamesWithDlc == null && avgCount == null && !top.length) return null;
  return { gamesWithDlc, avgCount, max: top };
}
