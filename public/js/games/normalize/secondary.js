import { arr, firstString, numOrNull, text } from '../../core/dom.js';
import { fmtInt } from '../../ui.js';
import { boolOrNull, hoursText, normalizeFranchiseRef, normalizeGenres } from './common.js';

export const SECONDARY_SOURCE_ORDER = ['steam', 'gog', 'epic'];
export const SECONDARY_SOURCE_LABELS = { steam: 'Steam', gog: 'GOG', epic: 'Epic' };

export function normalizeSourceKey(value) {
  const key = text(value).toLowerCase();
  if (key === 'steam' || key === 'gog' || key === 'epic') return key;
  return '';
}

/** Protocol-relative GOG URLs (`//images.gog.com/…`) become https. */
function normalizeHttpUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/** The four leading digits of an ISO date / year-ish string, else null. */
function yearFromDate(value) {
  const match = /(^|[^\d])(\d{4})([^\d]|$)/.exec(text(value));
  if (!match) return null;
  const year = Number(match[2]);
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * One `hoursBySource` value in **hours**. Integration contract (01.11.2026):
 * the `/stats` payload sends hours there, not minutes (the union converts
 * once, server-side). For robustness the normaliser still accepts an object
 * (`{ minutes }` / `{ hours }`) from an older/newer backend, but a plain
 * number is read as hours — never divided again (double conversion was the
 * M6a/M6c integration risk).
 */
function sourceHours(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const hours = numOrNull(value.hours ?? value.hoursTotal ?? value.playtimeHours);
    if (hours != null) return hours;
    const minutes = numOrNull(value.minutes ?? value.totalMinutes ?? value.playtime_forever);
    return minutes != null ? minutes / 60 : null;
  }
  return numOrNull(value);
}

function secondaryHoursBySource(entry, gog, epic) {
  const raw = entry.hoursBySource && typeof entry.hoursBySource === 'object'
    ? entry.hoursBySource
    : {};
  // A future contract may move hours into `entry.hours` (hours, not minutes).
  const direct = entry.hours && typeof entry.hours === 'object' ? entry.hours : null;
  const directHours = numOrNull(entry.hours);
  const out = {};
  for (const source of SECONDARY_SOURCE_ORDER) {
    const value = direct && direct[source] != null ? direct[source] : raw[source];
    let hours = sourceHours(value);
    if (hours == null && directHours != null && source === normalizeSourceKey(entry.source)) {
      hours = directHours;
    }
    out[source] = hours;
  }
  // GOG's library row is the historical source of the poster; keep the block
  // shape so callers can still read `work.gog`.
  if (out.gog == null && gog && gog.hours != null) out.gog = numOrNull(gog.hours);
  if (out.epic == null && epic && epic.hours != null) out.epic = numOrNull(epic.hours);
  return out;
}

/**
 * Normalise one `secondaryWorks[]` entry (GOG work or Epic game).
 *
 * The list is deliberately independent from `gamesIndex`: these rows are not
 * Steam games, they have no appid and no `/api/games/game/:appid` card. The
 * view model therefore carries everything the client-side card needs.
 */
