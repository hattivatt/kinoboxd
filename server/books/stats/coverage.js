'use strict';

/**
 * Metadata coverage and first-publication-year progress of a books profile.
 *
 * S2 «распил god-функции»: two `summary` sub-objects that answer «сколько
 * библиографии уже есть» (`metadata`) and «почему год всё ещё неизвестен»
 * (`yearBackfill`). Both are pure reads of the prepared work set plus the
 * resolve-state archive; `buildSummary` assigns them in this order, because
 * the payload key order is part of the contract.
 */

const bookCache = require('../book-cache');
const { saneYear } = require('./numeric');
const { FILE_METADATA_SOURCE } = require('./constants');

/**
 * Metadata coverage of the profile: a work is "covered" when it has a
 * canonical work link (`metadataWorkId`) or a details document (shared
 * metadata chain: Hardcover/Litres/GB/OL/LiveLib card). `running` is only
 * true while the resolve stage of an import job is alive; it lets the UI say
 * "догружается" instead of showing empty genres as final. A Hardcover
 * profile takes its metadata from the journal, so it is never "loading" here.
 *
 * The badge used to count a work as resolved when the *file export* carried
 * genres/series/publisher (`work.unresolved === false`), so 444 works with
 * no link and no details document read as "resolved" and the badge sat at
 * 99% forever (user report, 28.10.2026; explore round 29.10.2026). The
 * counters below separate the three states:
 *
 *   linked      — a canonical provider work id (hc:/litres:/gb:/ol:);
 *   withDetails — a details document exists (link may be absent for a card);
 *   unlinked    — neither: the honest tail the scheduled resolve walks.
 *
 * The denominator is the RESOLVABLE pool, not every work. `hopeless` are
 * unlinked works whose every resolve key was asked and answered nothing
 * (resolve-state); `keyless` are works with no resolve key at all — they can
 * never be resolved, so they must not pin the badge below 100% either. Both
 * are reported separately instead of being silently folded into `total`.
 */
function buildMetadataCoverage(ctx) {
  const { works, workLinkKeys, profile, options } = ctx;
  const metadataTotal = works.size;
  let metadataLinked = 0;
  let metadataWithDetails = 0;
  let metadataUnlinked = 0;
  const resolveArchive =
    profile.source === 'livelib' ? bookCache.getResolveState('livelib', profile.userKey) : null;
  const hopelessKeys = new Set(
    Array.isArray(resolveArchive && resolveArchive.unmatchedKeys)
      ? resolveArchive.unmatchedKeys.map(String)
      : []
  );
  let metadataHopeless = 0;
  let metadataKeyless = 0;
  for (const [workId, work] of works) {
    // `work.metadataWorkId` falls back to the book's own `ll:` id when no
    // canonical link exists, so the prefix is what separates the two states.
    const canonicalWorkId = work.metadataWorkId && !String(work.metadataWorkId).startsWith('ll:');
    if (canonicalWorkId) metadataLinked++;
    if (work.details) metadataWithDetails++;
    if (canonicalWorkId || work.details) continue;
    metadataUnlinked++;
    const keys = workLinkKeys.get(workId) || [];
    if (keys.length === 0) {
      metadataKeyless++;
      continue;
    }
    if (hopelessKeys.size && keys.every((key) => hopelessKeys.has(String(key)))) {
      metadataHopeless++;
    }
  }
  const metadataResolved = metadataTotal - metadataUnlinked;
  const metadataResolvable = Math.max(
    0,
    metadataTotal - metadataHopeless - metadataKeyless
  );
  const resolveState = options.resolveState && typeof options.resolveState === 'object'
    ? options.resolveState
    : {};
  const metadataRunning = profile.source === 'livelib' && resolveState.running === true;
  const budgetRemaining = resolveState.budgetRemaining != null &&
    Number.isFinite(Number(resolveState.budgetRemaining))
    ? Number(resolveState.budgetRemaining)
    : null;
  const metadataPercent = metadataResolvable
    ? Math.round((metadataResolved * 100) / metadataResolvable)
    : 100;
  return {
    resolved: metadataResolved,
    total: metadataTotal,
    linked: metadataLinked,
    withDetails: metadataWithDetails,
    unlinked: metadataUnlinked,
    resolvable: metadataResolvable,
    hopeless: metadataHopeless,
    keyless: metadataKeyless,
    percent: metadataPercent,
    // "done" = nothing left to load for the resolvable pool. The badge uses it
    // to stop saying «догружается» once the job finished, even if `hopeless` /
    // `keyless` works remain dark.
    done: !metadataRunning && metadataResolved >= metadataResolvable,
    running: metadataRunning,
    budgetRemaining: metadataRunning ? budgetRemaining : null,
  };
}

