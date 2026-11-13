'use strict';

const RECENT_LIMIT = 10;
const TOP_LIMIT = 20;
const BACKLOG_LIMIT = 200;
const TAG_LIMIT = 50;
const TAG_INDEX_LIMIT = 5;
const DLC_TOP_LIMIT = 10;
const RARE_PERCENT = 5;
const UNKNOWN_YEAR_LABEL = 'год неизвестен';

const REVIEW_SCORE_LABELS = {
  1: 'Overwhelmingly Negative',
  2: 'Very Negative',
  3: 'Negative',
  4: 'Mostly Negative',
  5: 'Mixed',
  6: 'Mostly Positive',
  7: 'Positive',
  8: 'Very Positive',
  9: 'Overwhelmingly Positive',
};

const MODE_TESTS = {
  single: /^single-player$/i,
  multi: /multi-player/i,
  coop: /co-op/i,
  onlineCoop: /online co-op/i,
  localCoop: /local co-op|shared\/split screen/i,
  onlinePvp: /online pvp|^pvp$/i,
  mmo: /^mmo$/i,
  cloud: /steam cloud/i,
  controller: /full controller support/i,
};

const HISTOGRAM_BUCKETS = [
  { bucket: '0', test: (hours) => hours === 0 },
  { bucket: '<1', test: (hours) => hours > 0 && hours < 1 },
  { bucket: '1-5', test: (hours) => hours >= 1 && hours < 5 },
  { bucket: '5-20', test: (hours) => hours >= 5 && hours < 20 },
  { bucket: '20-50', test: (hours) => hours >= 20 && hours < 50 },
  { bucket: '50-100', test: (hours) => hours >= 50 && hours < 100 },
  { bucket: '100-500', test: (hours) => hours >= 100 && hours < 500 },
  { bucket: '500+', test: (hours) => hours >= 500 },
];

module.exports = {
  RECENT_LIMIT,
  TOP_LIMIT,
  BACKLOG_LIMIT,
  TAG_LIMIT,
  TAG_INDEX_LIMIT,
  DLC_TOP_LIMIT,
  RARE_PERCENT,
  UNKNOWN_YEAR_LABEL,
  REVIEW_SCORE_LABELS,
  MODE_TESTS,
  HISTOGRAM_BUCKETS,
};