export function normalizeSecondaryWork(entry, context = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const gog = entry.gog && typeof entry.gog === 'object' ? entry.gog : {};
  const epic = entry.epic && typeof entry.epic === 'object' ? entry.epic : {};
  const storeIds = entry.storeIds && typeof entry.storeIds === 'object' ? entry.storeIds : {};
  const gogId = firstString(storeIds.gog, gog.gogGameId, gog.gogProductId);
  const epicId = firstString(storeIds.epic, epic.catalogItemId);
  const explicitSource = normalizeSourceKey(entry.source);
  const sources = [];
  for (const value of [...arr(entry.sources), ...arr(entry.ownedOn)]) {
    const key = normalizeSourceKey(value);
    if (key && !sources.includes(key)) sources.push(key);
  }
  if (!sources.length && explicitSource) sources.push(explicitSource);
  if (!sources.length && gogId) sources.push('gog');
  if (!sources.length && epicId) sources.push('epic');
  if (!sources.length && storeIds.steam) sources.push('steam');
  sources.sort((left, right) => {
    const li = SECONDARY_SOURCE_ORDER.indexOf(left);
    const ri = SECONDARY_SOURCE_ORDER.indexOf(right);
    return (li < 0 ? 99 : li) - (ri < 0 ? 99 : ri);
  });
  const source = explicitSource || sources.find((key) => key !== 'steam') || sources[0] || '';
  const name = firstString(entry.name, gog.title, epic.name, epic.title, entry.title);
  if (!name) return null;
  const hoursBySource = secondaryHoursBySource(entry, gog, epic);
  const hoursKnownFlag = boolOrNull(
    entry.hoursKnown ?? entry.playtimeKnown
    ?? gog.playtimeKnown ?? epic.playtimeKnown
  );
  const knownHours = SECONDARY_SOURCE_ORDER
    .map((key) => hoursBySource[key])
    .filter((value) => value != null);
  let hoursKnown = hoursKnownFlag == null ? knownHours.length > 0 : hoursKnownFlag;
  // The server's playtime snapshot is the only honest way to tell «never
  // launched» (0) from «playtime not fetched yet» (also 0). `playtimeFetchedAt`
  // is present but null while the GOG/Epic playtime snapshot is missing.
  if (hoursKnownFlag == null) {
    const sourceZero = (key) => hoursBySource[key] == null || hoursBySource[key] === 0;
    if (sources.includes('gog') && context.gogPlaytimeKnown === false && sourceZero('gog')) {
      hoursKnown = false;
    }
    if (sources.includes('epic') && context.epicPlaytimeKnown === false && sourceZero('epic')) {
      hoursKnown = false;
    }
  }
  let hours = null;
  let hoursSource = '';
  for (const key of SECONDARY_SOURCE_ORDER) {
    const value = hoursBySource[key];
    if (value == null) continue;
    if (hours == null || value > hours) {
      hours = value;
      hoursSource = key;
    }
  }
  const hoursParts = SECONDARY_SOURCE_ORDER
    .filter((key) => hoursKnown && hoursBySource[key] != null)
    .map((key) => ({
      source: key,
      label: SECONDARY_SOURCE_LABELS[key] || key,
      hours: hoursBySource[key],
      hoursText: hoursText(hoursBySource[key]),
    }));
  const hoursTextValue = hoursParts.length === 1
    ? hoursParts[0].hoursText
    : hoursParts.map((part) => `${part.label} ${part.hoursText}`).join(' · ');
  // M6d: the store product poster is `verticalCover` (GOG box art 171×241,
  // Epic portrait 1200×1600). It is the card art and must win over the older
  // `verticalCoverUrl` spelling and over the horizontal `image` (which CSS
  // centre-crops into the 2:3 frame). Before this, the union card silently
  // fell back to the landscape banner even when a cached detail had a poster.
  const verticalCover = normalizeHttpUrl(
    entry.verticalCover || entry.verticalCoverUrl
    || gog.verticalCover || gog.verticalCoverUrl
    || epic.verticalCover || epic.verticalCoverUrl
  );
  const image = verticalCover || normalizeHttpUrl(
    entry.coverUrl || entry.image
    || gog.coverUrl || gog.image
    || epic.coverUrl || epic.image
  );
  const coverUrl = image;
  const releaseYear = numOrNull(entry.releaseYear ?? entry.year)
    ?? yearFromDate(entry.releaseDate)
    ?? yearFromDate(gog.releaseDate)
    ?? yearFromDate(epic.releaseDate);
  // M6d tolerant fallback: an older payload may carry the store genres on the
  // `epic`/`gog` block only (or an empty top-level array) — the top-level
  // non-empty list always wins, otherwise the source block fills the card.
  const genres = normalizeGenres(
    Array.isArray(entry.genres) && entry.genres.length
      ? entry.genres
      : Array.isArray(epic.genres) && epic.genres.length
        ? epic.genres
        : Array.isArray(gog.genres) && gog.genres.length
          ? gog.genres
          : entry.genres ?? epic.genres ?? gog.genres
  );
  const slug = firstString(entry.slug, gog.slug, epic.slug);
  // M6 follow-up: the store detail document names the studios; Wikidata (via
  // the bridge) supplies the QID and the P179 series. Both are additive — an
  // old payload simply has empty lists and no chip.
  const developers = normalizeGenres(
    Array.isArray(entry.developers) && entry.developers.length
      ? entry.developers
      : Array.isArray(epic.developers) && epic.developers.length
        ? epic.developers
        : entry.developers ?? epic.developers ?? epic.developer ?? gog.developers
  );
  const publishers = normalizeGenres(
    Array.isArray(entry.publishers) && entry.publishers.length
      ? entry.publishers
      : Array.isArray(epic.publishers) && epic.publishers.length
        ? epic.publishers
        : entry.publishers ?? epic.publishers ?? epic.publisher ?? gog.publishers
  );
  const franchise = normalizeFranchiseRef(entry.franchise);
  const qid = text(entry.qid) || null;
  const gogSlug = firstString(gog.slug, entry.slug);
  const epicSlug = firstString(epic.slug, entry.slug);
  const storeLinks = [];
  if (gogSlug && (sources.includes('gog') || source === 'gog')) {
    storeLinks.push({ source: 'gog', label: 'GOG', href: `https://www.gog.com/game/${gogSlug}` });
  }
  if (epicSlug && (sources.includes('epic') || source === 'epic')) {
    storeLinks.push({ source: 'epic', label: 'Epic Games Store', href: `https://store.epicgames.com/p/${epicSlug}` });
  }
  return {
    workKey: text(entry.workKey) || null,
    key: text(entry.workKey) || (gogId ? `gog:${gogId}` : epicId ? `epic:${epicId}` : name),
    source,
    sources,
    sourceLabels: sources.map((key) => SECONDARY_SOURCE_LABELS[key] || key),
    sourceChips: sources.map((key) => ({
      source: key,
      label: SECONDARY_SOURCE_LABELS[key] || key,
    })),
    name,
    gogGameId: gogId,
    epicId,
    slug: slug || null,
    image: image || null,
    coverUrl: coverUrl || null,
    // M6d poster in its own field: the store art, distinct from the horizontal
    // `image` fallback, so callers can tell «настоящий постер» from «баннер».
    verticalCover: verticalCover || null,
    releaseDate: text(entry.releaseDate) || text(gog.releaseDate) || text(epic.releaseDate) || null,
    releaseYear: releaseYear != null ? Math.round(releaseYear) : null,
    genres,
    developers,
    publishers,
    // Wikidata identity + series of the work (`null` = not resolved yet).
    qid,
    franchise,
    hoursBySource,
    hoursKnown,
    hours,
    hoursSource,
    hoursParts,
    hoursText: hoursTextValue,
    hoursUnknown: !hoursKnown || hours == null,
    notPlayed: hoursKnown && hours === 0,
    storeLinks,
    // Backward-compatible flat aliases used by the old «Источники» chips.
    gog,
    epic,
  };
}

