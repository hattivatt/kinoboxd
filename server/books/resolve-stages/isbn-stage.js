'use strict';

const { isbnOfEvent, eventKeyOf } = require('./identity');
const { hardcoverEntryConflict } = require('./matching');

function createLookup(ctx) {
  const codes = ctx.lookupErrors;
  return async function lookupSafe(isbns) {
    try {
      return await ctx.lookupFn(isbns, { onProgress: ctx.onProgress });
    } catch (err) {
      const code = (err && err.code) || 'isbn_lookup_failed';
      if (!codes.includes(code)) codes.push(code);
      return { byIsbn: new Map(), works: new Map(), queries: [...isbns], requests: 0 };
    }
  };
}

function isbnIndex(events) {
  const isbnToBookIds = new Map();
  for (const event of events) {
    const isbn = isbnOfEvent(event);
    if (!isbn) continue;
    if (!isbnToBookIds.has(isbn)) isbnToBookIds.set(isbn, new Set());
    isbnToBookIds.get(isbn).add(eventKeyOf(event));
  }
  return isbnToBookIds;
}

async function lookupHardcoverByIsbn(ctx, isbns) {
  const byIsbn = new Map();
  if (!isbns.size || !ctx.chain.byName.has('hardcover')) return byIsbn;
  const lookup = await ctx.lookup([...isbns]);
  ctx.report.requests += lookup.requests;
  for (const [isbn, entry] of lookup.byIsbn) byIsbn.set(isbn, entry);
  for (const details of lookup.works.values()) {
    await ctx.cache.saveDetails(details.hcWorkId, details);
  }
  return byIsbn;
}

async function applyIsbnLinks(ctx) {
  const { plan, report, state, cache, now } = ctx;
  const isbnToBookIds = isbnIndex(plan.pending);
  ctx.isbnToBookIds = isbnToBookIds;
  if (isbnToBookIds.size === 0) return;

  const titles = new Map(plan.pending.map((event) => [eventKeyOf(event), event.title]));
  const lookup = await ctx.lookup([...isbnToBookIds.keys()]);
  report.requests += lookup.requests;
  for (const [isbn, entry] of lookup.byIsbn) {
    const workId = `hc:${entry.details.hcWorkId}`;
    plan.works.set(String(entry.details.hcWorkId), entry.details);
    for (const bookId of isbnToBookIds.get(isbn) || []) {
      if (plan.links.has(bookId)) continue;
      if (hardcoverEntryConflict(titles.get(bookId), entry)) {
        report.rejectedIsbn = (report.rejectedIsbn || 0) + 1;
        continue;
      }
      const link = {
        schemaVersion: 1,
        livelibBookId: bookId,
        workId,
        method: 'isbn',
        score: 1,
        evidence: { isbn, editionTitle: entry.editionTitle || null },
        resolvedAt: now,
      };
      plan.links.set(bookId, link);
      report.resolvedIsbn++;
    }
  }
  for (const details of lookup.works.values()) {
    await cache.saveDetails(details.hcWorkId, details);
  }
  for (const bookIds of isbnToBookIds.values()) {
    for (const bookId of bookIds) {
      state.askedKeys.add(String(bookId));
      if (ctx.lookupErrors.length) state.providerErrorKeys.add(String(bookId));
      else state.attemptedKeys.add(String(bookId));
    }
  }
}

module.exports = {
  createLookup,
  isbnIndex,
  lookupHardcoverByIsbn,
  applyIsbnLinks,
};
