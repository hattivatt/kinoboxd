'use strict';

/**
 * Top lists of the games payload: `topGames` (20 heaviest works),
 * `recentlyPlayed` (10), `recently2w` (2-week playtime) and the `backlog`
 * rows (200 names, sorted). A secondary-only work is a row of its own with
 * `appid: null`; a Steam work shows its display total (Steam + GOG + Epic).
 *
 * S1 «распил god-функции»: pure over `chartWorks`/`visibleWorks` and the
 * per-work metadata helpers. The key order of every entry is the payload
 * contract.
 *
 * `recentlyPlayed` (03.11.2026): the strip is "launched lately", and Steam
 * does not always expose a launch timestamp — `GetOwnedGames` can answer
 * `rtime_last_played: 0` on every row of an owner who is clearly playing
 * (verified on steam-76561198203871831: 226 rows with rtime=0, 6 games with
 * two-week hours). A work with **2-week hours > 0 but no rtime** therefore
 * joins the strip on the hours alone; its `lastPlayed` stays `null` — no date
 * is ever invented. Sorting: rtime desc, then two-week minutes desc.
 */

const { RECENT_LIMIT, TOP_LIMIT, BACKLOG_LIMIT } = require('./constants');
const {
  round1,
  minutesToHours,
  isoOfSeconds,
  iconUrlOf,
  headerImageOf,
  hoursBySourceOf,
} = require('./numeric');
const { detailOf } = require('./documents');