/**
 * Whether the chart buckets (`genres` / `years` / `decades`) include
 * secondary-only works. The M6c backend contract is additive; until it lands,
 * this returns `{ included: false }` and the widgets simply do not claim
 * anything. Both a summary flag and per-bucket counters are accepted.
 */
export function secondaryChartStatus(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const summary = p.summary && typeof p.summary === 'object' ? p.summary : {};
  const charts = summary.charts && typeof summary.charts === 'object' ? summary.charts : {};
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const explicit = boolOrNull(
    summary.chartsIncludeSecondary
    ?? summary.includeSecondaryInCharts
    ?? charts.includeSecondary
    ?? charts.includesSecondary
    ?? meta.chartsIncludeSecondary
    ?? p.chartsIncludeSecondary
  );
  let bucketFlag = false;
  for (const key of ['genres', 'years', 'decades']) {
    for (const item of arr(p[key])) {
      if (!item || typeof item !== 'object') continue;
      if (item.includesSecondary === true || item.secondary === true) bucketFlag = true;
      const count = numOrNull(
        item.secondaryCount ?? item.secondaryOnlyCount
        ?? item.secondaryWorks ?? item.secondary
      );
      if (count != null && count > 0) bucketFlag = true;
    }
  }
  const count = numOrNull(
    summary.secondaryWorksInCharts
    ?? summary.secondaryChartsWorks
    ?? summary.secondaryChartWorks
    ?? charts.secondaryWorks
    ?? charts.count
  );
  const included = (explicit === true && (count == null || count > 0))
    || bucketFlag
    || (count != null && count > 0);
  if (!included) return { included: false, count: null, text: '' };
  return {
    included: true,
    count: count != null ? count : null,
    text: count != null
      ? `включая вне Steam: ${fmtInt(count)}`
      : 'включая работы вне Steam',
  };
}
