'use strict';

/**
 * «Series» that are catalogue tags, not literary series
 * (КНИГИ-АРХИТЕКТУРА §7.4.1, 28.10.2026).
 *
 * A `livelib-backup` export carries the user's own «Серия» column, and the file
 * column IS the authority for bibliographic values — but it is not an authority
 * on the *kind* of the value. Литрес/Эксмо publish shelves in the same column
 * as a real cycle: «Книга на все времена» is a publisher's tag, not a series,
 * and the user confirmed it must not appear in the series widget (nor inflate
 * `summary.seriesCount`).
 *
 * The filter is applied to every source (литрес / file / hardcover) after the
 * series lists are merged, before any counting, so one tagged book cannot
 * resurrect the tag through the metadata chain.
 *
 * ── ДОПОЛНЯТЬ ПО ХОДУ ЭКСПЛУАТАЦИИ ─────────────────────────────────────────
 * Add the canonical spelling of a newly reported tag below, one per line, with
 * a short comment: what it is and when it was reported. Matching is normalized
 * (case, «ё», quotes, punctuation, a trailing parenthetical), so
 * «Книга на все времена», «книга на все времена» and
 * «КНИГА НА ВСЕ ВРЕМЕНА (Эксмо)» are one entry.
 */
const SERIES_BLACKLIST = [
  // Издательская серия-полка «Эксмо», не литературный цикл (28.10.2026).
  'Книга на все времена',
];

/**
 * Identity of a blacklist entry: NFKC, lowercase, «ё»→«е», parenthetical
 * suffixes dropped (a shelf may carry the publisher in brackets), punctuation
 * collapsed to single spaces.
 */
function blacklistKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // «Книга на все времена (Эксмо)» — the bracket is presentation.
    .replace(/\([^()]*\)/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const BLACKLIST_KEYS = new Set(
  SERIES_BLACKLIST.map(blacklistKey).filter(Boolean)
);

/** Is this series name a blacklisted catalogue tag? */
function isBlacklistedSeries(name) {
  const key = blacklistKey(name);
  return Boolean(key) && BLACKLIST_KEYS.has(key);
}

/**
 * Drop blacklisted entries from a series list. Returns `{ list, removed }` so
 * the caller can report honestly how many works were touched without leaking
 * the tag back into the payload.
 */
function filterBlacklistedSeries(list) {
  const out = [];
  let removed = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || !entry.name) continue;
    if (isBlacklistedSeries(entry.name)) {
      removed++;
      continue;
    }
    out.push(entry);
  }
  return { list: out, removed };
}

module.exports = {
  SERIES_BLACKLIST,
  blacklistKey,
  isBlacklistedSeries,
  filterBlacklistedSeries,
};
