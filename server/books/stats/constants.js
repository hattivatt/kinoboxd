'use strict';

const FILE_METADATA_SOURCE = 'livelib-file';

const ANCIENT_BEFORE_YEAR = 1000;

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
