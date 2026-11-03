'use strict';

/**
 * Viewing timeline, calendar days, recently watched and streaks.
 *
 * One viewing = one timeline event. With an attached Letterboxd archive every
 * diary row is one viewing (rewatches counted); a KinoPoisk film without a
 * diary row contributes the rating-date proxy. The calendar (watchDays) is the
 * day-level view of exactly the same events, so
 * `sum(watchDays.count) === sum(timeline.watched)` by construction.
 */

const { computeStreaks } = require('./numeric');

function addTimelineEvent(ctx, date, rated, event = null) {
  if (!date || !/^\d{4}-\d{2}/.test(String(date))) return;
  const day = String(date).slice(0, 10);
  const month = day.slice(0, 7);
  let bucket = ctx.timelineMap.get(month);
  if (!bucket) {
    bucket = { month, watched: 0, rated: 0, rewatchCount: 0 };
    ctx.timelineMap.set(month, bucket);
  }
  bucket.watched++;
  if (rated) bucket.rated++;
  // Only diary events carry a rewatch flag; the KinoPoisk rating-date proxy
  // has no rewatch signal and passes `null`, so it never lands here.
  if (event && event.rewatch === true) bucket.rewatchCount++;
  if (!ctx.realDateFrom || day < ctx.realDateFrom) ctx.realDateFrom = day;
  if (!ctx.realDateTo || day > ctx.realDateTo) ctx.realDateTo = day;

  if (event && event.slug) {
    let watchDay = ctx.watchDayMap.get(day);
    if (!watchDay) {
      watchDay = { date: day, count: 0, rewatchCount: 0, slugs: [] };
      ctx.watchDayMap.set(day, watchDay);
    }
    watchDay.count++;
    if (event.rewatch === true) watchDay.rewatchCount++;
    watchDay.slugs.push(String(event.slug));
    ctx.watchEvents.push({
      date: day,
      slug: String(event.slug),
      rewatch: event.rewatch === undefined ? null : event.rewatch,
    });
  }
}

function buildTimeline(ctx) {
  // KinoPoisk timelines are built in the film loop (attachment diary events
  // or the ratedAt proxy). A pure Letterboxd upload only uses diary events:
  // watched.csv carries the import date for every film, which would create a
  // huge fake spike, so it never feeds the timeline.
  if (!ctx.isKpSource) {
    for (const event of ctx.upload.events || []) {
      if (event.source !== 'diary') continue;
      if (!event.date) continue;
      addTimelineEvent(ctx, event.date, event.rating !== null && event.rating !== undefined, {
        slug: event.slug || null,
        rewatch: Boolean(event.rewatch),
      });
    }
  }

  const timeline = [...ctx.timelineMap.values()].sort((a, b) =>
    a.month.localeCompare(b.month)
  );
  // Total viewings (rewatches included), i.e. exactly the sum the monthly bars
  // and the calendar show. Without an attachment every KinoPoisk film
  // contributes one proxy viewing, so this equals filmCount.
  const viewCount = timeline.reduce((sum, bucket) => sum + bucket.watched, 0);

  // Day-level viewing history for the calendar heatmap. Sorted ascending;
  // sum(count) === sum(timeline.watched) by construction.
  const watchDays = [...ctx.watchDayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  // The newest 15 viewings, newest first, for the "recently watched" strip.
  const recentlyWatched = ctx.watchEvents
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);
  const streaks = computeStreaks(watchDays);

  return { timeline, watchDays, recentlyWatched, streaks, viewCount };
}

/** Rewatch ranking: films whose diary has at least two Rewatch=true rows. */
function buildRewatches(ctx) {
  return [...ctx.rewatchBySlug.entries()]
    .filter(([, count]) => count >= 2)
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
}

module.exports = {
  addTimelineEvent,
  buildTimeline,
  buildRewatches,
};
