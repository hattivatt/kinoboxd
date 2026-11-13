'use strict';

const { computeStreaks } = require('./numeric');

function buildTimeline(ctx) {
  const { finishedEvents, monthOnlyEvents } = ctx;
  const monthMap = new Map();
  const dayMap = new Map();
  function monthBucket(month) {
    if (!monthMap.has(month)) {
      monthMap.set(month, {
        month,
        finished: 0,
        reRead: 0,
        livelib: 0,
        hardcover: 0,
        monthOnly: 0,
      });
    }
    return monthMap.get(month);
  }
  for (const event of monthOnlyEvents) {
    const bucket = monthBucket(String(event.readMonth).slice(0, 7));
    bucket.monthOnly++;
    bucket[event.source] = (bucket[event.source] || 0) + 1;
    if (event.reread) bucket.reRead++;
  }
  for (const event of finishedEvents) {
    const month = String(event.finishedAt).slice(0, 7);
    const day = String(event.finishedAt).slice(0, 10);
    const monthEntry = monthBucket(month);
    monthEntry.finished++;
    if (event.reread) monthEntry.reRead++;
    monthEntry[event.source] = (monthEntry[event.source] || 0) + 1;

    if (!dayMap.has(day)) {
      dayMap.set(day, { date: day, count: 0, reReadCount: 0, ids: [], sources: new Set() });
    }
    const dayEntry = dayMap.get(day);
    dayEntry.count++;
    if (event.reread) dayEntry.reReadCount++;
    if (!dayEntry.ids.includes(event.workId)) dayEntry.ids.push(event.workId);
    dayEntry.sources.add(event.source);
  }
  const timeline = [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
  const readDays = [...dayMap.values()]
    .map((entry) => ({ ...entry, sources: [...entry.sources].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const streaks = computeStreaks(readDays);
  return { timeline, readDays, streaks };
}

function buildRecentlyFinished(ctx) {
  const { works, events } = ctx;
  const recentEvents = events
    .filter((event) => event.finishedAt || /^\d{4}-\d{2}$/.test(String(event.readMonth || '')))
    .map((event) => ({
      event,
      date: event.finishedAt ? String(event.finishedAt).slice(0, 10) : String(event.readMonth),
      precision: event.finishedAt ? 'day' : 'month',
    }));
  return recentEvents
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return String(a.event.id) < String(b.event.id) ? -1 : 1;
    })
    .slice(0, 15)
    .map(({ event, date, precision }) => {
      const work = works.get(event.workId);
      return {
        date,
        precision,
        workId: event.workId,
        title: (work && work.title) || event.title,
        authors: (work && work.authors.length ? work.authors : event.authors) || [],
        source: event.source,
        reRead: event.reread,
        rating: (work && work.rating10) != null ? work.rating10 : event.rating10,
      };
    });
}

function buildRecentlyReading(ctx) {
  const { prepared } = ctx;
  return prepared.readingEvents
    .map((event) => {
      const date = event.startedAt
        ? String(event.startedAt).slice(0, 10)
        : event.startMonth
          ? String(event.startMonth).slice(0, 7)
          : null;
      return {
        date,
        precision: date ? (event.startedAt ? 'day' : 'month') : null,
        startedAt: event.startedAt || null,
        workId: event.workId,
        title: event.title || null,
        authors: Array.isArray(event.authors) ? event.authors : [],
        source: event.source,
        status: 'reading',
        coverUrl: event.coverUrl || null,
      };
    })
    .sort((a, b) => {
      if (a.date !== b.date) {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date < b.date ? 1 : -1;
      }
      const left = String(a.title || '');
      const right = String(b.title || '');
      return left.localeCompare(right);
    })
    .slice(0, 15);
}

module.exports = { buildTimeline, buildRecentlyFinished, buildRecentlyReading };
