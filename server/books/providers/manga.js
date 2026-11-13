'use strict';

const MANGA_PATTERN =
  /(?:\bmanga\b|\bmanhwa\b|\bmanhua\b|\bcomics?\b|\bgraphic[\s-]?novels?\b|\bsingle[\s-]?issues?\b|\bcollected[\s-]?editions?\b|\bwebtoons?\b|\bshonen\b|\bshōnen\b|\bshoujo\b|\bshōjo\b|\bseinen\b|\bjosei\b|\banime\b|манга|манхва|манхуа|комикс|сёнэн|сёнен|сёдзё|сёдзе|сэйнэн|сэйнен|вебтун|веб-?комикс|додзинси|аниме|графическ[\p{L}]*\s+роман[\p{L}]*)/iu;

const MANGA_PUBLISHERS = [
  'viz media',
  'viz',
  'kodansha',
  'kodansha comics',
  'shueisha',
  'shogakukan',
  'kadokawa',
  'square enix',
  'yen press',
  'seven seas',
  'tokyopop',
  'dark horse',
  'dark horse manga',
  'dark horse comics',
  'marvel',
  'marvel comics',
  'dc comics',
  'vertigo',
  'image comics',
  'boom! studios',
  'boom studios',
  'idw',
  'idw publishing',
  'dynamite entertainment',
  'oni press',
  'fantagraphics',
  'top shelf',
  'titan comics',
  'avatar press',
  'archie comics',
  'valiant comics',
  'humanoids',
  'glenat',
  'glénat',
  'pika edition',
  'pika édition',
  'ki-oon',
  'kana',
  'kurokawa',
  'tonkam',
  'delcourt',
  'dargaud',
  'dupuis',
  'casterman',
  'urban comics',
  'panini',
  'panini comics',
  'star comics',
  'j-pop',
  'jpop',
  'комильфо',
  'komilfo',
  'bubble',
  'истари комикс',
  'istari comics',
  'фабрика комиксов',
  'alt graph',
  'xl media',
];

const MANGA_PUBLISHER_PATTERNS = MANGA_PUBLISHERS.map((name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'iu');
});

function normalizePublisher(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesOf(signals) {
  if (!signals) return [];
  const list = Array.isArray(signals) ? signals : [signals];
  const names = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      if (entry.trim()) names.push(entry.trim());
      continue;
    }
    if (typeof entry === 'object' && typeof entry.name === 'string' && entry.name.trim()) {
      names.push(entry.name.trim());
    }
  }
  return names;
}

function isMangaSignal(value) {
  return Boolean(value) && MANGA_PATTERN.test(String(value));
}

function isMangaPublisher(value) {
  const publisher = normalizePublisher(value);
  if (!publisher) return false;
  return MANGA_PUBLISHER_PATTERNS.some((pattern) => pattern.test(publisher));
}

function collectMangaTexts(input = {}) {
  const list = [];
  for (const value of [
    ...namesOf(input.genres),
    ...namesOf(input.categories),
    ...namesOf(input.subjects),
    ...namesOf(input.tags),
    ...namesOf(input.texts),
    ...namesOf(input.series),
  ]) {
    if (!list.includes(value)) list.push(value);
  }
  const publisher = input.publisher ? String(input.publisher).trim() : '';
  if (publisher && !list.includes(publisher)) list.push(publisher);
  return list;
}

function detectManga(input = {}) {
  const classifications = [
    ...namesOf(input.genres),
    ...namesOf(input.categories),
    ...namesOf(input.subjects),
    ...namesOf(input.tags),
    ...namesOf(input.texts),
  ];
  const series = namesOf(input.series);
  const publisher = input.publisher ? String(input.publisher).trim() : '';

  for (const value of classifications.concat(series)) {
    if (isMangaSignal(value)) return true;
  }
  if (isMangaSignal(publisher) || isMangaPublisher(publisher)) return true;
  if (classifications.length > 0) return false;
  return null;
}

module.exports = {
  MANGA_PATTERN,
  MANGA_PUBLISHERS,
  detectManga,
  isMangaSignal,
  isMangaPublisher,
  collectMangaTexts,
};
