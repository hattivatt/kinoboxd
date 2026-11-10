'use strict';

const providers = require('../providers');
const { normalizeIsbn, isbn10Of } = require('../normalize');
const { CYRILLIC_TITLE, eventKeyOf, chainInput } = require('./identity');
const { tryProvider, saveProviderWork, makeLink } = require('./chain');
const { lookupHardcoverByIsbn } = require('./isbn-stage');
const { unresolvedEvents } = require('./plan');

/**
 * Litres first for Cyrillic titles: Hardcover does not know RU editions, but
 * the litres card returns an ISBN that can still close a Hardcover work.
 *
 * The order inside the chain is: (a) ISBN batch — the cheapest and most
 * precise key, and a `livelib-backup` file already carries it, so a file row
 * never needs the LiveLib card just to learn its ISBN; (b) for Cyrillic
 * titles Litres is the first *title* matcher (user rule «литрес первым для
 * русских названий»), and its ISBN is fed back into Hardcover; (c) GB → OL →
 * LiveLib card fill whatever is left.
 */
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

    // ISBN feedback: the paper ISBN from litres may exist in Hardcover even
    // when the LiveLib ISBN did not.
    if (isbn && hardcoverByLitresIsbn.has(isbn)) {
      const entry = hardcoverByLitresIsbn.get(isbn);
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

    // Litres is the RU canonical card; GB/OL may only fill missing fields.
    // They are *fallbacks*, and their per-run budgets (BOOKS_GB_BUDGET) must
    // serve the unlinked tail, not re-enrich a litres hit that already has an
    // ISBN, a year and pages. Ask them only when something is missing.
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