/**
 * First-publication-year progress (round 29.10.2026).
 *
 * «Год неизвестен» is not one bucket: it mixes three different states, and
 * the user read them as a final verdict. The years backfill
 * (`kinoboxd-backfill-books`, timer `kinoboxd-backfill-books.timer`) fills
 * `pending` over several runs; `unlinked` needs the *metadata* chain first
 * (there is no details document to write a year into); `honestUnknown` is
 * final until the negative cache expires (30 days).
 *
 *   pending       — details document exists, has no year and was never asked
 *                   (or the last run deferred it on budget/network);
 *   honestUnknown — every provider answered and nobody knows the year
 *                   (`firstPublishedYearCheckedAt` is set);
 *   unlinked      — no details document at all: the year backfill cannot
 *                   help until the resolve chain creates one.
 *
 * `perRun`/`runsLeft` come from `BOOKS_BACKFILL_LIMIT` (the module exports
 * the unit's `--limit` to the server), so the UI can say «осталось ~K
 * прогонов» instead of showing the queue size as a final answer.
 */
function buildYearBackfill(ctx) {
  const { works, profile } = ctx;
  let yearsKnown = 0;
  let yearsPending = 0;
  let yearsHonest = 0;
  let yearsUnlinked = 0;
  const yearsBySource = { first: 0, edition: 0, manual: 0 };
  // Which legacy channel supplied an edition fallback: the export/file column
  // («Год издания» of the reader's own card) or the details document's print
  // run (`publicationYear`). Split so «восстановлено из файла» never hides
  // behind «провайдер знает год издания».
  const editionChannels = { file: 0, details: 0 };
  for (const work of works.values()) {
    if (Number.isFinite(work.year)) {
      yearsKnown++;
      if (work.yearSource && yearsBySource[work.yearSource] != null) {
        yearsBySource[work.yearSource]++;
      }
      if (work.yearSource === 'edition' && work.editionYearSource && editionChannels[work.editionYearSource] != null) {
        editionChannels[work.editionYearSource]++;
      }
      continue;
    }
    const details = work.details;
    if (!details) {
      yearsUnlinked++;
      continue;
    }
    if (details.firstPublishedYear != null || details.firstPublishedYearCheckedAt) {
      yearsHonest++;
      continue;
    }
    yearsPending++;
  }
  const backfillLimit = Number(process.env.BOOKS_BACKFILL_LIMIT);
  const yearsPerRun =
    Number.isFinite(backfillLimit) && backfillLimit > 0
      ? Math.floor(backfillLimit)
      : Math.max(yearsPending, 1);
  // Does the export itself carry a «Год издания» column? The 28.10.2026 file
  // export did not (0 of 1245 rows), which is why the legacy year channel
  // looked dead: the field the chart used to read was simply absent from the
  // file, not from the code. Counted over the profile document (before any
  // shelf/status filter) so the UI can tell the user «переэкспортируйте файл с
  // колонкой года» instead of blaming the providers.
  let fileRows = 0;
  let fileRowsWithYear = 0;
  for (const event of profile.events || []) {
    if (!event || event.origin !== FILE_METADATA_SOURCE) continue;
    fileRows++;
    if (event.edition && saneYear(event.edition.year) != null) fileRowsWithYear++;
  }
  return {
    known: yearsKnown,
    unknown: yearsPending + yearsHonest + yearsUnlinked,
    pending: yearsPending,
    honestUnknown: yearsHonest,
    unlinked: yearsUnlinked,
    // How the known years were obtained: an edition fallback is honest but not
    // a first publication, so the UI can say how many books are marked.
    sources: yearsBySource,
    // Split of the `edition` bucket by legacy channel (see `editionYearOf`).
    editionChannels,
    // The profile's own export: how many file rows carry «Год издания».
    fileColumn: { rows: fileRows, withYear: fileRowsWithYear },
    perRun: yearsPerRun,
    runsLeft: yearsPending > 0 ? Math.ceil(yearsPending / yearsPerRun) : 0,
    // Queue still open: «Год неизвестен» is a snapshot of the backfill, not a
    // final verdict. The UI words it that way only while this is true.
    open: yearsPending > 0,
  };
}

module.exports = { buildMetadataCoverage, buildYearBackfill };
