'use strict';

const providers = require('../providers');
const { normalizeIsbn, isbn10Of } = require('../normalize');
const { CYRILLIC_TITLE, eventKeyOf, chainInput, isbnOfEvent } = require('./identity');
const { tryProvider, saveProviderWork, makeLink } = require('./chain');
const { lookupHardcoverByIsbn } = require('./isbn-stage');
const { unresolvedEvents } = require('./plan');
const { hardcoverEntryConflict } = require('./matching');

async function runLitres(ctx) {
  const { plan, report, chain, now } = ctx;
  if (!chain.litres) return;
  const remaining = unresolvedEvents(ctx);
  const ruEvents = remaining.filter((event) => CYRILLIC_TITLE.test(String(event.title || '')));
  const litresByBook = new Map();
  for (const event of ruEvents) {
    const bookId = eventKeyOf(event);
    const result = await tryProvider(chain.litres, chainInput(event), ctx);
    if (result) litresByBook.set(bookId, result);
  }

  const litresIsbns = new Set();
  for (const result of litresByBook.values()) {
    const isbn = normalizeIsbn(result.isbn13) || normalizeIsbn(result.isbn10);
    if (isbn) litresIsbns.add(isbn);
  }
  const hardcoverByLitresIsbn = await lookupHardcoverByIsbn(ctx, litresIsbns);

  for (const event of ruEvents) {
    const bookId = eventKeyOf(event);
    if (plan.links.has(bookId)) continue;
    const litresResult = litresByBook.get(bookId);
    if (!litresResult) continue;
    const isbn = normalizeIsbn(litresResult.isbn13) || normalizeIsbn(litresResult.isbn10);

    const hcEntry = isbn ? hardcoverByLitresIsbn.get(isbn) : null;
    const hcConflict = hcEntry
      ? hardcoverEntryConflict(event.title, hcEntry, { derived: isbnOfEvent(event) !== isbn })
      : null;
    if (hcConflict) report.rejectedIsbn = (report.rejectedIsbn || 0) + 1;
    if (hcEntry && !hcConflict) {
      const entry = hcEntry;
      const hcResult = chain.hardcover.normalizeDetails(entry.details, entry.editionId);
      if (hcResult) {
        const merged = providers.mergeResults(hcResult, [litresResult]);
        const saved = await saveProviderWork(ctx, merged);
        if (saved) {
          plan.links.set(bookId, makeLink(bookId, merged, now));
          report.resolvedHardcoverFromLitres++;
          continue;
        }
      }
    }

    const needsExtra =
      !litresResult.isbn13 || litresResult.year == null || litresResult.pages == null;
    const extraInput = isbn
      ? chainInput(event, { isbn13: isbn, isbn10: isbn10Of(isbn) })
      : chainInput(event);
    let extra = null;
    if (needsExtra) {
      extra = await tryProvider(chain.google, extraInput, ctx);
      if (!extra) extra = await tryProvider(chain.openLibrary, extraInput, ctx);
    }
    const merged = providers.mergeResults(litresResult, extra ? [extra] : []);
    const saved = await saveProviderWork(ctx, merged);
    if (saved) {
      plan.links.set(bookId, makeLink(bookId, merged, now));
      report.resolvedLitres++;
    }
  }
}

module.exports = {
  runLitres,
};
