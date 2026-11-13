'use strict';

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
  const viewCount = timeline.reduce((sum, bucket) => sum + bucket.watched, 0);

  const watchDays = [...ctx.watchDayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const recentlyWatched = ctx.watchEvents
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 15);
  const streaks = computeStreaks(watchDays);

  return { timeline, watchDays, recentlyWatched, streaks, viewCount };
}

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
