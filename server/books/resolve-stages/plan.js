'use strict';

const segments = require('../segments');
const { eventKeyOf } = require('./identity');
const { loadWorks } = require('./corpus');

// Plan shelves of a file export («Читаю сейчас», «Хочу прочитать») are not
// reading history: stats never renders them, so spending the network budget
// (Litres: 2 s + 2 requests per book) on them would starve the books the user
// actually sees. They keep their file columns and are resolved if the book
// ever moves to a history shelf and the chain runs again.
const PLAN_SHELVES = new Set(['reading', 'wish']);

function expandEvents(ctx) {
  const { profiles, cache } = ctx;
  // Collection rows are expanded into their works before anything else: the
  // anthology is not matchable as a whole, each work is (СБОРНИКИ-ЭВРИСТИКА
  // §3). A row already decided as one book (link / enrichment / manual year) is
  // left alone — the user's decision outranks the heuristic.
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
  const links = new Map(); // bookId -> link doc
  const pending = [];
  let cached = 0;
  for (const event of events) {
    const bookId = eventKeyOf(event);
    // No identity at all (no LiveLib id, no file key): nothing to cache a link
    // under. A row carrying only a date is data noise, not an enrichment input.
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
