'use strict';

/**
 * Manga/comics detection for the books payload (`?includeMangaComics=0|1`).
 *
 * The flag is deliberately tri-state:
 *   true  — at least one metadata signal names manga/comics/graphic novel;
 *   false — classification fields are known and none of them is manga/comics;
 *   null  — no classification-level signal (LiveLib bulk has no genres at all),
 *           so the book is never filtered. `null` survives every filter, which
 *           is the conscious choice from the brief: a missing signal must not
 *           hide a regular book.
 *
 * Signal extraction is intentionally greedy across providers, because no single
 * source is reliable enough:
 *   - LiveLib card: `ShortInfoGenres` + `td.genre-card`;
 *   - Google Books: all `categories` (split on " / ");
 *   - Open Library: *all* `subjects` (the display list is still capped at 25,
 *     but detection reads the full subject array);
 *   - Hardcover: every `taggings` tag (not only the Genre category), series
 *     names and publisher;
 *   - series names themselves ("Crossed (Single Issues)", "Trigun (3 volumes)")
 *     and publisher strings ("VIZ Media", "Image Comics", "Комильфо").
 */

/**
 * Case-insensitive keyword set; Cyrillic prefixes cover all inflections.
 *
 * Russian columns of a `livelib-backup` export use human genre labels
 * («Манга», «Комиксы и манга», «Графический роман», «Сёнэн»), so the RU part
 * of the set is not optional: it is the only classification signal a
 * file-imported profile has (§3.3.2).
 */
const MANGA_PATTERN =
  /(?:\bmanga\b|\bmanhwa\b|\bmanhua\b|\bcomics?\b|\bgraphic[\s-]?novels?\b|\bsingle[\s-]?issues?\b|\bcollected[\s-]?editions?\b|\bwebtoons?\b|\bshonen\b|\bshōnen\b|\bshoujo\b|\bshōjo\b|\bseinen\b|\bjosei\b|\banime\b|манга|манхва|манхуа|комикс|сёнэн|сёнен|сёдзё|сёдзе|сэйнэн|сэйнен|вебтун|веб-?комикс|додзинси|аниме|графическ[\p{L}]*\s+роман[\p{L}]*)/iu;

/**
 * Publishers whose catalogue is comics/manga (a publisher hit is a strong
 * enough signal on its own). Deliberately excludes mixed prose houses — most
 * importantly `Эксмо`, `АСТ`, `Азбука`: they print both prose and comics, so a
 * publisher-only hit there would hide regular novels.
 */
const MANGA_PUBLISHERS = [
  // English-language comics/manga
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
  // French/Belgian comics & manga
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
  // Russian comics/manga
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

/**
 * Collect the text fields that should be persisted with a details document, so
 * the stats read can re-detect manga/comics without another network request.
 * `detectManga` also accepts these arrays directly (`texts`).
 */
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

/**
 * @param {{genres?: Array<string|object>, categories?: Array<string>,
 *          subjects?: Array<string>, tags?: Array<string>,
 *          texts?: Array<string>, series?: Array<string|object>,
 *          publisher?: string|null}} input
 * @returns {boolean|null}
 */
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
  // Classification fields known and clean -> confidently not manga/comics.
  // A clean publisher/series name alone is not enough to claim `false`.
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