function buildTop(ctx) {
  const {
    chartWorks,
    visibleWorks,
    gogUnion,
    details,
  } = ctx;
  const {
    workYear,
    workGenres,
    workCanonicalName,
    workDevelopers,
    workPublishers,
  } = ctx.workMeta;

  const byHoursDesc = [...chartWorks].sort(
    (left, right) =>
      right.minutes - left.minutes ||
      String(left.primary.name || '').localeCompare(String(right.primary.name || ''))
  );

  const topGames = byHoursDesc.slice(0, TOP_LIMIT).map((work) => {
    const game = work.primary;
    // M6c: a work that exists only outside Steam has no appid — the card keeps
    // `appid: null` and points at its own work key instead of inventing a Steam
    // identity. `hours` is the display total of the work (Steam + GOG + Epic).
    if (work.secondaryOnly) {
      const entry = work.union;
      return {
        appid: null,
        workKey: work.workKey,
        name: entry.name || null,
        hours: round1(work.hours),
        hours2w: 0,
        lastPlayed: null,
        releaseYear: workYear(work),
        genres: workGenres(work),
        type: 'game',
        isFree: null,
        completion: null,
        cover: null,
        iconUrl: null,
        canonicalWorkKey: work.workKey,
        editionCount: 1,
        sources: [...entry.sources],
        hoursBySource: hoursBySourceOf(entry),
        hoursUnknown: Boolean(entry.hoursUnknown),
        source: entry.sources.includes('gog') ? 'gog' : 'epic',
        ...(entry.developers.length ? { developers: [...entry.developers] } : {}),
        ...(entry.publishers.length ? { publishers: [...entry.publishers] } : {}),
      };
    }
    const doc = detailOf(details, game.appid);
    const entry = {
      appid: game.appid,
      name: game.name || null,
      hours: round1(work.hours),
      hours2w: work.minutes2w ? minutesToHours(work.minutes2w) : 0,
      lastPlayed: isoOfSeconds(work.rtime),
      releaseYear: workYear(work),
      genres: workGenres(work),
      type: doc ? doc.type : null,
      isFree: doc && typeof doc.is_free === 'boolean' ? doc.is_free : null,
      completion: work.completion ? work.completion.percent : null,
      cover: null,
      iconUrl: iconUrlOf(game.appid, game.img_icon_url),
      headerImage: headerImageOf(doc),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
    };
    // M6c: a Steam work that is also owned on GOG/Epic shows the display total
    // (`hours`) plus the per-source breakdown.
    if (work.union && work.union.sources.length > 1) {
      entry.sources = [...work.union.sources];
      entry.hoursBySource = hoursBySourceOf(work.union);
      entry.hoursSteam = round1((Number(work.union.steamMinutes) || 0) / 60);
    }
    // B6: the work's own metadata (base version) when the owned row is a
    // regional SKU without a store page. Additive: `name` stays the edition.
    const canonicalName = workCanonicalName(work);
    if (canonicalName) entry.canonicalName = canonicalName;
    if (work.games.length > 1 || canonicalName) {
      const developers = workDevelopers(work);
      const publishers = workPublishers(work);
      if (developers.length) entry.developers = developers;
      if (publishers.length) entry.publishers = publishers;
    }
    if (work.games.length > 1) {
      entry.editions = work.games.map((edition) => ({
        appid: edition.appid,
        name: edition.name || null,
        hours: minutesToHours(edition.playtime_forever),
        isPrimary: edition.appid === game.appid,
      }));
    }
    return entry;
  });

  const recentlyPlayed = [...visibleWorks]
    .filter((work) => work.rtime > 0 || work.minutes2w > 0)
    .sort(
      (left, right) =>
        right.rtime - left.rtime ||
        (Number(right.minutes2w) || 0) - (Number(left.minutes2w) || 0)
    )
    .slice(0, RECENT_LIMIT)
    .map((work) => ({
      appid: work.primary.appid,
      name: work.primary.name || null,
      hours2w: work.minutes2w ? minutesToHours(work.minutes2w) : 0,
      hoursTotal: round1(work.hours),
      // `rtime = 0` = "Steam did not expose a launch date", not a date.
      lastPlayed: isoOfSeconds(work.rtime),
      iconUrl: iconUrlOf(work.primary.appid, work.primary.img_icon_url),
      headerImage: headerImageOf(detailOf(details, work.primary.appid)),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
      // M6c: when the same work is owned outside Steam, the strip card can say
      // so (a small «GOG» badge) and show per-source hours. Additive: a
      // Steam-only payload keeps exactly the M1 shape.
      ...(gogUnion && gogUnion.byAppid[String(work.primary.appid)]
        ? {
            sources: gogUnion.byAppid[String(work.primary.appid)].sources,
            hoursBySource: hoursBySourceOf(gogUnion.byAppid[String(work.primary.appid)]),
          }
        : {}),
    }));

  const recently2w = [...visibleWorks]
    .filter((work) => work.minutes2w > 0)
    .sort((left, right) => right.minutes2w - left.minutes2w)
    .map((work) => ({
      appid: work.primary.appid,
      name: work.primary.name || null,
      hours2w: minutesToHours(work.minutes2w),
      hoursTotal: round1(work.hours),
      lastPlayed: isoOfSeconds(work.rtime),
      iconUrl: iconUrlOf(work.primary.appid, work.primary.img_icon_url),
      headerImage: headerImageOf(detailOf(details, work.primary.appid)),
      canonicalWorkKey: work.workKey,
      editionCount: work.games.length,
    }));

  const backlogItems = [...chartWorks]
    .filter((work) => work.minutes === 0 && !(work.union && work.union.hoursUnknown))
    .sort((left, right) =>
      String(left.primary.name || '').localeCompare(String(right.primary.name || ''))
    )
    .slice(0, BACKLOG_LIMIT)
    .map((work) => {
      if (work.secondaryOnly) {
        const entry = work.union;
        return {
          appid: null,
          workKey: work.workKey,
          name: entry.name || null,
          iconUrl: null,
          year: workYear(work),
          releaseYear: workYear(work),
          genres: workGenres(work),
          canonicalWorkKey: work.workKey,
          editionCount: 1,
          sources: [...entry.sources],
          source: entry.sources.includes('gog') ? 'gog' : 'epic',
          hoursUnknown: Boolean(entry.hoursUnknown),
        };
      }
      const game = work.primary;
      const year = workYear(work);
      const entry = {
        appid: game.appid,
        name: game.name || null,
        iconUrl: iconUrlOf(game.appid, game.img_icon_url),
        year,
        releaseYear: year,
        genres: workGenres(work),
        canonicalWorkKey: work.workKey,
        editionCount: work.games.length,
      };
      const canonicalName = workCanonicalName(work);
      if (canonicalName) entry.canonicalName = canonicalName;
      return entry;
    });

  return { topGames, recentlyPlayed, recently2w, backlogItems };
}

module.exports = { buildTop };
