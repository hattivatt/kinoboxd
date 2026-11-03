'use strict';

/**
 * Constants of the books stats payload.
 *
 * Extracted from `books/stats.js` unchanged (S2 «распил god-функции»): the
 * ancient-year bound is shared by the summary counter and both year charts,
 * and the page buckets are the histogram contract, so one definition per
 * number is what keeps them from drifting apart. `books/stats.js` re-exports
 * `PAGE_BUCKETS`, `HARDCOVER_PROFILE_STATUS_IDS` and `READ_SHELF_LABELS`; the
 * module surface is unchanged.
 */

/** `origin`/`metadataSources` value of the `livelib-backup` file import. */
const FILE_METADATA_SOURCE = 'livelib-file';

/**
 * Ancient works (Сунь Цзы, античные авторы, Kama Sutra) live in one bucket.
 *
 * The bound is shared by every place that answers «когда написана книга»:
 * `summary.ancientBookCount`, the decade bucket, the year bucket and the UI
 * click key. One 300-year-old work must never stretch a year axis from -3000,
 * so the bucket is a slot of its own on both charts, not a year. Keeping the
 * number in one constant is what stops the counter and the charts from
 * disagreeing (the 30.10.2026 «бакет некликабелен» report).
 */
const ANCIENT_BEFORE_YEAR = 1000;

/** Stable filter key of that bucket on `decades[]` and `years[]`. */
const ANCIENT_BUCKET_KEY = 'before-1000';

const PAGE_BUCKETS = [
  { key: '<100', min: 0, max: 99 },
  { key: '100-199', min: 100, max: 199 },
  { key: '200-299', min: 200, max: 299 },
  { key: '300-399', min: 300, max: 399 },
  { key: '400-499', min: 400, max: 499 },
  { key: '500-699', min: 500, max: 699 },
  { key: '700-999', min: 700, max: 999 },
  { key: '1000+', min: 1000, max: Number.POSITIVE_INFINITY },
];

/**
 * Hardcover journal statuses that belong to the reading profile: 3 = read,
 * 5 = dnf ("did not finish"). Mirrors `HARDCOVER_KEEP_STATUS_IDS` from
 * `hardcover.js`; kept local so a persisted profile can be re-filtered without
 * loading the network module.
 */
const HARDCOVER_PROFILE_STATUS_IDS = [3, 5];
const HARDCOVER_PROFILE_STATUS_LABELS = ['read', 'dnf'];

const SHELF_LABELS = ['read', 'dnf', 'reading', 'wish'];
const READ_SHELF_LABELS = ['read', 'dnf'];

module.exports = {
  FILE_METADATA_SOURCE,
  ANCIENT_BEFORE_YEAR,
  ANCIENT_BUCKET_KEY,
  PAGE_BUCKETS,
  HARDCOVER_PROFILE_STATUS_IDS,
  HARDCOVER_PROFILE_STATUS_LABELS,
  SHELF_LABELS,
  READ_SHELF_LABELS,
};
