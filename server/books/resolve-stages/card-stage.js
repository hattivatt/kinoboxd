'use strict';

const providers = require('../providers');
const { normalizeIsbn, isbn10Of } = require('../normalize');
const { isbnOfEvent, eventKeyOf, chainInput, chainNamesOf } = require('./identity');
const { tryProvider, saveProviderWork, makeLink, countResolution, saveCardMetadata } = require('./chain');
const { lookupHardcoverByIsbn } = require('./isbn-stage');
const { unresolvedEvents } = require('./plan');

function splitByIsbn(events) {
  const withIsbn = [];
  const withoutIsbn = [];
  for (const event of events) {
    if (isbnOfEvent(event)) withIsbn.push(event);
    else withoutIsbn.push(event);
  }
  return { withIsbn, withoutIsbn };
}

async function fetchCards(ctx, events) {
  const { chain, cache, force } = ctx;
  const cardByBook = new Map();
  if (!chain.card) return cardByBook;
  for (const event of events) {
    const bookId = eventKeyOf(event);
    // Positive card metadata is persisted at ll:{bookId}; never re-fetch it.
    if (!force && cache.getWorkDetails(`ll:${bookId}`)) continue;
    const card = await tryProvider(chain.card, chainInput(event), ctx);
    if (card) cardByBook.set(bookId, card);
  }
  return cardByBook;
}

async function lookupCardIsbns(ctx, cardByBook) {
  const cardIsbns = new Set();
  for (const card of cardByBook.values()) {
    const isbn = normalizeIsbn(card.isbn13) || normalizeIsbn(card.isbn10);
    if (isbn) cardIsbns.add(isbn);
  }
  return lookupHardcoverByIsbn(ctx, cardIsbns);
}

async function closeCardIsbn(ctx, bookId, card, hardcoverByIsbn) {
  const isbn = card ? normalizeIsbn(card.isbn13) || normalizeIsbn(card.isbn10) : null;
  if (!isbn || !hardcoverByIsbn.has(isbn)) return false;
  const entry = hardcoverByIsbn.get(isbn);
  const hcResult = ctx.chain.hardcover.normalizeDetails(entry.details, entry.editionId);
  if (!hcResult) return false;
  const merged = providers.mergeResults(hcResult, card ? [card] : []);
  const saved = await saveProviderWork(ctx, merged);
  if (!saved) return false;
  ctx.plan.links.set(bookId, makeLink(bookId, merged, ctx.now));
  ctx.report.resolvedHardcoverCard++;
  return true;
}

async function applyCard(ctx, event, card, isbnInput) {
  const { plan, report, chain, cache, now } = ctx;
  const bookId = eventKeyOf(event);
  if (await closeCardIsbn(ctx, bookId, card, isbnInput.hardcoverByIsbn)) return;

  let result = null;
  if (isbnInput.isbn) {
    const input = chainInput(event, { isbn13: isbnInput.isbn, isbn10: isbn10Of(isbnInput.isbn) });
    result = await tryProvider(chain.google, input, ctx);
    if (!result) result = await tryProvider(chain.openLibrary, input, ctx);
  }
  if (!result) {
    result = await tryProvider(chain.google, chainInput(event), ctx);
    if (!result) result = await tryProvider(chain.openLibrary, chainInput(event), ctx);
  }
  if (result) {
    const merged = providers.mergeResults(result, card ? [card] : []);
    const saved = await saveProviderWork(ctx, merged);
    if (saved) {
      plan.links.set(bookId, makeLink(bookId, merged, now));
      countResolution(report, merged);
      return;
    }
  }

  if (card) {
    await saveCardMetadata(ctx, event, card);
    report.enriched++;
    report.resolvedLivelibCard++;
    return;
  }

  // No chain hit: leave the event unresolved (negatives are not persisted).
  if (isbnInput.isbn && ctx.isbnToBookIds.size > 0) {
    cache.appendMatchLog({
      ts: now,
      source: 'livelib',
      livelibBookId: bookId,
      query: event.title,
      decision: 'provider-miss',
      evidence: { isbn: isbnInput.isbn, providers: chainNamesOf(chain.list) },
    });
  }
}

/**
 * Events without an ISBN: the LiveLib card supplies the ISBN + RU metadata. The
 * card is budgeted (default 300/run) and pauses 2 s between requests. Card
 * metadata is saved as `ll:` details; the card ISBN is fed back into Hardcover.
 */
async function enrichWithoutIsbn(ctx, events, cardByBook, hardcoverByIsbn) {
  const { plan, report, cache, force } = ctx;
  for (const event of events) {
    const bookId = eventKeyOf(event);
    if (plan.links.has(bookId)) continue;
    if (!force && cache.getWorkDetails(`ll:${bookId}`)) {
      report.enriched++;
      report.resolvedLivelibCard++;
      continue;
    }
    const card = cardByBook.get(bookId) || null;
    const isbn = card ? normalizeIsbn(card.isbn13) || normalizeIsbn(card.isbn10) : null;
    await applyCard(ctx, event, card, { isbn, hardcoverByIsbn });
  }
}

async function enrichWithIsbn(ctx, events) {
  const { plan, report, chain, cache, force } = ctx;
  for (const event of events) {
    const bookId = eventKeyOf(event);
    if (plan.links.has(bookId)) continue;
    if (!force && cache.getWorkDetails(`ll:${bookId}`)) {
      report.enriched++;
      report.resolvedLivelibCard++;
      continue;
    }
    const isbnInput = chainInput(event);
    let result = await tryProvider(chain.google, isbnInput, ctx);
    if (!result) result = await tryProvider(chain.openLibrary, isbnInput, ctx);
    if (result) {
      const merged = providers.mergeResults(result, []);
      const saved = await saveProviderWork(ctx, merged);
      if (saved) {
        plan.links.set(bookId, makeLink(bookId, merged, ctx.now));
        countResolution(report, merged);
        continue;
      }
    }
    if (chain.card) {
      const card = await tryProvider(chain.card, chainInput(event), ctx);
      if (card) {
        await saveCardMetadata(ctx, event, card);
        report.enriched++;
        report.resolvedLivelibCard++;
        continue;
      }
    }
  }
}

async function runCard(ctx) {
  const { withIsbn, withoutIsbn } = splitByIsbn(unresolvedEvents(ctx));
  const cardByBook = await fetchCards(ctx, withoutIsbn);
  const hardcoverByIsbn = await lookupCardIsbns(ctx, cardByBook);
  await enrichWithoutIsbn(ctx, withoutIsbn, cardByBook, hardcoverByIsbn);
  await enrichWithIsbn(ctx, withIsbn);
}

module.exports = {
  splitByIsbn,
  runCard,
};
