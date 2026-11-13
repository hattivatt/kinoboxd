'use strict';

const segments = require('../segments');
const { eventKeyOf } = require('./identity');
const { loadWorks } = require('./corpus');

const PLAN_SHELVES = new Set(['reading', 'wish']);

function expandEvents(ctx) {
  const { profiles, cache } = ctx;
  const collectionYearOverrides =
    profiles.userKey && profiles.source === 'livelib'
      ? cache.getYearOverrides(profiles.source, profiles.userKey)
      : null;
  const allEvents = segments.expandProfileEvents(profiles.events, {
    canExpand(event) {
      const key = eventKeyOf(event);
      if (!key) return true;
      return !segments.expansionBlocked(event, {
        link: cache.getLink(key),
        details: cache.getWorkDetails(`ll:${key}`),
        yearOverrides: collectionYearOverrides,
      });
    },
  });
  const events = allEvents.filter((event) => !(event && PLAN_SHELVES.has(event.shelf)));
  return { events, skippedPlanShelf: allEvents.length - events.length };
}

function scanLinks(ctx, events) {
  const links = new Map();
  const pending = [];
  let cached = 0;
  for (const event of events) {
    const bookId = eventKeyOf(event);
    if (!bookId) continue;
    if (!ctx.force) {
      const link = ctx.cache.getLink(bookId);
      if (link && link.workId) {
        links.set(bookId, link);
        cached++;
        continue;
      }
    }
    pending.push(event);
  }
  return { links, pending, cached };
}

function buildPlan(ctx) {
  const { events, skippedPlanShelf } = expandEvents(ctx);
  const { links, pending, cached } = scanLinks(ctx, events);
  return {
    events,
    skippedPlanShelf,
    links,
    pending,
    cached,
    works: loadWorks(),
    corpus: null,
  };
}

function unresolvedEvents(ctx) {
  return ctx.plan.pending.filter((event) => !ctx.plan.links.has(eventKeyOf(event)));
}

module.exports = {
  PLAN_SHELVES,
  buildPlan,
  unresolvedEvents,
};
