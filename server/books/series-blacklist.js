'use strict';

const SERIES_BLACKLIST = [
  'Книга на все времена',
  'Азбука-классика',
  'Эксклюзивная классика',
  'The Big Book',
  'Иностранная литература. Большие книги',
  'Женская библиотека',
  'Зарубежная классика',
  'Классика',
  'Русская классика',
  'Классики и современники',
  'Зачарованный мир',
  'Золотая серия фэнтези',
  'Библиотека приключений',
  'Pocket book',
  'Прочесть обязательно!',
  'Шорт-лист',
];

function blacklistKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\([^()]*\)/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const BLACKLIST_KEYS = new Set(
  SERIES_BLACKLIST.map(blacklistKey).filter(Boolean)
);

function isBlacklistedSeries(name) {
  const key = blacklistKey(name);
  return Boolean(key) && BLACKLIST_KEYS.has(key);
}

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
